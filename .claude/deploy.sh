#!/bin/bash
# ──────────────────────────────────────────────────────────
# deploy.sh — Deploiement complet de l'ecosysteme BOTVINTEDCODEX
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh              # Deploy complet (install + restart PM2)
#   ./deploy.sh --restart    # Restart seulement (pas de npm install)
#   ./deploy.sh --stop       # Arret de tous les process PM2
#   ./deploy.sh --status     # Statut de l'ecosysteme
#   ./deploy.sh --logs       # Voir les logs en live
# ──────────────────────────────────────────────────────────

set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "========================================="
echo "  BOTVINTEDCODEX — Deploiement Ecosysteme"
echo "========================================="
echo "  Dossier: $APP_DIR"
echo "  Date:    $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="

# ─── Commandes rapides ─────────────────────────────────────

if [ "$1" = "--stop" ]; then
  echo "[deploy] Arret de l'ecosysteme..."
  pm2 stop ecosystem.config.js 2>/dev/null || true
  pm2 delete ecosystem.config.js 2>/dev/null || true
  echo "[deploy] Ecosysteme arrete."
  exit 0
fi

if [ "$1" = "--status" ]; then
  pm2 list
  echo ""
  echo "--- Etat du scheduler ---"
  if [ -f "output/scheduler-state.json" ]; then
    cat output/scheduler-state.json | head -60
  else
    echo "(pas encore de state)"
  fi
  exit 0
fi

if [ "$1" = "--logs" ]; then
  pm2 logs --lines 50
  exit 0
fi

# ─── Preparation ─────────────────────────────────────────────

# Creer les dossiers necessaires
mkdir -p logs
mkdir -p output
mkdir -p output/agents
mkdir -p output/http-cache

# Verifier que Node.js est installe
if ! command -v node &> /dev/null; then
  echo "[ERREUR] Node.js n'est pas installe. Installez-le d'abord."
  exit 1
fi

# Verifier PM2
if ! command -v pm2 &> /dev/null; then
  echo "[deploy] Installation de PM2..."
  npm install -g pm2
fi

# ─── Installation des dependances ──────────────────────────

if [ "$1" != "--restart" ]; then
  echo ""
  echo "[deploy] Installation des dependances..."
  npm install --production
  echo "[deploy] Dependances installees."
fi

# ─── Verification du .env ─────────────────────────────────

if [ ! -f ".env" ]; then
  echo "[ERREUR] Fichier .env manquant. Copiez .env.example et configurez-le."
  exit 1
fi

# Verifier les variables critiques
if ! grep -q "TELEGRAM_BOT_TOKEN=" .env; then
  echo "[ATTENTION] TELEGRAM_BOT_TOKEN manquant dans .env"
fi

echo ""
echo "[deploy] Verification syntaxe..."
node --check src/index.js
node --check src/scheduler.js
node --check src/server.js
echo "[deploy] Syntaxe OK."

# ─── Deploiement PM2 ────────────────────────────────────────

echo ""
echo "[deploy] Arret des anciens process..."
pm2 stop ecosystem.config.js 2>/dev/null || true
pm2 delete ecosystem.config.js 2>/dev/null || true

echo "[deploy] Demarrage de l'ecosysteme..."
pm2 start ecosystem.config.js

# Sauvegarder la config PM2 pour auto-start au reboot
pm2 save

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
echo "  pm2 logs dashboard      # Logs du dashboard"
echo "  pm2 monit               # Monitoring en live"
echo "  ./deploy.sh --status    # Etat de l'ecosysteme"
echo "  ./deploy.sh --stop      # Arreter tout"
echo ""
