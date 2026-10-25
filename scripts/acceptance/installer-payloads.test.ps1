param([string]$Msi)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot '../validate-installer-payloads.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
# Load only pure helper definitions; do not run an installer verifier or extract
# any artifact as part of these rejection checks.
foreach ($function in $ast.EndBlock.Statements) {
    if ($function -is [Management.Automation.Language.FunctionDefinitionAst]) {
        . ([ScriptBlock]::Create($function.Extent.Text))
    }
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../test-results/payload-path-test'))
$valid = Resolve-Child $root 'agent-sidecar/dist/index.js'
if ($valid -ne (Join-Path $root 'agent-sidecar\dist\index.js')) { throw 'Valid relative path changed' }
$rejected = 0
foreach ($path in @('', ' ', '..\escape', '../escape', 'a/../../escape', '\rooted', 'C:\escape', 'C:relative', 'a/file:stream', '//host/share/file')) {
    $threw = $false
    try { [void](Resolve-Child $root $path) } catch { $threw = $true }
    if (-not $threw) { throw "Unsafe payload path accepted: $path" }
    $rejected++
}
Assert-RegularFile $script
$threw = $false
try { Assert-RegularFile $PSScriptRoot } catch { $threw = $true }
if (-not $threw) { throw 'Directory accepted as an artifact' }
Write-Host "PASS installer payload verifier: syntax, $rejected unsafe paths rejected, regular-file checks"
if ($Msi) {
    Assert-RegularFile $Msi
    $map = Get-MsiPayloadMap ([IO.Path]::GetFullPath($Msi))
    if (-not $map.ContainsKey('node.exe') -or -not $map.ContainsKey('agent-sidecar/dist/index.js') -or -not $map.ContainsKey('agent-sidecar/package.json')) {
        throw 'MSI file-table paths did not reconstruct the bundled sidecar layout'
    }
    Write-Host "PASS read-only MSI directory/component/file mapping: $($map.Count) files"
}
