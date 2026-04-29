// src/controllers/superController.js
// Developer/superadmin access — cross-enterprise visibility and control
'use strict';

const { v4: uuidv4 }  = require('uuid');
const bcrypt          = require('bcryptjs');
const jwt             = require('jsonwebtoken');
const { getDb }       = require('../db/localDb');

// ── POST /api/super/login ─────────────────────────────────────────
// No OTP — direct password login from .env credentials
const login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: 'Email and password required' });

  const envEmail    = process.env.SUPERADMIN_EMAIL    || 'dev@posystem.com';
  const envPassword = process.env.SUPERADMIN_PASSWORD || 'superdev123';
  const envName     = process.env.SUPERADMIN_NAME     || 'Developer';

  if (email.toLowerCase().trim() !== envEmail.toLowerCase()) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  const valid = password === envPassword;
  if (!valid) return res.status(401).json({ success: false, message: 'Invalid credentials' });

  // Upsert into superadmins table for audit trail
  const db  = getDb();
  const now = new Date().toISOString();
  let super_user = db.prepare('SELECT * FROM superadmins WHERE email=?').get(envEmail.toLowerCase());
  if (!super_user) {
    const id = uuidv4();
    db.prepare(`INSERT INTO superadmins (id, name, email, password, created_at, last_login) VALUES (?,?,?,?,?,?)`)
      .run(id, envName, envEmail.toLowerCase(), 'env-managed', now, now);
    super_user = { id, name: envName, email: envEmail };
  } else {
    db.prepare('UPDATE superadmins SET last_login=? WHERE email=?').run(now, envEmail.toLowerCase());
  }

  const token = jwt.sign(
    { id: super_user.id, email: super_user.email, name: super_user.name || envName, role: 'superadmin', enterprise_id: null },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  return res.json({ success: true, data: {
    token,
    user: { id: super_user.id, name: super_user.name || envName, email: super_user.email, role: 'superadmin' },
  }});
};

