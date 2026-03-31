const fs = require('fs');
const path = require('path');

// Parse .env file manually (no dotenv dependency needed)
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  const vars = {};
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      vars[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
    }
  } catch {}
  return vars;
}

const envVars = loadEnvFile();

module.exports = {
  apps: [
    // ─── Process 1 : Bot Scanner (scan Vinted toutes les 15 min) ───
    {
      name: 'bot-scanner',
      script: 'src/index.js',
      args: '--loop --interval=15',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        // Fix SSL certificate errors on VPS (OpenAI, Telegram APIs)
        NODE_TLS_REJECT_UNAUTHORIZED: envVars.NODE_TLS_REJECT_UNAUTHORIZED || '1',
        // Limit Node.js heap to 700MB — les données (price-db 5MB, scan 24MB) prennent ~600MB au démarrage
        NODE_OPTIONS: '--use-openssl-ca --max-old-space-size=1400',
        ...envVars
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10000,
      // Logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/bot-scanner-error.log',
      out_file: 'logs/bot-scanner-output.log',
      merge_logs: true,
      // Log rotation: max 10MB per log file, keep 5 rotations
      max_size: '10M',
      retain: 5,
      // Memory limit: restart if > 800MB (VPS has 8GB, bot uses ~620MB at startup)
      max_memory_restart: '1500M',
      // Exponential backoff on crash
      exp_backoff_restart_delay: 5000
    },

    // ─── Process 2 : Scheduler — DÉSACTIVÉ ──────────────────────────────────
    // Le scheduler (agents autonomes) spammait des messages Discovery inutiles.
    // Pour le relancer manuellement via le dashboard : boutons "Lancer" dans server.js.
    // {
    //   name: 'scheduler',
    //   script: 'src/scheduler.js',
    //   cwd: __dirname,
    //   env: { NODE_ENV: 'production', ...envVars },
    //   autorestart: true,
    //   max_restarts: 50,
    //   restart_delay: 10000,
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss',
    //   error_file: 'logs/scheduler-error.log',
    //   out_file: 'logs/scheduler-output.log',
    //   merge_logs: true,
    //   max_memory_restart: '512M',
    //   exp_backoff_restart_delay: 5000
    // },

    // ─── Note : le Dashboard (port 3000) est lance automatiquement ──
    // par le bot-scanner via require('./server') dans index.js.
    // Pas besoin d'un process PM2 separe pour eviter un conflit de port.
    // Si tu veux le lancer separement, decommente ci-dessous et
    // desactive le require('./server') dans index.js.
    //
    // {
    //   name: 'dashboard',
    //   script: 'src/server.js',
    //   cwd: __dirname,
    //   env: { NODE_ENV: 'production', ...envVars },
    //   autorestart: true,
    //   max_restarts: 20,
    //   restart_delay: 5000,
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss',
    //   error_file: 'logs/dashboard-error.log',
    //   out_file: 'logs/dashboard-output.log',
    //   merge_logs: true,
    //   max_memory_restart: '256M'
    // }
  ]
};
