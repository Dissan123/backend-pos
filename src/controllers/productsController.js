// src/controllers/productsController.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../db/localDb');

const EID = (req) => req.user.enterprise_id;

// GET /api/products
const getProducts = (req, res) => {
  const db    = getDb();
  const eid   = EID(req);
  const bid   = req.user.branch_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'owner';
  const { search, category, low_stock } = req.query;

  // Admin: sees all products with warehouse_qty
  // Cashier: sees only products their branch has received (branch_stock > 0)
  let sql, args;

  if (isAdmin) {
    sql  = `SELECT * FROM products WHERE enterprise_id=? AND is_active=1`;
    args = [eid];
    if (search)               { sql += ` AND (name LIKE ? OR barcode=?)`; args.push(`%${search}%`, search); }
    if (category)             { sql += ` AND category=?`;                 args.push(category); }
    if (low_stock === 'true')   sql += ` AND warehouse_qty <= low_stock_alert`;
  } else {
    // Cashier: join branch_stock, only show products with stock > 0 in their branch
    sql  = `
      SELECT p.*, bs.quantity AS stock_quantity
      FROM products p
      JOIN branch_stock bs ON bs.product_id=p.id AND bs.branch_id=?
      WHERE p.enterprise_id=? AND p.is_active=1 AND bs.quantity > 0
    `;
    args = [bid, eid];
    if (search)               { sql += ` AND (p.name LIKE ? OR p.barcode=?)`; args.push(`%${search}%`, search); }
    if (category)             { sql += ` AND p.category=?`;                   args.push(category); }
    if (low_stock === 'true')   sql += ` AND bs.quantity <= p.low_stock_alert`;
  }

  sql += ` ORDER BY ${isAdmin ? 'name' : 'p.name'} ASC`;
  const rows = db.prepare(sql).all(...args);
  return res.json({ success: true, data: rows, count: rows.length });
};

// GET /api/products/categories
const getCategories = (req, res) => {
  const rows = getDb().prepare(
    `SELECT DISTINCT category FROM products WHERE enterprise_id=? AND is_active=1 AND category IS NOT NULL ORDER BY category`
  ).all(EID(req));
  return res.json({ success: true, data: rows.map(r => r.category) });
};

// GET /api/products/barcode/:barcode
const getProductByBarcode = (req, res) => {
  const db    = getDb();
  const eid   = EID(req);
  const bid   = req.user.branch_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'owner';

  let row;
  if (isAdmin) {
    row = db.prepare(`SELECT * FROM products WHERE enterprise_id=? AND barcode=? AND is_active=1`).get(eid, req.params.barcode);
  } else {
    row = db.prepare(`
      SELECT p.*, bs.quantity AS stock_quantity
      FROM products p
      JOIN branch_stock bs ON bs.product_id=p.id AND bs.branch_id=?
      WHERE p.enterprise_id=? AND p.barcode=? AND p.is_active=1 AND bs.quantity > 0
    `).get(bid, eid, req.params.barcode);
  }
  if (!row) return res.status(404).json({ success: false, message: 'Product not found' });
  return res.json({ success: true, data: row });
};

// GET /api/products/:id
const getProduct = (req, res) => {
  const db    = getDb();
  const eid   = EID(req);
  const bid   = req.user.branch_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'owner';

  let row;
  if (isAdmin) {
    row = db.prepare(`SELECT * FROM products WHERE enterprise_id=? AND id=? AND is_active=1`).get(eid, req.params.id);
  } else {
    row = db.prepare(`
      SELECT p.*, COALESCE(bs.quantity, 0) AS stock_quantity
      FROM products p
      LEFT JOIN branch_stock bs ON bs.product_id=p.id AND bs.branch_id=?
      WHERE p.enterprise_id=? AND p.id=? AND p.is_active=1
    `).get(bid, eid, req.params.id);
  }
  if (!row) return res.status(404).json({ success: false, message: 'Product not found' });
  return res.json({ success: true, data: row });
};

// POST /api/products
const createProduct = (req, res) => {
  const { name, description, price, cost_price, stock_quantity,
          barcode, category, unit, low_stock_alert, image_url, expiry_date } = req.body;
  const eid = EID(req);

  if (!name || price === undefined)
    return res.status(400).json({ success: false, message: 'name and price are required' });

  const db = getDb();

  if (barcode) {
    const dup = db.prepare(`SELECT id FROM products WHERE enterprise_id=? AND barcode=?`).get(eid, barcode);
    if (dup) return res.status(409).json({ success: false, message: 'Barcode already exists' });
  }

  const id  = uuidv4();
  const now = new Date().toISOString();
  const qty = parseInt(stock_quantity) || 0;

  db.prepare(`
    INSERT INTO products
      (id, enterprise_id, name, description, price, cost_price, stock_quantity,
       warehouse_qty, barcode, category, unit, low_stock_alert, image_url, expiry_date, is_active, created_at, updated_at, synced)
    VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,1,?,?,0)
  `).run(
    id, eid,
    String(name),
    description ? String(description) : null,
    parseFloat(price),
    parseFloat(cost_price) || 0,
    qty,
    barcode ? String(barcode) : null,
    category ? String(category) : null,
    unit ? String(unit) : 'piece',
    parseInt(low_stock_alert) || 5,
    image_url   ? String(image_url)   : null,
    expiry_date ? String(expiry_date) : null,
    now, now
  );

  if (qty > 0) {
    db.prepare(`
      INSERT INTO inventory_logs
        (id, enterprise_id, product_id, change, reason, stock_before, stock_after, user_id, created_at)
      VALUES (?,?,?,?,'opening_stock',0,?,?,?)
    `).run(uuidv4(), eid, id, qty, qty, req.user.id, now);
  }

  const product = db.prepare(`SELECT * FROM products WHERE id=?`).get(id);

  db.prepare(`
    INSERT INTO sync_queue (id, enterprise_id, action_type, entity_type, entity_id, payload_json)
    VALUES (?,?,'CREATE_PRODUCT','products',?,?)
  `).run(uuidv4(), eid, id, JSON.stringify(product));

  return res.status(201).json({ success: true, data: product });
};

