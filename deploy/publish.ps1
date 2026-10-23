<#
  One-click publish for qianwan MEGA site.
  Steps: git commit -> push to GitHub (SSH) -> package -> upload -> rebuild containers.

  Preferred entry point (works even when scripts are blocked by policy):
    .\deploy\publish.cmd -Message "fix: xxx"

  Direct usage:
    powershell -ExecutionPolicy Bypass -File .\deploy\publish.ps1 -Message "fix: xxx"

  Options:
    -Message <string>  commit message (keep it ASCII), default "chore: update site"
    -GitOnly           only commit + push, skip server deploy
    -SkipPush          skip git entirely, only deploy current working tree

  Safety:
    - deploy/.env.production, deploy/certs, deploy/data, deploy/wechat-verification
      and deploy/nginx.container.conf are EXCLUDED from the package.
    - Before rebuild it aborts if nginx.container.conf still holds the placeholder domain.
    - Proxy env vars are cleared for git, otherwise pushes to GitHub hang.
#>
param(
  [string]$Message = "chore: update site",
  [switch]$GitOnly,
  [switch]$SkipPush
)

$ErrorActionPreference = "Stop"

# Project root = parent of this script's folder. Avoids hardcoding a CJK path,
# which breaks PowerShell 5.1 parsing on UTF-8-without-BOM files.
$ProjectDir = Split-Path -Parent $PSScriptRoot
$Server     = "root@115.191.3.2"
$RemoteApp  = "/root/app"
$RemoteDep  = "/root/app/deploy"

# ---------- locate tools ----------
$GitCandidates = @(
  "D:\LenovoSoftstore\Install\WorkBuddy\resources\vendor\PortableGit\mingw64\bin\git.exe",
  "C:\Program Files\Git\cmd\git.exe",
  "C:\Program Files (x86)\Git\cmd\git.exe"
)
$Git = $GitCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Git) {
  $c = Get-Command git -ErrorAction SilentlyContinue
  if ($c) { $Git = $c.Source } else { throw "git not found. Install Git for Windows." }
}

# Windows built-in tar is bsdtar and rejects --force-local; use PortableGit GNU tar.
# tar spawns gzip as a child, so PortableGit\usr\bin must be on PATH or it fails
# with "gzip: command not found".
$GitUsr = "D:\LenovoSoftstore\Install\WorkBuddy\resources\vendor\PortableGit\usr\bin"
$Tar = Join-Path $GitUsr "tar.exe"
if (-not (Test-Path $Tar)) { throw "GNU tar not found at $Tar" }
$env:PATH = $GitUsr + ";" + $env:PATH

$Ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
$Scp = "C:\Windows\System32\OpenSSH\scp.exe"
foreach ($t in @($Ssh, $Scp)) { if (-not (Test-Path $t)) { throw "OpenSSH not found: $t" } }

# force git to use Windows ssh (reads %USERPROFILE%\.ssh\id_ed25519)
$env:GIT_SSH_COMMAND = "`"$Ssh`""

# The host sets HTTP_PROXY/HTTPS_PROXY, which git honours above its own config
# and which makes every push to github.com hang until timeout. Clear them.
$env:HTTP_PROXY = $null
$env:HTTPS_PROXY = $null
$env:ALL_PROXY = $null
$env:NO_PROXY = $null

Write-Host "git : $Git"
Write-Host "tar : $Tar"

Set-Location $ProjectDir

# ---------- 1. commit + push ----------
if (-not $SkipPush) {
  Write-Host ""
  Write-Host "[1/4] commit and push to GitHub"
  & $Git add -A
  $pending = & $Git status --porcelain
  if ($pending) {
    & $Git commit -m $Message | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
  } else {
    Write-Host "      no file changes, skip commit"
  }
  & $Git push origin main
  if ($LASTEXITCODE -ne 0) { throw "git push failed - check network or SSH key" }
  Write-Host "      HEAD: $(& $Git log --oneline -1)"

  if ($GitOnly) { Write-Host ""; Write-Host "GitOnly set, deploy skipped."; exit 0 }
} else {
  Write-Host "[1/4] skipped (SkipPush)"
}

# ---------- 2. package ----------
Write-Host ""
Write-Host "[2/4] package working tree"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$pkgWin = Join-Path $env:TEMP "qianwan-$stamp.tar.gz"
# GNU tar wants forward slashes, scp must not see a drive-letter colon.
$pkgTar = $pkgWin.Replace('\', '/')

& $Tar --force-local `
  --exclude="deploy/.env.production" `
  --exclude="deploy/certs" `
  --exclude="deploy/data" `
  --exclude="deploy/wechat-verification" `
  --exclude="deploy/nginx.container.conf" `
  -czf $pkgTar `
  Dockerfile lib package.json patches pnpm-lock.yaml pnpm-workspace.yaml scripts server.js web deploy
if ($LASTEXITCODE -ne 0) { throw "tar failed" }
$mb = [math]::Round((Get-Item $pkgWin).Length / 1MB, 2)
Write-Host "      $pkgWin ($mb MB)"

# ---------- 3. upload ----------
# Run scp from the temp dir with a bare filename: Win32 scp treats any path
# containing a colon as host:path, so "C:\..." would be read as host "C".
Write-Host ""
Write-Host "[3/4] upload to server"
$pkgName = Split-Path $pkgWin -Leaf
Push-Location $env:TEMP
try {
  & $Scp -o StrictHostKeyChecking=accept-new $pkgName "${Server}:/root/"
  if ($LASTEXITCODE -ne 0) { throw "scp failed" }
} finally {
  Pop-Location
}
$remotePkg = "/root/$pkgName"

# ---------- 4. deploy ----------
Write-Host ""
Write-Host "[4/4] deploy on server"
$remoteScript = @"
set -e
cd $RemoteApp
tar -xzf $remotePkg
if grep -q "event.example.com" $RemoteDep/nginx.container.conf; then
  echo "ABORT: nginx.container.conf still uses placeholder domain event.example.com"
  exit 1
fi
grep -n "server_name" $RemoteDep/nginx.container.conf
cd $RemoteDep
docker compose --env-file .env.production -f compose.yaml -f compose.volcengine.yaml up -d --build
docker compose --env-file .env.production -f compose.yaml -f compose.volcengine.yaml ps
rm -f $remotePkg
"@

$remoteScript | & $Ssh -o StrictHostKeyChecking=accept-new $Server "bash -s"
if ($LASTEXITCODE -ne 0) { throw "remote deploy failed" }

Write-Host ""
Write-Host "Done. https://mega.gynnai.com/  (hard refresh with Ctrl+F5)"

# ---------- 5. verify ----------
try {
  $r = Invoke-WebRequest -Uri "https://mega.gynnai.com/" -UseBasicParsing -TimeoutSec 20
  Write-Host "Verify: HTTP $($r.StatusCode), $($r.Content.Length) bytes"
} catch {
  Write-Host "Verify: WARN - $($_.Exception.Message)"
}
