[CmdletBinding()]
param(
    [string]$SdkRoot,
    [string]$JavaHome,
    [string]$ApkPath,
    [ValidateSet('debug', 'release')][string]$Variant = 'debug',
    [string]$ReportPath,
    [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot

function Require([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Hash-Bytes([byte[]]$Bytes) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}
function Run-Tool([string]$Program, [string[]]$Arguments, [switch]$AllowFailure) {
    # Native stderr is diagnostic data; inspect the exit code even in Windows PS 5.
    $ErrorActionPreference = 'Continue'
    $output = @(& $Program @Arguments 2>&1 | ForEach-Object { $_.ToString() })
    $exitCode = $LASTEXITCODE
    if (!$AllowFailure -and $exitCode -ne 0) { throw ('Tool failed ({0}): {1}' -f $exitCode, ($output -join "`n")) }
    return @{ ExitCode = $exitCode; Text = ($output -join "`n") }
}
function XmlTree-Nodes([string]$Text) {
    $nodes = [Collections.Generic.List[object]]::new()
    $stack = [Collections.Generic.List[object]]::new()
    foreach ($line in ($Text -split "`n")) {
        if ($line -match '^(\s*)E: ([^\s]+)') {
            $indent = $Matches[1].Length
            while ($stack.Count -gt 0 -and $stack[$stack.Count - 1].Indent -ge $indent) { $stack.RemoveAt($stack.Count - 1) }
            $parent = if ($stack.Count) { $stack[$stack.Count - 1] } else { $null }
            $node = @{ Name = $Matches[2]; Indent = $indent; Attributes = @{}; Parent = $parent }
            $nodes.Add($node); $stack.Add($node)
        } elseif ($line -match '^\s*A: ([^\s(=]+)(?:\([^)]*\))?=(.*)$' -and $stack.Count) {
            $attributeName = $Matches[1].Replace('http://schemas.android.com/apk/res/android:', 'android:')
            $stack[$stack.Count - 1].Attributes[$attributeName] = $Matches[2].Trim()
        }
    }
    return $nodes.ToArray()
}
function Xml-String($Node, [string]$Name) {
    $value = $Node.Attributes[$Name]
    if ($null -ne $value -and $value -match '^"([^"]*)"') { return $Matches[1] }
    return $null
}
function Xml-False($Node, [string]$Name) {
    $value = $Node.Attributes[$Name]
    return $null -ne $value -and $value -match '^(?:false|\(type 0x12\)0x0)$'
}
function Xml-True($Node, [string]$Name) {
    $value = $Node.Attributes[$Name]
    return $null -ne $value -and $value -match '^(?:true|\(type 0x12\)0xffffffff)$'
}
function Xml-Children($Nodes, $Parent, [string]$Name) {
    return @($Nodes | Where-Object { $_.Name -eq $Name -and [object]::ReferenceEquals($_.Parent, $Parent) })
}
function Resource-Table([string]$Text) {
    $resources = @{}; $current = $null
    foreach ($line in ($Text -split "`n")) {
        if ($line -match '^\s+resource (0x[0-9a-f]+) (\S+)\s*$') {
            $current = @{ Id = $Matches[1]; Files = @{} }
            $resources[$Matches[2]] = $current
        } elseif ($null -ne $current -and $line -match '^\s+\(([^)]*)\) \(file\) (\S+) type=(PNG|XML)\s*$') {
            Require (!$current.Files.ContainsKey($Matches[1])) 'Duplicate resource configuration.'
            $current.Files[$Matches[1]] = $Matches[2]
        }
    }
    return $resources
}
function Resource-File($Resources, [string]$Name, [string]$Configuration) {
    Require ($Resources.ContainsKey($Name) -and $Resources[$Name].Files.ContainsKey($Configuration)) ('Missing compiled resource: ' + $Name + '/' + $Configuration)
    return $Resources[$Name].Files[$Configuration]
}
function Assert-Manifest([string]$Text, [string]$ExpectedId, [string]$BuildVariant) {
    $nodes = @(XmlTree-Nodes $Text)
    $applications = @($nodes | Where-Object Name -EQ 'application')
    Require ($applications.Count -eq 1) 'APK must contain exactly one application.'
    $application = $applications[0]
    Require ($application.Attributes['android:largeHeap'] -match '^(?:true|\(type 0x12\)0xffffffff)$') 'Missing heap request for the unchanged wallet KDF.'
    foreach ($flag in @('android:allowBackup', 'android:fullBackupContent', 'android:usesCleartextTraffic')) {
        Require (Xml-False $application $flag) ('Unsafe or missing merged manifest flag: ' + $flag)
    }
    Require ($application.Attributes.ContainsKey('android:dataExtractionRules')) 'Missing data extraction rules.'
    $debug = $application.Attributes['android:debuggable']
    if ($BuildVariant -eq 'debug') { Require ($debug -match '^(?:true|\(type 0x12\)0xffffffff)$') 'Debug APK must be explicitly debuggable.' }
    else { Require ($null -eq $debug -or (Xml-False $application 'android:debuggable')) 'Release APK must not be debuggable.' }
    $permissions = @($nodes | Where-Object { $_.Name -like 'uses-permission*' } | ForEach-Object { Xml-String $_ 'android:name' })
    $internalPermission = $ExpectedId + '.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
    $platformPermissions = @($permissions | Where-Object { $_ -ne $internalPermission } | Sort-Object -Unique)
    Require (($platformPermissions -join ',') -eq 'android.permission.ACCESS_NETWORK_STATE,android.permission.CAMERA,android.permission.FOREGROUND_SERVICE,android.permission.FOREGROUND_SERVICE_SPECIAL_USE,android.permission.INTERNET') 'Unexpected or missing APK platform permissions.'
    if ($permissions -contains $internalPermission) {
        $declared = @($nodes | Where-Object { $_.Name -eq 'permission' -and (Xml-String $_ 'android:name') -eq $internalPermission })
        Require ($declared.Count -eq 1 -and $declared[0].Attributes['android:protectionLevel'] -match '^(?:0x00000002|\(type 0x11\)0x2)$') 'AndroidX internal receiver permission must be signature-protected.'
    }
    $activities = @($nodes | Where-Object Name -EQ 'activity')
    Require ($activities.Count -eq 2) 'Expected only launcher/payment-link and internal QR activities.'
    $mainActivities = @($activities | Where-Object { (Xml-String $_ 'android:name') -eq ($ExpectedId + '.MainActivity') })
    $scannerActivities = @($activities | Where-Object { (Xml-String $_ 'android:name') -eq ($ExpectedId + '.PaymentQrCaptureActivity') })
    Require ($mainActivities.Count -eq 1 -and $scannerActivities.Count -eq 1) 'Unexpected launcher or scanner activity.'
    $mainActivity = $mainActivities[0]; $scannerActivity = $scannerActivities[0]
    Require (Xml-True $mainActivity 'android:exported') 'The launcher/payment-link activity must be exported.'
    Require (Xml-False $scannerActivity 'android:exported') 'The QR activity must not be exported.'
    Require (@(Xml-Children $nodes $scannerActivity 'intent-filter').Count -eq 0) 'The internal QR scanner must not have intent filters.'
    $filters = @(Xml-Children $nodes $mainActivity 'intent-filter')
    Require ($filters.Count -eq 2) 'MainActivity must have exactly launcher and connectcoin payment filters.'
    $seenActions = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($filter in $filters) {
        Require (@($nodes | Where-Object { [object]::ReferenceEquals($_.Parent, $filter) -and $_.Name -notin @('action', 'category', 'data') }).Count -eq 0) 'Unexpected nested activity URL scope.'
        $actions = @(Xml-Children $nodes $filter 'action')
        Require ($actions.Count -eq 1) 'Each entry point must have exactly one action.'
        $action = Xml-String $actions[0] 'android:name'
        Require ($seenActions.Add($action)) 'Duplicate activity entry point.'
        $categories = @((Xml-Children $nodes $filter 'category') | ForEach-Object { Xml-String $_ 'android:name' } | Sort-Object)
        $data = @(Xml-Children $nodes $filter 'data')
        if ($action -eq 'android.intent.action.MAIN') {
            Require (($categories -join ',') -eq 'android.intent.category.LAUNCHER' -and $data.Count -eq 0) 'Unexpected launcher intent scope.'
        } elseif ($action -eq 'android.intent.action.VIEW') {
            Require (($categories -join ',') -eq 'android.intent.category.BROWSABLE,android.intent.category.DEFAULT') 'Unexpected payment-link categories.'
            Require ($data.Count -eq 1 -and $data[0].Attributes.Count -eq 1 -and (Xml-String $data[0] 'android:scheme') -eq 'connectcoin') 'Only connectcoin payment URLs may open the wallet; no broad URL, host, path or MIME handlers.'
        } else { throw 'Unexpected external activity action.' }
    }
    Require (@($nodes | Where-Object Name -EQ 'data').Count -eq 1) 'Unexpected additional external URL scope.'
    $features = @($nodes | Where-Object Name -EQ 'uses-feature')
    Require ((($features | ForEach-Object { Xml-String $_ 'android:name' } | Sort-Object) -join ',') -eq 'android.hardware.camera,android.hardware.camera.any,android.hardware.camera.autofocus,android.hardware.camera.flash,android.hardware.camera.front,android.hardware.screen.landscape,android.hardware.wifi') 'Unexpected hardware or missing optional pinned-scanner feature declarations.'
    foreach ($feature in $features) { Require (Xml-False $feature 'android:required') 'Camera hardware must remain optional.' }
    Require (@($nodes | Where-Object Name -EQ 'activity-alias').Count -eq 0) 'Unexpected activity alias.'
    $services = @($nodes | Where-Object Name -EQ 'service')
    Require ($services.Count -eq 1) 'Expected exactly the claims service.'
    Require ((Xml-String $services[0] 'android:name') -eq ($ExpectedId + '.ClaimsService') -and (Xml-False $services[0] 'android:exported')) 'Unexpected or exported service.'
    Require ($services[0].Attributes['android:foregroundServiceType'] -match '^(?:0x40000000|\(type 0x11\)0x40000000)$') 'Claims requires the explicit specialUse type.'
    foreach ($node in $nodes) {
        if ($node.Name -eq 'provider') {
            Require ((Xml-String $node 'android:name') -eq 'androidx.startup.InitializationProvider' -and (Xml-False $node 'android:exported')) 'Unexpected or exported provider.'
        }
        if ($node.Name -eq 'receiver') {
            Require ((Xml-String $node 'android:name') -eq 'androidx.profileinstaller.ProfileInstallReceiver' -and (Xml-String $node 'android:permission') -eq 'android.permission.DUMP') 'Unexpected or unprotected receiver.'
        }
        if ($node.Name -eq 'action' -and (Xml-String $node 'android:name') -eq 'android.intent.action.VIEW') {
            Require ($null -ne $node.Parent -and [object]::ReferenceEquals($node.Parent.Parent, $mainActivity)) 'Unexpected external URL handler.'
        }
    }
    return @{ PlatformPermissions = $platformPermissions; InternalSignaturePermission = ($permissions -contains $internalPermission); Application = $application }
}
function Entry-Bytes($Archive, [string]$Name) {
    $entry = $Archive.GetEntry($Name)
    Require ($null -ne $entry) ('Missing APK entry: ' + $Name)
    Require ($entry.Length -le 16777216) ('Oversized APK asset: ' + $Name)
    $stream = $entry.Open(); $buffer = [IO.MemoryStream]::new()
    try { $stream.CopyTo($buffer); return ,$buffer.ToArray() }
    finally { $stream.Dispose(); $buffer.Dispose() }
}
function Pixel-Hash([byte[]]$Bytes) {
    $stream = [IO.MemoryStream]::new($Bytes, $false)
    $image = $null; $bitmap = $null; $graphics = $null; $locked = $null
    try {
        $image = [Drawing.Image]::FromStream($stream)
        Require ($image.Width -le 512 -and $image.Height -le 512) 'Oversized launcher bitmap.'
        $bitmap = [Drawing.Bitmap]::new($image.Width, $image.Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $graphics.DrawImageUnscaled($image, 0, 0)
        $rectangle = [Drawing.Rectangle]::new(0, 0, $bitmap.Width, $bitmap.Height)
        $locked = $bitmap.LockBits($rectangle, [Drawing.Imaging.ImageLockMode]::ReadOnly, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $pixels = [byte[]]::new([Math]::Abs($locked.Stride) * $bitmap.Height)
        [Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $pixels, 0, $pixels.Length)
        return ('{0}x{1}:{2}' -f $bitmap.Width, $bitmap.Height, (Hash-Bytes $pixels))
    } finally {
        if ($locked) { $bitmap.UnlockBits($locked) }
        if ($graphics) { $graphics.Dispose() }; if ($bitmap) { $bitmap.Dispose() }; if ($image) { $image.Dispose() }; $stream.Dispose()
    }
}

if ($SelfTest) {
    $fixture = @'
E: manifest
  E: uses-permission
    A: android:name(0x01010003)="android.permission.INTERNET" (Raw: "android.permission.INTERNET")
  E: uses-permission
    A: android:name(0x01010003)="android.permission.ACCESS_NETWORK_STATE"
  E: uses-permission
    A: android:name(0x01010003)="android.permission.FOREGROUND_SERVICE"
  E: uses-permission
    A: android:name(0x01010003)="android.permission.FOREGROUND_SERVICE_SPECIAL_USE"
  E: uses-permission
    A: android:name(0x01010003)="android.permission.CAMERA"
  E: uses-feature
    A: android:name(0x01010003)="android.hardware.camera"
    A: android:required(0x0101028e)=(type 0x12)0x0
  E: uses-feature
    A: android:name(0x01010003)="android.hardware.camera.any"
    A: android:required(0x0101028e)=(type 0x12)0x0
  E: uses-feature
    A: android:name(0x01010003)="android.hardware.camera.autofocus"
    A: android:required(0x0101028e)=(type 0x12)0x0
  E: uses-feature
    A: android:name(0x01010003)="android.hardware.camera.flash"
    A: android:required(0x0101028e)=(type 0x12)0x0
  E: uses-feature
    A: android:name(0x01010003)="android.hardware.camera.front"
    A: android:required(0x0101028e)=(type 0x12)0x0
  E: uses-feature
    A: android:name(0x01010003)="android.hardware.screen.landscape"
    A: android:required(0x0101028e)=(type 0x12)0x0
  E: uses-feature
    A: android:name(0x01010003)="android.hardware.wifi"
    A: android:required(0x0101028e)=(type 0x12)0x0
  E: application
    A: android:largeHeap(0x0101035a)=(type 0x12)0xffffffff
    A: android:allowBackup(0x01010280)=(type 0x12)0x0
    A: android:fullBackupContent(0x010104eb)=(type 0x12)0x0
    A: android:usesCleartextTraffic(0x010104ec)=(type 0x12)0x0
    A: android:dataExtractionRules(0x0101064e)=@0x7f0b0000
    A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff
    E: activity
      A: android:name(0x01010003)="com.example.wallet.MainActivity"
      A: android:exported(0x01010010)=(type 0x12)0xffffffff
      E: intent-filter
        E: action
          A: android:name(0x01010003)="android.intent.action.MAIN"
        E: category
          A: android:name(0x01010003)="android.intent.category.LAUNCHER"
      E: intent-filter
        E: action
          A: android:name(0x01010003)="android.intent.action.VIEW"
        E: category
          A: android:name(0x01010003)="android.intent.category.DEFAULT"
        E: category
          A: android:name(0x01010003)="android.intent.category.BROWSABLE"
        E: data
          A: android:scheme(0x01010027)="connectcoin"
    E: activity
      A: android:name(0x01010003)="com.example.wallet.PaymentQrCaptureActivity"
      A: android:exported(0x01010010)=(type 0x12)0x0
    E: service
      A: android:name(0x01010003)="com.example.wallet.ClaimsService"
      A: android:exported(0x01010010)=(type 0x12)0x0
      A: android:foregroundServiceType(0x01010599)=0x40000000
'@
    $null = Assert-Manifest $fixture 'com.example.wallet' 'debug'
    $modernFixture = $fixture.Replace('A: android:', 'A: http://schemas.android.com/apk/res/android:').Replace('(type 0x12)0x0', 'false').Replace('(type 0x12)0xffffffff', 'true')
    $null = Assert-Manifest $modernFixture 'com.example.wallet' 'debug'
    $badFixtures = @(
        $fixture.Replace('android.permission.INTERNET', 'android.permission.POST_NOTIFICATIONS'),
        $fixture.Replace('android.permission.CAMERA', 'android.permission.VIBRATE'),
        $fixture.Replace('android:allowBackup(0x01010280)=(type 0x12)0x0', 'android:allowBackup(0x01010280)=(type 0x12)0xffffffff'),
        $fixture.Replace('android:scheme(0x01010027)="connectcoin"', 'android:scheme(0x01010027)="https"'),
        $fixture.Replace('android:scheme(0x01010027)="connectcoin"', 'android:scheme(0x01010027)="*"'),
        $fixture.Replace('android:scheme(0x01010027)="connectcoin"', "android:scheme(0x01010027)=`"connectcoin`"`n          A: android:host(0x01010028)=`"*`""),
        $fixture.Replace('android.intent.category.BROWSABLE', 'android.intent.category.LAUNCHER'),
        $fixture.Replace('android.intent.action.VIEW', 'android.intent.action.SEND'),
        $fixture.Replace('com.example.wallet.PaymentQrCaptureActivity', 'com.journeyapps.barcodescanner.CaptureActivity'),
        $fixture.Replace('android:exported(0x01010010)=(type 0x12)0x0', 'android:exported(0x01010010)=(type 0x12)0xffffffff'),
        $fixture.Replace('android:required(0x0101028e)=(type 0x12)0x0', 'android:required(0x0101028e)=(type 0x12)0xffffffff')
    )
    # Change only the scanner export bit; a service error must not mask this regression.
    $badFixtures += [regex]::Replace($fixture, '(PaymentQrCaptureActivity"\s+A: android:exported\(0x01010010\)=)\(type 0x12\)0x0', '${1}(type 0x12)0xffffffff')
    foreach ($bad in $badFixtures) {
        $rejected = $false
        try { $null = Assert-Manifest $bad 'com.example.wallet' 'debug' } catch { $rejected = $true }
        Require $rejected 'Manifest negative self-test failed.'
    }
    $rejected = $false
    try { $null = Assert-Manifest $fixture 'com.example.wallet' 'release' } catch { $rejected = $true }
    Require $rejected 'Debuggable release negative self-test failed.'
    Write-Host 'APK verifier self-tests passed (manifest parsing and negative security cases).'
    exit 0
}

Require ($SdkRoot -and $JavaHome -and $ApkPath) 'Supply -SdkRoot, -JavaHome and -ApkPath.'
$sdk = (Resolve-Path -LiteralPath $SdkRoot).Path
$jdk = (Resolve-Path -LiteralPath $JavaHome).Path
$apk = (Resolve-Path -LiteralPath $ApkPath).Path
Require ((Get-Item -LiteralPath $apk).Length -le 268435456) 'APK exceeds the bounded verification size.'
$buildTools = Join-Path $sdk 'build-tools/36.0.0'
$aapt2 = Join-Path $buildTools 'aapt2.exe'
$signer = Join-Path $buildTools 'lib/apksigner.jar'
$javaExe = Join-Path $jdk 'bin/java.exe'
foreach ($file in @($aapt2, $signer, $javaExe)) { Require (Test-Path -LiteralPath $file -PathType Leaf) ('Missing required existing tool: ' + $file) }
Require ((Get-Content -LiteralPath (Join-Path $buildTools 'source.properties') -Raw) -match '(?m)^Pkg.Revision\s*=\s*36\.0\.0\s*$') 'SDK Build Tools must be exactly 36.0.0.'
$package = Get-Content -LiteralPath (Join-Path $mobileRoot 'package.json') -Raw | ConvertFrom-Json
$config = Get-Content -LiteralPath (Join-Path $mobileRoot 'capacitor.config.json') -Raw | ConvertFrom-Json
$gradle = Get-Content -LiteralPath (Join-Path $mobileRoot 'android/app/build.gradle') -Raw
$variables = Get-Content -LiteralPath (Join-Path $mobileRoot 'android/variables.gradle') -Raw
Require ($gradle -match 'versionCode\s+(\d+)') 'Cannot derive versionCode.'; $versionCode = $Matches[1]
Require ($gradle -match 'versionName\s+"([^"]+)"') 'Cannot derive versionName.'; $versionName = $Matches[1]
Require ($versionName -eq $package.version) 'Native and mobile package versions differ.'
Require ($variables -match 'minSdkVersion\s*=\s*(\d+)') 'Cannot derive minSdk.'; $minSdk = $Matches[1]
Require ($variables -match 'targetSdkVersion\s*=\s*(\d+)') 'Cannot derive targetSdk.'; $targetSdk = $Matches[1]
$badging = (Run-Tool $aapt2 @('dump', 'badging', $apk)).Text
Require ($badging -match ("(?m)^package: name='" + [regex]::Escape($config.appId) + "' versionCode='" + $versionCode + "' versionName='" + [regex]::Escape($versionName) + "'")) 'APK identity/version does not match current sources.'
Require ($badging -match ("(?m)^minSdkVersion:'" + $minSdk + "'")) 'APK minSdk differs.'
Require ($badging -match ("(?m)^targetSdkVersion:'" + $targetSdk + "'")) 'APK targetSdk differs.'
Require ($badging -match ("(?m)^application-label:'" + [regex]::Escape($config.appName) + "'")) 'APK English application label differs.'
Require ($badging -match ("(?m)^launchable-activity: name='" + [regex]::Escape($config.appId + '.MainActivity') + "'\s+label='" + [regex]::Escape($config.appName) + "'")) 'APK launcher label differs.'
Require ($badging -match '(?m)^locales:(.*)$') 'Missing APK locales.'
$locales = @([regex]::Matches($Matches[1], "'([^']*)'") | ForEach-Object { $_.Groups[1].Value })
Require (@($locales | Where-Object { $_ -notmatch '^(?:|--_--|en(?:[-_].*)?)$' }).Count -eq 0) 'Unexpected non-English packaged locale.'
$manifestText = (Run-Tool $aapt2 @('dump', 'xmltree', $apk, '--file', 'AndroidManifest.xml')).Text
$manifestResult = Assert-Manifest $manifestText $config.appId $Variant
$resources = Resource-Table (Run-Tool $aapt2 @('dump', 'resources', $apk)).Text
foreach ($pair in @(@('android:icon', 'mipmap/ic_launcher'), @('android:roundIcon', 'mipmap/ic_launcher_round'), @('android:dataExtractionRules', 'xml/data_extraction_rules'))) {
    Require ($resources.ContainsKey($pair[1]) -and $manifestResult.Application.Attributes[$pair[0]] -eq ('@' + $resources[$pair[1]].Id)) ('Manifest references the wrong compiled resource: ' + $pair[0])
}
$backupResource = Resource-File $resources 'xml/data_extraction_rules' ''
$backupNodes = @(XmlTree-Nodes (Run-Tool $aapt2 @('dump', 'xmltree', $apk, '--file', $backupResource)).Text)
$expectedDomains = @('root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref') | Sort-Object
foreach ($backupKind in @('cloud-backup', 'device-transfer')) {
    Require (@($backupNodes | Where-Object Name -EQ $backupKind).Count -eq 1) ('Missing compiled backup section: ' + $backupKind)
    $exclusions = @($backupNodes | Where-Object { $_.Name -eq 'exclude' -and $_.Parent.Name -eq $backupKind })
    $domains = @($exclusions | ForEach-Object { Require ((Xml-String $_ 'path') -eq '.') 'Incomplete compiled backup exclusion.'; Xml-String $_ 'domain' }) | Sort-Object
    Require (($domains -join ',') -eq ($expectedDomains -join ',')) ('Incomplete compiled backup exclusions: ' + $backupKind)
}
Require (@($backupNodes | Where-Object Name -EQ 'include').Count -eq 0) 'Unexpected compiled backup inclusion.'
$signature = Run-Tool $javaExe @('-jar', $signer, 'verify', '--verbose', '--print-certs', $apk) -AllowFailure
if ($Variant -eq 'debug') {
    Require ($signature.ExitCode -eq 0) 'Debug APK signature verification failed.'
    Require ($signature.Text -match 'Signer #1 certificate DN:.*CN=Android Debug') 'Expected the local Android debug signing certificate.'
} else { Require ($signature.ExitCode -ne 0) 'Release signing was not requested; refuse to label a signed release as an unsigned artifact.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Drawing
$archive = [IO.Compression.ZipFile]::OpenRead($apk)
$assetCount = 0; $iconCount = 0
try {
    $names = @($archive.Entries | ForEach-Object FullName)
    $uniqueNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $names) { Require ($uniqueNames.Add($name)) ('Duplicate ZIP entry in APK: ' + $name) }
    Require ($names -contains 'classes.dex') 'No Android bytecode in APK.'
    if ($Variant -eq 'release') {
        Require (@($names | Where-Object { $_ -match '^META-INF/.*\.(SF|RSA|DSA|EC)$' }).Count -eq 0) 'Release APK unexpectedly contains JAR signatures.'
        $apkBytes = [IO.File]::ReadAllBytes($apk)
        $eocd = -1
        for ($i = $apkBytes.Length - 22; $i -ge [Math]::Max(0, $apkBytes.Length - 65557); $i--) {
            if ([BitConverter]::ToUInt32($apkBytes, $i) -eq 0x06054b50 -and $i + 22 + [BitConverter]::ToUInt16($apkBytes, $i + 20) -eq $apkBytes.Length) { $eocd = $i; break }
        }
        Require ($eocd -ge 0) 'Cannot inspect release ZIP signing state.'
        $centralDirectory = [BitConverter]::ToUInt32($apkBytes, $eocd + 16)
        Require ($centralDirectory -le $eocd) 'Invalid release central directory.'
        if ($centralDirectory -ge 16) { Require ([Text.Encoding]::ASCII.GetString($apkBytes, $centralDirectory - 16, 16) -ne 'APK Sig Block 42') 'Release APK unexpectedly contains an APK signing block.' }
    }
    $bundledConfig = [Text.Encoding]::UTF8.GetString((Entry-Bytes $archive 'assets/capacitor.config.json')) | ConvertFrom-Json
    Require ($bundledConfig.appId -eq $config.appId -and $bundledConfig.appName -eq $config.appName -and $bundledConfig.android.webContentsDebuggingEnabled -eq $false -and $bundledConfig.android.allowMixedContent -eq $false) 'Bundled Capacitor identity/name/debugging policy differs.'
    Require ($bundledConfig.android.minWebViewVersion -eq $config.android.minWebViewVersion -and $bundledConfig.server.androidScheme -eq 'https' -and $bundledConfig.server.errorPath -eq $config.server.errorPath -and !$bundledConfig.server.url -and !$bundledConfig.server.allowNavigation) 'Bundled WebView policy differs.'
    foreach ($density in @('mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi')) {
        foreach ($icon in @('ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground')) {
            # Release resource paths are shortened by AAPT2; resolve their table IDs.
            $iconEntry = Resource-File $resources ('mipmap/' + $icon) $density
            $source = Join-Path $mobileRoot ('android/app/src/main/res/mipmap-' + $density + '/' + $icon + '.png')
            Require ((Pixel-Hash (Entry-Bytes $archive $iconEntry)) -eq (Pixel-Hash ([IO.File]::ReadAllBytes($source)))) ('APK launcher artwork differs: ' + $icon)
            $iconCount++
        }
    }
    foreach ($icon in @('ic_launcher', 'ic_launcher_round')) {
        $resource = Resource-File $resources ('mipmap/' + $icon) 'anydpi-v26'
        $tree = (Run-Tool $aapt2 @('dump', 'xmltree', $apk, '--file', $resource)).Text
        $iconNodes = @(XmlTree-Nodes $tree)
        Require (@($iconNodes | Where-Object Name -EQ 'adaptive-icon').Count -eq 1) 'Invalid adaptive icon.'
        foreach ($pair in @(@('background', 'color/ic_launcher_background'), @('foreground', 'mipmap/ic_launcher_foreground'))) {
            $layer = @($iconNodes | Where-Object Name -EQ $pair[0])
            Require ($layer.Count -eq 1 -and $resources.ContainsKey($pair[1]) -and $layer[0].Attributes['android:drawable'] -eq ('@' + $resources[$pair[1]].Id)) ('Adaptive icon layer differs: ' + $pair[0])
        }
    }
    $webDirectory = (Resolve-Path -LiteralPath (Join-Path $mobileRoot $config.webDir)).Path
    $expectedAssets = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($file in (Get-ChildItem -LiteralPath $webDirectory -Recurse -File)) {
        $relative = $file.FullName.Substring($webDirectory.Length + 1).Replace('\', '/')
        $assetName = 'assets/public/' + $relative
        $null = $expectedAssets.Add($assetName)
        Require ((Hash-Bytes (Entry-Bytes $archive $assetName)) -eq (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()) ('Stale or changed bundled web asset: ' + $relative)
        $assetCount++
    }
    # Capacitor CLI 8 generates these empty compatibility files when there are no
    # Cordova plugins. Do not permit an old JS bundle to survive a later sync.
    foreach ($stub in @('assets/public/cordova.js', 'assets/public/cordova_plugins.js')) {
        Require (!$expectedAssets.Contains($stub)) 'Unexpected Cordova file in the application web directory.'
        Require ((Entry-Bytes $archive $stub).Length -eq 0) ('Unexpected nonempty Capacitor compatibility stub: ' + $stub)
        $null = $expectedAssets.Add($stub)
    }
    foreach ($name in $names) {
        if ($name.StartsWith('assets/public/', [StringComparison]::Ordinal) -and !$name.EndsWith('/')) {
            Require ($expectedAssets.Contains($name)) ('Unexpected or stale extra bundled web asset: ' + $name)
        }
    }
    Require ($assetCount -ge 4 -and $uniqueNames.Contains('assets/public/index.html') -and $uniqueNames.Contains('assets/public/unsupported-webview.html')) 'Incomplete bundled UI/fallback.'
} finally { $archive.Dispose() }
$sha256 = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
if (!$ReportPath) { $ReportPath = Join-Path $mobileRoot ('.tools/android-build-reports/verified-' + [Guid]::NewGuid().ToString('N') + '.json') }
$reportFile = [IO.Path]::GetFullPath($ReportPath)
$allowedRoots = @((Join-Path $mobileRoot '.tools'), (Join-Path $mobileRoot 'dist'))
Require (@($allowedRoots | Where-Object { $reportFile.StartsWith($_ + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) }).Count -eq 1) 'Write reports only inside ignored mobile/.tools or mobile/dist.'
Require (!(Test-Path -LiteralPath $reportFile)) 'Use a new report filename; old validation reports are not overwritten.'
$report = [ordered]@{ verifiedAtUtc = [DateTime]::UtcNow.ToString('o'); status = 'verified'; variant = $Variant; apk = $apk; sha256 = $sha256
    appId = $config.appId; appName = $config.appName; versionName = $versionName; versionCode = [int]$versionCode; minSdk = [int]$minSdk; targetSdk = [int]$targetSdk
    platformPermissions = $manifestResult.PlatformPermissions; internalSignaturePermission = $manifestResult.InternalSignaturePermission; locales = $locales
    verifiedWebAssets = $assetCount; verifiedLauncherBitmaps = $iconCount; signatureVerified = ($Variant -eq 'debug'); installableTestArtifact = ($Variant -eq 'debug')
    distribution = $(if ($Variant -eq 'debug') { 'Debug-signed APK.' } else { 'Unsigned release APK; signing is required for installation.' })
    checks = @('Compiled manifest, permissions, backup policy, package identity, version, signing state, launcher icons and bundled web assets.') }
New-Item -ItemType Directory -Path (Split-Path -Parent $reportFile) -Force | Out-Null
[IO.File]::WriteAllText($reportFile, ($report | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
Write-Host ('Verified {0} APK: {1}' -f $Variant, $apk)
Write-Host ('SHA-256: ' + $sha256)
Write-Host $report.distribution
Write-Host ('Report: ' + $reportFile)
exit 0
