param(
    [Parameter(Mandatory = $true)][string]$JavaHome,
    [Parameter(Mandatory = $true)][string]$DependencyDirectory
)
$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $JavaHome 'bin/javac.exe'
$runtime = Join-Path $JavaHome 'bin/java.exe'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf) -or !(Test-Path -LiteralPath $runtime -PathType Leaf)) {
    throw 'Pass an existing JDK 21+ directory. This script does not install or change a system toolchain.'
}
# Exact Maven Central artifacts; downloaded checksums were independently compared
# with their published Central SHA-1 files before these SHA-256 pins were recorded.
$dependencies = @(
    @{ Name = 'junit-4.13.2.jar'; Hash = '8E495B634469D64FB8ACFA3495A065CBACC8A0FFF55CE1E31007BE4C16DC57D3' },
    @{ Name = 'hamcrest-core-1.3.jar'; Hash = '66FDEF91E9739348DF7A096AA384A5685F4E875584CCE89386A7A47251C4D8E9' },
    @{ Name = 'json-20250517.jar'; Hash = '3EA61B2A06E31EDF1C91134FE9106B0EBB16628BE169F3DB75BC7A2B06B45796' }
)
$jars = foreach ($dependency in $dependencies) {
    $file = Join-Path $DependencyDirectory $dependency.Name
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $dependency.Hash) {
        throw ('Dependency checksum mismatch: ' + $dependency.Name)
    }
    (Resolve-Path -LiteralPath $file).Path
}
$outputDirectory = Join-Path $mobileRoot '.tools/rpc-test-classes'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$packagePath = 'com/connectcoincrypto/connectwallet/mobile/alpha'
$production = Join-Path $mobileRoot ('android/app/src/main/java/' + $packagePath + '/RpcTransport.java')
$tests = Join-Path $mobileRoot ('android/app/src/test/java/' + $packagePath + '/RpcTransportTest.java')
$classPath = $jars -join [IO.Path]::PathSeparator
& $compiler -Xlint:all -Werror -encoding UTF-8 -cp $classPath -d $outputDirectory $production $tests
if ($LASTEXITCODE -ne 0) { throw 'Native RPC test compilation failed.' }
& $runtime -cp ($outputDirectory + [IO.Path]::PathSeparator + $classPath) org.junit.runner.JUnitCore com.connectcoincrypto.connectwallet.mobile.alpha.RpcTransportTest
if ($LASTEXITCODE -ne 0) { throw 'Native RPC tests failed.' }
# Loopback only. Passing these tests does not certify APK/plugin/Android lifecycle behavior.