// ── GET /api/super/enterprises ────────────────────────────────────
const getEnterprises = (req, res) => {
  const db = getDb();

  const enterprises = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM users    u WHERE u.enterprise_id=e.id AND u.is_active=1)    AS user_count,
      (SELECT COUNT(*) FROM branches b WHERE b.enterprise_id=e.id AND b.is_active=1)    AS branch_count,
      (SELECT COUNT(*) FROM products p WHERE p.enterprise_id=e.id AND p.is_active=1)    AS product_count,
      (SELECT COUNT(*) FROM sales    s WHERE s.enterprise_id=e.id AND s.status='completed') AS sale_count,
      (SELECT COALESCE(SUM(s2.total_amount),0) FROM sales s2 WHERE s2.enterprise_id=e.id AND s2.status='completed') AS total_revenue,
      (SELECT COALESCE(SUM(s3.total_amount),0) FROM sales s3 WHERE s3.enterprise_id=e.id AND s3.status='completed' AND date(s3.created_at)=date('now')) AS today_revenue,
      (SELECT MAX(s4.created_at) FROM sales s4 WHERE s4.enterprise_id=e.id) AS last_sale_at
    FROM enterprises e
    ORDER BY e.created_at DESC
  `).all();

  return res.json({ success: true, data: enterprises });
};

// ── GET /api/super/enterprises/:id ───────────────────────────────
const getEnterprise = (req, res) => {
  const db = getDb();
  const eid = req.params.id;

  const enterprise = db.prepare('SELECT * FROM enterprises WHERE id=?').get(eid);
  if (!enterprise) return res.status(404).json({ success: false, message: 'Enterprise not found' });

  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
           b.name AS branch_name
    FROM users u LEFT JOIN branches b ON b.id=u.branch_id
    WHERE u.enterprise_id=? ORDER BY u.role DESC, u.name ASC
  `).all(eid);

  const branches = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM users u WHERE u.branch_id=b.id AND u.is_active=1) AS staff_count,
      (SELECT COALESCE(SUM(s.total_amount),0) FROM sales s WHERE s.branch_id=b.id AND s.status='completed') AS total_revenue
    FROM branches b WHERE b.enterprise_id=? ORDER BY b.is_hq DESC, b.name ASC
  `).all(eid);

  const stats = db.prepare(`
    SELECT COUNT(*)                                     AS total_sales,
           COALESCE(SUM(total_amount),0)                AS total_revenue,
           COALESCE(AVG(total_amount),0)                AS avg_sale,
           COUNT(CASE WHEN date(created_at)=date('now') THEN 1 END) AS today_sales,
           COALESCE(SUM(CASE WHEN date(created_at)=date('now') THEN total_amount ELSE 0 END),0) AS today_revenue
    FROM sales WHERE enterprise_id=? AND status='completed'
  `).get(eid);

  const inventory = db.prepare(`
    SELECT COUNT(*) AS products,
           COALESCE(SUM(stock_quantity),0) AS total_units,
           COALESCE(SUM(stock_quantity*price),0) AS retail_value,
           COALESCE(SUM(warehouse_qty),0) AS warehouse_units
    FROM products WHERE enterprise_id=? AND is_active=1
  `).get(eid);

  return res.json({ success: true, data: { ...enterprise, users, branches, stats, inventory } });
};

// ── GET /api/super/users ──────────────────────────────────────────
// All users across all enterprises
const getAllUsers = (req, res) => {
  const db = getDb();
  const { search, enterprise_id, role } = req.query;

  let sql = `
    SELECT u.*, e.name AS enterprise_name, b.name AS branch_name
    FROM users u
    LEFT JOIN enterprises e ON e.id=u.enterprise_id
    LEFT JOIN branches    b ON b.id=u.branch_id
    WHERE 1=1
  `;
  const args = [];

  if (search)        { sql += ` AND (u.name LIKE ? OR u.email LIKE ?)`; args.push(`%${search}%`, `%${search}%`); }
  if (enterprise_id) { sql += ` AND u.enterprise_id=?`; args.push(enterprise_id); }
  if (role)          { sql += ` AND u.role=?`; args.push(role); }

  sql += ` ORDER BY u.created_at DESC LIMIT 200`;
  const users = db.prepare(sql).all(...args);
  return res.json({ success: true, data: users });
};

// ── PATCH /api/super/users/:id ────────────────────────────────────
// Modify any user — name, role, status, password
const updateUser = async (req, res) => {
  const db  = getDb();
  const now = new Date().toISOString();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const { name, role, is_active, password } = req.body;
  const updates = [];
  const vals    = [];

  if (name      !== undefined) { updates.push('name=?');      vals.push(String(name)); }
  if (role      !== undefined) { updates.push('role=?');      vals.push(String(role)); }
  if (is_active !== undefined) { updates.push('is_active=?'); vals.push(is_active ? 1 : 0); }
  if (password)                {
    const hashed = await bcrypt.hash(password, 10);
    updates.push('password=?');
    vals.push(hashed);
  }

  if (!updates.length) return res.status(400).json({ success: false, message: 'Nothing to update' });

  updates.push('updated_at=?'); vals.push(now);
  vals.push(req.params.id);

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id=?`).run(...vals);
  const updated = db.prepare('SELECT id, name, email, role, is_active FROM users WHERE id=?').get(req.params.id);
  return res.json({ success: true, data: updated });
};

