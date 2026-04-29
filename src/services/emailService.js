// src/services/emailService.js
// Sends transactional emails via nodemailer (SMTP)
// Configure SMTP in your .env file

'use strict';

const nodemailer = require('nodemailer');

const createTransporter = () => {
  // Supports Gmail, Outlook, SendGrid SMTP, Mailgun, etc.
  // For Gmail: use an App Password (not your account password)
  // https://support.google.com/accounts/answer/185833
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

const FROM = process.env.SMTP_FROM || `"POS System" <${process.env.SMTP_USER}>`;
const APP  = process.env.APP_NAME  || 'POS System';

// ─── Send OTP for sign-in ────────────────────────────────────────
const sendSignInOTP = async (email, name, otp) => {
  const transporter = createTransporter();
  await transporter.sendMail({
    from:    FROM,
    to:      email,
    subject: `${otp} is your ${APP} sign-in code`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0a0b0e;color:#f1f0ec;border-radius:12px;">
        <div style="text-align:center;margin-bottom:28px;">
          <div style="display:inline-block;background:#f0b429;border-radius:12px;padding:12px 16px;">
            <span style="font-size:22px;">🏪</span>
          </div>
          <h2 style="margin:12px 0 4px;font-size:22px;">${APP}</h2>
          <p style="color:#6b7280;margin:0;font-size:14px;">Sign-in verification</p>
        </div>

        <p style="color:#d1d5db;margin-bottom:8px;">Hi ${name},</p>
        <p style="color:#d1d5db;margin-bottom:24px;">Use this code to sign in. It expires in <strong style="color:#f0b429;">10 minutes</strong>.</p>

        <div style="text-align:center;margin:28px 0;">
          <div style="display:inline-block;background:#181b21;border:2px solid #2a2e38;border-radius:12px;padding:20px 40px;">
            <span style="font-size:36px;font-weight:800;letter-spacing:10px;color:#f0b429;font-family:monospace;">${otp}</span>
          </div>
        </div>

        <p style="color:#6b7280;font-size:13px;text-align:center;">
          If you didn't request this code, you can safely ignore this email.
        </p>
        <hr style="border:none;border-top:1px solid #2a2e38;margin:24px 0;" />
        <p style="color:#4b5563;font-size:12px;text-align:center;margin:0;">${APP} · Secure sign-in</p>
      </div>
    `,
  });
};

// ─── Send welcome + email verification ──────────────────────────
const sendSignUpConfirmation = async (email, name, otp) => {
  const transporter = createTransporter();
  await transporter.sendMail({
    from:    FROM,
    to:      email,
    subject: `Welcome to ${APP} — verify your email`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0a0b0e;color:#f1f0ec;border-radius:12px;">
        <div style="text-align:center;margin-bottom:28px;">
          <div style="display:inline-block;background:#f0b429;border-radius:12px;padding:12px 16px;">
            <span style="font-size:22px;">🏪</span>
          </div>
          <h2 style="margin:12px 0 4px;font-size:22px;">Welcome to ${APP}!</h2>
          <p style="color:#6b7280;margin:0;font-size:14px;">Let's verify your email address</p>
        </div>

        <p style="color:#d1d5db;margin-bottom:8px;">Hi ${name},</p>
        <p style="color:#d1d5db;margin-bottom:24px;">
          Your account has been created. Enter this verification code to confirm your email and activate your account.
          The code expires in <strong style="color:#f0b429;">10 minutes</strong>.
        </p>

        <div style="text-align:center;margin:28px 0;">
          <div style="display:inline-block;background:#181b21;border:2px solid #2a2e38;border-radius:12px;padding:20px 40px;">
            <span style="font-size:36px;font-weight:800;letter-spacing:10px;color:#22c55e;font-family:monospace;">${otp}</span>
          </div>
        </div>

        <p style="color:#6b7280;font-size:13px;text-align:center;">
          If you didn't create this account, please ignore this email.
        </p>
        <hr style="border:none;border-top:1px solid #2a2e38;margin:24px 0;" />
        <p style="color:#4b5563;font-size:12px;text-align:center;margin:0;">${APP} · Account verification</p>
      </div>
    `,
  });
};

// ─── Generate a 6-digit OTP ──────────────────────────────────────
const generateOTP = () => {
  return String(Math.floor(100000 + Math.random() * 900000));
};

// OTP expires in 10 minutes
const getOTPExpiry = () => {
  return new Date(Date.now() + 10 * 60 * 1000).toISOString();
};

module.exports = { sendSignInOTP, sendSignUpConfirmation, generateOTP, getOTPExpiry };
