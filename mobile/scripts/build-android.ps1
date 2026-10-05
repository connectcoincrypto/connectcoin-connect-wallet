[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SdkRoot,
    [Parameter(Mandatory = $true)][string]$JavaHome,
    [ValidateSet(':app:testDebugUnitTest', ':app:assembleDebug', ':app:assembleRelease', ':app:assembleDebugAndroidTest', ':app:lintDebug', ':app:lintRelease')]
    [string[]]$Tasks = @(':app:testDebugUnitTest', ':app:assembleDebug', ':app:assembleRelease', ':app:assembleDebugAndroidTest', ':app:lintDebug', ':app:lintRelease')
)
# Uses only an existing toolchain. No SDK installation, license acceptance,
# emulator/device actions, system settings, signing credentials or CI changes.
$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot
$androidRoot = Join-Path $mobileRoot 'android'
$sdk = (Resolve-Path -LiteralPath $SdkRoot).Path
$jdk = (Resolve-Path -LiteralPath $JavaHome).Path
foreach ($file in @(
    (Join-Path $jdk 'bin/java.exe'), (Join-Path $jdk 'bin/javac.exe'),
    (Join-Path $sdk 'platforms/android-36/android.jar'),
    (Join-Path $sdk 'build-tools/35.0.0/aapt2.exe'),
    (Join-Path $sdk 'build-tools/36.0.0/aapt2.exe'),
    (Join-Path $sdk 'build-tools/36.0.0/lib/apksigner.jar')
)) { if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw ('Required existing toolchain file is missing: ' + $file) } }
# AGP 8.13 defaults to Build Tools 35.0.0; APK inspection deliberately uses 36.0.0.
foreach ($revision in @('35.0.0', '36.0.0')) {
    $sdkMetadata = Get-Content -LiteralPath (Join-Path $sdk ('build-tools/' + $revision + '/source.properties')) -Raw
    if ($sdkMetadata -notmatch ('(?m)^Pkg.Revision\s*=\s*' + [regex]::Escape($revision) + '\s*$')) { throw ('Unexpected SDK Build Tools metadata: ' + $revision) }
}
$releaseMetadata = Get-Content -LiteralPath (Join-Path $jdk 'release') -Raw
if ($releaseMetadata -notmatch '(?m)^JAVA_VERSION="21\.') { throw 'Use the existing JDK 21 toolchain.' }
if (!$Tasks.Count) { throw 'Select at least one supported Gradle task.' }
$npm = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24+ is required.' }

