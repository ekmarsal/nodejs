# Security

## Reporting a vulnerability

Email the maintainer directly rather than opening a public issue.

## Threat model

This service receives booking data from FareHarbor over the public
internet and writes it to Postgres. The assets worth protecting are:

| Asset | Why it matters |
|---|---|
| Customer contact details (name, email, phone) | Personal data; breach-notifiable |
| Free-text notes and custom-field answers | May contain health, dietary, accessibility data |
| Booking and revenue records | Competitively sensitive; feeds financial reporting |
| Webhook secret and admin token | Compromise allows forged bookings or full data read |

The primary threats are (1) an unauthenticated caller writing forged
bookings into the revenue database, (2) unauthenticated read of business
metrics, and (3) over-retention of personal data in the raw payload archive.

## Controls

**Authentication.** `/webhook` verifies an HMAC-SHA256 signature over the
exact request bytes, using a constant-time comparison. Verification
**fails closed**: if `FAREHARBOR_WEBHOOK_SECRET` is unset the endpoint
returns 503 rather than accepting traffic. `ALLOW_UNSIGNED_WEBHOOKS=true`
overrides this for a migration window only and logs an error on every request.

`/stats` and `/privacy/*` require a bearer token (`ADMIN_API_TOKEN`,
minimum 32 characters) compared in constant time. With no token
configured, those routes return 503 rather than opening.

**Replay protection.** Each payload is hashed; an exact repeat is
acknowledged with 200 but not reprocessed. When FareHarbor supplies an
`x-fareharbor-timestamp` header, payloads older than
`MAX_SIGNATURE_AGE_SECONDS` are rejected.

**Data minimization.** Payment instrument fields (card numbers, CVV,
tokens, authorization codes) and custom-field answers whose label matches
a special-category pattern are redacted before anything is written to
Postgres. See `lib/redact.js`. `REDACT_ALL_CUSTOM_FIELDS=true` masks every
custom-field answer.

**Retention.** Raw webhook payloads are purged after
`EVENT_RETENTION_DAYS` (default 90). The purge runs at startup and daily.

**Transport and headers.** CORS is an explicit allowlist and empty by
default. `X-Powered-By` is disabled; `nosniff`, `DENY` framing,
`no-referrer`, `no-store`, and HSTS are set on every response.

**Denial of service.** Request bodies are capped at 1 MB (was 50 MB) and
`/webhook` is rate limited per source IP.

**Error handling.** Responses carry a request id, never an internal error
message. Logs correlate by that id and mask email addresses.

## Operational requirements

- Rotate `FAREHARBOR_WEBHOOK_SECRET` and `ADMIN_API_TOKEN` at least annually
  and immediately after any staff departure with Railway access.
- Grant the application's Postgres role only `SELECT/INSERT/UPDATE/DELETE`
  on its three tables. It currently runs DDL at boot; once the schema is
  stable, run migrations separately and drop `CREATE` from the app role.
- Enable `DATABASE_SSL_VERIFY=true` once a CA bundle is supplied via
  `PGSSLROOTCERT`. Certificate verification is off by default because
  Railway's managed Postgres presents a self-signed certificate.
- Keep Railway logs' retention aligned with `EVENT_RETENTION_DAYS`.
