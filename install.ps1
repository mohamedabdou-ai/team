# Team for Claude Code - Copyright 2026 Mohammed Abdo - Apache-2.0 - https://github.com/Engmohammedabdo/team
# Manual install on Windows, without the plugin system: copies the skill into Claude Code's
# personal skills folder. Run again to update. Your config.json there is kept if it already exists.
$src  = Join-Path $PSScriptRoot "skills\team"
$dest = Join-Path $env:USERPROFILE ".claude\skills\team"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -Force (Join-Path $src "SKILL.md") $dest
Copy-Item -Recurse -Force (Join-Path $src "scripts") $dest
Copy-Item -Recurse -Force (Join-Path $src "prompts") $dest
foreach ($f in "LICENSE","NOTICE") { Copy-Item -Force (Join-Path $PSScriptRoot $f) $dest }
if (-not (Test-Path (Join-Path $dest "config.json"))) { Copy-Item (Join-Path $src "config.json") $dest }
Write-Output "Installed the team skill to $dest"
