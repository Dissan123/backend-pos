// src/controllers/stockOrderController.js
// Warehouse → Branch stock transfer system
'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../db/localDb');

const EID = (req) => req.user.enterprise_id;
const BID = (req) => req.user.branch_id;

// ── GET /api/stock-orders ─────────────────────────────────────────
// Admin sees all orders; cashier sees only their branch orders
const getOrders = (req, res) => {
  const db    = getDb();
  const eid   = EID(req);
  const isAdmin = req.user.role === 'admin' || req.user.role === 'owner';
  const { status, branch_id } = req.query;

  let sql = `
    SELECT so.*,
           b.name  AS branch_name,
           u.name  AS requested_by_name,
           a.name  AS approved_by_name,
           (SELECT COUNT(*) FROM stock_order_items si WHERE si.order_id=so.id) AS item_count
    FROM stock_orders so
    LEFT JOIN branches b ON b.id=so.branch_id
    LEFT JOIN users    u ON u.id=so.requested_by
    LEFT JOIN users    a ON a.id=so.approved_by
    WHERE so.enterprise_id=?
  `;
  const args = [eid];

  // Cashiers only see their own branch
  if (!isAdmin) {
    sql += ` AND so.branch_id=?`;
    args.push(BID(req));
  } else if (branch_id) {
    sql += ` AND so.branch_id=?`;
    args.push(branch_id);
  }

  if (status) { sql += ` AND so.status=?`; args.push(status); }

  sql += ` ORDER BY so.created_at DESC LIMIT 100`;

  const orders = db.prepare(sql).all(...args);
  return res.json({ success: true, data: orders });
};

// ── GET /api/stock-orders/:id ─────────────────────────────────────
const getOrder = (req, res) => {
  const db    = getDb();
  const eid   = EID(req);
  const isAdmin = req.user.role === 'admin' || req.user.role === 'owner';

  const order = db.prepare(`
    SELECT so.*,
           b.name AS branch_name,
           u.name AS requested_by_name,
           a.name AS approved_by_name
    FROM stock_orders so
    LEFT JOIN branches b ON b.id=so.branch_id
    LEFT JOIN users    u ON u.id=so.requested_by
    LEFT JOIN users    a ON a.id=so.approved_by
    WHERE so.id=? AND so.enterprise_id=?
  `).get(req.params.id, eid);

  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  // Cashier can only see their branch
  if (!isAdmin && order.branch_id !== BID(req))
    return res.status(403).json({ success: false, message: 'Access denied' });

  const items = db.prepare(`
    SELECT soi.*, p.warehouse_qty, p.stock_quantity, p.image_url
    FROM stock_order_items soi
    LEFT JOIN products p ON p.id=soi.product_id
    WHERE soi.order_id=?
  `).all(req.params.id);

  return res.json({ success: true, data: { ...order, items } });
};

