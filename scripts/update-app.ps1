<#
.SYNOPSIS
  Safely updates the running LabourLink deployment from GitHub: backs up the
  database, pulls the latest code, then rebuilds and restarts the production
  stack.

.EXAMPLE
  .\scripts\update-app.ps1
#>
param(
    [string]$EnvFile = ".env.production",
    [string]$ComposeFile = "docker-compose.prod.yml",
    [string]$Branch = "master"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Step 1/4: Backing up the database before updating..."
& (Join-Path $scriptDir "backup-db.ps1")

Write-Host "Step 2/4: Fetching latest code from GitHub..."
$previousCommit = git rev-parse HEAD
git fetch origin
git pull origin $Branch
if ($LASTEXITCODE -ne 0) { throw "git pull failed — resolve conflicts before retrying" }

Write-Host "Step 3/4: Rebuilding and restarting containers..."
docker compose -f $ComposeFile --env-file $EnvFile up -d --build
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

Write-Host "Step 4/4: Update complete."
Write-Host "Previous commit was $previousCommit."
Write-Host "If something is wrong, run: .\scripts\rollback.ps1 -CommitOrTag $previousCommit"