# Do not silently compile against an unrelated SDK recorded by an IDE.
$localProperties = Join-Path $androidRoot 'local.properties'
if (Test-Path -LiteralPath $localProperties) {
    $propertiesText = Get-Content -LiteralPath $localProperties -Raw
    if ($propertiesText -match '(?m)^\s*sdk\.dir\s*=\s*(.+?)\s*$') {
        $configuredSdk = $Matches[1].Replace('\:', ':').Replace('\\', '\')
        if (![IO.Path]::GetFullPath($configuredSdk).TrimEnd('\', '/').Equals($sdk.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'android/local.properties points to another SDK. Reconcile it explicitly before building; this script will not overwrite it.'
        }
    }
}

$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$reportDirectory = Join-Path $mobileRoot ('.tools/android-build-reports/' + $runId)
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
$environmentNames = @('JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_USER_HOME', 'GRADLE_USER_HOME', 'PATH')
$savedEnvironment = @{}
foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$previousDirectory = Get-Location
$started = [DateTime]::UtcNow
$completedTasks = $false
$verified = [Collections.Generic.List[object]]::new()
function Run-Checked([string]$Program, [string[]]$Arguments, [string]$LogName) {
    $ErrorActionPreference = 'Continue'
    & $Program @Arguments 2>&1 | Tee-Object -FilePath (Join-Path $reportDirectory $LogName) | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw ('Build step failed with exit code {0}. See {1}. No APK from this run is verified.' -f $LASTEXITCODE, $LogName) }
}
try {
    $androidUser = Join-Path $mobileRoot '.tools/android-user'
    $gradleUser = Join-Path $mobileRoot '.tools/gradle-user-home'
    New-Item -ItemType Directory -Path $androidUser, $gradleUser -Force | Out-Null
    [Environment]::SetEnvironmentVariable('JAVA_HOME', $jdk, 'Process')
    [Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdk, 'Process')
    [Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', $sdk, 'Process')
    [Environment]::SetEnvironmentVariable('ANDROID_USER_HOME', $androidUser, 'Process')
    [Environment]::SetEnvironmentVariable('GRADLE_USER_HOME', $gradleUser, 'Process')
    [Environment]::SetEnvironmentVariable('PATH', ((Join-Path $jdk 'bin') + [IO.Path]::PathSeparator + $savedEnvironment['PATH']), 'Process')
    Set-Location -LiteralPath $mobileRoot
    Run-Checked $npm @('run', 'sync:android') 'sync.log'
    Run-Checked $npm @('run', 'check:android') 'static-check.log'
    Set-Location -LiteralPath $androidRoot
    # Gradle may retrieve its pinned distribution/Maven dependencies normally.
    # Missing SDK components are NOT downloaded or installed by this script.
    $gradleArguments = @('--no-daemon', '--max-workers=2', '--console=plain', '-Dorg.gradle.jvmargs=-Xmx1536m', '-Pandroid.builder.sdkDownload=false') + $Tasks
    Run-Checked (Join-Path $androidRoot 'gradlew.bat') $gradleArguments 'gradle.log'
    $completedTasks = $true
    Set-Location -LiteralPath $mobileRoot
    foreach ($variant in @('debug', 'release')) {
        $task = if ($variant -eq 'debug') { ':app:assembleDebug' } else { ':app:assembleRelease' }
        if ($Tasks -notcontains $task) { continue }
        $filename = if ($variant -eq 'debug') { 'app-debug.apk' } else { 'app-release-unsigned.apk' }
        $apk = Join-Path $androidRoot ('app/build/outputs/apk/' + $variant + '/' + $filename)
        $report = Join-Path $reportDirectory ($variant + '.json')
        & (Join-Path $PSScriptRoot 'verify-apk.ps1') -SdkRoot $sdk -JavaHome $jdk -ApkPath $apk -Variant $variant -ReportPath $report
        if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $report -PathType Leaf)) { throw ('APK verification failed: ' + $variant) }
        $verified.Add((Get-Content -LiteralPath $report -Raw | ConvertFrom-Json))
    }
    $summary = [ordered]@{ status = 'verified'; startedAtUtc = $started.ToString('o'); completedAtUtc = [DateTime]::UtcNow.ToString('o')
        tasks = $Tasks; toolchain = @{ sdk = $sdk; jdk = $jdk; gradleWorkers = 2; gradleHeapMiB = 1536 }
        artifacts = $verified.ToArray(); note = 'No app/device/emulator was launched. Unsigned release APKs are not installable.' }
    [IO.File]::WriteAllText((Join-Path $reportDirectory 'build.json'), ($summary | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    Write-Host ('Build and requested artifact checks completed. Reports: ' + $reportDirectory)
} catch {
    # Do not inspect or offer pre-existing output APKs after any build failure.
    $failure = [ordered]@{ status = 'failed'; startedAtUtc = $started.ToString('o'); failedAtUtc = [DateTime]::UtcNow.ToString('o')
        gradleTasksCompleted = $completedTasks; tasks = $Tasks; message = $_.Exception.Message
        note = 'This run did not complete all requested checks. Existing output APKs must not be treated as newly verified.' }
    [IO.File]::WriteAllText((Join-Path $reportDirectory 'failed.json'), ($failure | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    throw
} finally {
    foreach ($name in $environmentNames) {
        # PowerShell binds $null to an empty string for this overload. On recent
        # .NET that leaves an empty environment variable instead of removing it.
        $originalValue = if ($null -eq $savedEnvironment[$name]) { [System.Management.Automation.Language.NullString]::Value } else { $savedEnvironment[$name] }
        [Environment]::SetEnvironmentVariable($name, $originalValue, 'Process')
    }
    Set-Location -LiteralPath $previousDirectory.Path
}
