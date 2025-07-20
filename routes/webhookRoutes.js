const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const router = express.Router();

// Re-initialize the pool connection within this file
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// --- All your original helper functions ---

// (verifyWebhookSignature, saveWebhookEvent, saveOrUpdateCustomer, saveBooking, etc. remain here)
// ...

// --- The Main Webhook Route with added logging ---
router.post('/', async (req, res) => {
    // THIS IS THE NEW DEBUGGING LINE
    console.log('--- FULL INCOMING WEBHOOK DATA ---');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('--- END OF WEBHOOK DATA ---');

    const { event_type, payload } = req.body;
    console.log(`Received event: ${event_type}`);

    try {
        // ... (rest of the try block)
    } catch (error) {
        // ... (rest of the catch block)
    }
});

module.exports = router;
