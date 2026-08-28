# Plugin analytics relay

The existing Express server exposes `POST /api/plugin-events` for multiple
Figma plugins. It stores one shared SQLite identity row per Figma user and
forwards raw events to GA4 without retaining event history. The same Figma
user therefore keeps one GA4 `client_id` across every plugin product.

## Data stored locally

`state/analytics-users.sqlite` contains:

- `analytics_users`: HMAC-SHA256 Figma user ID, stable GA4 `client_id`, current
  display name, total launch count and observed timestamps
- `analytics_plugins`: plugin ID, current name/version and observed timestamps
- `analytics_user_plugins`: per-user/per-plugin launch count, current version
  and observed timestamps

The raw Figma user ID and raw event payloads are never stored.

## Configuration

Copy the values from `.env.example` into the environment used to start
`server.js`. Secrets must not be committed to Git.

Before deployment, revoke the old GA4 Measurement Protocol secret because it
previously appeared as a fallback value in Git history. Create a new secret in:

```text
GA4 > Admin > Data streams > Measurement Protocol API secrets
```

Generate the HMAC secret on the server:

```bash
openssl rand -hex 32
```

Start with `GA4_DEBUG=true`. The GA4 debug endpoint validates events but does
not collect them. After `/analytics-healthz` reports success and the first event
passes validation, switch `GA4_DEBUG=false` and restart the process.

## Endpoints

```text
POST /api/plugin-events
GET  /analytics-healthz
```

The existing `/ga-proxy` endpoint remains available for older clients, but it
now requires `MEASUREMENT_ID` and `API_SECRET` from the server environment.

## Adding events

Every accepted event name must appear in `ALLOWED_EVENT_NAMES`:

```env
ALLOWED_EVENT_NAMES=plugin_launch,generate_bar_chart,generate_line_chart
```

All events reuse the same user-to-client-ID mapping. Only `plugin_launch`
increments the global and per-plugin launch counters. Add every product to the
allowlist while keeping all of them on the same relay and HMAC secret:

```env
ALLOWED_PLUGIN_IDS=1370606842652257742,another_figma_plugin_id
```

In GA4, register `plugin_id`, `plugin_name` and `plugin_version` as event-scoped
custom dimensions so reports and retention explorations can be filtered or
compared by plugin product. Do not create a separate GA4 `client_id` namespace
per plugin.
