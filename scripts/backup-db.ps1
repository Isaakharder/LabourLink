<#
.SYNOPSIS
  Backs up the LabourLink production PostgreSQL database to a timestamped
  file in a host folder (default C:\LabourLinkBackups).

.EXAMPLE
  .\scripts\backup-db.ps1
  .\scripts\backup-db.ps1 -BackupDir "D:\Backups\LabourLink"
#>
param(
    [string]$BackupDir = $(if ($env:LABOURLINK_BACKUP_DIR) { $env:LABOURLINK_BACKUP_DIR } else { "C:\LabourLinkBackups" }),
    [string]$EnvFile = ".env.production",
    [string]$ComposeFile = "docker-compose.prod.yml"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$fileName = "labourlink_$timestamp.dump"

Write-Host "Backing up LabourLink database to $BackupDir\$fileName ..."

# Runs pg_dump inside the postgres container, writing directly to the
# /backups bind mount (mapped to $BackupDir on the host) — avoids piping
# pg_dump's binary custom-format output through PowerShell stdout
# redirection, which is unreliable on Windows.
$dumpCmd = "pg_dump -U `$POSTGRES_USER -d `$POSTGRES_DB -F c -f /backups/$fileName"
docker compose -f $ComposeFile --env-file $EnvFile exec -T postgres sh -c $dumpCmd

if ($LASTEXITCODE -ne 0) {
    throw "pg_dump failed (exit code $LASTEXITCODE)"
}

Write-Host "Backup complete: $BackupDir\$fileName"
