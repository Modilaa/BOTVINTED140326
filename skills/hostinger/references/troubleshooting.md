# Hostinger Troubleshooting

## App Does Not Start

- Check the runtime first: `node -v`, `npm -v`, and the package manager lockfile.
- Check for missing env vars before changing code.
- Check ownership and permissions on the app directory.
- Read the real process output with `pm2 logs <app>` or `journalctl`.

## HTTP 502 Or Timeout

- Confirm the app process is actually running.
- Confirm the app is listening on the port Nginx expects.
- Check whether the app binds to `127.0.0.1` or `0.0.0.0` and whether that matches the topology.
- Re-test with a direct local `curl` before editing Nginx again.

## Playwright Or Browser Failures

- Re-check browser installation on the VPS.
- Re-check system dependencies and available memory.
- Expect browser automation to fit VPS better than shared hosting.
- Capture the exact missing library or sandbox error before changing flags.

## DNS Or SSL Problems

- Confirm where the domain's nameservers point.
- Check whether old `AAAA` or proxy records still override the intended target.
- Wait for TTL when a record was changed recently.
- Issue SSL only after DNS resolves to the correct host.

## Email Breakage After DNS Changes

- Compare old and new MX, SPF, DKIM, and DMARC values.
- Restore mail records before continuing with web tuning if email is broken.
- Avoid replacing all TXT records with a single new value.

## Safe Debug Pattern

1. capture the exact symptom
2. inspect logs and process state
3. test the smallest local path first
4. change one layer at a time
5. validate before moving to the next layer
