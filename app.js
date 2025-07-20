require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

// Import all route files
const webhookRoutes = require('./routes/webhookRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');

const app = express();

// --- Middleware Setup ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});

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
    req.body = {};
  }
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;

// --- Route Definitions ---
app.use('/webhook', webhookRoutes);
app.use('/', analyticsRoutes); // Use this for root paths like /stats and /analytics

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'healthy', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', database: 'disconnected', error: error.message });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'FareHarbor Webhook Server',
    status: 'running',
  });
});

// --- Error Handling and Server Start ---
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 FareHarbor Webhook Server Started on port ${PORT}`);
});

module.exports = app;
