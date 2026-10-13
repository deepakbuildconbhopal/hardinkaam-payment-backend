
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const app = express();
app.disable('x-powered-by');

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  credentials: true,
}));

// Keep the exact raw body for Razorpay webhook signature verification.
app.use(express.json({
  limit: '100kb',
  verify(req, res, buf) {
    req.rawBody = Buffer.from(buf);
  },
}));

let razorpayInstance;

function getRazorpay() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    throw new Error('Razorpay credentials are not configured.');
  }

  if (!razorpayInstance) {
    razorpayInstance = new Razorpay({ key_id, key_secret });
  }

  return razorpayInstance;
}

function safeEqualHex(a, b) {
  if (
    typeof a !== 'string' ||
    typeof b !== 'string' ||
    !/^[a-f0-9]+$/i.test(a) ||
    !/^[a-f0-9]+$/i.test(b)
  ) return false;

  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');

  return left.length === right.length &&
    left.length > 0 &&
    crypto.timingSafeEqual(left, right);
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

async function createOrderHandler(req, res) {
  try {
    const {
      amount,
      currency = 'INR',
      receipt,
      notes,
      purpose,
      role,
    } = req.body || {};

    let parsedAmount = Number(amount);

    if (purpose === 'registration_fee' && role) {
      if (role === 'business_partner') parsedAmount = 1021 * 100;
      else if (['customer', 'serviceman', 'service_pro'].includes(role)) {
        parsedAmount = 121 * 100;
      } else {
        return res.status(400).json({ error: 'Unsupported registration role.' });
      }
    }

    if (
      !Number.isSafeInteger(parsedAmount) ||
      parsedAmount < 100 ||
      currency !== 'INR'
    ) {
      return res.status(400).json({
        error: 'Invalid amount or currency.',
      });
    }

    const razorpay = getRazorpay();

    const order = await razorpay.orders.create({
      amount: parsedAmount,
      currency: 'INR',
      receipt: receipt || `hdk_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      notes: {
        ...(notes && typeof notes === 'object' ? notes : {}),
        purpose: purpose || 'service_booking',
        role: role || 'customer',
      },
    });

    res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      status: order.status,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('Order creation failed:', err.message);
    res.status(500).json({ error: 'Unable to create payment order.' });
  }
}

app.post('/api/create-order', createOrderHandler);
app.post('/api/razorpay/order', createOrderHandler);

async function verifyPaymentHandler(req, res) {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: 'Missing payment verification parameters.',
      });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      return res.status(500).json({
        success: false,
        error: 'Payment verification is not configured.',
      });
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (!safeEqualHex(expected, razorpay_signature)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payment signature.',
      });
    }

    const razorpay = getRazorpay();

    // Verify payment against Razorpay's server, not only the browser response.
    const [payment, order] = await Promise.all([
      razorpay.payments.fetch(razorpay_payment_id),
      razorpay.orders.fetch(razorpay_order_id),
    ]);

    if (
      payment.order_id !== razorpay_order_id ||
      order.id !== razorpay_order_id ||
      payment.status !== 'captured' ||
      order.status !== 'paid' ||
      payment.currency !== 'INR' ||
      order.currency !== 'INR' ||
      payment.amount !== order.amount
    ) {
      return res.status(409).json({
        success: false,
        error: 'Payment is not confirmed as captured for this order.',
      });
    }

    return res.json({
      success: true,
      message: 'Razorpay payment verified.',
      payment_id: payment.id,
      order_id: order.id,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
    });
  } catch (err) {
    console.error('Payment verification failed:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Unable to verify payment. Please retry.',
    });
  }
}

app.post('/api/verify-payment', verifyPaymentHandler);
app.post('/api/razorpay/verify', verifyPaymentHandler);

// Webhook: verifies Razorpay's exact raw request body.
// This route does NOT mark a booking paid or modify Firestore.
app.post('/api/razorpay/webhook', (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const receivedSignature = req.get('x-razorpay-signature');

  if (!webhookSecret || !req.rawBody || !receivedSignature) {
    return res.status(400).json({ error: 'Invalid webhook request.' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(req.rawBody)
    .digest('hex');

  if (!safeEqualHex(expectedSignature, receivedSignature)) {
    return res.status(401).json({ error: 'Invalid webhook signature.' });
  }

  const event = req.body?.event;
  const eventId = req.get('x-razorpay-event-id');

  if (!event || !eventId) {
    return res.status(400).json({ error: 'Missing webhook event details.' });
  }

  // Acknowledge only authenticated events. Persistent deduplication and
  // Firestore booking updates must be implemented with the real data schema.
  console.log('Verified Razorpay webhook:', { event, eventId });

  return res.status(200).json({ received: true });
});

app.use((err, req, res, next) => {
  console.error('Request error:', err.message);
  if (res.headersSent) return next(err);
  res.status(400).json({ error: 'Invalid request.' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HARDINKAAM payment backend running on port ${PORT}`);
});
