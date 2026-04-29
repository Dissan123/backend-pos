// src/controllers/usersController.js
'use strict';

const bcrypt         = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../db/localDb');

const EID = (req) => req.user.enterprise_id;

// GET /api/users
const getUsers = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const rows = db.prepare(`
    SELECT u.id, u.enterprise_id, u.branch_id, u.name, u.email, u.role,
           u.is_active, u.avatar_url, u.created_at,
           b.name AS branch_name, b.is_hq AS branch_is_hq
    FROM users u
    LEFT JOIN branches b ON b.id=u.branch_id
    WHERE u.enterprise_id=? ORDER BY u.role DESC, u.name ASC
  `).all(eid);
  return res.json({ success: true, data: rows });
};

// GET /api/users/:id
const getUser = (req, res) => {
  const row = getDb().prepare(
    `SELECT id, enterprise_id, name, email, role, is_active, avatar_url, created_at FROM users WHERE enterprise_id=? AND id=?`
  ).get(EID(req), req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'User not found' });
  return res.json({ success: true, data: row });
};

// POST /api/users — admin creates cashier
const createUser = async (req, res) => {
  const { name, email, password, branch_id } = req.body;
  const eid = EID(req);

  if (!name || !email || !password)
    return res.status(400).json({ success: false, message: 'name, email, and password required' });
  if (password.length < 8)
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });

  const db = getDb();

  const existing = db.prepare(`SELECT id FROM users WHERE email=?`).get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ success: false, message: 'Email already registered' });

  // Validate branch belongs to this enterprise
  let resolvedBranchId = branch_id || null;
  if (resolvedBranchId) {
    const branch = db.prepare(`SELECT id FROM branches WHERE id=? AND enterprise_id=? AND is_active=1`).get(resolvedBranchId, eid);
    if (!branch) return res.status(400).json({ success: false, message: 'Invalid branch — branch not found or inactive' });
  } else {
    // Default to HQ branch if none specified
    const hq = db.prepare(`SELECT id FROM branches WHERE enterprise_id=? AND is_hq=1`).get(eid);
    resolvedBranchId = hq?.id || null;
  }

  const id     = uuidv4();
  const hashed = await bcrypt.hash(password, 10);
  const now    = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (id, enterprise_id, branch_id, name, email, password, role, is_active, is_verified, created_at, updated_at)
    VALUES (?,?,?,?,?,?,'cashier',1,1,?,?)
  `).run(id, eid, resolvedBranchId, String(name), email.toLowerCase().trim(), hashed, now, now);

  db.prepare(`
    INSERT INTO sync_queue (id, enterprise_id, action_type, entity_type, entity_id, payload_json)
    VALUES (?,?,'CREATE_USER','users',?,?)
  `).run(uuidv4(), eid, id, JSON.stringify({
    id, enterprise_id: eid, branch_id: resolvedBranchId,
    name, email: email.toLowerCase().trim(), role: 'cashier',
  }));

  return res.status(201).json({ success: true, data: {
    id, name, email: email.toLowerCase().trim(),
    role: 'cashier', branch_id: resolvedBranchId, is_active: 1, created_at: now,
  }});
};

// PUT /api/users/:id
const updateUser = async (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const user = db.prepare(`SELECT * FROM users WHERE enterprise_id=? AND id=?`).get(eid, req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const name  = req.body.name  !== undefined ? String(req.body.name)  : user.name;
  const email = req.body.email !== undefined ? String(req.body.email) : user.email;
  const now   = new Date().toISOString();

  db.prepare(`UPDATE users SET name=?, email=?, updated_at=? WHERE enterprise_id=? AND id=?`)
    .run(name, email, now, eid, req.params.id);

  const updated = db.prepare(`SELECT id, name, email, role, is_active FROM users WHERE id=?`).get(req.params.id);
  return res.json({ success: true, data: updated });
};

// PATCH /api/users/:id/status
const setUserStatus = (req, res) => {
  const { is_active } = req.body;
  if (is_active === undefined) return res.status(400).json({ success: false, message: 'is_active required' });
  if (req.params.id === req.user.id) return res.status(400).json({ success: false, message: 'Cannot change your own status' });

  const db  = getDb();
  const eid = EID(req);
  const user = db.prepare(`SELECT id FROM users WHERE enterprise_id=? AND id=?`).get(eid, req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  db.prepare(`UPDATE users SET is_active=?, updated_at=? WHERE enterprise_id=? AND id=?`)
    .run(is_active ? 1 : 0, new Date().toISOString(), eid, req.params.id);

  return res.json({ success: true, message: `Account ${is_active ? 'activated' : 'deactivated'}` });
};

// PATCH /api/users/:id/password
const changePassword = async (req, res) => {
  const { current_password, new_password } = req.body;
  const eid    = EID(req);
  const isSelf = req.params.id === req.user.id;

  if (!new_password || new_password.length < 8)
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });

  const db   = getDb();
  const user = db.prepare(`SELECT * FROM users WHERE enterprise_id=? AND id=?`).get(eid, req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  // Require current password only when changing own password as non-admin
  if (isSelf && req.user.role !== 'admin') {
    if (!current_password)
      return res.status(400).json({ success: false, message: 'current_password required' });
    if (!bcrypt.compareSync(current_password, user.password))
      return res.status(401).json({ success: false, message: 'Current password incorrect' });
  }

  const hashed = await bcrypt.hash(new_password, 10);
  db.prepare(`UPDATE users SET password=?, updated_at=? WHERE enterprise_id=? AND id=?`)
    .run(hashed, new Date().toISOString(), eid, req.params.id);

  return res.json({ success: true, message: 'Password updated' });
};

// GET /api/users/:id/activity
const getUserActivity = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const user = db.prepare(`SELECT id, name FROM users WHERE enterprise_id=? AND id=?`).get(eid, req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const sales = db.prepare(
    `SELECT id, receipt_number, total_amount, status, created_at FROM sales WHERE enterprise_id=? AND user_id=? ORDER BY created_at DESC LIMIT 20`
  ).all(eid, req.params.id);

  const stats = db.prepare(
    `SELECT COUNT(*) AS total_sales, COALESCE(SUM(total_amount),0) AS total_revenue, COALESCE(AVG(total_amount),0) AS avg_sale FROM sales WHERE enterprise_id=? AND user_id=? AND status='completed'`
  ).get(eid, req.params.id);

  return res.json({ success: true, data: { user, stats, recent_sales: sales } });
};

module.exports = { getUsers, getUser, createUser, updateUser, setUserStatus, changePassword, getUserActivity };
