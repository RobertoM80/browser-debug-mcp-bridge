param(
  [string]$RepoPath = (Get-Location).Path
)

$ErrorActionPreference = "Stop"

Write-Host "[install] Using repo path: $RepoPath"

if (-not (Test-Path (Join-Path $RepoPath "package.json"))) {
  throw "package.json not found in $RepoPath. Run this script from repository root or pass -RepoPath."
}

Push-Location $RepoPath
try {
  Write-Host "[install] Installing dependencies..."
  pnpm install

  Write-Host "[install] Building MCP server..."
  pnpm nx build mcp-server

  Write-Host "[install] Building Chrome extension..."
  pnpm nx build chrome-extension

  Write-Host "[install] Printing MCP client configs..."
  pnpm mcp:print-config -- --repo="$RepoPath"

  Write-Host ""
  Write-Host "[done] Setup complete."
  Write-Host "Next:"
  Write-Host "  1) Load extension from dist/apps/chrome-extension in chrome://extensions"
  Write-Host "  2) Paste generated MCP config into your client"
}
finally {
  Pop-Location
}

