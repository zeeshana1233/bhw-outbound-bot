// PM2 Ecosystem Config
// Start: pm2 start deploy/ecosystem.config.cjs --env production
// Docs: https://pm2.keymetrics.io/docs/usage/application-declaration/

module.exports = {
  apps: [
    {
      name: 'bhw-bot',
      script: 'src/index.js',

      // Environment
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
        DISPLAY: ':99',           // Xvfb virtual display for headless Puppeteer on Linux
      },

      // Restart policy
      restart_delay: 10000,       // wait 10s before restart
      max_restarts: 15,           // give up after 15 consecutive crashes
      min_uptime: '30s',          // must stay alive 30s to count as "started"
      exp_backoff_restart_delay: 100,

      // Logging
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Node.js flags
      node_args: '--max-old-space-size=512',

      // Watch (off in production, can turn on for dev)
      watch: false,

      // Never run more than 1 instance (stateful bot)
      instances: 1,
      exec_mode: 'fork',
    },
  ],
};
