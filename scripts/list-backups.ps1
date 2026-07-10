<#
.SYNOPSIS
  Lists existing LabourLink database backups, newest first.
#>
param(
    [string]$BackupDir = $(if ($env:LABOURLINK_BACKUP_DIR) { $env:LABOURLINK_BACKUP_DIR } else { "C:\LabourLinkBackups" })
)

if (-not (Test-Path $BackupDir)) {
    Write-Host "No backups found — $BackupDir does not exist yet."
    exit 0
}

$backups = Get-ChildItem -Path $BackupDir -Filter "labourlink_*.dump" |
    Sort-Object LastWriteTime -Descending

if (-not $backups) {
    Write-Host "No backups found in $BackupDir."
    exit 0
}

$backups |
    Select-Object Name, @{N = 'Size (MB)'; E = { [math]::Round($_.Length / 1MB, 2) } }, LastWriteTime |
    Format-Table -AutoSize
