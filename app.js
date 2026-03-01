// USA Guided Tours - FareHarbor Webhook Server
// Updated: March 1, 2026
// Changes: Added booking_source extraction, fixed amount to use receipt_total/100
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();

// CORS headers first
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});

// Raw body capture for webhook signature verification - with increased limit
app.use('/webhook', express.raw({ type: 'application/json', limit: '50mb' }), (req, res, next) => {
  req.rawBody = req.body;
  if (req.rawBody && req.rawBody.length > 0) {
    req.body = JSON.parse(req.body.toString());
  } else {
    req.body = {};
  }
  next();
});

// JSON parsing for all other routes
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables on startup
async function initializeDatabase() {
  try {
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

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

// Webhook signature verification
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-fareharbor-signature'];
  const webhookSecret = process.env.FAREHARBOR_WEBHOOK_SECRET;

  console.log('🔐 Webhook received with signature:', signature ? 'present' : 'missing');

  if (!webhookSecret) {
    console.warn('⚠️ FAREHARBOR_WEBHOOK_SECRET not set - skipping signature verification');
    return next();
  }

  if (!signature) {
    console.error('❌ No signature found in headers');
    return res.status(401).json({ error: 'No signature provided' });
  }

  try {
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.rawBody)
      .digest('hex');

    const providedSignature = signature.startsWith('sha256=') ? signature.slice(7) : signature;

    if (crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(providedSignature))) {
      console.log('✅ Webhook signature verified successfully');
      next();
    } else {
      console.error('❌ Invalid webhook signature');
      res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (error) {
    console.error('❌ Error verifying signature:', error);
    res.status(401).json({ error: 'Signature verification failed' });
  }
}

// ============================================================
// BOOKING SOURCE EXTRACTION (NEW)
// Maps FareHarbor payload fields to a clean source label
// ============================================================
function extractBookingSource(bookingData) {
  try {
    // Priority 1: affiliate_company.shortname (Viator, GetYourGuide, Expedia, Klook, etc.)
    const affiliateShortname = bookingData.affiliate_company?.shortname;
    if (affiliateShortname) {
      const name = affiliateShortname.toLowerCase();
      // Normalize known affiliates to clean labels
      if (name.includes('viator') || name.includes('tripadvisor')) return 'viator';
      if (name.includes('getyourguide')) return 'getyourguide';
      if (name.includes('expedia')) return 'expedia';
      if (name.includes('klook')) return 'klook';
      if (name.includes('musement')) return 'musement';
      if (name.includes('civitatis')) return 'civitatis';
      if (name.includes('tiqets')) return 'tiqets';
      // Return the raw shortname for any other affiliate/network partner
      return affiliateShortname.toLowerCase().replace(/\s+/g, '_');
    }

    // Priority 2: source_type = 'reseller' → use booked_by.name as the source
    const sourceType = bookingData.source_type;
    const bookedByName = bookingData.booked_by?.name;

    if (sourceType === 'reseller' && bookedByName) {
      return bookedByName.toLowerCase().replace(/\s+/g, '_');
    }

    // Priority 3: booked_by exists (dashboard/staff booking)
    if (bookedByName) {
      return 'staff';
    }

    // Priority 4: source_type = 'online' with no affiliate → direct website booking
    if (sourceType === 'online') {
      return 'online';
    }

    // Priority 5: source_type has a value → use it
    if (sourceType) {
      return sourceType.toLowerCase();
    }

    // Fallback
    return 'direct';
  } catch (error) {
    console.error('⚠️ Error extracting booking source:', error);
    return 'direct';
  }
}

// ============================================================
// AMOUNT EXTRACTION (FIXED)
// FareHarbor stores receipt_total in CENTS — divide by 100
// ============================================================
function extractAmount(bookingData) {
  try {
    // Priority 1: receipt_total (most accurate — includes all fees/taxes)
    if (bookingData.receipt_total != null && bookingData.receipt_total !== '') {
      const cents = parseFloat(bookingData.receipt_total);
      if (!isNaN(cents) && cents > 0) {
        return (cents / 100).toFixed(2);
      }
    }

    // Priority 2: receipt_subtotal (before taxes/fees)
    if (bookingData.receipt_subtotal != null && bookingData.receipt_subtotal !== '') {
      const cents = parseFloat(bookingData.receipt_subtotal);
      if (!isNaN(cents) && cents > 0) {
        return (cents / 100).toFixed(2);
      }
    }

    // Priority 3: amount_paid (what customer actually paid)
    if (bookingData.amount_paid != null && bookingData.amount_paid !== '') {
      const cents = parseFloat(bookingData.amount_paid);
      if (!isNaN(cents) && cents > 0) {
        return (cents / 100).toFixed(2);
      }
    }

    // Fallback
    return '0.00';
  } catch (error) {
    console.error('⚠️ Error extracting amount:', error);
    return '0.00';
  }
}

// Database helper functions
async function saveWebhookEvent(eventType, fareharborId, rawPayload, status = 'success') {
  try {
    await pool.query(`
      INSERT INTO webhook_events (event_type, fareharbor_id, raw_payload, processing_status)
      VALUES ($1, $2, $3, $4)
    `, [eventType, fareharborId, rawPayload, status]);
  } catch (error) {
    console.error('Error saving webhook event:', error);
  }
}

async function saveOrUpdateCustomer(customerData) {
  if (!customerData) return null;

  const email = customerData.email || customerData.customer?.email;
  const name = customerData.name || customerData.customer?.name;
  const phone = customerData.phone || customerData.customer?.phone;

  if (!email) {
    console.log('⚠️ No customer email found, skipping customer save');
    return null;
  }

  try {
    const result = await pool.query(`
      INSERT INTO customers (email, name, phone)
      VALUES ($1, $2, $3)
      ON CONFLICT (email)
      DO UPDATE SET
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `, [email, name, phone]);

    return result.rows[0].id;
  } catch (error) {
    console.error('Error saving customer:', error);
    return null;
  }
}

async function saveBooking(bookingData, customerId) {
  try {
    const fareharborId = bookingData.display_id || bookingData.pk || bookingData.id;
    const customerEmail = bookingData.contact?.email || bookingData.customer?.email || bookingData.customer_email;
    const customerName = bookingData.contact?.name || bookingData.customer?.name || bookingData.customer_name;
    const tourName = bookingData.availability?.item?.name || bookingData.item?.name || bookingData.tour_name || 'Unknown Tour';
    const tourDate = bookingData.availability?.start_at || bookingData.tour_date || null;
    const status = bookingData.status || bookingData.rebooked_to ? 'rebooked' : 'confirmed';

    // Count passengers from customer_type_rates array
    let passengerCount = 0;
    if (bookingData.customer_type_rates && Array.isArray(bookingData.customer_type_rates)) {
      for (const ctr of bookingData.customer_type_rates) {
        passengerCount += parseInt(ctr.quantity || ctr.count || 1);
      }
    }
    if (passengerCount === 0) {
      passengerCount = bookingData.passenger_count || bookingData.num_passengers || 1;
    }

    // NEW: Use extractAmount() instead of raw bookingData.amount
    const amount = extractAmount(bookingData);

    // NEW: Use extractBookingSource() instead of null
    const bookingSource = extractBookingSource(bookingData);

    const specialRequests = bookingData.note || bookingData.special_requests || null;

    console.log(`📝 Saving booking: ${fareharborId} | ${tourName} | $${amount} | source: ${bookingSource} | ${passengerCount} pax`);

    const result = await pool.query(`
      INSERT INTO bookings (fareharbor_id, customer_id, customer_email, customer_name, tour_name, tour_date, passenger_count, amount, status, booking_source, special_requests, raw_data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (fareharbor_id)
      DO UPDATE SET
        tour_name = EXCLUDED.tour_name,
        tour_date = EXCLUDED.tour_date,
        passenger_count = EXCLUDED.passenger_count,
        amount = EXCLUDED.amount,
        status = EXCLUDED.status,
        booking_source = EXCLUDED.booking_source,
        special_requests = EXCLUDED.special_requests,
        raw_data = EXCLUDED.raw_data,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `, [fareharborId, customerId, customerEmail, customerName, tourName, tourDate, passengerCount, amount, status, bookingSource, specialRequests, bookingData]);

    console.log(`✅ Booking saved: ${fareharborId} (DB id: ${result.rows[0].id})`);
    return result.rows[0].id;
  } catch (error) {
    console.error('❌ Error saving booking:', error);
    return null;
  }
}

// ============================================================
// WEBHOOK ENDPOINT
// ============================================================
app.post('/webhook', verifyWebhookSignature, async (req, res) => {
  const startTime = Date.now();
  console.log('\n========================================');
  console.log(`📨 Webhook received at ${new Date().toISOString()}`);

  try {
    const payload = req.body;

    // FareHarbor sends booking data in different wrapper formats
    const bookingData = payload.booking || payload.data?.booking || payload.data || payload;
    const eventType = payload.event || payload.type || 'booking_created';
    const fareharborId = bookingData.display_id || bookingData.pk || bookingData.id || 'unknown';

    console.log(`📋 Event: ${eventType} | FH ID: ${fareharborId}`);
    console.log(`💰 receipt_total: ${bookingData.receipt_total} | source_type: ${bookingData.source_type} | affiliate: ${bookingData.affiliate_company?.shortname || 'none'}`);

    // Save raw webhook event for audit trail
    await saveWebhookEvent(eventType, fareharborId, payload);

    // Handle different event types
    if (eventType === 'booking_deleted' || eventType === 'booking.deleted' || eventType === 'cancellation') {
      // Handle cancellation - update status
      try {
        await pool.query(`
          UPDATE bookings SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
          WHERE fareharbor_id = $1
        `, [fareharborId]);
        console.log(`🚫 Booking ${fareharborId} marked as cancelled`);
      } catch (err) {
        console.error('Error updating cancellation:', err);
      }
    } else {
      // New booking or update - save/update customer and booking
      const contact = bookingData.contact || bookingData.customer || {};
      const customerId = await saveOrUpdateCustomer(contact);
      await saveBooking(bookingData, customerId);
    }

    const duration = Date.now() - startTime;
    console.log(`⏱️ Processed in ${duration}ms`);
    console.log('========================================\n');

    res.status(200).json({
      status: 'success',
      fareharborId,
      eventType,
      processingTime: `${duration}ms`
    });
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// ============================================================
// HEALTH & STATUS ENDPOINTS
// ============================================================
app.get('/', (req, res) => {
  res.json({
    service: 'USA Guided Tours - FareHarbor Webhook Server',
    status: 'running',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    endpoints: {
      webhook: 'POST /webhook',
      health: 'GET /health',
      stats: 'GET /stats'
    }
  });
});

app.get('/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT COUNT(*) FROM bookings');
    res.json({
      status: 'healthy',
      database: 'connected',
      totalBookings: parseInt(dbResult.rows[0].count),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message
    });
  }
});

app.get('/stats', async (req, res) => {
  try {
    const bookingCount = await pool.query('SELECT COUNT(*) FROM bookings');
    const recentBookings = await pool.query(`
      SELECT fareharbor_id, tour_name, amount, booking_source, status, created_at
      FROM bookings ORDER BY created_at DESC LIMIT 10
    `);
    const sourceBreakdown = await pool.query(`
      SELECT booking_source, COUNT(*) as count, SUM(amount) as total_revenue
      FROM bookings
      WHERE status != 'cancelled'
      GROUP BY booking_source
      ORDER BY total_revenue DESC
    `);
    const webhookEvents = await pool.query('SELECT COUNT(*) FROM webhook_events');

    res.json({
      totalBookings: parseInt(bookingCount.rows[0].count),
      totalWebhookEvents: parseInt(webhookEvents.rows[0].count),
      recentBookings: recentBookings.rows,
      sourceBreakdown: sourceBreakdown.rows,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// START SERVER
// ============================================================
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 USA Guided Tours Webhook Server v2.0.0`);
    console.log(`📡 Listening on port ${PORT}`);
    console.log(`🔗 Webhook endpoint: POST /webhook`);
    console.log(`❤️ Health check: GET /health`);
    console.log(`📊 Stats: GET /stats\n`);
  });
});
