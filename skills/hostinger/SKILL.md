---
name: hostinger
description: Deploy, migrate, configure, or troubleshoot sites, apps, domains, DNS, email, SSL, reverse proxies, cron jobs, and VPS workloads on Hostinger. Use when Codex needs to help with Hostinger hPanel or shared hosting, Hostinger VPS setup, Node.js app deployment, PM2 or Nginx configuration, domain cutovers, or operational debugging on Hostinger.
---

# Hostinger

## Start With Product Fit

- Identify the Hostinger surface first: shared hosting in hPanel, VPS, or a managed site builder.
- Treat long-running processes, Node.js servers, Playwright jobs, Docker, custom ports, workers, or root-level package installs as VPS work unless the user proves another Hostinger product supports it.
- Treat static sites, WordPress, PHP apps, email, DNS, and simple cron jobs as hPanel work unless the user needs OS-level control.
- Call out bad fits early. A background bot or scraper should not be forced onto shared hosting.

## Gather The Minimum Inputs

Collect only what changes the plan:

- target product: shared hosting, VPS, or unknown
- OS and distro if VPS
- domain or subdomain
- app type: static, PHP, Node.js, bot, API, WordPress, email, database
- whether the process must stay online continuously or can run on a schedule
- repo or artifact source
- env vars, secrets, storage, database, and webhook needs
- current pain: first deploy, migration, DNS cutover, SSL, downtime, logs, permissions, or limits

## Pick The Workflow

### Shared Hosting Or hPanel

- Use hPanel for domains, DNS zones, email boxes, SSL, file manager, databases, cron, and WordPress-style workloads.
- Prefer simple file uploads, Git deploys if available, or CMS-native workflows.
- Avoid promising custom daemons, persistent Node processes, or arbitrary system package installs.
- Before any DNS change, inventory existing A, AAAA, CNAME, MX, TXT, SPF, DKIM, and DMARC records.

### VPS

- Use SSH-driven workflows for Node.js, Python, Docker, reverse proxies, queues, schedulers, and anything that needs root or a persistent process.
- Prefer Ubuntu-style runbooks unless the user confirms a different distro.
- Create a clear deploy path: system packages, runtime install, app directory, env file, process manager, web server, firewall, and health checks.
- Read [references/node-vps-runbook.md](references/node-vps-runbook.md) for Node.js and bot-style deployments.
- Read [references/hostinger-surfaces.md](references/hostinger-surfaces.md) if the correct Hostinger product is unclear.
- Read [references/troubleshooting.md](references/troubleshooting.md) when symptoms matter more than setup.

### Managed Builder Or Non-Code Product

- Confirm whether the user is actually working in a no-code Hostinger product.
- Keep instructions inside the product UI if possible; do not invent shell access or filesystem control.

## Node And Bot Guidance

- Recommend VPS for Node.js servers, Telegram bots, Playwright jobs, scraping pipelines, or PM2-managed workers.
- For a background bot with no public HTTP endpoint, skip Nginx unless webhooks, dashboards, or health endpoints are required.
- For Playwright-based apps, make browser installation and Linux dependencies explicit during provisioning.
- Prefer PM2 or systemd for persistence. Use cron only when a scheduled batch job is enough.

## Domain, Email, And SSL Safety

- Lower TTL before planned cutovers when timing matters.
- Preserve existing mail records unless the user explicitly wants email reconfigured.
- Check for nameserver mismatches before assuming a DNS record edit in Hostinger will take effect.
- Validate both DNS resolution and certificate issuance after changes.
- Mention rollback steps before replacing working records or web server configs.

## Deliverables

When helping with Hostinger tasks, provide:

1. a short architecture decision
2. exact commands or UI steps
3. config files or diffs when relevant
4. validation commands or checks
5. rollback notes for risky changes
