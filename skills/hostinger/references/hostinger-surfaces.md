# Hostinger Surfaces

## Use This Reference

Read this file when the user says "Hostinger" but does not say which product or control surface they are using.

## Capability Matrix

| Surface | Good fit | Usually a bad fit | Control level |
| --- | --- | --- | --- |
| Shared hosting in hPanel | Static sites, PHP apps, WordPress, email, DNS, SSL, file uploads, simple cron | Persistent custom workers, browser automation, Docker, arbitrary ports, root package installs | UI-first, limited server control |
| VPS | Node.js, Python, bots, APIs, queues, Playwright, Docker, Nginx, custom networking, system packages | Users who do not want to manage a server at all | Full SSH and OS control |
| Managed builder or no-code surface | Marketing sites and simple business presence | Repo-based deploys, custom backend services, long-running jobs | Product UI only |

## Decision Rules

- Choose VPS for anything that must keep running in the background.
- Choose VPS for custom runtimes, Linux packages, reverse proxies, or browser automation.
- Stay in hPanel for DNS, mailboxes, SSL, and simple website management unless the user explicitly needs server-level access.
- Ask where DNS is authoritative before editing records. The domain may use external nameservers.
- Flag migrations that touch MX, SPF, DKIM, or DMARC as higher risk than ordinary web cutovers.

## Questions That Usually Unblock The Plan

- Which Hostinger product are you using right now?
- Do you have SSH or root access?
- Is this a web app, a background worker, or only domain and email setup?
- Do you need a public domain, webhook endpoint, or only outbound jobs?
- Is mail already live on the domain?