// ── POST /api/stock-orders — Branch requests stock ────────────────
const createOrder = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const bid = BID(req);
  const { items, notes } = req.body;

  if (!bid)
    return res.status(400).json({ success: false, message: 'You must be assigned to a branch to place orders' });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ success: false, message: 'Order must have at least one item' });

  // Validate all products exist in warehouse
  for (const item of items) {
    if (!item.product_id || !item.quantity_requested || item.quantity_requested < 1)
      return res.status(400).json({ success: false, message: 'Each item needs product_id and quantity_requested >= 1' });

    const product = db.prepare(`SELECT * FROM products WHERE id=? AND enterprise_id=? AND is_active=1`).get(item.product_id, eid);
    if (!product)
      return res.status(400).json({ success: false, message: `Product not found: ${item.product_id}` });
  }

  const now = new Date().toISOString();
  const orderId = uuidv4();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO stock_orders (id, enterprise_id, branch_id, requested_by, status, notes, created_at, updated_at)
      VALUES (?,?,?,?,'pending',?,?,?)
    `).run(orderId, eid, bid, req.user.id, notes || null, now, now);

    for (const item of items) {
      const product = db.prepare(`SELECT * FROM products WHERE id=?`).get(item.product_id);
      db.prepare(`
        INSERT INTO stock_order_items (id, order_id, enterprise_id, product_id, product_name, quantity_requested, unit_cost)
        VALUES (?,?,?,?,?,?,?)
      `).run(uuidv4(), orderId, eid, item.product_id, product.name, parseInt(item.quantity_requested), product.cost_price || 0);
    }
  })();

  const order = db.prepare(`SELECT * FROM stock_orders WHERE id=?`).get(orderId);
  const orderItems = db.prepare(`SELECT * FROM stock_order_items WHERE order_id=?`).all(orderId);

  return res.status(201).json({ success: true, data: { ...order, items: orderItems } });
};

// ── PATCH /api/stock-orders/:id/approve — Admin approves ─────────
const approveOrder = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const now = new Date().toISOString();

  const order = db.prepare(`SELECT * FROM stock_orders WHERE id=? AND enterprise_id=?`).get(req.params.id, eid);
  if (!order)         return res.status(404).json({ success: false, message: 'Order not found' });
  if (order.status !== 'pending')
    return res.status(400).json({ success: false, message: `Order is already ${order.status}` });

  // Optionally adjust quantities per item
  const { quantities } = req.body; // { product_id: approved_qty }

  const items = db.prepare(`SELECT * FROM stock_order_items WHERE order_id=?`).all(order.id);

  // Check warehouse stock for each item
  const shortages = [];
  for (const item of items) {
    const approvedQty = quantities?.[item.product_id] ?? item.quantity_requested;
    const product = db.prepare(`SELECT * FROM products WHERE id=?`).get(item.product_id);
    const warehouseQty = product?.warehouse_qty || 0;
    if (approvedQty > warehouseQty) {
      shortages.push(`${item.product_name}: requested ${approvedQty}, warehouse only has ${warehouseQty}`);
    }
  }

  if (shortages.length > 0)
    return res.status(400).json({ success: false, message: 'Insufficient warehouse stock', shortages });

  // All good — approve and fulfill immediately
  db.transaction(() => {
    db.prepare(`
      UPDATE stock_orders SET status='fulfilled', approved_by=?, updated_at=? WHERE id=?
    `).run(req.user.id, now, order.id);

    for (const item of items) {
      const approvedQty = quantities?.[item.product_id] ?? item.quantity_requested;
      const product = db.prepare(`SELECT * FROM products WHERE id=?`).get(item.product_id);

      // 1. Deduct from warehouse stock
      const newWarehouseQty = Math.max((product.warehouse_qty || 0) - approvedQty, 0);
      db.prepare(`UPDATE products SET warehouse_qty=?, updated_at=?, synced=0 WHERE id=?`)
        .run(newWarehouseQty, now, item.product_id);

      // 2. Upsert into branch_stock — this is the branch's own inventory
      const existing = db.prepare(
        `SELECT quantity FROM branch_stock WHERE branch_id=? AND product_id=?`
      ).get(order.branch_id, item.product_id);

      const prevBranchQty = existing?.quantity || 0;
      const newBranchQty  = prevBranchQty + approvedQty;

      if (existing) {
        db.prepare(`UPDATE branch_stock SET quantity=?, updated_at=? WHERE branch_id=? AND product_id=?`)
          .run(newBranchQty, now, order.branch_id, item.product_id);
      } else {
        db.prepare(`
          INSERT INTO branch_stock (id, enterprise_id, branch_id, product_id, quantity, updated_at)
          VALUES (?,?,?,?,?,?)
        `).run(uuidv4(), eid, order.branch_id, item.product_id, newBranchQty, now);
      }

      // 3. Update fulfilled quantity on the order item
      db.prepare(`UPDATE stock_order_items SET quantity_fulfilled=? WHERE id=?`)
        .run(approvedQty, item.id);

      // 4. Log inventory transfer
      db.prepare(`
        INSERT INTO inventory_logs
          (id, enterprise_id, branch_id, product_id, change, reason, reference_id,
           stock_before, stock_after, user_id, created_at)
        VALUES (?,?,?,?,?,'branch_transfer',?,?,?,?,?)
      `).run(
        uuidv4(), eid, order.branch_id, item.product_id,
        approvedQty, order.id,
        prevBranchQty, newBranchQty,
        req.user.id, now
      );
    }
  })();

  return res.json({ success: true, message: 'Order approved and stock transferred to branch' });
};

// ── PATCH /api/stock-orders/:id/reject — Admin rejects ───────────
const rejectOrder = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { reason } = req.body;

  const order = db.prepare(`SELECT * FROM stock_orders WHERE id=? AND enterprise_id=?`).get(req.params.id, eid);
  if (!order)               return res.status(404).json({ success: false, message: 'Order not found' });
  if (order.status !== 'pending')
    return res.status(400).json({ success: false, message: `Order is already ${order.status}` });

  db.prepare(`
    UPDATE stock_orders SET status='rejected', approved_by=?, rejection_reason=?, updated_at=? WHERE id=?
  `).run(req.user.id, reason || 'No reason given', new Date().toISOString(), order.id);

  return res.json({ success: true, message: 'Order rejected' });
};

// ── GET /api/warehouse — Admin sees central warehouse stock ───────
const getWarehouse = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { search, category, low_stock } = req.query;

  let sql = `SELECT * FROM products WHERE enterprise_id=? AND is_active=1`;
  const args = [eid];

  if (search)             { sql += ` AND (name LIKE ? OR barcode=?)`; args.push(`%${search}%`, search); }
  if (category)           { sql += ` AND category=?`; args.push(category); }
  if (low_stock === 'true') sql += ` AND warehouse_qty <= low_stock_alert`;

  sql += ` ORDER BY name ASC`;

  const products = db.prepare(sql).all(...args);

  // Pending orders summary per product
  const pendingOrders = db.prepare(`
    SELECT soi.product_id, SUM(soi.quantity_requested) AS total_requested
    FROM stock_order_items soi
    JOIN stock_orders so ON so.id=soi.order_id
    WHERE so.enterprise_id=? AND so.status='pending'
    GROUP BY soi.product_id
  `).all(eid);

  const pendingMap = {};
  pendingOrders.forEach(p => { pendingMap[p.product_id] = p.total_requested; });

  const withPending = products.map(p => ({
    ...p,
    pending_requests: pendingMap[p.id] || 0,
  }));

  return res.json({ success: true, data: withPending });
};

// ── PATCH /api/warehouse/:id/restock — Admin adds warehouse stock ─
const restockWarehouse = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { quantity, notes } = req.body;

  if (!quantity || parseInt(quantity) < 1)
    return res.status(400).json({ success: false, message: 'quantity must be >= 1' });

  const product = db.prepare(`SELECT * FROM products WHERE id=? AND enterprise_id=? AND is_active=1`).get(req.params.id, eid);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

  const qty = parseInt(quantity);
  const now = new Date().toISOString();
  const newWarehouseQty = (product.warehouse_qty || 0) + qty;

  db.prepare(`UPDATE products SET warehouse_qty=?, updated_at=?, synced=0 WHERE id=? AND enterprise_id=?`)
    .run(newWarehouseQty, now, req.params.id, eid);

  // ── HQ branch gets the same stock automatically ──────────────
  // HQ doesn't place stock orders — restocking the warehouse IS
  // restocking the HQ. Find HQ branch and top up its branch_stock.
  const hqBranch = db.prepare(
    `SELECT id FROM branches WHERE enterprise_id=? AND is_hq=1 AND is_active=1 LIMIT 1`
  ).get(eid);

  if (hqBranch) {
    const existing = db.prepare(
      `SELECT quantity FROM branch_stock WHERE branch_id=? AND product_id=?`
    ).get(hqBranch.id, req.params.id);

    if (existing) {
      db.prepare(`UPDATE branch_stock SET quantity=quantity+?, updated_at=? WHERE branch_id=? AND product_id=?`)
        .run(qty, now, hqBranch.id, req.params.id);
    } else {
      db.prepare(`INSERT INTO branch_stock (id, enterprise_id, branch_id, product_id, quantity, updated_at) VALUES (?,?,?,?,?,?)`)
        .run(uuidv4(), eid, hqBranch.id, req.params.id, qty, now);
    }

    db.prepare(`
      INSERT INTO inventory_logs
        (id, enterprise_id, branch_id, product_id, change, reason, notes,
         stock_before, stock_after, user_id, created_at)
      VALUES (?,?,?,?,?,'restock',?,?,?,?,?)
    `).run(uuidv4(), eid, hqBranch.id, req.params.id, qty, notes || null,
           existing?.quantity || 0,
           (existing?.quantity || 0) + qty,
           req.user.id, now);
  }

  db.prepare(`
    INSERT INTO inventory_logs
      (id, enterprise_id, product_id, change, reason, notes, stock_before, stock_after, user_id, created_at)
    VALUES (?,?,?,?,'restock',?,?,?,?,?)
  `).run(uuidv4(), eid, req.params.id, qty, notes || null,
         product.warehouse_qty || 0, newWarehouseQty, req.user.id, now);

  return res.json({ success: true, data: {
    warehouse_qty: newWarehouseQty,
    hq_stock_updated: !!hqBranch,
  } });
};

// ── GET /api/stock-orders/summary — pending count for badge ───────
const getSummary = (req, res) => {
  const db    = getDb();
  const eid   = EID(req);
  const isAdmin = req.user.role === 'admin' || req.user.role === 'owner';

  if (isAdmin) {
    const pending = db.prepare(`SELECT COUNT(*) AS c FROM stock_orders WHERE enterprise_id=? AND status='pending'`).get(eid);
    return res.json({ success: true, data: { pending_count: pending.c } });
  } else {
    const bid = BID(req);
    const pending = db.prepare(`SELECT COUNT(*) AS c FROM stock_orders WHERE enterprise_id=? AND branch_id=? AND status='pending'`).get(eid, bid);
    return res.json({ success: true, data: { pending_count: pending.c } });
  }
};

// ── GET /api/warehouse/catalogue — All products with warehouse stock (cashiers can see) ──
const getCatalogue = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const bid = BID(req);
  const { search, category } = req.query;

  let sql  = `
    SELECT p.*,
           p.warehouse_qty AS available_in_warehouse,
           COALESCE(bs.quantity, 0) AS branch_qty,
           COALESCE(pending.total_requested, 0) AS my_pending_qty
    FROM products p
    LEFT JOIN branch_stock bs
      ON bs.product_id=p.id AND bs.branch_id=?
    LEFT JOIN (
      SELECT soi.product_id, SUM(soi.quantity_requested) AS total_requested
      FROM stock_order_items soi
      JOIN stock_orders so ON so.id=soi.order_id
      WHERE so.branch_id=? AND so.status='pending'
      GROUP BY soi.product_id
    ) pending ON pending.product_id=p.id
    WHERE p.enterprise_id=? AND p.is_active=1
  `;
  const args = [bid || '', bid || '', eid];

  if (search) {
    sql += ` AND (p.name LIKE ? OR p.barcode=?)`;
    args.push(`%${search}%`, search);
  }
  if (category) {
    sql += ` AND p.category=?`;
    args.push(category);
  }

  sql += ` ORDER BY p.name ASC`;
  const rows = db.prepare(sql).all(...args);

  return res.json({ success: true, data: rows });
};

module.exports = {
  getOrders, getOrder, createOrder, getCatalogue,
  approveOrder, rejectOrder,
  getWarehouse, restockWarehouse, getSummary,
};