// ── DELETE /api/super/users/:id ───────────────────────────────────
const deleteUser = (req, res) => {
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  if (user.role === 'admin' || user.role === 'owner') {
    const adminCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE enterprise_id=? AND role='admin' AND is_active=1`).get(user.enterprise_id);
    if (adminCount.c <= 1) return res.status(400).json({ success: false, message: 'Cannot delete the last admin of an enterprise' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  return res.json({ success: true, message: 'User deleted' });
};

// ── PATCH /api/super/enterprises/:id ─────────────────────────────
const updateEnterprise = (req, res) => {
  const db  = getDb();
  const now = new Date().toISOString();
  const ent = db.prepare('SELECT * FROM enterprises WHERE id=?').get(req.params.id);
  if (!ent) return res.status(404).json({ success: false, message: 'Enterprise not found' });

  const { name, address, phone, email, currency, tax_rate } = req.body;
  db.prepare(`
    UPDATE enterprises SET
      name=COALESCE(?,name), address=COALESCE(?,address), phone=COALESCE(?,phone),
      email=COALESCE(?,email), currency=COALESCE(?,currency), tax_rate=COALESCE(?,tax_rate),
      updated_at=?
    WHERE id=?
  `).run(name||null, address||null, phone||null, email||null, currency||null, tax_rate||null, now, req.params.id);

  const updated = db.prepare('SELECT * FROM enterprises WHERE id=?').get(req.params.id);
  return res.json({ success: true, data: updated });
};

// ── DELETE /api/super/enterprises/:id ────────────────────────────
const deleteEnterprise = (req, res) => {
  const db  = getDb();
  const ent = db.prepare('SELECT * FROM enterprises WHERE id=?').get(req.params.id);
  if (!ent) return res.status(404).json({ success: false, message: 'Enterprise not found' });

  // Cascade: delete all linked data
  db.transaction(() => {
    const tables = ['stock_order_items', 'stock_orders', 'branch_stock', 'sale_items', 'inventory_logs', 'sales', 'products', 'settings', 'sync_queue', 'users', 'branches', 'enterprises'];
    for (const t of tables) {
      if (t === 'enterprises')  db.prepare(`DELETE FROM enterprises WHERE id=?`).run(req.params.id);
      else if (t === 'sale_items') db.prepare(`DELETE FROM sale_items WHERE enterprise_id=?`).run(req.params.id);
      else                      db.prepare(`DELETE FROM ${t} WHERE enterprise_id=?`).run(req.params.id);
    }
  })();

  return res.json({ success: true, message: `Enterprise "${ent.name}" and all data deleted` });
};

// ── GET /api/super/stats ──────────────────────────────────────────
// Platform-wide stats
const getPlatformStats = (req, res) => {
  const db = getDb();

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM enterprises)                         AS enterprises,
      (SELECT COUNT(*) FROM users WHERE is_active=1)            AS active_users,
      (SELECT COUNT(*) FROM branches WHERE is_active=1)         AS branches,
      (SELECT COUNT(*) FROM products WHERE is_active=1)         AS products,
      (SELECT COUNT(*) FROM sales WHERE status='completed')     AS total_sales,
      (SELECT COALESCE(SUM(total_amount),0) FROM sales WHERE status='completed') AS total_revenue,
      (SELECT COALESCE(SUM(total_amount),0) FROM sales WHERE status='completed' AND date(created_at)=date('now')) AS today_revenue,
      (SELECT COUNT(*) FROM sales WHERE status='completed' AND date(created_at)=date('now')) AS today_sales
  `).get();

  const recentEnterprises = db.prepare(`
    SELECT id, name, created_at FROM enterprises ORDER BY created_at DESC LIMIT 5
  `).all();

  const topEnterprises = db.prepare(`
    SELECT e.id, e.name,
           COALESCE(SUM(s.total_amount),0) AS revenue,
           COUNT(s.id) AS sales
    FROM enterprises e
    LEFT JOIN sales s ON s.enterprise_id=e.id AND s.status='completed'
    GROUP BY e.id ORDER BY revenue DESC LIMIT 10
  `).all();

  return res.json({ success: true, data: { totals, recent_enterprises: recentEnterprises, top_enterprises: topEnterprises } });
};

// ── POST /api/super/enterprises/:id/impersonate ───────────────────
// Returns a JWT as the admin of any enterprise — for debugging
const impersonate = (req, res) => {
  const db  = getDb();
  const eid = req.params.id;

  const enterprise = db.prepare('SELECT * FROM enterprises WHERE id=?').get(eid);
  if (!enterprise) return res.status(404).json({ success: false, message: 'Enterprise not found' });

  const admin = db.prepare(`SELECT * FROM users WHERE enterprise_id=? AND role='admin' AND is_active=1 ORDER BY created_at ASC LIMIT 1`).get(eid);
  if (!admin) return res.status(404).json({ success: false, message: 'No active admin found for this enterprise' });

  const token = jwt.sign(
    { id: admin.id, email: admin.email, name: admin.name, role: admin.role, enterprise_id: admin.enterprise_id, branch_id: admin.branch_id, impersonated_by: req.user.id },
    process.env.JWT_SECRET,
    { expiresIn: '2h' }
  );

  return res.json({ success: true, data: { token, user: { ...admin, password: undefined }, enterprise } });
};

module.exports = { login, getEnterprises, getEnterprise, getAllUsers, updateUser, deleteUser, updateEnterprise, deleteEnterprise, getPlatformStats, impersonate };
