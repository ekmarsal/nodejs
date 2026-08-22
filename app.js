// USA Guided Tours - FareHarbor Webhook Server
// v3.0.0 - hardened ingestion pipeline
//
// Security posture:
//   - Webhook signatures are verified and FAIL CLOSED. A missing secret
//     rejects traffic instead of silently accepting it.
//   - Operational and privacy endpoints require a bearer token.
//   - Payment data and special-category custom-field answers are stripped
//     before any payload is archived.
//   - Raw webhook events are purged on a retention schedule.
require('dotenv').config();

const express = require('express');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const { redactPayload, maskEmail } = require('./lib/redact');
const {
  safeEqual,
  rateLimit,
  requireAdminToken,
  securityHeaders,
  corsAllowlist,
  requestId,
} = require('./lib/security');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------
const CONFIG = {
  // FareHarbor booking payloads are small; 1 MB is generous. The previous
  // 50 MB ceiling let an unauthenticated caller stall the event loop.
  bodyLimit: process.env.WEBHOOK_BODY_LIMIT || '1mb',

  // Explicit, loudly-named escape hatch for a migration window only.
  allowUnsigned: process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true',

  // Mask every custom-field answer rather than only special-category ones.
  redactAllCustomFields: process.env.REDACT_ALL_CUSTOM_FIELDS === 'true',

  // How long the raw event archive is kept. 0 disables the purge.
  eventRetentionDays: parseInt(process.env.EVENT_RETENTION_DAYS || '90', 10),

  // Reject signed payloads older than this to blunt replay attacks.
  maxSignatureAgeSeconds: parseInt(process.env.MAX_SIGNATURE_AGE_SECONDS || '300', 10),

  // Verify the Postgres server certificate. Left off by default because
  // Railway's managed Postgres presents a self-signed cert; turn on once
  // the CA bundle is supplied via PGSSLROOTCERT.
  verifyDbCert: process.env.DATABASE_SSL_VERIFY === 'true',
};

// ------------------------------------------------------------
// Global middleware
// ------------------------------------------------------------
app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway terminates TLS at its edge proxy.

app.use(requestId);
app.use(securityHeaders);
app.use(corsAllowlist);

// ------------------------------------------------------------
// Database
// ------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: IS_PRODUCTION ? { rejectUnauthorized: CONFIG.verifyDbCert } : false,
  max: parseInt(process.env.PGPOOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE,
      name VARCHAR(255),
      phone VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      fareharbor_id VARCHAR(100) UNIQUE NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      customer_email VARCHAR(255),
      customer_name VARCHAR(255),
      tour_name VARCHAR(255),
      tour_date TIMESTAMP,
      passenger_count INTEGER,
      amount DECIMAL(10,2),
      status VARCHAR(50),
      booking_source VARCHAR(100),
      special_requests TEXT,
      raw_data JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id SERIAL PRIMARY KEY,
      event_type VARCHAR(100),
      fareharbor_id VARCHAR(100),
      processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      raw_payload JSONB,
      processing_status VARCHAR(50) DEFAULT 'success'
    )
  `);

  // Replay detection: a hash of the exact bytes FareHarbor delivered.
  await pool.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS payload_hash CHAR(64)`);

  // Indexes for the retention purge, replay lookups, and reporting.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_webhook_events_processed_at ON webhook_events (processed_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_webhook_events_payload_hash ON webhook_events (payload_hash)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings (created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bookings_source ON bookings (booking_source)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status)`);

  console.log('[db] schema initialized');
}

// ------------------------------------------------------------
// Retention purge
//
// Data minimization: the raw event archive exists for replay and
// debugging, not indefinite storage of customer records.
// ------------------------------------------------------------
async function purgeExpiredEvents() {
  if (CONFIG.eventRetentionDays <= 0) return;
  try {
    const result = await pool.query(
      `DELETE FROM webhook_events WHERE processed_at < NOW() - ($1 || ' days')::INTERVAL`,
      [String(CONFIG.eventRetentionDays)]
    );
    if (result.rowCount > 0) {
      console.log(`[retention] purged ${result.rowCount} webhook_events older than ${CONFIG.eventRetentionDays} days`);
    }
  } catch (error) {
    console.error('[retention] purge failed:', error.message);
  }
}

