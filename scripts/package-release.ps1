[CmdletBinding()]
param()

# Builds dist\DiscordProfileSwitcher-windows.zip and dist\SHA256SUMS.txt for a GitHub release.
# Run it after building the helper into artifacts\native-host (see README, Development).

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Manifest = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'extension\manifest.json') | ConvertFrom-Json
$Version = [string]$Manifest.version
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw 'extension\manifest.json has an invalid version.'
}

$HostExecutable = Join-Path $ProjectRoot 'artifacts\native-host\DiscordMultiAccountHost.exe'
$InstallScript = Join-Path $ProjectRoot 'scripts\install-native-host.ps1'
$DistRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'dist'))
$StageRoot = Join-Path $DistRoot 'stage'
$PackageName = "DiscordProfileSwitcher-v$Version"
$PackageRoot = Join-Path $StageRoot $PackageName
$ZipName = 'DiscordProfileSwitcher-windows.zip'
$ZipPath = Join-Path $DistRoot $ZipName
$SumsPath = Join-Path $DistRoot 'SHA256SUMS.txt'

if (-not $DistRoot.StartsWith($ProjectRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to write outside the project folder.'
}

if (-not (Test-Path -LiteralPath $HostExecutable)) {
    throw 'artifacts\native-host\DiscordMultiAccountHost.exe is missing. Build the helper first.'
}

# The installer only accepts a prebuilt helper whose hash it pins, so ship exactly that file.
$PinnedMatch = [regex]::Match(
    (Get-Content -Raw -LiteralPath $InstallScript),
    "\`$ExpectedHostHash = '([0-9A-Fa-f]{64})'")
if (-not $PinnedMatch.Success) {
    throw 'Could not find $ExpectedHostHash in install-native-host.ps1.'
}
$PinnedHash = $PinnedMatch.Groups[1].Value.ToUpperInvariant()
$HostHash = (Get-FileHash -LiteralPath $HostExecutable -Algorithm SHA256).Hash.ToUpperInvariant()
if ($PinnedHash -ne $HostHash) {
    throw "The helper's SHA-256 ($HostHash) does not match the pinned hash ($PinnedHash). Update install-native-host.ps1 or rebuild."
}

if (Test-Path -LiteralPath $DistRoot) {
    Remove-Item -LiteralPath $DistRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $PackageRoot -Force | Out-Null

$Items = @(
    'extension',
    'scripts\install-native-host.cmd',
    'scripts\install-native-host.ps1',
    'scripts\uninstall-native-host.cmd',
    'scripts\uninstall-native-host.ps1',
    'native-host\Program.cs',
    'native-host\DiscordMultiAccountHost.csproj',
    'README.md',
    'SECURITY.md'
)
foreach ($Item in $Items) {
    $Source = Join-Path $ProjectRoot $Item
    $Destination = Join-Path $PackageRoot $Item
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse
}

$HostDestination = Join-Path $PackageRoot 'artifacts\native-host'
New-Item -ItemType Directory -Path $HostDestination -Force | Out-Null
Copy-Item -LiteralPath $HostExecutable -Destination $HostDestination

$InstallText = @"
Discord Profile Switcher $Version
=================================

1. Keep this folder somewhere permanent, for example Documents\DiscordProfileSwitcher.
2. In Chrome, open chrome://extensions, turn on Developer mode,
   click "Load unpacked", and choose the "extension" folder in here.
3. Open the "scripts" folder and double-click install-native-host.cmd.
4. Restart Chrome, pin Discord Profile Switcher, open it,
   and check that the bottom bar says "Helper ready".

Updating? Replace the old folder with this one, reload the extension on
chrome://extensions, and run install-native-host.cmd again. Your profiles stay.

This tool never asks for, reads, stores, or injects Discord tokens.
More: README.md and SECURITY.md in this folder.
"@
$Utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $PackageRoot 'INSTALL.txt'), ($InstallText -replace "`r?`n", "`r`n"), $Utf8WithoutBom)

# Build the zip entry by entry so paths always use forward slashes.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Archive = [IO.Compression.ZipFile]::Open($ZipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($File in Get-ChildItem -LiteralPath $StageRoot -Recurse -File) {
        $EntryName = $File.FullName.Substring($StageRoot.Length + 1).Replace('\', '/')
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $Archive,
            $File.FullName,
            $EntryName,
            [IO.Compression.CompressionLevel]::Optimal)
    }
}
finally {
    $Archive.Dispose()
}

Remove-Item -LiteralPath $StageRoot -Recurse -Force

$ZipHash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$Sums = @(
    "$ZipHash  $ZipName",
    "$($HostHash.ToLowerInvariant())  $PackageName/artifacts/native-host/DiscordMultiAccountHost.exe"
)
[IO.File]::WriteAllText($SumsPath, (($Sums -join "`n") + "`n"), $Utf8WithoutBom)

Write-Host "Packaged $PackageName" -ForegroundColor Green
Write-Host "  $ZipPath"
Write-Host "  $SumsPath"
