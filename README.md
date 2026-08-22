# FareHarbor Webhook Server

Receives FareHarbor booking webhooks for USA Guided Tours (`usaguidedtoursdc`,
`usaguidedtoursny`) and writes them to Railway Postgres for reporting.

## Endpoints

| Method | Path | Auth |
|---|---|---|
| `POST` | `/webhook` | HMAC-SHA256 signature (`x-fareharbor-signature`) |
| `GET` | `/health` | none — liveness only, no business metrics |
| `GET` | `/stats` | `Authorization: Bearer $ADMIN_API_TOKEN` |
| `GET` | `/privacy/subject?email=` | `Authorization: Bearer $ADMIN_API_TOKEN` |
| `POST` | `/privacy/erase` | `Authorization: Bearer $ADMIN_API_TOKEN` |

## Setup

```bash
npm install
cp .env.example .env      # then fill in the required values
npm start
```

Three variables are required: `FAREHARBOR_WEBHOOK_SECRET`, `DATABASE_URL`,
and `ADMIN_API_TOKEN`. Generate the admin token with `openssl rand -hex 32`.

Without the webhook secret, `/webhook` returns 503 by design — it will not
silently accept unsigned traffic. See [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test
```

Runs the security smoke tests with Postgres stubbed; no infrastructure needed.

## Documentation

- [SECURITY.md](SECURITY.md) — threat model, controls, operational requirements
- [docs/DATA-HANDLING.md](docs/DATA-HANDLING.md) — personal data inventory,
  retention, disclosures, and data-subject request handling
