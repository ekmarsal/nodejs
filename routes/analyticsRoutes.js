const express = require('express');
const { Pool } = require('pg');
const router = express.Router();

// Re-initialize the pool connection within this file
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Stats endpoint
router.get('/stats', async (req, res) => {
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
router.get('/analytics', async (req, res) => {
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

module.exports = router;
