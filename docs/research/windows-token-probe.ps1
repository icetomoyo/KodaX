param([string]$NodePath = (Get-Command node.exe).Source)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-token-probe.cs')
$probeRoot = Join-Path $PSScriptRoot ('.token-probe-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $probeRoot | Out-Null
try {
    $outside = Join-Path $probeRoot 'outside.txt'
    Set-Content -LiteralPath $outside -Value 'original'
    & icacls.exe $outside /grant '*S-1-1-0:(M)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'icacls failed on temporary file' }
    [TokenProbe]::Run($probeRoot, $outside, $NodePath)
} finally {
    $resolvedProbe = [System.IO.Path]::GetFullPath($probeRoot)
    $expectedPrefix = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\.token-probe-'
    if (!$resolvedProbe.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe probe cleanup path' }
    Remove-Item -LiteralPath $resolvedProbe -Recurse -Force
}
