# Server deployment

The collector listens on `127.0.0.1:1086` and is exposed only through the
Nginx routes below. The public dashboard URL is:

```text
https://tutop.top/product/plugin-data/
```

Keep the server firewall closed for public access to port 1086. Direct IP and
port access is neither required nor enabled by the default configuration.

## 1. Update the application

```bash
cd /root/plugin-data-fetcher
git pull --ff-only
```

Run `npm ci` on the first deployment or whenever `package-lock.json` changes.
The deployment that introduces `.env` loading adds the `dotenv` package, so
run it once after pulling this revision. It is unnecessary on later source-only
deployments while the lockfile remains unchanged.

Do not replace `data/`, `state/` or `.env`; they are intentionally ignored by
Git and hold the collection history, browser profile and analytics identities.

## 2. Configure private environment values

Create `/root/plugin-data-fetcher/.env` from `.env.example`, fill the real
values, then protect it:

```bash
chmod 600 /root/plugin-data-fetcher/.env
```

The GA4 `MEASUREMENT_ID` and `API_SECRET` must belong to the same GA4 data
stream. Keep one `ANALYTICS_HMAC_SECRET` and one analytics SQLite database
across every plugin so the same Figma user keeps a stable shared identity.

## 3. Keep Node running with systemd

Confirm the Node executable path first:

```bash
command -v node
```

If it is not `/usr/bin/node`, update `ExecStart` in the service template before
installing it. Then:

```bash
cp deploy/systemd/plugin-data-fetcher.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now plugin-data-fetcher
systemctl status plugin-data-fetcher --no-pager
```

When replacing an existing `screen` process, stop that old process before
starting the service so only one collector writes scheduled snapshots.

## 4. Add routes to the shared tutop.top Nginx server

This repository deliberately provides only `location` blocks. The domain is
shared by the homepage, Tura and this collector, so a second catch-all
`server_name tutop.top` configuration must not be installed.

Copy the route snippet:

```bash
mkdir -p /etc/nginx/snippets
cp deploy/nginx/plugin-data-fetcher.locations.conf /etc/nginx/snippets/
```

Add this line inside the existing HTTPS `server {}` block for `tutop.top`:

```nginx
include /etc/nginx/snippets/plugin-data-fetcher.locations.conf;
```

If the HTTP server redirects everything to HTTPS, only the HTTPS block needs
the include. Otherwise include it in both blocks. Validate before reloading:

```bash
nginx -t
systemctl reload nginx
```

Do not add CORS headers or intercept `OPTIONS` in Nginx. Express handles both
for `/api/plugin-events`.

## 5. Verify

```bash
curl -fsS http://127.0.0.1:1086/analytics-healthz
curl -fsS https://tutop.top/analytics-healthz
curl -I https://tutop.top/product/plugin-data/
journalctl -u plugin-data-fetcher -n 100 --no-pager
```

With `GA4_DEBUG=true`, Measurement Protocol requests are validated but not
collected. After validation succeeds, set `GA4_DEBUG=false`, restart the
service and launch a development plugin to send a real event:

```bash
systemctl restart plugin-data-fetcher
```
