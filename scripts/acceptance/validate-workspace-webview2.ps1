param(
    [ValidateRange(1, 12)][int]$Panes = 8,
    [ValidateRange(1, 65535)][int]$Port = 1420,
    [switch]$Profile,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$sdkVersion = '1.0.4191.47'
$sdkHash = 'F492BBF547D0DA329553B6727435B677579B1E9F91CC9E4A1AD029366D5F23D0'
$sdk = Join-Path $repo "test-results/acceptance/webview2-sdk/$sdkVersion"
$archive = Join-Path $sdk 'sdk.zip'
New-Item -ItemType Directory -Force -Path $sdk | Out-Null
if (!(Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg" -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $sdkHash) {
    throw 'Official WebView2 SDK package does not match the pinned SHA256.'
}
Expand-Archive -LiteralPath $archive -DestinationPath $sdk -Force
if (!$OutputDirectory) {
    $OutputDirectory = Join-Path $repo ('test-results/acceptance/webview2-perf/' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff') + "-${Panes}panes")
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Use a fresh output directory to isolate the WebView2 profile.' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$bin = Join-Path $OutputDirectory 'bin'
New-Item -ItemType Directory -Path $bin | Out-Null
$core = (Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.Core.dll').Replace('/', '\')
$forms = (Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.WinForms.dll').Replace('/', '\')
Copy-Item -LiteralPath $core, $forms, (Join-Path $sdk 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $bin
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$source = (Join-Path $PSScriptRoot 'WorkspaceWebView2Host.cs').Replace('/', '\')
$executable = (Join-Path $bin 'WorkspaceWebView2Host.exe').Replace('/', '\')
& $compiler /nologo /target:exe /platform:x64 "/out:$executable" "/reference:$core" "/reference:$forms" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $source
if ($LASTEXITCODE -ne 0) { throw 'Native test host compilation failed.' }
$url = "http://127.0.0.1:$Port/e2e/harness/workspace.html?panes=$Panes"
@{
    sdkVersion = $sdkVersion; sdkSha256 = $sdkHash; url = $url
    hostSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    startedUtc = [DateTime]::UtcNow.ToString('o'); cpuProfiling = [bool]$Profile
    scope = 'Dedicated native WebView2 test host; mocked Tauri transport; not packaged application acceptance'
    sources = @('e2e/harness/workspace.tsx', 'e2e/harness/workspace-bridge.ts', 'src/hooks/useXterm.ts', 'src/components/workspace/WorkspaceMosaicContainer.tsx') | ForEach-Object {
        @{ path = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $repo $_) -Algorithm SHA256).Hash }
    }
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'manifest.json') -Encoding UTF8
$mode = if ($Profile) { 'profile' } else { 'metrics' }
& $executable $url $OutputDirectory $mode
if ($LASTEXITCODE -ne 0) {
    if (Test-Path -LiteralPath (Join-Path $OutputDirectory 'error.txt')) { Get-Content -LiteralPath (Join-Path $OutputDirectory 'error.txt') }
    throw "Native acceptance failed: $OutputDirectory"
}
foreach ($run in @('cold', 'warm')) {
    $metrics = Get-Content -LiteralPath (Join-Path $OutputDirectory "$run.json") -Raw | ConvertFrom-Json
    $metrics | Select-Object @{n='run';e={$run}}, panes, elapsedMs, p95FrameIntervalMs, maxFrameIntervalMs, longTasks, maxLongTaskMs, launches, disposals, kills | Format-Table
    if ($metrics.launches -ne $Panes -or $metrics.disposals -ne 0 -or $metrics.kills -ne 0 -or $metrics.unexpected.Count -ne 0) { throw 'Workspace lifecycle acceptance failed.' }
    if ($metrics.tails.Count -ne $Panes) { throw 'Missing terminal tails.' }
    for ($index = 0; $index -lt $Panes; $index++) {
        $tail = $metrics.tails | Where-Object { $_.id -eq "pane-$index" }
        $japanese = -join ([char]0x65e5, [char]0x672c, [char]0x8a9e)
        if (!$metrics.runId -or !$tail -or !$tail.text.Contains("END_${index}_${japanese}_RUN_$($metrics.runId)")) { throw "Missing current-run Unicode output end marker for pane $index." }
    }
    if ($Profile) {
        $cpu = (Get-Content -LiteralPath (Join-Path $OutputDirectory "$run-profile.json") -Raw | ConvertFrom-Json).profile
        $cpu | ConvertTo-Json -Depth 100 -Compress | Set-Content -LiteralPath (Join-Path $OutputDirectory "$run.cpuprofile") -Encoding UTF8
        $nodes = @{}; $times = @{}
        foreach ($node in $cpu.nodes) { $nodes[[int]$node.id] = $node }
        for ($index = 0; $index -lt $cpu.samples.Count; $index++) {
            $id = [int]$cpu.samples[$index]
            if (!$times.ContainsKey($id)) { $times[$id] = 0.0 }
            $times[$id] += $cpu.timeDeltas[$index] / 1000.0
        }
        $hot = $times.GetEnumerator() | ForEach-Object {
            $frame = $nodes[$_.Key].callFrame
            [pscustomobject]@{ selfSampleMs = [Math]::Round($_.Value, 2); function = $frame.functionName; url = $frame.url; line = $frame.lineNumber + 1 }
        } | Sort-Object selfSampleMs -Descending | Select-Object -First 30
        $hot | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDirectory "$run-hot-functions.json") -Encoding UTF8
        $hot | Select-Object -First 10 | Format-Table -AutoSize
    }
}
Write-Output "Native WebView2 acceptance evidence: $OutputDirectory"
