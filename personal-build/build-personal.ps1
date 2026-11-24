$ErrorActionPreference = 'Stop'
# Rebuilds the personal Orca: latest upstream main + the feature branches below, then the Windows installer.
$features = @('origin/feat/project-groups-dnd', 'origin/feat/project-group-nesting', 'origin/feat/project-group-appearance', 'origin/feat/relay-runtime-pairing-port')

Set-Location (Join-Path $PSScriptRoot '..')
# VsDevCmd needs vswhere on PATH, or it reports VSCMD_VER=17.0 and Orca's native build rejects the toolchain.
$env:PATH = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer;$env:USERPROFILE\.cargo\bin;$env:PATH"
if (git status --porcelain --untracked-files=no) { throw 'Uncommitted changes in the build worktree; commit or discard them first.' }

git fetch upstream main
git fetch origin
foreach ($ref in @('upstream/main') + $features) {
  Write-Host "Merging $ref"
  git merge --no-edit $ref
  if ($LASTEXITCODE -ne 0) { throw "Merge of $ref has conflicts; resolve them, commit, and rerun." }
}

pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
pnpm -C mobile install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'mobile pnpm install failed' }
pnpm build:win
if ($LASTEXITCODE -ne 0) { throw 'pnpm build:win failed' }

$installer = Get-ChildItem dist -Filter '*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "Installer: $($installer.FullName)"
