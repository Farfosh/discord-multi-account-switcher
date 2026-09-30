[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$HostName = 'com.local.discord_multi_account'
$InstallRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'DiscordMultiAccount'))
$ExpectedParent = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
$RegistryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $HostName

if (-not $InstallRoot.StartsWith($ExpectedParent, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to remove a path outside LOCALAPPDATA.'
}

if (Test-Path -LiteralPath $InstallRoot) {
    $HostDirectory = Join-Path $InstallRoot 'NativeHost'
    $ManifestPath = Join-Path $InstallRoot ($HostName + '.json')

    if (Test-Path -LiteralPath $HostDirectory) {
        Remove-Item -LiteralPath $HostDirectory -Recurse -Force
    }
    if (Test-Path -LiteralPath $ManifestPath) {
        Remove-Item -LiteralPath $ManifestPath -Force
    }
}

if (Test-Path -LiteralPath $RegistryPath) {
    Remove-Item -LiteralPath $RegistryPath -Recurse -Force
}

Write-Host 'Helper removed. Account list and isolated profiles were preserved.' -ForegroundColor Green
Write-Host 'Remove the unpacked extension from chrome://extensions if you no longer need it.'
