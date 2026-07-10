<#
.SYNOPSIS
  Rolls back the LabourLink deployment to a previous commit/tag and rebuilds
  the production stack. Does NOT roll back the database automatically.

.EXAMPLE
  .\scripts\rollback.ps1 -CommitOrTag abc1234
#>
param(
    [Parameter(Mandatory = $true)][string]$CommitOrTag,
    [string]$EnvFile = ".env.production",
    [string]$ComposeFile = "docker-compose.prod.yml"
)

$ErrorActionPreference = "Stop"

Write-Warning "Rolling back code to $CommitOrTag and rebuilding containers."
Write-Warning "This does NOT roll back the database automatically. If the failed"
Write-Warning "update included a migration, restore a pre-update backup manually:"
Write-Warning "  .\scripts\list-backups.ps1"
Write-Warning "  .\scripts\restore-db.ps1 -BackupFile <path>"

git checkout $CommitOrTag
if ($LASTEXITCODE -ne 0) { throw "git checkout failed" }

docker compose -f $ComposeFile --env-file $EnvFile up -d --build
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

Write-Host "Rolled back to $CommitOrTag."