// ------------------------------------------------------------
// Webhook body capture and signature verification
// ------------------------------------------------------------
app.use(
  '/webhook',
  express.raw({ type: ['application/json', 'application/*+json'], limit: CONFIG.bodyLimit }),
  (req, res, next) => {
    req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (req.rawBody.length === 0) {
      return res.status(400).json({ error: 'Empty request body' });
    }
    try {
      req.parsedBody = JSON.parse(req.rawBody.toString('utf8'));
    } catch (error) {
      console.warn(`[${req.id}] malformed JSON body rejected`);
      return res.status(400).json({ error: 'Malformed JSON body' });
    }
    if (req.parsedBody === null || typeof req.parsedBody !== 'object') {
      return res.status(400).json({ error: 'Body must be a JSON object' });
    }
    return next();
  }
);

app.use(
  '/webhook',
  rateLimit({
    windowMs: parseInt(process.env.WEBHOOK_RATE_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.WEBHOOK_RATE_MAX || '300', 10),
    name: 'webhook',
  })
);

function verifyWebhookSignature(req, res, next) {
  const webhookSecret = process.env.FAREHARBOR_WEBHOOK_SECRET;

  // Fail closed. Previously a missing secret meant every caller on the
  // internet could write bookings into the revenue database.
  if (!webhookSecret) {
    if (CONFIG.allowUnsigned) {
      console.error(
        `[${req.id}] ACCEPTING UNSIGNED WEBHOOK - ALLOW_UNSIGNED_WEBHOOKS is enabled. ` +
          'This is unsafe and must be turned off once the secret is configured.'
      );
      return next();
    }
    console.error(`[${req.id}] FAREHARBOR_WEBHOOK_SECRET is not set - rejecting webhook`);
    return res.status(503).json({ error: 'Webhook verification unavailable' });
  }

  const signature = req.headers['x-fareharbor-signature'];
  if (!signature || typeof signature !== 'string') {
    console.warn(`[${req.id}] rejected: no signature header`);
    return res.status(401).json({ error: 'No signature provided' });
  }

  // Optional replay window, when FareHarbor supplies a timestamp header.
  const timestampHeader = req.headers['x-fareharbor-timestamp'];
  if (timestampHeader && CONFIG.maxSignatureAgeSeconds > 0) {
    const sent = Number(timestampHeader) * (String(timestampHeader).length > 10 ? 0.001 : 1);
    const ageSeconds = Math.abs(Date.now() / 1000 - sent);
    if (Number.isFinite(ageSeconds) && ageSeconds > CONFIG.maxSignatureAgeSeconds) {
      console.warn(`[${req.id}] rejected: signature timestamp is ${Math.round(ageSeconds)}s old`);
      return res.status(401).json({ error: 'Signature expired' });
    }
  }

  const expected = crypto.createHmac('sha256', webhookSecret).update(req.rawBody).digest('hex');
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  if (!safeEqual(expected, provided.trim().toLowerCase())) {
    console.warn(`[${req.id}] rejected: invalid signature from ${req.ip}`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  return next();
}

// JSON parsing for every other route.
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ limit: '256kb', extended: false }));

// ============================================================
// BOOKING SOURCE EXTRACTION
// Maps FareHarbor payload fields to a clean source label.
// ============================================================
function extractBookingSource(bookingData) {
  try {
    const affiliateShortname = bookingData.affiliate_company?.shortname;
    if (affiliateShortname) {
      const name = affiliateShortname.toLowerCase();
      if (name.includes('viator') || name.includes('tripadvisor')) return 'viator';
      if (name.includes('getyourguide')) return 'getyourguide';
      if (name.includes('expedia')) return 'expedia';
      if (name.includes('klook')) return 'klook';
      if (name.includes('musement')) return 'musement';
      if (name.includes('civitatis')) return 'civitatis';
      if (name.includes('tiqets')) return 'tiqets';
      return affiliateShortname.toLowerCase().replace(/\s+/g, '_');
    }

    const sourceType = bookingData.source_type;
    const bookedByName = bookingData.booked_by?.name;

    if (sourceType === 'reseller' && bookedByName) {
      return bookedByName.toLowerCase().replace(/\s+/g, '_');
    }
    if (bookedByName) return 'staff';
    if (sourceType === 'online') return 'online';
    if (sourceType) return String(sourceType).toLowerCase();

    return 'direct';
  } catch (error) {
    console.error('[parse] booking source extraction failed:', error.message);
    return 'direct';
  }
}

// ============================================================
// AMOUNT EXTRACTION
// FareHarbor stores receipt_total in CENTS - divide by 100.
// ============================================================
function extractAmount(bookingData) {
  const candidates = ['receipt_total', 'receipt_subtotal', 'amount_paid'];
  for (const field of candidates) {
    const value = bookingData[field];
    if (value == null || value === '') continue;
    const cents = parseFloat(value);
    if (!Number.isNaN(cents) && cents > 0) return (cents / 100).toFixed(2);
  }
  return '0.00';
}

