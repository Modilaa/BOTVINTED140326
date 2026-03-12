# Node.js On Hostinger VPS

## Use This Reference

Read this file when deploying or repairing a Node.js app, API, webhook receiver, bot, or Playwright workload on a Hostinger VPS.

## Default Architecture

- Use a VPS, not shared hosting, for persistent Node.js processes.
- Use a dedicated app directory such as `/opt/<app>` or `/srv/<app>`.
- Install a current Node LTS release.
- Keep secrets in an `.env` file or other protected runtime config, not hard-coded in the repo.
- Use PM2 or systemd for process persistence.
- Add Nginx only if the app exposes HTTP or HTTPS traffic.

## Bootstrap Checklist

Adapt commands to the distro if it is not Ubuntu or Debian-like.

```bash
sudo apt update
sudo apt install -y nginx ufw git curl unzip build-essential
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## App Setup

```bash
sudo adduser deploy
sudo mkdir -p /opt/<app>
sudo chown -R deploy:deploy /opt/<app>
su - deploy
cd /opt/<app>
git clone <repo-url> .
npm ci
```

If the repo uses Playwright, install browsers and Linux dependencies during provisioning:

```bash
npx playwright install --with-deps chromium
```

Create runtime configuration before the first start:

```bash
cp .env.example .env
nano .env
```

## Start The App

For a background worker or bot:

```bash
cd /opt/<app>
pm2 start src/index.js --name <app> --cwd /opt/<app>
pm2 save
pm2 startup
```

For an HTTP service, start the app first and then reverse-proxy it with Nginx.

## Nginx Pattern

Use this only when the app listens on an internal port such as `3000`.

```nginx
server {
    server_name <domain>;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then enable the site, test the config, reload Nginx, and issue SSL once DNS points correctly.

## Validation

Run the smallest checks that prove the stack is healthy:

```bash
node -v
npm -v
pm2 status
pm2 logs <app> --lines 100
ss -ltnp
systemctl status nginx
curl -I http://127.0.0.1:3000
```

If the app is job-based rather than HTTP-based, replace the `curl` check with a log or queue check that proves the worker is actually processing work.

## Rollback Notes

- Keep a copy of the previous Nginx config before replacing it.
- Do not delete a working `.env` file until the new one is verified.
- Record the old DNS values before a cutover.
- If the new release fails, restore the last known-good build and restart PM2.
