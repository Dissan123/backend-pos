// src/index.js
// Main entry point — sets up Express, starts sync scheduler, listens

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const cron       = require('node-cron');

const routes       = require('./routes');
const { runSync }  = require('./services/syncEngine');
const { initDb }   = require('./db/localDb');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Security Middleware ──────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:19006'],
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
app.use('/api', limiter);

// ─── Request Parsing ─────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Logging ─────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ─── Routes ──────────────────────────────────────────────────
app.use('/api', routes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ─── Startup ─────────────────────────────────────────────────
const start = async () => {
  // Initialise the sql.js database (async WASM load) before accepting requests
  await initDb();
  console.log('✅ Database ready');

  // Background sync — every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    if (process.env.NODE_ENV !== 'test') {
      await runSync();
    }
  });

  app.listen(PORT, '0.0.0.0', () => {
    const saEmail = process.env.SUPERADMIN_EMAIL    || 'dev@posystem.com';
    const saPass  = process.env.SUPERADMIN_PASSWORD || 'superdev123';

    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   POS & Inventory System — Backend API   ║');
    console.log(`║   Running on http://localhost:${PORT}      ║`);
    console.log(`║   Mode: ${(process.env.NODE_ENV || 'development').padEnd(33)}║`);
    console.log('╠══════════════════════════════════════════╣');
    console.log('║   🔐 Developer Console                   ║');
    console.log(`║   URL:  http://localhost:5173/super/login ║`);
    console.log(`║   User: ${saEmail.padEnd(33)}║`);
    console.log(`║   Pass: ${saPass.padEnd(33)}║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
  });
};

start().catch((err) => { console.error('Failed to start server:', err); process.exit(1); });

module.exports = app; // for testing
