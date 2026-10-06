// Configuración de pm2 para baileys_esam (opcional).
// Uso: npm run build && pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'baileys_esam',
      script: 'dist/index.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'storage/logs/pm2-error.log',
      out_file: 'storage/logs/pm2-out.log',
      time: true,
    },
  ],
};
