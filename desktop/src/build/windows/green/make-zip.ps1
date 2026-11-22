param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Readme,
  [Parameter(Mandatory = $true)][string]$Unblock,
  [Parameter(Mandatory = $true)][string]$ExtraExeDir,
  [Parameter(Mandatory = $true)][string]$Output,
  [Parameter(Mandatory = $true)][string]$Stage
)

# Assemble the no-install zip: the bare client exe + a usage note + the
# unblock helper. Everything lives under bin/ (git-ignored), so no build
# artifact ever lands in the source tree.
$ErrorActionPreference = 'Stop'

Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Stage | Out-Null

Copy-Item -Force $Exe (Join-Path $Stage (Split-Path -Leaf $Exe))
Copy-Item -Force $Readme (Join-Path $Stage 'README.txt')
Copy-Item -Force $Unblock (Join-Path $Stage 'Unblock.bat')

# Optional: the WebView2 bootstrapper, only useful on machines without the
# runtime. Microsoft-signed, so it never trips the block we are dodging.
$wv2 = Get-ChildItem -Path $ExtraExeDir -Filter '*.exe' -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($wv2) {
  Copy-Item -Force $wv2.FullName (Join-Path $Stage $wv2.Name)
}

Remove-Item -Force $Output -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $Output -Force
Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue

Write-Host "[green] wrote $Output"
