const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const router = express.Router();

// Re-initialize the pool connection within this file
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// --- All your original helper functions go here ---

// Enhanced webhook signature verification
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-fareharbor-signature'];
  const webhookSecret = process.env.FAREHARBOR_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return next(); // Skip if no secret is set
  }
  if (!signature) {
    return res.status(401).json({ error: 'No signature provided' });
  }

  try {
    const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(req.rawBody).digest('hex');
    const providedSignature = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    if (crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(providedSignature))) {
      next();
    } else {
      res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (error) {
    res.status(401).json({ error: 'Signature verification failed' });
  }
}

// Database helper functions
async function saveWebhookEvent(eventType, fareharborId, rawPayload, status = 'success') {
  try {
    await pool.query(
      'INSERT INTO webhook_events (event_type, fareharbor_id, raw_payload, processing_status) VALUES ($1, $2, $3, $4)',
      [eventType, fareharborId, rawPayload, status]
    );
  } catch (error) {
    console.error('Error saving webhook event:', error);
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
      `INSERT INTO customers (email, name, phone) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [email, name, phone]
    );
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

    if (!fareharborId) {
        console.error('❌ No FareHarbor ID found in booking data');
        return;
    }

    await pool.query(
      `INSERT INTO bookings (fareharbor_id, customer_id, customer_email, customer_name, tour_name, tour_date, passenger_count, amount, status, booking_source, special_requests, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (fareharbor_id) DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount, passenger_count = EXCLUDED.passenger_count, customer_email = EXCLUDED.customer_email, customer_name = EXCLUDED.customer_name, tour_name = EXCLUDED.tour_name, tour_date = EXCLUDED.tour_date, updated_at = CURRENT_TIMESTAMP`,
      [fareharborId, customerId, customerEmail, customerName, tourName, tourDate, passengerCount, amount, status, bookingSource, bookingData.special_requests || null, JSON.stringify(bookingData)]
    );
    console.log('✅ Booking saved to database successfully');
  } catch (error) {
    console.error('❌ Error saving booking:', error);
    throw error;
  }
}

// Event handler functions
async function handleBookingCreated(booking) {
  const customerId = await saveOrUpdateCustomer(booking.contact || booking.customer);
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
    await pool.query(
      'UPDATE bookings SET status = \'cancelled\', updated_at = CURRENT_TIMESTAMP WHERE fareharbor_id = $1',
      [booking.display_id || booking.pk]
    );
    console.log('✅ Cancellation processed and saved');
  } catch (error) {
    console.error('❌ Error updating cancelled booking:', error);
  }
}

// --- The Main Webhook Route ---
router.post('/', verifyWebhookSignature, async (req, res) => {
    const { event_type, payload } = req.body;
    console.log(`Received event: ${event_type}`);

    try {
        await saveWebhookEvent(event_type, payload?.display_id || payload?.pk, req.body);

        switch (event_type) {
            case 'booking.created':
                await handleBookingCreated(payload);
                break;
            case 'booking.updated':
                await handleBookingUpdated(payload);
                break;
            case 'booking.cancelled':
                await handleBookingCancelled(payload);
                break;
            default:
                console.log(`⚠️ Unhandled event type: ${event_type}`);
        }
        res.status(200).json({ status: 'success' });
    } catch (error) {
        console.error('❌ Error processing webhook:', error);
        await saveWebhookEvent(event_type, payload?.display_id || payload?.pk, req.body, 'error');
        res.status(500).json({ status: 'error' });
    }
});

module.exports = router;
