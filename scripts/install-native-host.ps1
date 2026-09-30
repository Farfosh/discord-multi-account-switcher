[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$HostName = 'com.local.discord_multi_account'
$ExtensionId = 'ofnblgcbllibhicnkjhogibgpjmnpncf'
$ExpectedHostHash = 'E429C36D3CBCF04C00FD9D502B61A6B67221CA98F83BBAE798319E6EAE8C24B7'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProjectFile = Join-Path $ProjectRoot 'native-host\DiscordMultiAccountHost.csproj'
$PrebuiltExecutable = Join-Path $ProjectRoot 'artifacts\native-host\DiscordMultiAccountHost.exe'
$InstallRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'DiscordMultiAccount'))
$HostDirectory = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'NativeHost'))
$HostExecutable = Join-Path $HostDirectory 'DiscordMultiAccountHost.exe'
$ManifestPath = Join-Path $InstallRoot ($HostName + '.json')
$RegistryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $HostName
$StageDirectory = [IO.Path]::GetFullPath((Join-Path $InstallRoot ('NativeHost.stage-' + [Guid]::NewGuid().ToString('N'))))
$BackupDirectory = [IO.Path]::GetFullPath((Join-Path $InstallRoot ('NativeHost.backup-' + [Guid]::NewGuid().ToString('N'))))
$RootWithSeparator = $InstallRoot.TrimEnd('\') + '\'

foreach ($candidate in @($HostDirectory, $StageDirectory, $BackupDirectory)) {
    if (-not ($candidate + '\').StartsWith($RootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to install outside the expected LOCALAPPDATA folder.'
    }
}

Write-Host 'Installing the safe Discord profile helper...' -ForegroundColor Cyan
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path $StageDirectory -Force | Out-Null

try {
    $StagedExecutable = Join-Path $StageDirectory 'DiscordMultiAccountHost.exe'

    if (Test-Path -LiteralPath $PrebuiltExecutable) {
        $ActualHash = (Get-FileHash -LiteralPath $PrebuiltExecutable -Algorithm SHA256).Hash
        if (-not [string]::Equals($ActualHash, $ExpectedHostHash, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Prebuilt helper integrity check failed.'
        }
        Copy-Item -LiteralPath $PrebuiltExecutable -Destination $StagedExecutable -Force
    }
    else {
        $DotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
        if (-not $DotnetCommand) {
            throw 'The prebuilt helper was not found, and the .NET SDK is not installed, so it cannot be built.'
        }

        $InstalledSdks = & dotnet --list-sdks
        if (-not ($InstalledSdks -match '^(8|9|10)\.')) {
            throw 'The prebuilt helper was not found, and the .NET 8+ SDK is not installed, so it cannot be built.'
        }

        & dotnet publish $ProjectFile `
            --configuration Release `
            --framework net8.0-windows `
            --runtime win-x64 `
            --self-contained true `
            --output $StageDirectory

        if ($LASTEXITCODE -ne 0) {
            throw 'Native helper build failed.'
        }
    }

    if (-not (Test-Path -LiteralPath $StagedExecutable)) {
        throw 'Native helper executable is missing.'
    }

    $StartupProcess = Start-Process `
        -FilePath $StagedExecutable `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    if ($StartupProcess.ExitCode -ne 2) {
        throw 'Native helper startup check failed.'
    }

    if (Test-Path -LiteralPath $HostDirectory) {
        Move-Item -LiteralPath $HostDirectory -Destination $BackupDirectory
    }

    try {
        Move-Item -LiteralPath $StageDirectory -Destination $HostDirectory
    }
    catch {
        if (Test-Path -LiteralPath $BackupDirectory) {
            Move-Item -LiteralPath $BackupDirectory -Destination $HostDirectory
        }
        throw
    }

    if (Test-Path -LiteralPath $BackupDirectory) {
        Remove-Item -LiteralPath $BackupDirectory -Recurse -Force
    }
}
finally {
    if (Test-Path -LiteralPath $StageDirectory) {
        Remove-Item -LiteralPath $StageDirectory -Recurse -Force
    }
}

$NativeManifest = [ordered]@{
    name = $HostName
    description = 'Launches fixed, isolated Chrome profiles for Discord without handling tokens.'
    path = $HostExecutable
    type = 'stdio'
    allowed_origins = @('chrome-extension://' + $ExtensionId + '/')
}

$ManifestJson = $NativeManifest | ConvertTo-Json -Depth 4
$Utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($ManifestPath, $ManifestJson, $Utf8WithoutBom)

New-Item -Path $RegistryPath -Force | Out-Null
Set-Item -Path $RegistryPath -Value $ManifestPath

Write-Host ''
Write-Host 'Installed successfully.' -ForegroundColor Green
Write-Host ('Extension ID: ' + $ExtensionId)
Write-Host 'Reload Chrome, open the extension, then click Check again.'