// PUT /api/products/:id
const updateProduct = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const existing = db.prepare(`SELECT * FROM products WHERE enterprise_id=? AND id=? AND is_active=1`).get(eid, req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Product not found' });

  const now = new Date().toISOString();

  // Only update fields that were actually sent
  const name            = req.body.name            !== undefined ? String(req.body.name)             : existing.name;
  const description     = req.body.description     !== undefined ? String(req.body.description)      : existing.description;
  const price           = req.body.price           !== undefined ? parseFloat(req.body.price)        : existing.price;
  const cost_price      = req.body.cost_price      !== undefined ? parseFloat(req.body.cost_price)   : existing.cost_price;
  const barcode         = req.body.barcode         !== undefined ? String(req.body.barcode)          : existing.barcode;
  const category        = req.body.category        !== undefined ? String(req.body.category)         : existing.category;
  const unit            = req.body.unit            !== undefined ? String(req.body.unit)             : existing.unit;
  const low_stock_alert = req.body.low_stock_alert !== undefined ? parseInt(req.body.low_stock_alert): existing.low_stock_alert;
  const image_url       = req.body.image_url       !== undefined ? (req.body.image_url ? String(req.body.image_url) : null) : existing.image_url;
  const expiry_date     = req.body.expiry_date     !== undefined ? (req.body.expiry_date ? String(req.body.expiry_date) : null) : existing.expiry_date;

  db.prepare(`
    UPDATE products SET
      name=?, description=?, price=?, cost_price=?,
      barcode=?, category=?, unit=?, low_stock_alert=?,
      image_url=?, updated_at=?, synced=0
    WHERE enterprise_id=? AND id=?
  `).run(name, description, price, cost_price, barcode, category, unit, low_stock_alert, image_url, now, eid, req.params.id);

  const updated = db.prepare(`SELECT * FROM products WHERE id=?`).get(req.params.id);

  db.prepare(`
    INSERT INTO sync_queue (id, enterprise_id, action_type, entity_type, entity_id, payload_json)
    VALUES (?,?,'UPDATE_PRODUCT','products',?,?)
  `).run(uuidv4(), eid, req.params.id, JSON.stringify(updated));

  return res.json({ success: true, data: updated });
};

// PATCH /api/products/:id/stock
const updateStock = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { change, reason, notes } = req.body;

  if (change === undefined || !reason)
    return res.status(400).json({ success: false, message: 'change and reason are required' });

  const product = db.prepare(`SELECT * FROM products WHERE enterprise_id=? AND id=? AND is_active=1`).get(eid, req.params.id);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

  const delta    = parseInt(change);
  const newStock = product.stock_quantity + delta;
  if (newStock < 0) return res.status(400).json({ success: false, message: `Insufficient stock. Available: ${product.stock_quantity}` });

  const now = new Date().toISOString();

  db.prepare(`UPDATE products SET stock_quantity=?, updated_at=?, synced=0 WHERE enterprise_id=? AND id=?`)
    .run(newStock, now, eid, req.params.id);

  db.prepare(`
    INSERT INTO inventory_logs
      (id, enterprise_id, product_id, change, reason, notes, stock_before, stock_after, user_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(uuidv4(), eid, req.params.id, delta, String(reason), notes ? String(notes) : null,
         product.stock_quantity, newStock, req.user.id, now);

  const payload = { id: req.params.id, enterprise_id: eid, stock_quantity: newStock, updated_at: now };
  db.prepare(`
    INSERT INTO sync_queue (id, enterprise_id, action_type, entity_type, entity_id, payload_json)
    VALUES (?,?,'UPDATE_STOCK','products',?,?)
  `).run(uuidv4(), eid, req.params.id, JSON.stringify(payload));

  return res.json({ success: true, data: { stock_quantity: newStock } });
};

// DELETE /api/products/:id
const deleteProduct = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const product = db.prepare(`SELECT * FROM products WHERE enterprise_id=? AND id=? AND is_active=1`).get(eid, req.params.id);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

  const now = new Date().toISOString();
  db.prepare(`UPDATE products SET is_active=0, updated_at=?, synced=0 WHERE enterprise_id=? AND id=?`)
    .run(now, eid, req.params.id);

  db.prepare(`
    INSERT INTO sync_queue (id, enterprise_id, action_type, entity_type, entity_id, payload_json)
    VALUES (?,?,'DELETE_PRODUCT','products',?,?)
  `).run(uuidv4(), eid, req.params.id, JSON.stringify({ id: req.params.id, enterprise_id: eid, is_active: false }));

  return res.json({ success: true, message: 'Product deleted' });
};

module.exports = {
  getProducts, getCategories, getProductByBarcode, getProduct,
  createProduct, updateProduct, updateStock, deleteProduct,
};
