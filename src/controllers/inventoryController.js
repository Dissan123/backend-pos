// src/controllers/inventoryController.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../db/localDb');

const EID = (req) => req.user.enterprise_id;

// GET /api/inventory/logs
const getLogs = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { product_id, reason, limit = 50, offset = 0 } = req.query;

  let sql    = `SELECT il.*, p.name AS product_name FROM inventory_logs il LEFT JOIN products p ON il.product_id=p.id WHERE il.enterprise_id=?`;
  const args = [eid];

  if (product_id) { sql += ` AND il.product_id=?`; args.push(product_id); }
  if (reason)     { sql += ` AND il.reason=?`;     args.push(reason); }

  sql += ` ORDER BY il.created_at DESC LIMIT ? OFFSET ?`;
  args.push(parseInt(limit), parseInt(offset));

  const logs  = db.prepare(sql).all(...args);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM inventory_logs WHERE enterprise_id=?`).get(eid);
  return res.json({ success: true, data: logs, total: total.c });
};

// GET /api/inventory/low-stock
const getLowStock = (req, res) => {
  const db    = getDb();
  const eid   = EID(req);
  const bid   = req.user.branch_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'owner';

  let rows;
  if (isAdmin) {
    rows = db.prepare(
      `SELECT * FROM products WHERE enterprise_id=? AND is_active=1 AND warehouse_qty<=low_stock_alert ORDER BY warehouse_qty ASC`
    ).all(eid);
  } else {
    rows = db.prepare(`
      SELECT p.*, bs.quantity AS stock_quantity
      FROM products p
      JOIN branch_stock bs ON bs.product_id=p.id AND bs.branch_id=?
      WHERE p.enterprise_id=? AND p.is_active=1 AND bs.quantity<=p.low_stock_alert
      ORDER BY bs.quantity ASC
    `).all(bid, eid);
  }
  return res.json({ success: true, data: rows });
};

// GET /api/reports/sales
const getSalesReport = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { from, to, group_by = 'day' } = req.query;

  const today = new Date().toISOString().slice(0, 10);
  const start = from || `${today}T00:00:00`;
  const end   = to   || `${today}T23:59:59`;

  const fmts = { hour: '%Y-%m-%d %H:00', month: '%Y-%m', day: '%Y-%m-%d' };
  const fmt  = fmts[group_by] || fmts.day;

  const over = db.prepare(`
    SELECT strftime('${fmt}', created_at) AS period,
           COUNT(*) AS transactions,
           COALESCE(SUM(total_amount),0) AS revenue,
           COALESCE(SUM(discount),0)     AS discounts
    FROM sales
    WHERE enterprise_id=? AND status='completed' AND created_at BETWEEN ? AND ?
    GROUP BY period ORDER BY period ASC
  `).all(eid, start, end);

  const top = db.prepare(`
    SELECT si.product_name, SUM(si.quantity) AS total_sold, SUM(si.subtotal) AS revenue
    FROM sale_items si JOIN sales s ON si.sale_id=s.id
    WHERE s.enterprise_id=? AND s.status='completed' AND s.created_at BETWEEN ? AND ?
    GROUP BY si.product_id ORDER BY total_sold DESC LIMIT 10
  `).all(eid, start, end);

  return res.json({ success: true, data: { over_time: over, top_products: top, period: { from: start, to: end } } });
};

// GET /api/settings
const getSettings = (req, res) => {
  const db  = getDb();
  const eid = EID(req);

  const enterprise = db.prepare(`SELECT * FROM enterprises WHERE id=?`).get(eid) || {};
  const rows       = db.prepare(`SELECT key, value FROM settings WHERE enterprise_id=?`).all(eid);
  const kv         = Object.fromEntries(rows.map(r => [r.key, r.value]));

  return res.json({
    success: true,
    data: {
      enterprise_id:  eid,
      business_name:  enterprise.name            || kv.store_name     || '',
      store_address:  enterprise.address         || kv.store_address  || '',
      store_phone:    enterprise.phone           || kv.store_phone    || '',
      store_email:    enterprise.email           || '',
      currency:       enterprise.currency        || kv.currency       || 'UGX',
      tax_rate:       enterprise.tax_rate        !== undefined ? enterprise.tax_rate : parseFloat(kv.tax_rate || '0'),
      receipt_footer: enterprise.receipt_footer  || kv.receipt_footer || '',
      logo_url:       enterprise.logo_url        || '',
    },
  });
};

// PUT /api/settings
const updateSettings = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const now = new Date().toISOString();

  // Safe coerce — undefined/empty → null so SQLite COALESCE keeps existing value
  const s = (v) => (v === undefined || v === null || v === '') ? null : String(v);
  const n = (v) => (v === undefined || v === null || v === '') ? null : parseFloat(v);

  const bizName  = s(req.body.business_name);
  const address  = s(req.body.store_address);
  const phone    = s(req.body.store_phone);
  const email    = s(req.body.store_email);
  const currency = s(req.body.currency);
  const taxRate  = n(req.body.tax_rate);
  const footer   = s(req.body.receipt_footer);

  db.prepare(`
    UPDATE enterprises SET
      name           = COALESCE(?, name),
      address        = COALESCE(?, address),
      phone          = COALESCE(?, phone),
      email          = COALESCE(?, email),
      currency       = COALESCE(?, currency),
      tax_rate       = COALESCE(?, tax_rate),
      receipt_footer = COALESCE(?, receipt_footer),
      updated_at     = ?
    WHERE id = ?
  `).run(bizName, address, phone, email, currency, taxRate, footer, now, eid);

  // Keep KV settings in sync
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO settings (enterprise_id, key, value, updated_at) VALUES (?,?,?,?)
  `);
  const kvMap = {
    store_name:     bizName,
    store_address:  address,
    store_phone:    phone,
    currency:       currency,
    tax_rate:       taxRate !== null ? String(taxRate) : null,
    receipt_footer: footer,
  };
  for (const [k, v] of Object.entries(kvMap)) {
    if (v !== null) upsert.run(eid, k, v, now);
  }

  // Queue for cloud sync
  const enterprise = db.prepare(`SELECT * FROM enterprises WHERE id=?`).get(eid);
  db.prepare(`
    INSERT INTO sync_queue (id, enterprise_id, action_type, entity_type, entity_id, payload_json)
    VALUES (?,?,'CREATE_ENTERPRISE','enterprises',?,?)
  `).run(uuidv4(), eid, eid, JSON.stringify(enterprise));

  return res.json({ success: true, message: 'Settings saved' });
};

module.exports = { getLogs, getLowStock, getSalesReport, getSettings, updateSettings };
