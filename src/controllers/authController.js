// src/controllers/authController.js
'use strict';

const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/localDb');
const { sendSignInOTP, sendSignUpConfirmation, generateOTP, getOTPExpiry } = require('../services/emailService');

const makeToken = (user) => jwt.sign(
  { id: user.id, email: user.email, role: user.role, name: user.name, enterprise_id: user.enterprise_id, branch_id: user.branch_id || null },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
);

const safeUser = (u) => ({
  id: u.id, name: u.name, email: u.email,
  role: u.role, enterprise_id: u.enterprise_id, branch_id: u.branch_id || null,
  avatar_url: u.avatar_url || null,
});

// ─── POST /api/auth/signup ─────────────────────────────────────
// Creates an enterprise + admin owner in one step
const signup = async (req, res) => {
  const { name, email, password, business_name } = req.body;
  const role = 'admin'; // self-signup is always admin/owner

  if (!name || !email || !password)
    return res.status(400).json({ success: false, message: 'Name, email, and password are required' });
  if (password.length < 8)
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });

  const db  = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id, is_verified FROM users WHERE email = ?').get(email.toLowerCase().trim());

  if (existing && existing.is_verified)
    return res.status(409).json({ success: false, message: 'Email already registered. Please sign in.' });

  const otp       = generateOTP();
  const otpExpiry = getOTPExpiry();
  const hashed    = await bcrypt.hash(password, 10);

  if (existing) {
    // Re-send OTP for unverified account
    db.prepare(`UPDATE users SET name=?, password=?, otp_code=?, otp_expires_at=?, otp_type='signup', updated_at=? WHERE id=?`)
      .run(name, hashed, otp, otpExpiry, now, existing.id);
  } else {
    // 1. Create enterprise
    const enterpriseId = uuidv4();
    db.prepare(`INSERT INTO enterprises (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(enterpriseId, business_name || `${name}'s Business`, now, now);

    // 2. Create HQ branch
    const hqBranchId = uuidv4();
    db.prepare(`INSERT INTO branches (id, enterprise_id, name, is_active, is_hq, created_at, updated_at) VALUES (?,?,?,1,1,?,?)`)
      .run(hqBranchId, enterpriseId, business_name || (name + `'s Business`), now, now);

    // 3. Seed default enterprise settings
    const defaults = [
      ['store_name',     business_name || `${name}'s Business`],
      ['store_phone',    ''],
      ['store_address',  ''],
      ['currency',       'UGX'],
      ['tax_rate',       '0'],
      ['receipt_footer', 'Thank you for shopping with us!'],
    ];
    const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (enterprise_id, key, value) VALUES (?, ?, ?)`);
    for (const [k, v] of defaults) insertSetting.run(enterpriseId, k, v);

    // 4. Create admin user linked to enterprise + HQ branch
    const userId = uuidv4();
    db.prepare(`
      INSERT INTO users (id, enterprise_id, branch_id, name, email, password, role, is_active, is_verified, otp_code, otp_expires_at, otp_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'admin', 1, 0, ?, ?, 'signup', ?, ?)
    `).run(userId, enterpriseId, hqBranchId, name, email.toLowerCase().trim(), hashed, otp, otpExpiry, now, now);
  }

  let emailSent = false;
  try {
    await sendSignUpConfirmation(email, name, otp);
    emailSent = true;
  } catch (err) {
    console.error('⚠️  Email send failed:', err.message);
    console.log(`\n🔑 DEV OTP for ${email}: ${otp}\n`);
  }

  return res.status(201).json({
    success: true,
    message: emailSent
      ? 'Account created! Check your email for a 6-digit verification code.'
      : 'Account created! (Email not configured — check server console for OTP)',
    data: { email, requires_verification: true, dev_otp: emailSent ? undefined : otp },
  });
};

// ─── POST /api/auth/verify-email ──────────────────────────────
const verifyEmail = (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp)
    return res.status(400).json({ success: false, message: 'Email and code are required' });

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());

  if (!user)      return res.status(404).json({ success: false, message: 'Account not found' });
  if (user.otp_type !== 'signup') return res.status(400).json({ success: false, message: 'No pending verification' });
  if (user.otp_code !== otp)      return res.status(400).json({ success: false, message: 'Incorrect code' });
  if (new Date(user.otp_expires_at) < new Date()) return res.status(400).json({ success: false, message: 'Code expired. Request a new one.' });

  const now = new Date().toISOString();
  db.prepare(`UPDATE users SET is_verified=1, otp_code=NULL, otp_expires_at=NULL, otp_type=NULL, updated_at=? WHERE id=?`)
    .run(now, user.id);

  const token = makeToken(user);
  return res.json({ success: true, message: 'Email verified! Welcome.', data: { token, user: safeUser(user) } });
};

// ─── POST /api/auth/login — step 1: verify password → send OTP ─
const login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: 'Email and password are required' });

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.toLowerCase().trim());

  if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
  if (!user.is_verified) return res.status(403).json({ success: false, message: 'Please verify your email first', data: { requires_verification: true, email } });

  const isValid = bcrypt.compareSync(password, user.password);
  if (!isValid) return res.status(401).json({ success: false, message: 'Invalid credentials' });

  const otp = generateOTP();
  const otpExpiry = getOTPExpiry();
  const now = new Date().toISOString();
  db.prepare(`UPDATE users SET otp_code=?, otp_expires_at=?, otp_type='signin', updated_at=? WHERE id=?`)
    .run(otp, otpExpiry, now, user.id);

  let emailSent = false;
  try {
    await sendSignInOTP(email, user.name, otp);
    emailSent = true;
  } catch (err) {
    console.error('⚠️  Email send failed:', err.message);
    console.log(`\n🔑 DEV OTP for ${email}: ${otp}\n`);
  }

  return res.json({
    success: true,
    message: emailSent ? `Code sent to ${email}` : `Code generated (check server console)`,
    data: { email, requires_otp: true, dev_otp: emailSent ? undefined : otp },
  });
};

// ─── POST /api/auth/verify-otp — step 2: verify OTP → JWT ─────
const verifyOTP = (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ success: false, message: 'Email and code required' });

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.toLowerCase().trim());

  if (!user) return res.status(404).json({ success: false, message: 'Account not found' });
  if (user.otp_type !== 'signin') return res.status(400).json({ success: false, message: 'No pending sign-in' });
  if (user.otp_code !== otp)      return res.status(400).json({ success: false, message: 'Incorrect code' });
  if (new Date(user.otp_expires_at) < new Date()) return res.status(400).json({ success: false, message: 'Code expired. Sign in again.' });

  const now = new Date().toISOString();
  db.prepare(`UPDATE users SET otp_code=NULL, otp_expires_at=NULL, otp_type=NULL, updated_at=? WHERE id=?`)
    .run(now, user.id);

  const token = makeToken(user);
  return res.json({ success: true, data: { token, user: safeUser(user) } });
};

// ─── POST /api/auth/google ────────────────────────────────────
const googleAuth = async (req, res) => {
  const { id_token } = req.body;
  if (!id_token) return res.status(400).json({ success: false, message: 'Google ID token required' });

  try {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${id_token}`);
    const payload  = await response.json();
    if (payload.error || !payload.email)
      return res.status(401).json({ success: false, message: 'Invalid Google token' });

    const { email, name, sub: googleId, picture: avatarUrl } = payload;
    const db  = getDb();
    const now = new Date().toISOString();

    let user = db.prepare('SELECT * FROM users WHERE email = ? OR google_id = ?').get(email.toLowerCase(), googleId);

    if (user) {
      db.prepare(`UPDATE users SET google_id=?, avatar_url=?, is_verified=1, updated_at=? WHERE id=?`)
        .run(googleId, avatarUrl, now, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    } else {
      // New Google signup — create enterprise + admin
      const enterpriseId = uuidv4();
      db.prepare(`INSERT INTO enterprises (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
        .run(enterpriseId, `${name}'s Business`, now, now);

      const defaults = [['store_name', `${name}'s Business`], ['currency', 'UGX'], ['tax_rate', '0']];
      const ins = db.prepare(`INSERT OR IGNORE INTO settings (enterprise_id, key, value) VALUES (?, ?, ?)`);
      for (const [k, v] of defaults) ins.run(enterpriseId, k, v);

      const id = uuidv4();
      db.prepare(`
        INSERT INTO users (id, enterprise_id, name, email, password, role, is_active, is_verified, google_id, avatar_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', 'admin', 1, 1, ?, ?, ?, ?)
      `).run(id, enterpriseId, name, email.toLowerCase(), googleId, avatarUrl, now, now);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }

    const token = makeToken(user);
    return res.json({ success: true, data: { token, user: safeUser(user) } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Google authentication failed' });
  }
};

// ─── POST /api/auth/resend-otp ────────────────────────────────
const resendOTP = async (req, res) => {
  const { email, type = 'signin' } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) return res.status(404).json({ success: false, message: 'Account not found' });

  const otp = generateOTP();
  const now = new Date().toISOString();
  db.prepare(`UPDATE users SET otp_code=?, otp_expires_at=?, otp_type=?, updated_at=? WHERE id=?`)
    .run(otp, getOTPExpiry(), type, now, user.id);

  try {
    if (type === 'signup') await sendSignUpConfirmation(email, user.name, otp);
    else await sendSignInOTP(email, user.name, otp);
  } catch (err) {
    console.log(`\n🔑 DEV OTP for ${email}: ${otp}\n`);
    return res.status(500).json({ success: false, message: 'Failed to send email. Check SMTP settings.' });
  }

  return res.json({ success: true, message: 'New code sent.' });
};

// ─── GET /api/auth/me ─────────────────────────────────────────
const getMe = (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT id, enterprise_id, name, email, role, avatar_url, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  return res.json({ success: true, data: user });
};

// ─── POST /api/auth/register (admin creates cashier) ─────────
const register = async (req, res) => {
  const { name, email, password, role = 'cashier' } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ success: false, message: 'Name, email, and password required' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ success: false, message: 'Email already registered' });

  const hashed = await bcrypt.hash(password, 10);
  const id  = uuidv4();
  const now = new Date().toISOString();

  // Cashier is created under the admin's enterprise
  db.prepare(`
    INSERT INTO users (id, enterprise_id, name, email, password, role, is_active, is_verified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `).run(id, req.user.enterprise_id, name, email.toLowerCase(), hashed, role === 'admin' ? 'cashier' : role, now, now);

  return res.status(201).json({ success: true, message: 'User created', data: { id, name, email, role } });
};

module.exports = { signup, verifyEmail, login, verifyOTP, googleAuth, resendOTP, getMe, register };