// ============================================================
// STATUS EXTRACTION
//
// The previous expression was `a || b ? 'rebooked' : 'confirmed'`, which
// parses as `(a || b) ? ...` - so every booking carrying a status at all
// was written as 'rebooked'. Statuses are now mapped explicitly.
// ============================================================
function extractStatus(bookingData) {
  if (bookingData.cancelled_at) return 'cancelled';
  if (bookingData.rebooked_to || bookingData.rebooked_at) return 'rebooked';

  const raw = typeof bookingData.status === 'string' ? bookingData.status.toLowerCase().trim() : '';
  if (!raw) return 'confirmed';
  if (raw === 'booked' || raw === 'confirmed') return 'confirmed';
  if (raw.startsWith('cancel')) return 'cancelled';
  if (raw.startsWith('rebook')) return 'rebooked';
  return raw;
}

// ------------------------------------------------------------
// Persistence
// ------------------------------------------------------------
function hashPayload(rawBody) {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

async function isReplay(payloadHash) {
  try {
    const result = await pool.query(
      `SELECT 1 FROM webhook_events WHERE payload_hash = $1 LIMIT 1`,
      [payloadHash]
    );
    return result.rowCount > 0;
  } catch (error) {
    console.error('[db] replay check failed:', error.message);
    return false; // Never drop a real booking because the check failed.
  }
}

async function saveWebhookEvent(eventType, fareharborId, rawPayload, payloadHash, status = 'success') {
  try {
    await pool.query(
      `INSERT INTO webhook_events (event_type, fareharbor_id, raw_payload, payload_hash, processing_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventType, fareharborId, rawPayload, payloadHash, status]
    );
  } catch (error) {
    console.error('[db] failed to save webhook event:', error.message);
  }
}

async function saveOrUpdateCustomer(customerData) {
  if (!customerData) return null;

  const email = customerData.email || customerData.customer?.email;
  const name = customerData.name || customerData.customer?.name;
  const phone = customerData.phone || customerData.customer?.phone;

  if (!email) return null;

  try {
    const result = await pool.query(
      `INSERT INTO customers (email, name, phone)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         phone = EXCLUDED.phone,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [email, name, phone]
    );
    return result.rows[0].id;
  } catch (error) {
    console.error('[db] failed to save customer:', error.message);
    return null;
  }
}

async function saveBooking(bookingData, customerId, redactedPayload, reqId) {
  try {
    const fareharborId = bookingData.display_id || bookingData.pk || bookingData.id;
    if (!fareharborId) {
      console.warn(`[${reqId}] booking has no identifier - skipping`);
      return null;
    }

    const customerEmail = bookingData.contact?.email || bookingData.customer?.email || bookingData.customer_email;
    const customerName = bookingData.contact?.name || bookingData.customer?.name || bookingData.customer_name;
    const tourName =
      bookingData.availability?.item?.name || bookingData.item?.name || bookingData.tour_name || 'Unknown Tour';
    const tourDate = bookingData.availability?.start_at || bookingData.tour_date || null;
    const status = extractStatus(bookingData);

    let passengerCount = 0;
    if (Array.isArray(bookingData.customer_type_rates)) {
      for (const ctr of bookingData.customer_type_rates) {
        passengerCount += parseInt(ctr.quantity || ctr.count || 1, 10) || 0;
      }
    }
    if (passengerCount === 0) {
      passengerCount = bookingData.customer_count || bookingData.passenger_count || bookingData.num_passengers || 1;
    }

    const amount = extractAmount(bookingData);
    const bookingSource = extractBookingSource(bookingData);
    const specialRequests = bookingData.note || bookingData.special_requests || null;

    // Log the shape of the booking, never the customer's identity.
    console.log(
      `[${reqId}] booking ${fareharborId} | ${tourName} | $${amount} | ${bookingSource} | ${passengerCount} pax | ${status}`
    );

    const result = await pool.query(
      `INSERT INTO bookings (
         fareharbor_id, customer_id, customer_email, customer_name, tour_name, tour_date,
         passenger_count, amount, status, booking_source, special_requests, raw_data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (fareharbor_id) DO UPDATE SET
         tour_name = EXCLUDED.tour_name,
         tour_date = EXCLUDED.tour_date,
         passenger_count = EXCLUDED.passenger_count,
         amount = EXCLUDED.amount,
         status = EXCLUDED.status,
         booking_source = EXCLUDED.booking_source,
         special_requests = EXCLUDED.special_requests,
         raw_data = EXCLUDED.raw_data,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [
        String(fareharborId), customerId, customerEmail, customerName, tourName, tourDate,
        passengerCount, amount, status, bookingSource, specialRequests, redactedPayload,
      ]
    );

    return result.rows[0].id;
  } catch (error) {
    console.error(`[${reqId}] failed to save booking:`, error.message);
    return null;
  }
}

// ============================================================
// WEBHOOK ENDPOINT
// ============================================================
app.post('/webhook', verifyWebhookSignature, async (req, res) => {
  const startTime = Date.now();

  try {
    const payload = req.parsedBody;
    const bookingData = payload.booking || payload.data?.booking || payload.data || payload;
    const eventType = payload.event || payload.type || 'booking_created';
    const fareharborId = String(bookingData.display_id || bookingData.pk || bookingData.id || 'unknown');
    const payloadHash = hashPayload(req.rawBody);

    if (await isReplay(payloadHash)) {
      console.log(`[${req.id}] duplicate payload for ${fareharborId} - acknowledged without reprocessing`);
      return res.status(200).json({ status: 'duplicate', fareharborId });
    }

    // Everything persisted from here on is the redacted copy.
    const redacted = redactPayload(payload, { redactAllCustomFields: CONFIG.redactAllCustomFields });
    const redactedBooking = redactPayload(bookingData, { redactAllCustomFields: CONFIG.redactAllCustomFields });

    console.log(`[${req.id}] event=${eventType} fh_id=${fareharborId}`);

    await saveWebhookEvent(eventType, fareharborId, redacted, payloadHash);

    const isCancellation =
      eventType === 'booking_deleted' || eventType === 'booking.deleted' || eventType === 'cancellation';

    if (isCancellation) {
      await pool.query(
        `UPDATE bookings SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE fareharbor_id = $1`,
        [fareharborId]
      );
      console.log(`[${req.id}] booking ${fareharborId} marked cancelled`);
    } else {
      const contact = bookingData.contact || bookingData.customer || {};
      if (contact.email) {
        console.log(`[${req.id}] contact ${maskEmail(contact.email)}`);
      }
      const customerId = await saveOrUpdateCustomer(contact);
      await saveBooking(bookingData, customerId, redactedBooking, req.id);
    }

    return res.status(200).json({
      status: 'success',
      fareharborId,
      eventType,
      processingTime: `${Date.now() - startTime}ms`,
    });
  } catch (error) {
    // Log detail server-side; return nothing that describes internals.
    console.error(`[${req.id}] webhook processing error:`, error);
    return res.status(500).json({ error: 'Internal server error', requestId: req.id });
  }
});

// ============================================================
// PUBLIC ENDPOINTS
// ============================================================

// Service banner. Deliberately does not enumerate protected routes.
app.get('/', (req, res) => {
  res.json({ service: 'USA Guided Tours - FareHarbor Webhook Server', status: 'running' });
});

// Liveness probe. Returns no business metrics - booking volume is
// competitively sensitive and used to be readable by anyone.
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', database: 'connected' });
  } catch (error) {
    console.error(`[${req.id}] health check failed:`, error.message);
    res.status(503).json({ status: 'unhealthy', database: 'disconnected' });
  }
});

// ============================================================
// PROTECTED OPERATIONAL ENDPOINTS
// ============================================================
const adminLimiter = rateLimit({ windowMs: 60000, max: 30, name: 'admin' });

app.get('/stats', adminLimiter, requireAdminToken, async (req, res) => {
  try {
    const [bookingCount, recentBookings, sourceBreakdown, webhookEvents] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM bookings'),
      pool.query(
        `SELECT fareharbor_id, tour_name, amount, booking_source, status, created_at
         FROM bookings ORDER BY created_at DESC LIMIT 10`
      ),
      pool.query(
        `SELECT booking_source, COUNT(*) AS count, SUM(amount) AS total_revenue
         FROM bookings WHERE status <> 'cancelled'
         GROUP BY booking_source ORDER BY total_revenue DESC`
      ),
      pool.query('SELECT COUNT(*) FROM webhook_events'),
    ]);

    res.json({
      totalBookings: parseInt(bookingCount.rows[0].count, 10),
      totalWebhookEvents: parseInt(webhookEvents.rows[0].count, 10),
      recentBookings: recentBookings.rows,
      sourceBreakdown: sourceBreakdown.rows,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[${req.id}] stats query failed:`, error.message);
    res.status(500).json({ error: 'Query failed', requestId: req.id });
  }
});

