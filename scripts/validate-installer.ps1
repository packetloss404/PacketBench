[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Manifest,
    [switch]$Install,
    [string]$InstallDirectory
)
$ErrorActionPreference = 'Stop'
$manifestPath = (Resolve-Path -LiteralPath $Manifest).Path
$build = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($build.schemaVersion -ne 1) { throw 'Unsupported acceptance manifest' }
if (-not $InstallDirectory) { $InstallDirectory = Join-Path $env:LOCALAPPDATA $build.productName }
$InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
$reportDir = Split-Path -Parent $manifestPath
$reportPath = Join-Path $reportDir 'installation.json'
$report = [ordered]@{ startedAt = [DateTime]::UtcNow.ToString('o'); version = $build.version; passed = $false; installDirectory = $InstallDirectory }
try {
    foreach ($artifact in $build.installers) {
        if ((Get-FileHash -LiteralPath $artifact.path -Algorithm SHA256).Hash -ne $artifact.sha256) {
            throw "Installer hash mismatch: $($artifact.path)"
        }
    }
    if ($Install) {
        # NSIS CheckIfAppIsRunning kills the process automatically in silent
        # mode, even if /D targets another directory. Do not interrupt sessions.
        $name = [IO.Path]::GetFileNameWithoutExtension($build.binaryName)
        if (Get-Process -Name $name -ErrorAction SilentlyContinue) {
            throw "Close $($build.productName) normally before installing; silent NSIS would terminate its active sessions."
        }
        $installer = @($build.installers | Where-Object { $_.path.EndsWith('-setup.exe') })
        if ($installer.Count -ne 1) { throw 'Expected exactly one NSIS installer' }
        # /D must be last and unquoted, including when the path contains spaces.
        # This is the documented NSIS command-line grammar, not shell syntax.
        $process = Start-Process -FilePath $installer[0].path -ArgumentList "/S /D=$InstallDirectory" -WindowStyle Hidden -PassThru
        if (-not $process.WaitForExit(180000)) { throw 'Installer still running after 180 seconds; inspect it before retrying.' }
        $report.installerExitCode = $process.ExitCode
        if ($process.ExitCode -ne 0) { throw "NSIS exited with $($process.ExitCode)" }
    }
    $verified = 0
    foreach ($file in $build.files) {
        $installed = [IO.Path]::GetFullPath((Join-Path $InstallDirectory $file.installedPath))
        if (-not $installed.StartsWith($InstallDirectory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Manifest resource escapes the installation directory'
        }
        if ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne $file.sha256) {
            throw "Installed payload hash mismatch: $($file.installedPath)"
        }
        $verified++
    }
    $report.verifiedFiles = $verified
    $exe = Join-Path $InstallDirectory $build.binaryName
    $version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
    if (($version -replace '\.0$', '') -ne $build.version -and $version -ne $build.version) {
        throw "Installed version $version does not match $($build.version)"
    }
    $report.executableSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $report.productVersion = $version
    $node = Join-Path $InstallDirectory 'node.exe'
    $report.nodeVersion = (& $node --version)
    if ($LASTEXITCODE -ne 0) { throw 'Bundled Node failed' }
    & $node (Join-Path $PSScriptRoot 'acceptance/packaged-sidecar.mjs') $InstallDirectory (Join-Path $reportDir 'packaged-sidecar.json')
    if ($LASTEXITCODE -ne 0) { throw 'Packaged sidecar validation failed' }
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Host "Installation evidence: $reportPath"
}
