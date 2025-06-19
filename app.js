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
  req.body = JSON.parse(req.body.toString());
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