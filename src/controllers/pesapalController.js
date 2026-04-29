// src/controllers/pesapalController.js
// PesaPal v3 API integration for mobile money payments (MTN, Airtel, etc.)

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/localDb');

const PESAPAL_BASE_URL = process.env.PESAPAL_ENV === 'production'
  ? 'https://pay.pesapal.com/v3'
  : 'https://cybqa.pesapal.com/pesapalv3';

// ── Helper: get/refresh PesaPal access token ─────────────────────────────────
let _tokenCache = null;
async function getPesapalToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) {
    return _tokenCache.token;
  }

  const res = await fetch(`${PESAPAL_BASE_URL}/api/Auth/RequestToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      consumer_key:    process.env.PESAPAL_CONSUMER_KEY,
      consumer_secret: process.env.PESAPAL_CONSUMER_SECRET,
    }),
  });

  if (!res.ok) throw new Error(`PesaPal auth failed: ${res.status}`);
  const data = await res.json();

  if (data.error) throw new Error(`PesaPal auth error: ${data.error.message}`);

  _tokenCache = {
    token:     data.token,
    expiresAt: Date.now() + (data.expiryDate ? new Date(data.expiryDate).getTime() - Date.now() : 3_600_000),
  };
  return _tokenCache.token;
}

// ── Helper: register IPN URL (only needs to happen once, cached in settings) ──
async function ensureIpnRegistered() {
  const db = getDb();
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'pesapal_ipn_id'").get();
  if (existing?.value) return existing.value;

  const token   = await getPesapalToken();
  const ipnUrl  = `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/pesapal/ipn`;

  const res = await fetch(`${PESAPAL_BASE_URL}/api/URLSetup/RegisterIPN`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: ipnUrl, ipn_notification_type: 'GET' }),
  });

  if (!res.ok) throw new Error(`IPN registration failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`IPN error: ${data.error.message}`);

  const ipnId = data.ipn_id;
  const now   = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('pesapal_ipn_id', ?, ?)")
    .run(ipnId, now);

  return ipnId;
}

// ── POST /api/pesapal/initiate ────────────────────────────────────────────────
// Initiates a STK push / payment request and returns a redirect URL or order ID
const initiatePayment = async (req, res) => {
  const { amount, phone, customer_name, customer_email, sale_ref } = req.body;

  if (!amount || !phone) {
    return res.status(400).json({ success: false, message: 'amount and phone are required' });
  }

  // Normalise phone: strip leading 0 or +256, ensure 256XXXXXXXXX format
  let normalised = phone.replace(/\s+/g, '');
  if (normalised.startsWith('+')) normalised = normalised.slice(1);
  if (normalised.startsWith('0'))  normalised = '256' + normalised.slice(1);
  if (!normalised.startsWith('256')) normalised = '256' + normalised;

  try {
    const [token, ipnId] = await Promise.all([getPesapalToken(), ensureIpnRegistered()]);

    const orderId    = sale_ref || `POS-${uuidv4().slice(0, 8).toUpperCase()}`;
    const callbackUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/pesapal/callback`;

    const payload = {
      id:               orderId,
      currency:         'UGX',
      amount:           parseFloat(amount),
      description:      `POS Sale ${orderId}`,
      callback_url:     callbackUrl,
      notification_id:  ipnId,
      billing_address: {
        phone_number:   normalised,
        email_address:  customer_email || '',
        first_name:     (customer_name || 'Customer').split(' ')[0],
        last_name:      (customer_name || '').split(' ').slice(1).join(' ') || 'N/A',
        country_code:   'UG',
      },
    };

    const orderRes = await fetch(`${PESAPAL_BASE_URL}/api/Transactions/SubmitOrderRequest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });

    if (!orderRes.ok) throw new Error(`PesaPal order submission failed: ${orderRes.status}`);
    const orderData = await orderRes.json();
    if (orderData.error) throw new Error(`Order error: ${orderData.error.message}`);

    // Store pending payment in DB for IPN reconciliation
    const db  = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
    `).run(`pesapal_pending_${orderId}`, JSON.stringify({
      order_tracking_id: orderData.order_tracking_id,
      amount,
      phone: normalised,
      created_at: now,
    }), now);

    return res.json({
      success: true,
      data: {
        order_id:          orderId,
        order_tracking_id: orderData.order_tracking_id,
        redirect_url:      orderData.redirect_url,
      },
    });
  } catch (err) {
    console.error('[PesaPal] initiatePayment error:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
};

// ── GET /api/pesapal/status/:orderTrackingId ──────────────────────────────────
// Poll payment status — frontend polls this until status is COMPLETED or FAILED
const checkStatus = async (req, res) => {
  const { orderTrackingId } = req.params;
  try {
    const token = await getPesapalToken();

    const statusRes = await fetch(
      `${PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
    );

    if (!statusRes.ok) throw new Error(`Status check failed: ${statusRes.status}`);
    const data = await statusRes.json();
    if (data.error) throw new Error(`Status error: ${data.error.message}`);

    // payment_status_description: "Completed" | "Failed" | "Invalid" | "Reversed" | "Pending"
    return res.json({
      success: true,
      data: {
        order_tracking_id:           data.order_tracking_id,
        status:                      data.payment_status_description, // "Completed"|"Failed"|"Pending"
        payment_method:              data.payment_method,
        amount:                      data.amount,
        currency:                    data.currency,
        confirmation_code:           data.confirmation_code,
        mobile_money_account:        data.mobile_money_account,
        message:                     data.description,
      },
    });
  } catch (err) {
    console.error('[PesaPal] checkStatus error:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
};

// ── GET /api/pesapal/ipn ──────────────────────────────────────────────────────
// IPN callback from PesaPal servers — marks pending sales as paid
const handleIpn = async (req, res) => {
  const { orderTrackingId, orderMerchantReference, orderNotificationType } = req.query;

  try {
    const token = await getPesapalToken();

    const statusRes = await fetch(
      `${PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
    );

    const data = await statusRes.json();
    const db   = getDb();
    const now  = new Date().toISOString();

    // Update sale payment_method if sale exists with this receipt reference
    if (data.payment_status_description === 'Completed') {
      const sale = db.prepare("SELECT id FROM sales WHERE receipt_number LIKE ? OR notes LIKE ?")
        .get(`%${orderMerchantReference}%`, `%${orderMerchantReference}%`);

      if (sale) {
        db.prepare("UPDATE sales SET payment_method = 'mobile_money', updated_at = ?, synced = 0 WHERE id = ?")
          .run(now, sale.id);
      }

      // Clean up pending key
      db.prepare("DELETE FROM settings WHERE key = ?").run(`pesapal_pending_${orderMerchantReference}`);
    }

    // PesaPal expects this exact response
    return res.json({ orderNotificationType, orderTrackingId, orderMerchantReference, status: '200' });
  } catch (err) {
    console.error('[PesaPal] IPN error:', err.message);
    return res.status(200).json({ orderNotificationType, orderTrackingId, orderMerchantReference, status: '500' });
  }
};

// ── GET /api/pesapal/config ───────────────────────────────────────────────────
// Let frontend know if PesaPal is configured
const getConfig = (req, res) => {
  const configured = !!(process.env.PESAPAL_CONSUMER_KEY && process.env.PESAPAL_CONSUMER_SECRET);
  return res.json({
    success: true,
    data: {
      enabled:     configured,
      environment: process.env.PESAPAL_ENV || 'sandbox',
      currency:    'UGX',
    },
  });
};

module.exports = { initiatePayment, checkStatus, handleIpn, getConfig };
