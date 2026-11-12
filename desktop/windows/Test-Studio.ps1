#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'SionnaRTStudio\app'),
    [string]$ReportDirectory = (Join-Path $env:LOCALAPPDATA 'SionnaRTStudio\acceptance'),
    [switch]$AllowCpu,
    [switch]$Headless
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$runtime = Join-Path $InstallDirectory 'runtime'
$python = Join-Path $runtime 'python\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    $python = Join-Path $runtime '.venv\Scripts\python.exe'
}
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Studio Python was not found at $python. Run Install-Studio.ps1 first."
}

$verify = Join-Path $PSScriptRoot '..\verify_studio.py'
$verifyArgs = @('-B', $verify, '--runtime', $runtime, '--report-directory', $ReportDirectory)
if ($Headless) {
    $verifyArgs += '--headless'
} else {
    $app = Join-Path $InstallDirectory 'SionnaRTStudio.exe'
    if (-not (Test-Path -LiteralPath $app -PathType Leaf)) {
        throw "Studio executable was not found at $app. Run Install-Studio.ps1 first."
    }
    $verifyArgs += @('--app', $app)
}
if ($AllowCpu) { $verifyArgs += '--allow-cpu' }

& $python @verifyArgs
exit $LASTEXITCODE
