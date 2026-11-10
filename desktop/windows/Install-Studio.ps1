#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'SionnaRTStudio\app'),
    [string]$PythonPath,
    [switch]$NoShortcut,
    [switch]$SkipWebView2Check
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$osArchitecture = $env:PROCESSOR_ARCHITEW6432
if (-not $osArchitecture) { $osArchitecture = $env:PROCESSOR_ARCHITECTURE }
if ($env:OS -ne 'Windows_NT' -or $osArchitecture -ne 'AMD64') {
    throw 'Sionna RT Studio requires Windows x64.'
}

function Invoke-CheckedCommand {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$(Split-Path -Leaf $Executable) failed with exit code $LASTEXITCODE. See its output above."
    }
}

function Find-Python312 {
    $probe = "import platform, struct, sys; sys.exit(0 if sys.version_info[:2] == (3, 12) and struct.calcsize('P') == 8 and platform.machine().upper() in ('AMD64', 'X86_64') else 1)"
    if ($PythonPath) {
        $candidate = (Get-Item -LiteralPath $PythonPath).FullName
        & $candidate -I -c $probe
        if ($LASTEXITCODE -eq 0) { return $candidate }
        throw "PythonPath must point to a Python 3.12 x64 executable: $candidate"
    }
    $launcher = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($launcher) {
        try {
            $candidate = & $launcher.Source '-3.12-64' -I -c 'import sys; print(sys.executable)' 2>$null
            if ($LASTEXITCODE -eq 0 -and $candidate) {
                & $candidate -I -c $probe
                if ($LASTEXITCODE -eq 0) { return $candidate }
            }
        } catch {
            # Try Python on PATH if the launcher has no usable 3.12 install.
        }
    }
    $python = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($python -and $python.Source -notlike '*\Microsoft\WindowsApps\*') {
        & $python.Source -I -c $probe
        if ($LASTEXITCODE -eq 0) { return $python.Source }
    }
    return $null
}

function Test-WebView2Runtime {
    $client = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($key in @("HKLM:\SOFTWARE\WOW6432Node\$client", "HKLM:\SOFTWARE\$client", "HKCU:\Software\$client")) {
        $version = Get-ItemPropertyValue -LiteralPath $key -Name pv -ErrorAction SilentlyContinue
        if ($version -match '^[1-9]\d*\.\d+\.\d+\.\d+$') { return $true }
    }
    return $false
}

$python = Find-Python312
$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$dotnet = Get-Command dotnet.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$nodeVersion = if ($node) { & $node.Source -p "process.arch === 'x64' ? process.versions.node : '0.0.0'" } else { '0.0.0' }
$missing = @()
if (-not $python) { $missing += 'winget install --exact --id Python.Python.3.12 --architecture x64' }
if (-not $npm -or [Version]$nodeVersion -lt [Version]'22.12.0') {
    $missing += 'winget install --exact --id OpenJS.NodeJS.22 --architecture x64'
}
if (-not $dotnet -or -not ((& $dotnet.Source --list-sdks) -match '^8\.0\.\d+\s')) {
    $missing += 'winget install --exact --id Microsoft.DotNet.SDK.8 --architecture x64'
}
if (-not $SkipWebView2Check -and -not (Test-WebView2Runtime)) {
    $missing += 'winget install --exact --id Microsoft.EdgeWebView2Runtime --architecture x64'
}
if ($missing.Count) {
    throw ('Install the missing prerequisites and open a new PowerShell window before retrying:' + "`n  " + ($missing -join "`n  "))
}

