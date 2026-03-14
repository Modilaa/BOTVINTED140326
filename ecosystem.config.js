module.exports = {
  apps: [
    {
      name: 'botvintedcodex',
      script: 'src/index.js',
      args: '--loop',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production'
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
