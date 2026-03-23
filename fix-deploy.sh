#!/bin/bash
# ──────────────────────────────────────────────────────────
# fix-deploy.sh — Deploiement cote serveur BOTVINTEDCODEX
#
# A lancer APRES avoir envoye l'archive via deploy_v2.ps1
#
# Usage:
#   cd /root/botvintedcodex
#   bash fix-deploy.sh
# ──────────────────────────────────────────────────────────

set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

ARCHIVE="botvintedcodex-deploy.tar.gz"

echo "========================================="
echo "  BOTVINTEDCODEX — Deploiement Serveur"
echo "========================================="
echo "  Dossier: $APP_DIR"
echo "  Date:    $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="

# ─── Verifier que l'archive existe ───────────────────────
if [ ! -f "$ARCHIVE" ]; then
  echo "[ERREUR] Archive $ARCHIVE introuvable."
  echo "  Lance d'abord deploy_v2.ps1 depuis Windows."
  exit 1
fi

# ─── Sauvegarder .env et output ──────────────────────────
echo ""
echo "[deploy] Sauvegarde .env et output..."
cp -f .env .env.deploy-backup 2>/dev/null || true
if [ -d "output" ]; then
  cp -r output output.deploy-backup 2>/dev/null || true
fi

# ─── Extraire l'archive ──────────────────────────────────
echo "[deploy] Extraction de l'archive..."
tar -xzf "$ARCHIVE" --overwrite

# ─── Restaurer .env ──────────────────────────────────────
echo "[deploy] Restauration du .env..."
cp -f .env.deploy-backup .env 2>/dev/null || true

# ─── Restaurer output (si backup existe) ─────────────────
if [ -d "output.deploy-backup" ]; then
  echo "[deploy] Restauration des donnees output..."
  # Copier les fichiers de backup seulement s'ils n'existent pas deja
  cp -rn output.deploy-backup/* output/ 2>/dev/null || true
fi

# ─── Preparer les dossiers ────────────────────────────────
mkdir -p logs output output/agents output/http-cache

# ─── Installer les dependances ────────────────────────────
echo ""
echo "[deploy] Installation des dependances..."
npm install --production
echo "[deploy] Dependances installees."

# ─── Verifier la syntaxe ─────────────────────────────────
echo ""
echo "[deploy] Verification syntaxe..."
node --check src/index.js
node --check src/scheduler.js
node --check src/server.js
echo "[deploy] Syntaxe OK."

# ─── Verifier PM2 ────────────────────────────────────────
if ! command -v pm2 &> /dev/null; then
  echo "[deploy] Installation de PM2..."
  npm install -g pm2
fi

# ─── Deploiement PM2 ─────────────────────────────────────
echo ""
echo "[deploy] Arret des anciens process..."
pm2 stop ecosystem.config.js 2>/dev/null || true
pm2 delete ecosystem.config.js 2>/dev/null || true

echo "[deploy] Demarrage de l'ecosysteme..."
pm2 start ecosystem.config.js

pm2 save

# ─── Nettoyage ────────────────────────────────────────────
rm -f "$ARCHIVE"
rm -f .env.deploy-backup
rm -rf output.deploy-backup

echo ""
echo "========================================="
echo "  DEPLOIEMENT TERMINE"
echo "========================================="
echo ""
pm2 list
echo ""
echo "Commandes utiles:"
echo "  pm2 logs bot-scanner    # Logs du scanner"
echo "  pm2 logs scheduler      # Logs du scheduler"
echo "  pm2 monit               # Monitoring en live"
echo ""