// ============================================================
// PRIVACY ENDPOINTS (GDPR Art. 15/17, CPRA 1798.105/110)
//
// These make data-subject access and erasure requests a routine
// operation rather than a manual database edit.
// ============================================================
const privacyLimiter = rateLimit({ windowMs: 60000, max: 10, name: 'privacy' });

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Access request: everything held about one customer.
app.get('/privacy/subject', privacyLimiter, requireAdminToken, async (req, res) => {
  const email = normalizeEmail(req.query.email);
  if (!email) return res.status(400).json({ error: 'email query parameter is required' });

  try {
    const customer = await pool.query(`SELECT * FROM customers WHERE LOWER(email) = $1`, [email]);
    const bookings = await pool.query(
      `SELECT id, fareharbor_id, customer_email, customer_name, tour_name, tour_date,
              passenger_count, amount, status, booking_source, special_requests, created_at, updated_at
       FROM bookings WHERE LOWER(customer_email) = $1 ORDER BY created_at DESC`,
      [email]
    );

    console.log(`[${req.id}] DSAR access request fulfilled for ${maskEmail(email)}`);
    res.json({ customer: customer.rows, bookings: bookings.rows, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error(`[${req.id}] DSAR access failed:`, error.message);
    res.status(500).json({ error: 'Query failed', requestId: req.id });
  }
});

// Erasure request: pseudonymize rather than delete, so revenue history
// stays intact while the person is no longer identifiable.
app.post('/privacy/erase', privacyLimiter, requireAdminToken, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'email is required in the request body' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tombstone = `erased-${crypto.createHash('sha256').update(email).digest('hex').slice(0, 16)}@erased.invalid`;

    const bookingsUpdated = await client.query(
      `UPDATE bookings
          SET customer_email = $2,
              customer_name = 'ERASED',
              special_requests = NULL,
              raw_data = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE LOWER(customer_email) = $1`,
      [email, tombstone]
    );

    const eventsUpdated = await client.query(
      `UPDATE webhook_events SET raw_payload = NULL
        WHERE fareharbor_id IN (SELECT fareharbor_id FROM bookings WHERE customer_email = $1)`,
      [tombstone]
    );

    const customersUpdated = await client.query(
      `UPDATE customers
          SET email = $2, name = 'ERASED', phone = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE LOWER(email) = $1`,
      [email, tombstone]
    );

    await client.query('COMMIT');

    console.log(
      `[${req.id}] erasure completed for ${maskEmail(email)}: ` +
        `${customersUpdated.rowCount} customer, ${bookingsUpdated.rowCount} bookings, ${eventsUpdated.rowCount} events`
    );

    res.json({
      status: 'erased',
      customersUpdated: customersUpdated.rowCount,
      bookingsUpdated: bookingsUpdated.rowCount,
      eventsUpdated: eventsUpdated.rowCount,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[${req.id}] erasure failed:`, error.message);
    res.status(500).json({ error: 'Erasure failed', requestId: req.id });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// Fallbacks
// ------------------------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') {
    console.warn(`[${req.id}] rejected oversized body`);
    return res.status(413).json({ error: 'Payload too large' });
  }
  console.error(`[${req.id}] unhandled error:`, error);
  return res.status(500).json({ error: 'Internal server error', requestId: req.id });
});

// ============================================================
// STARTUP
// ============================================================
function reportStartupPosture() {
  if (!process.env.FAREHARBOR_WEBHOOK_SECRET) {
    console.error(
      CONFIG.allowUnsigned
        ? '[startup] WARNING: unsigned webhooks are being accepted (ALLOW_UNSIGNED_WEBHOOKS=true)'
        : '[startup] WARNING: FAREHARBOR_WEBHOOK_SECRET is unset - /webhook will return 503'
    );
  }
  if (!process.env.ADMIN_API_TOKEN) {
    console.warn('[startup] ADMIN_API_TOKEN is unset - /stats and /privacy/* are disabled');
  }
  if (IS_PRODUCTION && !CONFIG.verifyDbCert) {
    console.warn('[startup] Postgres TLS certificate verification is off (set DATABASE_SSL_VERIFY=true once a CA is configured)');
  }
}

let server;

async function start() {
  await initializeDatabase();
  await purgeExpiredEvents();

  const purgeTimer = setInterval(purgeExpiredEvents, 24 * 60 * 60 * 1000);
  if (typeof purgeTimer.unref === 'function') purgeTimer.unref();

  reportStartupPosture();

  server = app.listen(PORT, () => {
    console.log(`[startup] FareHarbor webhook server v3.0.0 listening on port ${PORT}`);
  });
}

async function shutdown(signal) {
  console.log(`[shutdown] received ${signal}`);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  start().catch((error) => {
    console.error('[startup] failed:', error);
    process.exit(1);
  });
}

module.exports = { app, extractBookingSource, extractAmount, extractStatus, pool };
