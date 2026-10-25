[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Manifest,
    [string]$SevenZip
)
# Archive inspection only. Never execute either installer or launch the app.
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'test-results/acceptance'))
function Assert-RegularFile([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Expected a regular file: $Path"
    }
    for ($parent = $item.Directory; $null -ne $parent; $parent = $parent.Parent) {
        if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "File has a linked parent: $Path" }
    }
}
function Resolve-Child([string]$Root, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':')) {
        throw "Invalid relative payload path: $Relative"
    }
    if (($Relative -split '[\\/]') -contains '..') { throw "Payload path traversal: $Relative" }
    $full = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not $full.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Payload escapes extraction root: $Relative"
    }
    return $full
}
function Get-Hash([string]$Path) {
    Assert-RegularFile $Path
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Read-MsiRows($Database, [string]$Sql, [string[]]$Columns) {
    $view = $Database.OpenView($Sql)
    try {
        [void]$view.Execute()
        while ($record = $view.Fetch()) {
            try {
                $row = @{}
                for ($i = 0; $i -lt $Columns.Count; $i++) { $row[$Columns[$i]] = $record.StringData($i + 1) }
                Write-Output $row
            } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
        }
    } finally {
        [void]$view.Close()
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
    }
}
function Get-MsiPayloadMap([string]$Archive) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.OpenDatabase($Archive, 0) # read-only, no MSI actions
    try {
        $directories = @{}
        foreach ($row in (Read-MsiRows $database 'SELECT `Directory`, `Directory_Parent`, `DefaultDir` FROM `Directory`' @('id', 'parent', 'name'))) {
            $directories[$row.id] = $row
        }
        $components = @{}
        foreach ($row in (Read-MsiRows $database 'SELECT `Component`, `Directory_` FROM `Component`' @('id', 'directory'))) {
            $components[$row.id] = $row.directory
        }
        $paths = @{ INSTALLDIR = '' }
        function Resolve-MsiDirectory([string]$Id, [string[]]$Ancestors = @()) {
            if ($paths.ContainsKey($Id)) { return $paths[$Id] }
            if ($Ancestors -contains $Id -or -not $directories.ContainsKey($Id)) { throw "Invalid MSI directory tree: $Id" }
            $row = $directories[$Id]
            if (-not $row.parent) { throw "MSI file is outside INSTALLDIR: $Id" }
            $parent = Resolve-MsiDirectory $row.parent ($Ancestors + $Id)
            $name = (($row.name -split ':')[0] -split '\|')[-1]
            $relative = if ($name -eq '.') { $parent } elseif ($parent) { "$parent/$name" } else { $name }
            $paths[$Id] = $relative
            return $relative
        }
        $map = @{}
        foreach ($row in (Read-MsiRows $database 'SELECT `File`, `Component_`, `FileName` FROM `File`' @('id', 'component', 'name'))) {
            $directory = Resolve-MsiDirectory $components[$row.component]
            $name = ($row.name -split '\|')[-1]
            $relative = if ($directory) { "$directory/$name" } else { $name }
            if ($map.ContainsKey($relative)) { throw "Duplicate MSI payload path: $relative" }
            $map[$relative] = $row.id
        }
        return $map
    } finally {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
    }
}

