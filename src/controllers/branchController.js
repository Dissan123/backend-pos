// src/controllers/branchController.js
'use strict';

const { v4: uuidv4 }  = require('uuid');
const { getDb }       = require('../db/localDb');

const EID = (req) => req.user.enterprise_id;

// ── GET /api/branches ─────────────────────────────────────────────
const getBranches = (req, res) => {
  const db  = getDb();
  const eid = EID(req);

  const branches = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM users   u WHERE u.branch_id=b.id AND u.is_active=1) AS staff_count,
      (SELECT COUNT(*) FROM products p WHERE p.branch_id=b.id AND p.is_active=1) AS product_count,
      (SELECT COALESCE(SUM(s.total_amount),0) FROM sales s
       WHERE s.branch_id=b.id AND s.status='completed'
       AND date(s.created_at)=date('now')) AS revenue_today
    FROM branches b
    WHERE b.enterprise_id=?
    ORDER BY b.is_hq DESC, b.name ASC
  `).all(eid);

  return res.json({ success: true, data: branches });
};

// ── GET /api/branches/:id ─────────────────────────────────────────
const getBranch = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const branch = db.prepare(`SELECT * FROM branches WHERE id=? AND enterprise_id=?`).get(req.params.id, eid);
  if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

  const staff = db.prepare(`
    SELECT id, name, email, role, is_active FROM users
    WHERE branch_id=? AND enterprise_id=? ORDER BY role ASC, name ASC
  `).all(req.params.id, eid);

  const stats = db.prepare(`
    SELECT COUNT(*) AS total_sales,
           COALESCE(SUM(total_amount),0) AS total_revenue,
           COALESCE(AVG(total_amount),0) AS avg_sale,
           COUNT(CASE WHEN date(created_at)=date('now') THEN 1 END) AS today_sales,
           COALESCE(SUM(CASE WHEN date(created_at)=date('now') THEN total_amount ELSE 0 END),0) AS today_revenue
    FROM sales WHERE branch_id=? AND status='completed'
  `).get(req.params.id);

  const inventory = db.prepare(`
    SELECT COUNT(*) AS products,
           COALESCE(SUM(stock_quantity),0) AS total_units,
           COALESCE(SUM(stock_quantity*price),0) AS retail_value,
           COUNT(CASE WHEN stock_quantity=0 THEN 1 END) AS out_of_stock,
           COUNT(CASE WHEN stock_quantity>0 AND stock_quantity<=low_stock_alert THEN 1 END) AS low_stock
    FROM products WHERE branch_id=? AND is_active=1
  `).get(req.params.id);

  return res.json({ success: true, data: { ...branch, staff, stats, inventory } });
};

// ── POST /api/branches ────────────────────────────────────────────
const createBranch = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { name, address, phone, email } = req.body;

  if (!name?.trim()) return res.status(400).json({ success: false, message: 'Branch name is required' });

  const id  = uuidv4();
  const now = new Date().toISOString();

  // Check if this is the first branch (make it HQ)
  const existing = db.prepare(`SELECT COUNT(*) AS c FROM branches WHERE enterprise_id=?`).get(eid);
  const isHQ = existing.c === 0 ? 1 : 0;

  db.prepare(`
    INSERT INTO branches (id, enterprise_id, name, address, phone, email, is_active, is_hq, created_at, updated_at)
    VALUES (?,?,?,?,?,?,1,?,?,?)
  `).run(id, eid, String(name).trim(), address || null, phone || null, email || null, isHQ, now, now);

  const branch = db.prepare(`SELECT * FROM branches WHERE id=?`).get(id);

  // Queue for sync
  db.prepare(`
    INSERT INTO sync_queue (id, enterprise_id, action_type, entity_type, entity_id, payload_json)
    VALUES (?,?,'CREATE_BRANCH','branches',?,?)
  `).run(uuidv4(), eid, id, JSON.stringify(branch));

  return res.status(201).json({ success: true, data: branch });
};

// ── PUT /api/branches/:id ─────────────────────────────────────────
const updateBranch = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const branch = db.prepare(`SELECT * FROM branches WHERE id=? AND enterprise_id=?`).get(req.params.id, eid);
  if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

  const now  = new Date().toISOString();
  const name    = req.body.name    !== undefined ? String(req.body.name)    : branch.name;
  const address = req.body.address !== undefined ? String(req.body.address) : branch.address;
  const phone   = req.body.phone   !== undefined ? String(req.body.phone)   : branch.phone;
  const email   = req.body.email   !== undefined ? String(req.body.email)   : branch.email;

  db.prepare(`
    UPDATE branches SET name=?, address=?, phone=?, email=?, updated_at=?
    WHERE id=? AND enterprise_id=?
  `).run(name, address, phone, email, now, req.params.id, eid);

  const updated = db.prepare(`SELECT * FROM branches WHERE id=?`).get(req.params.id);
  return res.json({ success: true, data: updated });
};

// ── PATCH /api/branches/:id/status ───────────────────────────────
const setBranchStatus = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { is_active } = req.body;
  if (is_active === undefined) return res.status(400).json({ success: false, message: 'is_active required' });

  const branch = db.prepare(`SELECT * FROM branches WHERE id=? AND enterprise_id=?`).get(req.params.id, eid);
  if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });
  if (branch.is_hq && !is_active) return res.status(400).json({ success: false, message: 'Cannot deactivate HQ branch' });

  db.prepare(`UPDATE branches SET is_active=?, updated_at=? WHERE id=? AND enterprise_id=?`)
    .run(is_active ? 1 : 0, new Date().toISOString(), req.params.id, eid);

  return res.json({ success: true, message: `Branch ${is_active ? 'activated' : 'deactivated'}` });
};

// ── GET /api/branches/compare ─────────────────────────────────────
const compareBranches = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { from, to } = req.query;
  const today = new Date().toISOString().slice(0, 10);
  const start = from || `${today}T00:00:00`;
  const end   = to   || `${today}T23:59:59`;

  const branches = db.prepare(`SELECT * FROM branches WHERE enterprise_id=? AND is_active=1`).all(eid);

  const result = branches.map(branch => {
    const sales = db.prepare(`
      SELECT COUNT(*) AS transactions,
             COALESCE(SUM(total_amount),0)  AS revenue,
             COALESCE(AVG(total_amount),0)  AS avg_sale,
             COALESCE(SUM(discount),0)      AS discounts
      FROM sales WHERE branch_id=? AND status='completed' AND created_at BETWEEN ? AND ?
    `).get(branch.id, start, end);

    const cogs = db.prepare(`
      SELECT COALESCE(SUM(si.quantity * COALESCE(p.cost_price,0)),0) AS total_cogs
      FROM sale_items si
      JOIN sales s ON si.sale_id=s.id
      LEFT JOIN products p ON si.product_id=p.id
      WHERE s.branch_id=? AND s.status='completed' AND s.created_at BETWEEN ? AND ?
    `).get(branch.id, start, end);

    const items = db.prepare(`
      SELECT COALESCE(SUM(si.quantity),0) AS total
      FROM sale_items si JOIN sales s ON si.sale_id=s.id
      WHERE s.branch_id=? AND s.status='completed' AND s.created_at BETWEEN ? AND ?
    `).get(branch.id, start, end);

    const inv = db.prepare(`
      SELECT COUNT(*) AS products,
             COALESCE(SUM(stock_quantity),0) AS units,
             COUNT(CASE WHEN stock_quantity=0 THEN 1 END) AS out_of_stock
      FROM products WHERE branch_id=? AND is_active=1
    `).get(branch.id);

    const topProduct = db.prepare(`
      SELECT si.product_name, SUM(si.quantity) AS qty, SUM(si.subtotal) AS rev
      FROM sale_items si JOIN sales s ON si.sale_id=s.id
      WHERE s.branch_id=? AND s.status='completed' AND s.created_at BETWEEN ? AND ?
      GROUP BY si.product_id ORDER BY rev DESC LIMIT 1
    `).get(branch.id, start, end);

    const grossProfit = sales.revenue - cogs.total_cogs;

    return {
      branch: { id: branch.id, name: branch.name, is_hq: branch.is_hq },
      sales: {
        transactions: sales.transactions,
        revenue:      sales.revenue,
        avg_sale:     sales.avg_sale,
        discounts:    sales.discounts,
        items_sold:   items.total,
        gross_profit: grossProfit,
        profit_margin: sales.revenue > 0 ? ((grossProfit / sales.revenue) * 100).toFixed(1) : '0',
      },
      inventory: inv,
      top_product: topProduct || null,
    };
  });

  // Sort by revenue desc
  result.sort((a, b) => b.sales.revenue - a.sales.revenue);

  const totalRevenue = result.reduce((t, r) => t + r.sales.revenue, 0);
  const resultWithShare = result.map(r => ({
    ...r,
    revenue_share: totalRevenue > 0 ? ((r.sales.revenue / totalRevenue) * 100).toFixed(1) : '0',
  }));

  return res.json({ success: true, data: { branches: resultWithShare, period: { from: start, to: end }, total_revenue: totalRevenue } });
};

// ── PATCH /api/users/:id/branch — assign user to branch ──────────
const assignUserToBranch = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { branch_id } = req.body;

  const user = db.prepare(`SELECT * FROM users WHERE id=? AND enterprise_id=?`).get(req.params.id, eid);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  if (branch_id) {
    const branch = db.prepare(`SELECT id FROM branches WHERE id=? AND enterprise_id=? AND is_active=1`).get(branch_id, eid);
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });
  }

  db.prepare(`UPDATE users SET branch_id=?, updated_at=? WHERE id=? AND enterprise_id=?`)
    .run(branch_id || null, new Date().toISOString(), req.params.id, eid);

  return res.json({ success: true, message: branch_id ? 'User assigned to branch' : 'User unassigned from branch' });
};

module.exports = { getBranches, getBranch, createBranch, updateBranch, setBranchStatus, compareBranches, assignUserToBranch };
