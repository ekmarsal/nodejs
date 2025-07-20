require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const webhookRoutes = require('./routes/webhookRoutes'); // Import the new route file

const app = express();

// CORS headers first
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});

// Raw body capture needed for webhook signature verification.
// This MUST come before the webhookRoutes are used.
app.use('/webhook', express.raw({ type: 'application/json', limit: '50mb' }), (req, res, next) => {
  req.rawBody = req.body;
  try {
    if (req.rawBody && req.rawBody.length > 0) {
        req.body = JSON.parse(req.body.toString());
    } else {
        req.body = {};
    }
  } catch (e) {
    console.error("Error parsing raw body:", e);
    req.body = {}; // Reset body on parsing error
  }
  next();
});

// General JSON parsing for other routes
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Use the webhook routes for any request to /webhook
app.use('/webhook', webhookRoutes);

// --- Analytics, Stats, and other routes remain here for now ---

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'healthy', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', database: 'disconnected', error: error.message });
  }
});

// Stats endpoint
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

// Analytics endpoint
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

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'FareHarbor Webhook Server',
    status: 'running',
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 FareHarbor Webhook Server Started on port ${PORT}`);
});

module.exports = app;