$manifestPath = (Resolve-Path -LiteralPath $Manifest).Path
Assert-RegularFile $manifestPath
$build = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($build.schemaVersion -ne 1 -or $build.source.sourceSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $build.source.head -notmatch '^[a-fA-F0-9]{40,64}$' -or $build.source.files -lt 1) {
    throw 'Unsupported or unstamped acceptance manifest'
}
if (-not $SevenZip) {
    $command = Get-Command 7z.exe -ErrorAction SilentlyContinue
    $SevenZip = if ($command) { $command.Source } else { Join-Path $env:ProgramFiles '7-Zip/7z.exe' }
}
Assert-RegularFile $SevenZip
if (@($build.installers).Count -ne 2 -or @($build.files).Count -eq 0) { throw 'Expected NSIS/MSI artifacts and payload file hashes' }
$runRoot = Join-Path $evidenceRoot ('payloads-' + [Guid]::NewGuid().ToString('N'))
[void](Resolve-Child $evidenceRoot ([IO.Path]::GetFileName($runRoot)))
[void](New-Item -ItemType Directory -Path $runRoot)
$reportPath = Join-Path $runRoot 'report.json'
$report = [ordered]@{
    startedAt = [DateTime]::UtcNow.ToString('o'); passed = $false
    scope = 'Noninstalling archive extraction, payload hashes, executable version, bundled Node and two echo turns. No GUI, installation actions, paid provider or external service acceptance.'
    manifest = $manifestPath; manifestSha256 = Get-Hash $manifestPath
    version = $build.version; source = $build.source; artifacts = @()
}
try {
    $formats = @{}
    foreach ($artifact in $build.installers) {
        Assert-RegularFile $artifact.path
        if ((Get-Hash $artifact.path) -ne $artifact.sha256) { throw "Installer hash mismatch: $($artifact.path)" }
        $format = if ($artifact.path.EndsWith('.msi', [StringComparison]::OrdinalIgnoreCase)) { 'msi' } elseif ($artifact.path.EndsWith('-setup.exe', [StringComparison]::OrdinalIgnoreCase)) { 'nsis' } else { throw 'Unsupported installer format' }
        if ($formats.ContainsKey($format)) { throw "Duplicate installer format: $format" }
        $formats[$format] = $true
        if ($artifact.executableSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Missing per-format executable hash' }
        $formatRoot = Join-Path $runRoot $format
        $raw = Join-Path $formatRoot 'raw'
        $payload = if ($format -eq 'nsis') { $raw } else { Join-Path $formatRoot 'payload' }
        $expectedPaths = @{}
        foreach ($file in $build.files) {
            [void](Resolve-Child $payload $file.installedPath)
            if ($file.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Invalid payload hash: $($file.installedPath)" }
            $canonical = Resolve-Child $payload $file.installedPath
            if ($expectedPaths.ContainsKey($canonical)) { throw "Duplicate manifest payload path: $($file.installedPath)" }
            $expectedPaths[$canonical] = $true
        }
        [void](Resolve-Child $payload $build.binaryName)
        foreach ($required in @($build.binaryName, 'node.exe', 'agent-sidecar/dist/index.js', 'agent-sidecar/package.json')) {
            if (-not $expectedPaths.ContainsKey((Resolve-Child $payload $required))) { throw "Required payload is absent from manifest: $required" }
        }
        # Validate every archive entry before extraction, including entries not
        # selected by the manifest; reject links and absolute/traversal paths.
        $listing = (& $SevenZip l -slt -- $artifact.path 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) { throw "Archive listing failed: $($artifact.path)" }
        $entries = ($listing -split '(?m)^----------\s*$', 2)[1]
        if (-not $entries -or $entries -match '(?m)^(Symbolic Link|Hard Link) =') { throw 'Missing or linked archive entries' }
        foreach ($match in [regex]::Matches($entries, '(?m)^Path = (.+)\r?$')) { [void](Resolve-Child $raw $match.Groups[1].Value.TrimEnd("`r")) }
        [void](New-Item -ItemType Directory -Path $raw -Force)
        & $SevenZip x -y -bb0 -bso0 -bsp0 "-o$raw" -- $artifact.path
        if ($LASTEXITCODE -ne 0) { throw "Archive extraction failed: $($artifact.path)" }
        foreach ($item in (Get-ChildItem -LiteralPath $raw -Recurse -Force)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Extracted link: $($item.FullName)" }
            if ($format -eq 'nsis' -and -not $item.PSIsContainer -and -not $expectedPaths.ContainsKey($item.FullName)) {
                $pluginRoot = (Join-Path $raw '$PLUGINSDIR') + '\'
                if (-not $item.FullName.StartsWith($pluginRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Unexpected NSIS application file: $($item.FullName)" }
            }
        }
        if ($format -eq 'msi') {
            $map = Get-MsiPayloadMap $artifact.path
            if ($map.Count -ne $build.files.Count) { throw 'MSI application file table differs from manifest file count' }
            foreach ($file in $build.files) {
                if (-not $map.ContainsKey($file.installedPath)) { throw "Missing MSI file table mapping: $($file.installedPath)" }
                $source = Resolve-Child $raw $map[$file.installedPath]
                Assert-RegularFile $source
                $destination = Resolve-Child $payload $file.installedPath
                [void](New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force)
                Copy-Item -LiteralPath $source -Destination $destination
            }
        }
        $verified = 0
        foreach ($file in $build.files) {
            $expected = if ($file.installedPath -eq $build.binaryName) { $artifact.executableSha256 } else { $file.sha256 }
            if ((Get-Hash (Resolve-Child $payload $file.installedPath)) -ne $expected) { throw "Payload hash mismatch ($format): $($file.installedPath)" }
            $verified++
        }
        $exe = Resolve-Child $payload $build.binaryName
        $version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
        if ($version -ne $build.version -and ($version -replace '\.0$', '') -ne $build.version) { throw "Executable version mismatch: $version" }
        $node = Resolve-Child $payload 'node.exe'
        Assert-RegularFile $node
        $nodeVersion = (& $node --version)
        if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v\d+\.\d+\.\d+$') { throw 'Bundled Node failed version probe' }
        $sidecarReport = Join-Path $formatRoot 'packaged-sidecar.json'
        & $node (Join-Path $PSScriptRoot 'acceptance/packaged-sidecar.mjs') $payload $sidecarReport
        if ($LASTEXITCODE -ne 0) { throw "Packaged sidecar failed ($format)" }
        if ((Get-Hash $artifact.path) -ne $artifact.sha256) { throw "Installer changed during validation: $($artifact.path)" }
        $report.artifacts += [ordered]@{ format = $format; installer = $artifact.path; installerSha256 = $artifact.sha256; executableSha256 = Get-Hash $exe; verifiedFiles = $verified; productVersion = $version; nodeVersion = $nodeVersion; sidecarReport = $sidecarReport; passed = $true }
        Write-Host "PASS $format`: $verified exact payload hashes; Node $nodeVersion; two echo turns"
    }
    if ((Get-Hash $manifestPath) -ne $report.manifestSha256) { throw 'Manifest changed during validation' }
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Host "Payload evidence: $reportPath"
}
