// Forcing a new build
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
  // Ensure body is not empty before parsing
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
    // Create customers table
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

    // Create bookings table
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

    // Create events table for audit trail
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

// Enhanced webhook signature verification
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
  console.log('DEBUG_STEP_4: Inside saveBooking, before query');
  try {
    const fareharborId = bookingData.display_id || bookingData.pk || bookingData.id;
    const customerEmail = bookingData.contact?.email || bookingData.customer?.email || bookingData.customer_email;
    const customerName = bookingData.contact?.name || bookingData.customer?.name || bookingData.customer_name;
    const tourName = bookingData.availability?.item?.name || bookingData.item?.name || bookingData.tour_name;
    const tourDate = bookingData.availability?.start_datetime || bookingData.start_datetime || bookingData.tour_date;
    const passengerCount = bookingData.customer_count || bookingData.passenger_count || 1;
    const amount = bookingData.amount || bookingData.price || 0;
    const status = bookingData.status || 'confirmed';
    const bookingSource = bookingData.booking_source || bookingData.source || 'fareharbor';

    if (!fareharborId) {
      console.error('❌ No FareHarbor ID found in booking data');
      return;
    }

    await pool.query(`
      INSERT INTO bookings (
        fareharbor_id, customer_id, customer_email, customer_name,
        tour_name, tour_date, passenger_count, amount, status,
        booking_source, special_requests, raw_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (fareharbor_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        amount = EXCLUDED.amount,
        passenger_count = EXCLUDED.passenger_count,
        customer_email = EXCLUDED.customer_email,
        customer_name = EXCLUDED.customer_name,
        tour_name = EXCLUDED.tour_name,
        tour_date = EXCLUDED.tour_date,
        updated_at = CURRENT_TIMESTAMP
    `, [
      fareharborId,
      customerId,
      customerEmail,
      customerName,
      tourName,
      tourDate,
      passengerCount,
      amount,
      status,
      bookingSource,
      bookingData.special_requests || null,
      JSON.stringify(bookingData)
    ]);

    console.log('DEBUG_STEP_5: After query, before success log');
    console.log('✅ Booking saved to database successfully');
  } catch (error) {
    console.error('❌ Error saving booking:', error);
    console.log('Booking data that failed:', JSON.stringify(bookingData, null, 2));
    throw error;
  }
}

// Enhanced webhook endpoint with better logging
app.post('/webhook', verifyWebhookSignature, async (req, res) => {
  const { event_type, payload, timestamp } = req.body;

  console.log('=== WEBHOOK RECEIVED ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Event Type: ${event_type}`);

  try {
    await saveWebhookEvent(event_type, payload?.display_id || payload?.pk, req.body);

    switch (event_type) {
      case 'booking.created':
        console.log('DEBUG_STEP_1: Routing to handleBookingCreated');
        await handleBookingCreated(payload);
        break;
      case 'booking.updated':
        // Other handlers can have debug steps too if needed
        await handleBookingUpdated(payload);
        break;
      case 'booking.cancelled':
        await handleBookingCancelled(payload);
        break;
      // ... other cases
      default:
        console.log(`⚠️ Unhandled event type: ${event_type}`);
    }

    res.status(200).json({
      status: 'success',
      message: 'Webhook processed successfully'
    });
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    await saveWebhookEvent(event_type, payload?.display_id || payload?.pk, req.body, 'error');
    res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Event handlers with database integration
async function handleBookingCreated(booking) {
  console.log('DEBUG_STEP_2: Calling saveOrUpdateCustomer');
  const customerId = await saveOrUpdateCustomer(booking.contact || booking.customer);
  console.log('DEBUG_STEP_3: Calling saveBooking');
  await saveBooking(booking, customerId);
  console.log('✅ New booking processed and saved');
}

async function handleBookingUpdated(booking) {
  const customerId = await saveOrUpdateCustomer(booking.contact || booking.customer);
  await saveBooking(booking, customerId);
  console.log('✅ Booking update processed and saved');
}

async function handleBookingCancelled(booking) {
  try {
    await pool.query(`
      UPDATE bookings
      SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE fareharbor_id = $1
    `, [booking.display_id || booking.pk]);
    console.log('✅ Cancellation processed and saved');
  } catch (error) {
    console.error('❌ Error updating cancelled booking:', error);
  }
}

// ... other handlers and endpoints
// Health check endpoint with database status
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'healthy' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// ... other endpoints like stats, analytics, etc.
app.get('/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total_bookings,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_bookings,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_bookings,
        COALESCE(SUM(amount), 0) as total_revenue,
        COUNT(DISTINCT customer_email) as unique_customers
      FROM bookings
    `);
    res.json({ stats: stats.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/analytics', async (req, res) => {
  try {
    const totalStats = await pool.query(`
      SELECT
        COUNT(*) as total_bookings,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_bookings,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_bookings,
        COALESCE(SUM(amount), 0) as total_revenue,
        COALESCE(AVG(amount), 0) as average_booking_value,
        COUNT(DISTINCT customer_email) as unique_customers
      FROM bookings
    `);
    const dailyRevenue = await pool.query(`
      SELECT DATE(created_at) as booking_date, COUNT(*) as bookings_count, COALESCE(SUM(amount), 0) as daily_revenue
      FROM bookings WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at) ORDER BY booking_date DESC
    `);
    const topTours = await pool.query(`
      SELECT tour_name, COUNT(*) as booking_count, COALESCE(SUM(amount), 0) as tour_revenue
      FROM bookings WHERE tour_name IS NOT NULL
      GROUP BY tour_name ORDER BY booking_count DESC LIMIT 10
    `);
    const recentBookings = await pool.query(`
      SELECT fareharbor_id, customer_name, customer_email, tour_name, amount, status, created_at
      FROM bookings ORDER BY created_at DESC LIMIT 20
    `);
    res.json({
      summary: totalStats.rows[0],
      dailyRevenue: dailyRevenue.rows,
      topTours: topTours.rows,
      recentBookings: recentBookings.rows,
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics data' });
  }
});

// Start the server and initialize database
app.listen(PORT, async () => {
  console.log(`🚀 FareHarbor Webhook Server Started on port ${PORT}`);
  await initializeDatabase();
  console.log('🔗 Ready to receive FareHarbor webhooks!');
});

module.exports = app;
