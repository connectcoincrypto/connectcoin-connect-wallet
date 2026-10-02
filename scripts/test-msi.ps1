[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Msi([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ConnectWallet MSI verification failed: $Message" }
}

function Release-Com($Object) {
    if ($null -ne $Object -and [System.Runtime.InteropServices.Marshal]::IsComObject($Object)) {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Object)
    }
}

function Read-MsiRows([string]$Query, [string[]]$Columns, [int]$StreamColumn = 0) {
    $view = $null
    try {
        $view = $script:database.OpenView($Query)
        [void]$view.Execute()
        while ($null -ne ($record = $view.Fetch())) {
            try {
                $row = @{}
                for ($index = 0; $index -lt $Columns.Length; $index++) {
                    $row[$Columns[$index]] = $record.StringData($index + 1)
                }
                if ($StreamColumn -gt 0) { $row['StreamBytes'] = $record.DataSize($StreamColumn) }
                Write-Output $row
            } finally { Release-Com $record }
        }
    } finally {
        if ($null -ne $view) { [void]$view.Close(); Release-Com $view }
    }
}

$installer = $null
$script:database = $null
$summary = $null
try {
    $file = Get-Item -LiteralPath $Path
    Assert-Msi ($file -is [System.IO.FileInfo] -and $file.Extension -ieq '.msi') 'Path must identify one existing .msi file.'
    $installer = New-Object -ComObject WindowsInstaller.Installer
    # msiOpenDatabaseModeReadOnly = 0. This script never invokes InstallProduct,
    # msiexec, administrative extraction, or any installer actions.
    $script:database = $installer.OpenDatabase($file.FullName, 0)
    $properties = @{}
    foreach ($row in @(Read-MsiRows 'SELECT `Property`, `Value` FROM `Property`' @('Name', 'Value'))) {
        $properties[$row.Name] = $row.Value
    }
    Assert-Msi ($properties['ProductName'] -ceq 'ConnectWallet') 'ProductName must be ConnectWallet.'
    Assert-Msi ($properties['ProductLanguage'] -eq '1033') 'ProductLanguage must be English (1033).'
    $summary = $script:database.SummaryInformation(0)
    $summaryTemplate = [string]$summary.Property(7)
    Assert-Msi ($summaryTemplate -match '^[^;]+;1033$') 'MSI summary must declare only English (1033).'

    $conditions = @(Read-MsiRows 'SELECT `Condition`, `Description` FROM `LaunchCondition`' @('Condition', 'Description'))
    $windows = @($conditions | Where-Object { $_.Condition -ceq 'Installed OR (CONNECTWALLET_WINDOWS_BUILD >= 10240)' })
    Assert-Msi ($windows.Count -eq 1) 'Windows 10 build 10240 minimum launch condition is missing.'
    Assert-Msi ($windows[0].Description -ceq 'Windows 10 or later is required to install ConnectWallet.') 'Windows launch message must be English.'
    Assert-Msi (@($conditions | Where-Object { $_.Description -match 'Windows 7|Windows 8' -or $_.Condition -match '\bVersionNT\s*[><=]' }).Count -eq 0) 'A stale Windows launch condition is present.'
    $searches = @(Read-MsiRows 'SELECT `Property`, `Signature_` FROM `AppSearch`' @('Property', 'Signature'))
    Assert-Msi (@($searches | Where-Object { $_.Property -ceq 'CONNECTWALLET_WINDOWS_BUILD' -and $_.Signature -ceq 'ConnectWalletWindowsBuildSearch' }).Count -eq 1) 'Windows build AppSearch is missing.'
    $registry = @(Read-MsiRows 'SELECT `Signature_`, `Root`, `Key`, `Name`, `Type` FROM `RegLocator`' @('Signature', 'Root', 'Key', 'Name', 'Type'))
    Assert-Msi (@($registry | Where-Object {
        $_.Signature -ceq 'ConnectWalletWindowsBuildSearch' -and $_.Root -eq '2' -and
        $_.Key -ceq 'SOFTWARE\Microsoft\Windows NT\CurrentVersion' -and
        $_.Name -ceq 'CurrentBuildNumber' -and $_.Type -eq '18'
    }).Count -eq 1) 'Windows build search must read the 64-bit HKLM CurrentBuildNumber value.'

    $icons = @(Read-MsiRows 'SELECT `Name`, `Data` FROM `Icon`' @('Name') 2)
    $iconName = $properties['ARPPRODUCTICON']
    $icon = @($icons | Where-Object { $_.Name -ceq $iconName })
    Assert-Msi ($iconName -ceq 'ConnectWalletIcon.exe' -and $icon.Count -eq 1 -and $icon[0].StreamBytes -gt 0) 'ARPPRODUCTICON must refer to the nonempty ConnectWallet icon binary.'

    $files = @(Read-MsiRows 'SELECT `File`, `Component_`, `FileName`, `FileSize` FROM `File`' @('Id', 'Component', 'Name', 'Size'))
    $main = @($files | Where-Object { $_.Id -ceq 'mainExecutable' -and ($_.Name -split '\|')[-1] -ceq 'ConnectWallet.exe' })
    $helper = @($files | Where-Object { ($_.Name -split '\|')[-1] -ceq 'connectwallet-claims.exe' })
    Assert-Msi ($main.Count -eq 1 -and [long]$main[0].Size -gt 0) 'Packaged mainExecutable is missing or empty.'
    Assert-Msi ($helper.Count -eq 1 -and [long]$helper[0].Size -gt 0) 'Packaged native claims helper is missing or empty.'
    $shortcuts = @(Read-MsiRows 'SELECT `Shortcut`, `Directory_`, `Name`, `Component_`, `Target`, `Icon_`, `WkDir` FROM `Shortcut`' @('Id', 'Directory', 'Name', 'Component', 'Target', 'Icon', 'WorkingDirectory'))
    Assert-Msi ($shortcuts.Count -eq 2) 'Expected two application shortcuts.'
    $shortcutProperties = @(Read-MsiRows 'SELECT `Shortcut_`, `PropertyKey`, `PropVariantValue` FROM `MsiShortcutProperty`' @('Shortcut', 'Key', 'Value'))
    foreach ($id in @('desktopShortcut', 'startMenuShortcut')) {
        $shortcut = @($shortcuts | Where-Object { $_.Id -ceq $id })
        Assert-Msi ($shortcut.Count -eq 1) "Missing $id."
        $expectedDirectory = if ($id -ceq 'desktopShortcut') { 'DesktopFolder' } else { 'ProgramMenuFolder' }
        Assert-Msi ($shortcut[0].Icon -ceq $iconName -and ($shortcut[0].Name -split '\|')[-1] -ceq 'ConnectWallet' -and
            $shortcut[0].Directory -ceq $expectedDirectory -and $shortcut[0].Component -ceq $main[0].Component -and
            $shortcut[0].Target -ceq 'ProductFeature' -and $shortcut[0].WorkingDirectory -ceq 'APPLICATIONFOLDER') "$id must point to ConnectWallet and use its icon."
        Assert-Msi (@($shortcutProperties | Where-Object {
            $_.Shortcut -ceq $id -and $_.Key -ceq 'System.AppUserModel.ID' -and $_.Value -ceq 'com.connectcoincrypto.connectwallet'
        }).Count -eq 1) "$id must carry the ConnectWallet AppUserModel.ID."
    }

    $controls = @(Read-MsiRows 'SELECT `Dialog_`, `Control`, `Text` FROM `Control`' @('Dialog', 'Id', 'Text'))
    Assert-Msi (@($controls | Where-Object { $_.Dialog -ceq 'WelcomeDlg' -and $_.Id -ceq 'Title' -and $_.Text -cmatch '\bWelcome\b' }).Count -eq 1) 'Welcome dialog must be English.'
    Assert-Msi (@($controls | Where-Object { $_.Dialog -ceq 'WelcomeDlg' -and $_.Id -ceq 'Next' -and $_.Text -cmatch 'N&?ext' }).Count -eq 1) 'Next button must be English.'
    Assert-Msi (@($controls | Where-Object { $_.Dialog -ceq 'WelcomeDlg' -and $_.Id -ceq 'Cancel' -and $_.Text -cmatch 'Cancel' }).Count -eq 1) 'Cancel button must be English.'

    [ordered]@{
        ok = $true
        path = $file.FullName
        product = $properties['ProductName']
        language = [int]$properties['ProductLanguage']
        minimumWindowsBuild = 10240
        iconBytes = $icon[0].StreamBytes
        shortcuts = $shortcuts.Count
        files = $files.Count
        helper = 'connectwallet-claims.exe'
        databaseMode = 'read-only'
    } | ConvertTo-Json -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    [Console]::Error.WriteLine($_.ScriptStackTrace)
    exit 1
} finally {
    Release-Com $summary
    Release-Com $script:database
    Release-Com $installer
}
