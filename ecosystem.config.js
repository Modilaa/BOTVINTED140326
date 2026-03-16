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
    {
      name: 'botvintedcodex',
      script: 'src/index.js',
      args: '--loop',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        ...envVars
      },
      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // Logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/error.log',
      out_file: 'logs/output.log',
      merge_logs: true,
      // Memory limit: restart if > 512MB
      max_memory_restart: '512M'
    }
  ]
};
