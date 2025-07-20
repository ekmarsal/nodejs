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

// Raw body capture for webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json', limit: '50mb' }), (req, res, next) => {
  req.rawBody = req.body;
  if (req.rawBody && req.rawBody.length > 0) {
      req.body = JSON.parse(req.body.toString());
  } else {
      req.body = {};
  }
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables on startup
async function initializeDatabase() {
  // ... (database initialization logic remains the same)
}

// --- All other functions (verifyWebhookSignature, saveBooking, etc.) remain here ---

// Health check endpoint - SIMPLIFIED
app.get('/health', async (req, res) => {
  // A simple health check that doesn't depend on the database.
  res.status(200).json({ status: 'healthy' });
});

// --- All other routes (/webhook, /stats, /analytics, etc.) remain here ---

app.listen(PORT, async () => {
  console.log(`🚀 FareHarbor Webhook Server Started on port ${PORT}`);
  await initializeDatabase();
  console.log('🔗 Ready to receive FareHarbor webhooks!');
});

module.exports = app;