$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$InstallDirectory = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDirectory))
if ($InstallDirectory -eq [IO.Path]::GetPathRoot($InstallDirectory)) {
    throw 'Choose an application directory rather than a drive root.'
}
$InstallDirectory = $InstallDirectory.TrimEnd('\')
$stateDirectory = Join-Path $env:LOCALAPPDATA 'SionnaRTStudio'
if ($stateDirectory -eq $InstallDirectory -or $stateDirectory.StartsWith("$InstallDirectory\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Choose an application directory that leaves the Studio user data directory outside it.'
}
$parent = Split-Path -Parent $InstallDirectory
$folderName = Split-Path -Leaf $InstallDirectory
$markerName = '.sionna-rt-studio-win-x64'
$exeName = 'SionnaRTStudio.exe'
$exe = Join-Path $InstallDirectory $exeName

function Assert-ReplaceableInstall {
    if (Test-Path -LiteralPath $InstallDirectory) {
        $target = Get-Item -LiteralPath $InstallDirectory -Force
        if (-not $target.PSIsContainer -or ($target.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            -not (Test-Path -LiteralPath (Join-Path $InstallDirectory $markerName) -PathType Leaf)) {
            throw "Refusing to replace an unrelated directory or link: $InstallDirectory"
        }
    }
    foreach ($process in (Get-Process -Name SionnaRTStudio -ErrorAction SilentlyContinue)) {
        if ($process.Path -eq $exe) { throw 'Close Sionna RT Studio before updating it.' }
    }
}

[void][IO.Directory]::CreateDirectory($parent)
$lockPath = Join-Path $parent ".$folderName.install.lock"
try {
    $installLock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
} catch [IO.IOException] {
    throw "Cannot lock $InstallDirectory. Close any other Studio installer and retry. $($_.Exception.Message)"
}

$staging = Join-Path $parent ('.studio-build-' + [Guid]::NewGuid().ToString('N'))
$payload = Join-Path $staging 'app'
$previous = Join-Path $staging 'previous'
$wheels = Join-Path $staging 'wheels'
$replacementStarted = $false
$installed = $false

try {
    Assert-ReplaceableInstall
    [void][IO.Directory]::CreateDirectory($payload)
    $runtime = Join-Path $payload 'runtime'
    $desktop = Join-Path $runtime 'desktop'
    $backend = Join-Path $runtime 'backend'
    $site = Join-Path $desktop 'site'
    [void][IO.Directory]::CreateDirectory($desktop)
    [void][IO.Directory]::CreateDirectory($backend)

    Write-Host 'Building the Studio interface and Windows application...'
    Push-Location -LiteralPath $source
    try {
        Invoke-CheckedCommand $npm.Source @('ci', '--no-audit', '--no-fund')
        $vite = Join-Path $source 'node_modules\vite\bin\vite.js'
        Invoke-CheckedCommand $node.Source @($vite, 'build', '--outDir', $site, '--emptyOutDir')
    } finally {
        Pop-Location
    }
    $project = Join-Path $PSScriptRoot 'app\SionnaRTStudio.csproj'
    Invoke-CheckedCommand $dotnet.Source @('publish', $project, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', $payload)
    if (-not (Test-Path -LiteralPath (Join-Path $payload $exeName) -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $site 'index.html') -PathType Leaf)) {
        throw 'Build output is missing the Studio executable or interface.'
    }

    Copy-Item -LiteralPath (Join-Path $source 'desktop\studio_server.py') -Destination $desktop
    $backendSource = Join-Path $source 'backend'
    Get-ChildItem -LiteralPath $backendSource -Filter '*.py' -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $backend
    }
    foreach ($name in @('requirements.txt', 'requirements-phy.txt')) {
        Copy-Item -LiteralPath (Join-Path $backendSource $name) -Destination $backend
    }
    foreach ($name in @('LICENSE', 'NOTICE')) {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination $payload
    }

    Write-Host 'Downloading Python dependencies for Sionna RT...'
    $requirements = Join-Path $backendSource 'requirements.txt'
    Invoke-CheckedCommand $python @('-I', '-m', 'pip', 'download', '--disable-pip-version-check', '--only-binary=:all:', '--dest', $wheels, '-r', $requirements)

    # A venv embeds absolute paths. Create it only after the payload reaches
    # its final location, using local wheels so an upgrade needs no network here.
    Assert-ReplaceableInstall
    if (Test-Path -LiteralPath $InstallDirectory) {
        [IO.Directory]::Move($InstallDirectory, $previous)
    }
    Rename-Item -LiteralPath (Join-Path $payload $exeName) -NewName "$exeName.staged"
    [IO.Directory]::Move($payload, $InstallDirectory)
    $replacementStarted = $true
    $venv = Join-Path $InstallDirectory 'runtime\.venv'
    Invoke-CheckedCommand $python @('-I', '-m', 'venv', $venv)
    $solverPython = Join-Path $venv 'Scripts\python.exe'
    Invoke-CheckedCommand $solverPython @('-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--find-links', $wheels, '-r', $requirements)
    Invoke-CheckedCommand $solverPython @('-I', '-m', 'pip', 'check')
    Invoke-CheckedCommand $solverPython @('-I', '-c', 'import mitsuba, drjit, numpy, mapbox_earcut')
    Set-Content -LiteralPath (Join-Path $InstallDirectory $markerName) -Value 'Sionna RT Studio for Windows x64' -Encoding ASCII
    Rename-Item -LiteralPath "$exe.staged" -NewName $exeName
    $installed = $true
} finally {
    try {
        if (-not $installed) {
            if ($replacementStarted) { Remove-Item -LiteralPath $InstallDirectory -Recurse -Force }
            if (Test-Path -LiteralPath $previous) { [IO.Directory]::Move($previous, $InstallDirectory) }
        }
        if (Test-Path -LiteralPath $staging) {
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Warning "Install cleanup did not finish. Any previous installation is in $previous. $($_.Exception.Message)"
    } finally {
        $installLock.Dispose()
    }
}

if (-not $NoShortcut) {
    try {
        $programs = [Environment]::GetFolderPath('Programs')
        [void][IO.Directory]::CreateDirectory($programs)
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path $programs 'Sionna RT Studio.lnk'))
        $shortcut.TargetPath = $exe
        $shortcut.WorkingDirectory = $InstallDirectory
        $shortcut.Save()
    } catch {
        Write-Warning "Start menu shortcut could not be created. Open the executable directly at $exe."
    }
}

Write-Host "Installed Sionna RT Studio at $exe"
