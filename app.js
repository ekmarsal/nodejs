Require('dotenv').config();
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

// Raw body capture for webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
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

    console.log('💾 Saving booking data:');
    console.log(`  FareHarbor ID: ${fareharborId}`);
    console.log(`  Customer: ${customerName} (${customerEmail})`);
    console.log(`  Tour: ${tourName}`);
    console.log(`  Amount: $${amount}`);

    if (!fareharborId) {
      console.error('❌ No FareHarbor ID found in booking data');
      console.log('Full booking data:', JSON.stringify(bookingData, null, 2));
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

    console.log('✅ Booking saved to database successfully');
  } catch (error)
 {
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
  console.log(`FareHarbor Timestamp: ${timestamp}`);
  console.log('Full Request Body:', JSON.stringify(req.body, null, 2));
  console.log('========================');

  try {
    await saveWebhookEvent(event_type, payload?.display_id || payload?.pk, req.body);

    switch (event_type) {
      case 'booking.created':
        console.log('🎉 Processing booking.created event');
        await handleBookingCreated(payload);
        break;
      case 'booking.updated':
        console.log('📝 Processing booking.updated event');
        await handleBookingUpdated(payload);
        break;
      case 'booking.cancelled':
        console.log('❌ Processing booking.cancelled event');
        await handleBookingCancelled(payload);
        break;
      case 'item.created':
        console.log('🆕 Processing item.created event');
        await handleItemCreated(payload);
        break;
      case 'item.updated':
        console.log('🔄 Processing item.updated event');
        await handleItemUpdated(payload);
        break;
      default:
        console.log(`⚠️ Unhandled event type: ${event_type}`);
        console.log('Payload:', JSON.stringify(payload, null, 2));
    }

    res.status(200).json({
      status: 'success',
      message: 'Webhook processed successfully',
      event_type: event_type,
      timestamp: new Date().toISOString()
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
  console.log('🎉 NEW BOOKING CREATED!');
  console.log(`Booking ID: ${booking.display_id || booking.pk}`);
  console.log(`Customer: ${booking.contact?.name || booking.customer?.name || 'Unknown'}`);
  console.log(`Email: ${booking.contact?.email || booking.customer?.email || 'No email'}`);
  console.log(`Amount: $${booking.amount || 0}`);
  console.log(`Customers: ${booking.customer_count || 0}`);

  if (booking.availability?.item || booking.item) {
    console.log(`Tour: ${booking.availability?.item?.name || booking.item?.name}`);
    console.log(`Date: ${booking.availability?.start_datetime || booking.start_datetime}`);
  }

  const customerId = await saveOrUpdateCustomer(booking.contact || booking.customer);
  await saveBooking(booking, customerId);
  console.log('✅ New booking processed and saved');
}

async function handleBookingUpdated(booking) {
  console.log('📝 BOOKING UPDATED');
  console.log(`Booking ID: ${booking.display_id || booking.pk}`);
  console.log(`Status: ${booking.status}`);

  const customerId = await saveOrUpdateCustomer(booking.contact || booking.customer);
  await saveBooking(booking, customerId);
  console.log('✅ Booking update processed and saved');
}

async function handleBookingCancelled(booking) {
  console.log('❌ BOOKING CANCELLED');
  console.log(`Booking ID: ${booking.display_id || booking.pk}`);
  console.log(`Customer: ${booking.contact?.name || booking.customer?.name || 'Unknown'}`);

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

async function handleItemCreated(item) {
  console.log('🆕 NEW ITEM CREATED');
  console.log(`Item: ${item.name}`);
  console.log(`Shortname: ${item.shortname}`);
  console.log('✅ New item processed');
}

async function handleItemUpdated(item) {
  console.log('🔄 ITEM UPDATED');
  console.log(`Item: ${item.name}`);
  console.log(`Shortname: ${item.shortname}`);
  console.log('✅ Item update processed');
}

// Health check endpoint with database status
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({
      status: 'healthy',
      service: 'FareHarbor Webhook Server',
      database: 'connected',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      service: 'FareHarbor Webhook Server',
      database: 'disconnected',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// New endpoint to get booking stats
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

    res.json({
      stats: stats.rows[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Advanced Analytics dashboard route
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
      SELECT
        DATE(created_at) as booking_date,
        COUNT(*) as bookings_count,
        COALESCE(SUM(amount), 0) as daily_revenue
      FROM bookings
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY booking_date DESC
    `);

    const topTours = await pool.query(`
      SELECT
        tour_name,
        COUNT(*) as booking_count,
        COALESCE(SUM(amount), 0) as tour_revenue
      FROM bookings
      WHERE tour_name IS NOT NULL
      GROUP BY tour_name
      ORDER BY booking_count DESC
      LIMIT 10
    `);

    const recentBookings = await pool.query(`
      SELECT
        fareharbor_id,
        customer_name,
        customer_email,
        tour_name,
        amount,
        status,
        created_at
      FROM bookings
      ORDER BY created_at DESC
      LIMIT 20
    `);

    res.json({
      summary: totalStats.rows[0],
      dailyRevenue: dailyRevenue.rows,
      topTours: topTours.rows,
      recentBookings: recentBookings.rows,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics data' });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'FareHarbor Webhook Server',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      webhook: 'POST /webhook - Receives FareHarbor webhooks',
      health: 'GET /health - Health check with database status',
      stats: 'GET /stats - Booking statistics',
      analytics: 'GET /analytics - Advanced analytics dashboard',
      debug: 'GET /debug-data - Debug data inspection'
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

// Test endpoint to see raw webhook data from FareHarbor
app.post('/test-webhook', (req, res) => {
  console.log('=== TEST WEBHOOK RECEIVED ===');
  console.log('Time:', new Date().toISOString());
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('Raw Body:', req.rawBody);
  console.log('=============================');

  res.status(200).json({
    status: 'received',
    message: 'Test webhook data logged successfully',
    timestamp: new Date().toISOString()
  });
});

// Test endpoint to check what's in your database
app.get('/debug-data', async (req, res) => {
  try {
    const bookings = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    const webhookEvents = await pool.query('SELECT * FROM webhook_events ORDER BY processed_at DESC LIMIT 10');

    res.json({
      totalBookings: bookings.rows.length,
      recentBookings: bookings.rows,
      recentWebhookEvents: webhookEvents.rows,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// Start the server and initialize database
app.listen(PORT, async () => {
  console.log('🚀 FareHarbor Webhook Server Started');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌐 Webhook endpoint: /webhook`);
  console.log(`❤️ Health check: /health`);
  console.log(`📊 Stats endpoint: /stats`);
  console.log(`📈 Analytics endpoint: /analytics`);
  console.log(`🔍 Debug endpoint: /debug-data`);
  console.log(`⚙️ Environment: ${process.env.NODE_ENV || 'development'}`);

  await initializeDatabase();

  console.log('🔗 Ready to receive FareHarbor webhooks!');
});

module.exports = app;
