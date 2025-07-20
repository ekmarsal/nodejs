// FINAL COMPLETE DEBUG VERSION
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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Database helper functions
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
        const result = await pool.query(
            `INSERT INTO customers (email, name, phone) VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, updated_at = CURRENT_TIMESTAMP
             RETURNING id`, [email, name, phone]
        );
        return result.rows[0].id;
    } catch (error) {
        console.error('❌ Error saving customer:', error);
        return null;
    }
}

async function saveBooking(bookingData, customerId) {
    console.log('DEBUG_STEP_4: Inside saveBooking, before query');
    try {
        const booking = bookingData.booking;
        const fareharborId = booking.pk;
        const customerEmail = booking.contact.email;
        const customerName = booking.contact.name;
        const tourName = booking.availability.item.name;
        const tourDate = booking.availability.start_at;
        const passengerCount = booking.customer_count;
        const amount = booking.invoice_price / 100; // FareHarbor provides price in cents
        const status = booking.status;
        const bookingSource = booking.source;

        if (!fareharborId) {
            console.error('❌ No FareHarbor ID found in booking data');
            return;
        }

        await pool.query(
            `INSERT INTO bookings (fareharbor_id, customer_id, customer_email, customer_name, tour_name, tour_date, passenger_count, amount, status, booking_source, raw_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (fareharbor_id) DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount, passenger_count = EXCLUDED.passenger_count, updated_at = CURRENT_TIMESTAMP`,
            [fareharborId, customerId, customerEmail, customerName, tourName, tourDate, passengerCount, amount, status, bookingSource, JSON.stringify(bookingData)]
        );
        console.log('DEBUG_STEP_5: After query, booking saved successfully');
    } catch (error) {
        console.error('❌ Error saving booking:', error);
        console.log('Booking data that failed:', JSON.stringify(bookingData, null, 2));
        throw error;
    }
}

// --- Main Webhook Route ---
app.post('/webhook', async (req, res) => {
    console.log('--- FULL INCOMING WEBHOOK DATA ---');
    console.log(JSON.stringify(req.body, null, 2));

    const bookingData = req.body;

    if (bookingData && bookingData.booking) {
        console.log('DEBUG_STEP_1: Booking data found, proceeding.');
        try {
            console.log('DEBUG_STEP_2: Calling saveOrUpdateCustomer');
            const customerId = await saveOrUpdateCustomer(bookingData.booking.contact);

            console.log('DEBUG_STEP_3: Calling saveBooking');
            await saveBooking(bookingData, customerId);

            res.status(200).json({ status: 'success' });
        } catch (error) {
            console.error('❌ Error processing webhook:', error);
            res.status(500).json({ status: 'error' });
        }
    } else {
        console.log('⚠️ Webhook received, but not a recognized booking format.');
        res.status(200).json({ status: 'ignored', message: 'Not a booking event' });
    }
});

// --- Other Routes ---
app.get('/analytics', (req, res) => res.json({ message: "Analytics endpoint active" }));
app.get('/stats', (req, res) => res.json({ message: "Stats endpoint active" }));
app.get('/', (req, res) => res.json({ service: 'FareHarbor Webhook Server', status: 'running' }));

// --- Server Start ---
app.listen(PORT, () => {
    console.log(`🚀 FareHarbor Webhook Server Started on port ${PORT}`);
});
