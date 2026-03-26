#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# deploy-vps.sh — Déploiement BOTVINTEDCODEX vers VPS
#
# Usage:
#   chmod +x deploy-vps.sh
#   ./deploy-vps.sh              # Deploy complet (rsync + npm install + PM2)
#   ./deploy-vps.sh --files-only # Transfert uniquement (sans restart PM2)
#   ./deploy-vps.sh --restart    # Restart PM2 uniquement (sans rsync)
#
# Prérequis:
#   - SSH configuré sans mot de passe (clé SSH dans ~/.ssh/)
#   - rsync installé localement
#   - Node.js + PM2 installés sur le VPS
# ──────────────────────────────────────────────────────────────────────────────

set -e

VPS_HOST="root@76.13.148.209"
REMOTE_DIR="/root/botvintedcodex"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================="
echo "  BOTVINTEDCODEX — Deploy VPS"
echo "========================================="
echo "  Host:   $VPS_HOST"
echo "  Remote: $REMOTE_DIR"
echo "  Local:  $LOCAL_DIR"
echo "  Date:   $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="

# ─── Restart uniquement ─────────────────────────────────────────────────────

if [ "$1" = "--restart" ]; then
  echo "[deploy-vps] Restart PM2 sur le VPS..."
  ssh "$VPS_HOST" "cd $REMOTE_DIR && pm2 stop ecosystem.config.js 2>/dev/null || true && pm2 delete ecosystem.config.js 2>/dev/null || true && pm2 start ecosystem.config.js && pm2 save && pm2 list"
  echo "[deploy-vps] Restart OK."
  exit 0
fi

# ─── 1. Transfert des fichiers projet ────────────────────────────────────────
# On transfère TOUT sauf :
#   - .git         (historique git inutile sur le VPS)
#   - node_modules (sera rebuilt par npm install)
#   - output/http-cache (trop volumineux, sera rebuild automatiquement)
# On INCLUT output/ et tous ses fichiers JSON :
#   - output/price-database.json   (150 produits accumulés — NE PAS PERDRE)
#   - output/seen-listings.json
#   - output/opportunities-history.json
#   - output/apify-usage.json
#   - output/portfolio-items.json
#   - output/learned-rules.json
#   - output/feedback-reports.json

echo ""
echo "[deploy-vps] Transfert fichiers vers $VPS_HOST:$REMOTE_DIR ..."
echo "  (inclut output/*.json — exclut output/http-cache et node_modules)"

rsync -avz --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='output/http-cache' \
  --exclude='output/agents' \
  --exclude='*.bak' \
  --exclude='.env' \
  "$LOCAL_DIR/" "$VPS_HOST:$REMOTE_DIR/"

echo "[deploy-vps] Transfert fichiers : OK"

if [ "$1" = "--files-only" ]; then
  echo "[deploy-vps] Mode --files-only : arrêt ici (pas de restart PM2)."
  exit 0
fi

# ─── 2. Copie du .env ────────────────────────────────────────────────────────
# Le .env n'est jamais commité — on le copie séparément.

echo ""
if [ -f "$LOCAL_DIR/.env" ]; then
  echo "[deploy-vps] Copie .env..."
  scp "$LOCAL_DIR/.env" "$VPS_HOST:$REMOTE_DIR/.env"
  echo "[deploy-vps] .env copié : OK"
else
  echo "[ATTENTION] Pas de .env local trouvé."
  echo "  → Vérifiez que le .env existe déjà sur le VPS : ssh $VPS_HOST 'ls -la $REMOTE_DIR/.env'"
fi

# ─── 3. npm install + démarrage PM2 ──────────────────────────────────────────

echo ""
echo "[deploy-vps] Installation dépendances + démarrage PM2 sur le VPS..."

ssh "$VPS_HOST" bash << REMOTE
set -e
cd $REMOTE_DIR

# Créer les répertoires nécessaires
mkdir -p logs output output/http-cache

# Vérifier que Node.js est disponible
node --version
npm --version

# Installer les dépendances (production uniquement)
echo "→ npm install --production..."
npm install --production

# Vérifier la syntaxe avant de (re)démarrer
echo "→ Vérification syntaxe..."
node --check src/index.js
node --check src/server.js
echo "  Syntaxe OK."

# PM2 : stop → delete → start (propre)
echo "→ PM2 restart..."
pm2 stop ecosystem.config.js 2>/dev/null || true
pm2 delete ecosystem.config.js 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

echo ""
pm2 list
REMOTE

echo ""
echo "========================================="
echo "  DEPLOY VPS TERMINÉ"
echo "========================================="
echo ""
echo "Commandes utiles (sur le VPS) :"
echo "  ssh $VPS_HOST"
echo "  pm2 logs bot-scanner      # Logs en live"
echo "  pm2 monit                 # Monitoring CPU/RAM"
echo "  pm2 list                  # État des processus"
echo "  ./deploy-vps.sh --restart # Restart sans retransférer les fichiers"
echo ""
