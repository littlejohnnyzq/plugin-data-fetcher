# Plugin analytics relay

The existing Express server exposes `POST /api/plugin-events` for Figma
plugins. It stores one SQLite identity row per Figma user and forwards raw
events to GA4 without retaining event history.

## Data stored locally

`state/analytics-users.sqlite` contains:

- HMAC-SHA256 Figma user ID
- stable GA4 `client_id`
- optional current display name
- cumulative plugin launch count
- first and latest observed launch timestamps

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
increments the launch counter.
