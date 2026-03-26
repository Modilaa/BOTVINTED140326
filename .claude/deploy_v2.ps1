# ──────────────────────────────────────────────────────────
# deploy_v2.ps1 — Envoi archive BOTVINTEDCODEX vers Hostinger
#
# Ce script ne fait QUE :
#   1. Creer l'archive tar.gz (en excluant node_modules, .bak, etc.)
#   2. L'envoyer via scp
#
# Le deploiement cote serveur se fait manuellement via fix-deploy.sh
#
# Usage:
#   .\deploy_v2.ps1
#   .\deploy_v2.ps1 -Host "root@123.456.789.0"
#   .\deploy_v2.ps1 -RemotePath "/root/botvintedcodex"
# ──────────────────────────────────────────────────────────

param(
    [string]$Host = "root@147.93.29.113",
    [string]$RemotePath = "/root/botvintedcodex",
    [string]$ArchiveName = "botvintedcodex-deploy.tar.gz"
)

$ErrorActionPreference = "Stop"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  BOTVINTEDCODEX — Envoi Archive" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Host:   $Host"
Write-Host "  Remote: $RemotePath"
Write-Host "  Date:   $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "=========================================" -ForegroundColor Cyan

# ─── Verifier qu'on est dans le bon dossier ──────────────
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if (-not (Test-Path "package.json")) {
    Write-Host "[ERREUR] package.json introuvable. Lancez ce script depuis le dossier du projet." -ForegroundColor Red
    exit 1
}

# ─── Nettoyer les anciens .bak avant archivage ──────────
Write-Host ""
Write-Host "[deploy] Nettoyage des fichiers .bak..." -ForegroundColor Yellow
$bakFiles = Get-ChildItem -Path . -Filter "*.bak" -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch "node_modules" }
if ($bakFiles.Count -gt 0) {
    $bakFiles | ForEach-Object {
        Write-Host "  Supprime: $($_.FullName)" -ForegroundColor DarkGray
        Remove-Item $_.FullName -Force
    }
    Write-Host "  $($bakFiles.Count) fichier(s) .bak supprimes." -ForegroundColor Green
} else {
    Write-Host "  Aucun fichier .bak trouve." -ForegroundColor DarkGray
}

# ─── Creer l'archive tar.gz ──────────────────────────────
Write-Host ""
Write-Host "[deploy] Creation de l'archive $ArchiveName..." -ForegroundColor Yellow

# Utiliser tar (disponible nativement sur Windows 10+)
$excludes = @(
    "--exclude=node_modules",
    "--exclude=.git",
    "--exclude=*.bak",
    "--exclude=output/http-cache",
    "--exclude=$ArchiveName"
)

$tarCmd = "tar -czf `"$ArchiveName`" $($excludes -join ' ') -C `"$projectRoot`" ."
Write-Host "  Commande: $tarCmd" -ForegroundColor DarkGray

try {
    tar -czf $ArchiveName --exclude=node_modules --exclude=.git --exclude="*.bak" --exclude="output/http-cache" --exclude=$ArchiveName -C $projectRoot .
} catch {
    Write-Host "[ERREUR] Echec creation archive: $_" -ForegroundColor Red
    exit 1
}

$archiveSize = (Get-Item $ArchiveName).Length / 1MB
Write-Host "  Archive creee: $ArchiveName ($([math]::Round($archiveSize, 2)) Mo)" -ForegroundColor Green

# ─── Envoyer via scp ─────────────────────────────────────
Write-Host ""
Write-Host "[deploy] Envoi vers $Host`:$RemotePath/..." -ForegroundColor Yellow

try {
    scp $ArchiveName "${Host}:${RemotePath}/$ArchiveName"
} catch {
    Write-Host "[ERREUR] Echec envoi scp: $_" -ForegroundColor Red
    exit 1
}

Write-Host "[deploy] Archive envoyee avec succes!" -ForegroundColor Green

# ─── Nettoyage local ─────────────────────────────────────
Remove-Item $ArchiveName -Force -ErrorAction SilentlyContinue

# ─── Instructions ─────────────────────────────────────────
Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
Write-Host "  ARCHIVE ENVOYEE" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Maintenant, connecte-toi au serveur et lance :" -ForegroundColor White
Write-Host ""
Write-Host "    ssh $Host" -ForegroundColor Cyan
Write-Host "    cd $RemotePath" -ForegroundColor Cyan
Write-Host "    bash fix-deploy.sh" -ForegroundColor Cyan
Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
