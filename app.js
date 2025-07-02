require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON payloads
app.use(express.json());

// Middleware to capture raw body for signature verification
app.use('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body;
  try {
    req.body = JSON.parse(req.body.toString());
  } catch (error) {
    console.log('JSON parse error:', error.message);
    console.log('Raw body:', req.body.toString());
    req.body = {};
  }
  next();
});

// Webhook signature verification middleware
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-fareharbor-signature'];
  const webhookSecret = process.env.FAREHARBOR_WEBHOOK_SECRET;
  
  console.log('Webhook received with signature:', signature ? 'present' : 'missing');
  
  if (!webhookSecret) {
    console.warn('FAREHARBOR_WEBHOOK_SECRET not set - skipping signature verification');
    return next();
  }
  
  if (!signature) {
    console.error('No signature found in headers');
    return res.status(401).json({ error: 'No signature provided' });
  }
  
  try {
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.rawBody)
      .digest('hex');
    
    if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      console.log('Signature verified successfully');
      next();
    } else {
      console.error('Invalid webhook signature');
      res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (error) {
    console.error('Error verifying signature:', error);
    res.status(401).json({ error: 'Signature verification failed' });
  }
}

// Main webhook endpoint
app.post('/webhook', verifyWebhookSignature, (req, res) => {
  const { event_type, payload, timestamp } = req.body;
  
  console.log('=== WEBHOOK RECEIVED ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Event Type: ${event_type}`);
  console.log(`FareHarbor Timestamp: ${timestamp}`);
  console.log('Payload:', JSON.stringify(payload, null, 2));
  console.log('========================');
  
  try {
    // Route to appropriate handler based on event type
    switch (event_type) {
      case 'booking.created':
        handleBookingCreated(payload);
        break;
      case 'booking.updated':
        handleBookingUpdated(payload);
        break;
      case 'booking.cancelled':
        handleBookingCancelled(payload);
        break;
      case 'item.created':
        handleItemCreated(payload);
        break;
      case 'item.updated':
        handleItemUpdated(payload);
        break;
      default:
        console.log(`⚠️  Unhandled event type: ${event_type}`);
    }
    
    // Always respond with 200 to acknowledge receipt
    res.status(200).json({ 
      status: 'success', 
      message: 'Webhook processed successfully',
      event_type: event_type,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Internal server error',
      error: error.message 
    });
  }
});

// Event handlers
function handleBookingCreated(booking) {
  console.log('🎉 NEW BOOKING CREATED!');
  console.log(`Booking ID: ${booking.display_id}`);
  console.log(`Customer: ${booking.contact?.name || 'Unknown'}`);
  console.log(`Email: ${booking.contact?.email || 'No email'}`);
  console.log(`Amount: $${booking.amount || 0}`);
  console.log(`Customers: ${booking.customer_count || 0}`);
  
  if (booking.availability?.item) {
    console.log(`Tour: ${booking.availability.item.name}`);
    console.log(`Date: ${booking.availability.start_datetime}`);
  }
  
  console.log('✅ New booking processed');
}

function handleBookingUpdated(booking) {
  console.log('📝 BOOKING UPDATED');
  console.log(`Booking ID: ${booking.display_id}`);
  console.log(`Status: ${booking.status}`);
  console.log('✅ Booking update processed');
}

function handleBookingCancelled(booking) {
  console.log('❌ BOOKING CANCELLED');
  console.log(`Booking ID: ${booking.display_id}`);
  console.log(`Customer: ${booking.contact?.name || 'Unknown'}`);
  console.log('✅ Cancellation processed');
}

function handleItemCreated(item) {
  console.log('🆕 NEW ITEM CREATED');
  console.log(`Item: ${item.name}`);
  console.log(`Shortname: ${item.shortname}`);
  console.log('✅ New item processed');
}

function handleItemUpdated(item) {
  console.log('🔄 ITEM UPDATED');
  console.log(`Item: ${item.name}`);
  console.log(`Shortname: ${item.shortname}`);
  console.log('✅ Item update processed');
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    service: 'FareHarbor Webhook Server',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'FareHarbor Webhook Server',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      webhook: 'POST /webhook - Receives FareHarbor webhooks',
      health: 'GET /health - Health check'
    },
    environment: process.env.NODE_ENV || 'development'
  });
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

// Start the server
app.listen(PORT, () => {
  console.log('🚀 FareHarbor Webhook Server Started');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌐 Webhook endpoint: /webhook`);
  console.log(`❤️  Health check: /health`);
  console.log(`⚙️  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('🔗 Ready to receive FareHarbor webhooks!');
});

module.exports = app;
