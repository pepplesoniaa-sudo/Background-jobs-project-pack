# Starts the web app for the dead-letter screenshot, pointed at jobs_evidence with the fake transport.
# Run from any PowerShell:  & ".\evidence_final\_helpers\start-web.ps1"
# Loads the real DATABASE_URL from .env, rewrites the database name to jobs_evidence, and overrides the
# transport to fake. The credentials are never printed. Stop the app with Ctrl+C.
. "$PSScriptRoot\env.ps1"
$env:PORT = "3200"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Write-Host "Web app starting on http://127.0.0.1:3200  (DB=jobs_evidence, transport=fake)"
Write-Host "Then open: http://127.0.0.1:3200/admin/dead"
node --env-file=.env --import tsx src/main.ts
