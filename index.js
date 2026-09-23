/**
 * HARDINKAAM - Standalone Razorpay Payment Backend
 * Deploy this on Render.com (free tier). Keeps Firebase Hosting untouched.
 *
 * Routes:
 *  GET  /api/health
 *  POST /api/create-order
 *  POST /api/verify-payment   (also aliased as /api/razorpay/verify)
 *  POST /api/razorpay/order   (alias)
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const app = express();
app.use(express.json());

// Allow requests from your Firebase Hosting site.
// Replace with your real domain(s) once known; using '*' works too if you don't need cookies.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((o) => o.trim());

app.use(
  cors({
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
    credentials: true,
  })
);

let razorpayInstance = null;
function getRazorpayInstance() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error('Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET environment variable.');
  }
  if (!razorpayInstance) {
    razorpayInstance = new Razorpay({ key_id, key_secret });
  }
  return razorpayInstance;
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

async function createOrderHandler(req, res) {
  try {
    const { amount, currency = 'INR', receipt, notes, purpose, role } = req.body || {};

    let parsedAmount = parseInt(String(amount), 10);
    if (purpose === 'registration_fee' && role) {
      parsedAmount = role === 'business_partner' ? 1021 * 100 : 121 * 100;
    }

    if (isNaN(parsedAmount) || parsedAmount < 100) {
      return res.status(400).json({ error: 'Invalid amount. Minimum amount is 100 paise (₹1).' });
    }

    const key_id = process.env.RAZORPAY_KEY_ID;
    if (!key_id || !process.env.RAZORPAY_KEY_SECRET) {
      console.error('Razorpay order creation failed: env vars missing.');
      return res.status(500).json({ error: 'Payment service configuration error. Please contact administrator.' });
    }

    const razorpay = getRazorpayInstance();
    const order = await razorpay.orders.create({
      amount: parsedAmount,
      currency: currency || 'INR',
      receipt: receipt || `rcpt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      notes: { ...(notes || {}), purpose: purpose || 'service_booking', role: role || 'customer' },
    });

    return res.status(200).json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      status: order.status,
      key_id,
    });
  } catch (err) {
    console.error('Error creating Razorpay order:', err);
    return res.status(500).json({ error: err.message || 'Failed to create Razorpay order' });
  }
}

app.post('/api/create-order', createOrderHandler);
app.post('/api/razorpay/order', createOrderHandler);

function verifyPaymentHandler(req, res) {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: 'Missing required payment verification parameters (order_id, payment_id, signature)',
      });
    }

    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key_secret) {
      console.error('Razorpay verification error: Missing RAZORPAY_KEY_SECRET.');
      return res.status(500).json({ success: false, error: 'Payment verification service configuration error.' });
    }

    const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
    const generated_signature = crypto.createHmac('sha256', key_secret).update(payload).digest('hex');

    const genBuf = Buffer.from(generated_signature, 'utf8');
    const sigBuf = Buffer.from(razorpay_signature, 'utf8');

    if (genBuf.length !== sigBuf.length || !crypto.timingSafeEqual(genBuf, sigBuf)) {
      return res.status(400).json({ success: false, error: 'Invalid payment signature.' });
    }

    return res.status(200).json({
      success: true,
      message: 'Payment verified successfully',
      payment_id: razorpay_payment_id,
      order_id: razorpay_order_id,
    });
  } catch (err) {
    console.error('Error verifying Razorpay payment:', err);
    return res.status(500).json({ success: false, error: err.message || 'Payment verification failed' });
  }
}

app.post('/api/verify-payment', verifyPaymentHandler);
app.post('/api/razorpay/verify', verifyPaymentHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HARDINKAAM payment backend running on port ${PORT}`);
});
