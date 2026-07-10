<#
.SYNOPSIS
  Restores the LabourLink production PostgreSQL database from a backup file.
  DESTRUCTIVE — replaces all current data.

.EXAMPLE
  .\scripts\restore-db.ps1 -BackupFile "C:\LabourLinkBackups\labourlink_20260710_120000.dump"
#>
param(
    [Parameter(Mandatory = $true)][string]$BackupFile,
    [string]$EnvFile = ".env.production",
    [string]$ComposeFile = "docker-compose.prod.yml"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $BackupFile)) {
    throw "Backup file not found: $BackupFile"
}

Write-Warning "This will REPLACE ALL DATA in the LabourLink production database."
Write-Warning "Source: $BackupFile"
$confirmation = Read-Host "Type YES to continue"
if ($confirmation -ne "YES") {
    Write-Host "Cancelled. No changes made."
    exit 1
}

$leaf = Split-Path $BackupFile -Leaf
$containerPath = "/tmp/$leaf"

Write-Host "Copying backup into the postgres container..."
docker compose -f $ComposeFile --env-file $EnvFile cp $BackupFile "postgres:$containerPath"
if ($LASTEXITCODE -ne 0) { throw "docker compose cp failed" }

Write-Host "Restoring (this may take a while)..."
$restoreCmd = "pg_restore -U `$POSTGRES_USER -d `$POSTGRES_DB --clean --if-exists `"$containerPath`""
docker compose -f $ComposeFile --env-file $EnvFile exec -T postgres sh -c $restoreCmd
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed (exit code $LASTEXITCODE)" }

docker compose -f $ComposeFile --env-file $EnvFile exec -T postgres rm -f $containerPath | Out-Null

Write-Host "Restore complete. Restart the api container so it picks up any schema changes:"
Write-Host "  docker compose -f $ComposeFile --env-file $EnvFile restart api"
