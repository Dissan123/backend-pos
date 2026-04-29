// src/controllers/salesController.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../db/localDb');

const receiptNumber = () => {
  const d = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const r = Math.random().toString(36).slice(2,8).toUpperCase();
  return `RCP-${d}-${r}`;
};

// POST /api/sales
const createSale = (req, res) => {
  const { items, amount_paid, discount = 0, tax = 0, notes, payment_method = 'cash' } = req.body;
  const eid = req.user.enterprise_id;
  const uid = req.user.id;
  const bid = req.user.branch_id || null;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ success: false, message: 'items array required' });
  if (amount_paid === undefined)
    return res.status(400).json({ success: false, message: 'amount_paid required' });

  const db = getDb();

  try {
    const result = db.transaction(() => {
      const saleId = uuidv4();
      const now    = new Date().toISOString();
      const rn     = receiptNumber();

      let subtotal   = 0;
      const saleItems = [];

      // Determine if this is a branch sale (has branch_id) or admin/warehouse sale
      const isBranchSale = !!bid;

      for (const item of items) {
        const product = db.prepare(
          `SELECT * FROM products WHERE enterprise_id=? AND id=? AND is_active=1`
        ).get(eid, item.product_id);

        if (!product) throw new Error(`Product not found`);

        // ── Stock source rules ───────────────────────────────────
        // ALL branch sales (including HQ) deduct from branch_stock.
        // HQ branch_stock is kept in sync with warehouse_qty — when
        // admin restocks the warehouse, HQ branch_stock is also topped up.
        // Sub-branches go through stock order → approval → branch_stock.
        // Admin with no branch context deducts from warehouse_qty directly.
        let availableStock, stockBefore, stockField;

        if (isBranchSale) {
          // Get this branch's stock level
          const bs = db.prepare(
            `SELECT * FROM branch_stock WHERE branch_id=? AND product_id=?`
          ).get(bid, item.product_id);

          if (bs && bs.quantity > 0) {
            // Branch has stock — use it (works for both HQ and sub-branches)
            availableStock = bs.quantity;
            stockBefore    = bs.quantity;
            stockField     = 'branch';
          } else {
            // No branch_stock row yet — fall back to stock_quantity (legacy/seeded products)
            availableStock = product.stock_quantity || 0;
            stockBefore    = product.stock_quantity || 0;
            stockField     = 'stock';
          }
        } else {
          // Admin sale with no branch — deduct from warehouse
          if ((product.warehouse_qty || 0) > 0) {
            availableStock = product.warehouse_qty;
            stockBefore    = product.warehouse_qty;
            stockField     = 'warehouse';
          } else {
            availableStock = product.stock_quantity || 0;
            stockBefore    = product.stock_quantity || 0;
            stockField     = 'stock';
          }
        }

        if (availableStock < item.quantity)
          throw new Error(`Insufficient stock for "${product.name}". Available: ${availableStock}`);

        const lineTotal = product.price * item.quantity;
        subtotal += lineTotal;
        saleItems.push({
          id:            uuidv4(),
          enterprise_id: eid,
          sale_id:       saleId,
          product_id:    product.id,
          product_name:  product.name,
          quantity:      item.quantity,
          unit_price:    product.price,
          discount:      parseFloat(item.discount) || 0,
          subtotal:      lineTotal,
          stock_before:  stockBefore,
          stock_after:   stockBefore - item.quantity,
          stock_field:   stockField,
          created_at:    now,
        });
      }

      const disc        = parseFloat(discount) || 0;
      const tx          = parseFloat(tax)      || 0;
      const totalAmount = subtotal - disc + tx;
      const paid        = parseFloat(amount_paid);
      const change      = paid - totalAmount;

      if (paid < totalAmount && payment_method === 'cash')
        throw new Error(`Insufficient payment. Total: ${totalAmount}, Paid: ${paid}`);

      db.prepare(`
        INSERT INTO sales
          (id, enterprise_id, branch_id, user_id, subtotal, discount, tax, total_amount,
           amount_paid, change_given, payment_method, notes, receipt_number,
           status, created_at, updated_at, synced)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'completed',?,?,0)
      `).run(saleId, eid, bid, uid, subtotal, disc, tx, totalAmount,
             paid, change, String(payment_method), notes ? String(notes) : null, rn, now, now);

      for (const si of saleItems) {
        db.prepare(`
          INSERT INTO sale_items
            (id, enterprise_id, branch_id, sale_id, product_id, product_name,
             quantity, unit_price, discount, subtotal, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(si.id, eid, bid, saleId, si.product_id, si.product_name,
               si.quantity, si.unit_price, si.discount, si.subtotal, si.created_at);

        if (si.stock_field === 'branch') {
          db.prepare(`UPDATE branch_stock SET quantity=?, updated_at=? WHERE branch_id=? AND product_id=?`)
            .run(si.stock_after, now, bid, si.product_id);
        } else if (si.stock_field === 'warehouse') {
          db.prepare(`UPDATE products SET warehouse_qty=?, updated_at=?, synced=0 WHERE enterprise_id=? AND id=?`)
            .run(si.stock_after, now, eid, si.product_id);
        } else {
          db.prepare(`UPDATE products SET stock_quantity=?, updated_at=?, synced=0 WHERE enterprise_id=? AND id=?`)
            .run(si.stock_after, now, eid, si.product_id);
        }

        db.prepare(`
          INSERT INTO inventory_logs
            (id, enterprise_id, branch_id, product_id, change, reason, reference_id,
             stock_before, stock_after, user_id, created_at)
          VALUES (?,?,?,?,?,'sale',?,?,?,?,?)
        `).run(uuidv4(), eid, bid, si.product_id, -si.quantity, saleId,
               si.stock_before, si.stock_after, uid, now);
      }

      const fullSale  = db.prepare(`SELECT * FROM sales WHERE id=?`).get(saleId);
      const fullItems = db.prepare(`SELECT * FROM sale_items WHERE sale_id=?`).all(saleId);

      db.prepare(`
        INSERT INTO sync_queue (id, enterprise_id, action_type, entity_type, entity_id, payload_json)
        VALUES (?,?,'CREATE_SALE','sales',?,?)
      `).run(uuidv4(), eid, saleId, JSON.stringify({ sale: fullSale, items: fullItems }));

      return { sale: fullSale, items: fullItems };
    })();

    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
};

// GET /api/sales
const getSales = (req, res) => {
  const db  = getDb();
  const eid = req.user.enterprise_id;
  const { from, to, limit = 50, offset = 0, branch_id, payment_method, status } = req.query;

  let sql    = `
    SELECT s.*,
           u.name  AS cashier_name,
           b.name  AS branch_name,
           b.is_hq AS branch_is_hq
    FROM sales s
    LEFT JOIN users    u ON u.id = s.user_id
    LEFT JOIN branches b ON b.id = s.branch_id
    WHERE s.enterprise_id=?
  `;
  const args = [eid];

  // Status filter — default exclude voided unless explicitly requested
  if (status === 'voided') { sql += ` AND s.status='voided'`; }
  else if (status === 'all') { /* no filter */ }
  else { sql += ` AND s.status!='voided'`; }

  if (from)           { sql += ` AND s.created_at>=?`;       args.push(from); }
  if (to)             { sql += ` AND s.created_at<=?`;        args.push(to); }
  if (branch_id)      { sql += ` AND s.branch_id=?`;          args.push(branch_id); }
  if (payment_method) { sql += ` AND s.payment_method=?`;     args.push(payment_method); }

  // Count query (same filters, no limit)
  const countSql = sql.replace(`
    SELECT s.*,
           u.name  AS cashier_name,
           b.name  AS branch_name,
           b.is_hq AS branch_is_hq
    FROM sales s
    LEFT JOIN users    u ON u.id = s.user_id
    LEFT JOIN branches b ON b.id = s.branch_id`,
    'SELECT COUNT(*) AS c FROM sales s'
  );
  const total = db.prepare(countSql).get(...args);

  sql += ` ORDER BY s.created_at DESC LIMIT ? OFFSET ?`;
  args.push(parseInt(limit), parseInt(offset));

  const sales = db.prepare(sql).all(...args);

  // Branch-level summary for the current filter window
  const branchSummary = db.prepare(`
    SELECT s.branch_id,
           b.name  AS branch_name,
           b.is_hq AS branch_is_hq,
           COUNT(*)                      AS sale_count,
           COALESCE(SUM(s.total_amount),0) AS revenue,
           COALESCE(AVG(s.total_amount),0) AS avg_sale,
           COALESCE(SUM(s.discount),0)     AS discounts
    FROM sales s
    LEFT JOIN branches b ON b.id=s.branch_id
    WHERE s.enterprise_id=? AND s.status!='voided'
    ${from ? 'AND s.created_at>=?' : ''}
    ${to   ? 'AND s.created_at<=?' : ''}
    GROUP BY s.branch_id
    ORDER BY revenue DESC
  `).all(...[eid, ...(from ? [from] : []), ...(to ? [to] : [])]);

  return res.json({ success: true, data: sales, total: total.c, branch_summary: branchSummary });
};

// GET /api/sales/:id
const getSale = (req, res) => {
  const db  = getDb();
  const eid = req.user.enterprise_id;
  const sale = db.prepare(`SELECT * FROM sales WHERE enterprise_id=? AND id=?`).get(eid, req.params.id);
  if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
  const items = db.prepare(`SELECT * FROM sale_items WHERE sale_id=?`).all(req.params.id);
  return res.json({ success: true, data: { ...sale, items } });
};

// GET /api/sales/receipt/:receiptNumber
const getSaleByReceipt = (req, res) => {
  const db  = getDb();
  const eid = req.user.enterprise_id;
  const sale = db.prepare(`SELECT * FROM sales WHERE enterprise_id=? AND receipt_number=?`).get(eid, req.params.receiptNumber);
  if (!sale) return res.status(404).json({ success: false, message: 'Receipt not found' });
  const items    = db.prepare(`SELECT * FROM sale_items WHERE sale_id=?`).all(sale.id);
  const settings = db.prepare(`SELECT key, value FROM settings WHERE enterprise_id=?`).all(eid);
  const store    = Object.fromEntries(settings.map(s => [s.key, s.value]));
  return res.json({ success: true, data: { ...sale, items, store } });
};

// POST /api/sales/:id/void
const voidSale = (req, res) => {
  const db  = getDb();
  const eid = req.user.enterprise_id;
  const sale = db.prepare(`SELECT * FROM sales WHERE enterprise_id=? AND id=?`).get(eid, req.params.id);
  if (!sale)                    return res.status(404).json({ success: false, message: 'Sale not found' });
  if (sale.status === 'voided') return res.status(400).json({ success: false, message: 'Sale already voided' });

  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`UPDATE sales SET status='voided', updated_at=?, synced=0 WHERE enterprise_id=? AND id=?`)
      .run(now, eid, sale.id);

    const items = db.prepare(`SELECT * FROM sale_items WHERE sale_id=?`).all(sale.id);
    for (const item of items) {
      const product  = db.prepare(`SELECT stock_quantity FROM products WHERE id=?`).get(item.product_id);
      const newStock = (product?.stock_quantity || 0) + item.quantity;

      db.prepare(`UPDATE products SET stock_quantity=?, updated_at=?, synced=0 WHERE enterprise_id=? AND id=?`)
        .run(newStock, now, eid, item.product_id);

      db.prepare(`
        INSERT INTO inventory_logs
          (id, enterprise_id, product_id, change, reason, reference_id,
           stock_before, stock_after, user_id, created_at)
        VALUES (?,?,?,?,'return',?,?,?,?,?)
      `).run(uuidv4(), eid, item.product_id, item.quantity, sale.id,
             product?.stock_quantity || 0, newStock, req.user.id, now);
    }

    db.prepare(`
      INSERT INTO sync_queue (id, enterprise_id, action_type, entity_type, entity_id, payload_json)
      VALUES (?,?,'VOID_SALE','sales',?,?)
    `).run(uuidv4(), eid, sale.id, JSON.stringify({ id: sale.id, enterprise_id: eid, status: 'voided' }));
  })();

  return res.json({ success: true, message: 'Sale voided and stock restored' });
};

// GET /api/sales/summary/today
const getTodaySummary = (req, res) => {
  const db    = getDb();
  const eid   = req.user.enterprise_id;
  const today = new Date().toISOString().slice(0, 10);

  const summary = db.prepare(`
    SELECT COUNT(*) AS total_transactions,
           COALESCE(SUM(total_amount),0) AS total_revenue,
           COALESCE(SUM(discount),0)     AS total_discounts,
           COALESCE(AVG(total_amount),0) AS avg_transaction
    FROM sales
    WHERE enterprise_id=? AND date(created_at)=? AND status='completed'
  `).get(eid, today);

  const topProducts = db.prepare(`
    SELECT si.product_name, SUM(si.quantity) AS total_sold, SUM(si.subtotal) AS revenue
    FROM sale_items si JOIN sales s ON si.sale_id=s.id
    WHERE s.enterprise_id=? AND date(s.created_at)=? AND s.status='completed'
    GROUP BY si.product_id ORDER BY total_sold DESC LIMIT 5
  `).all(eid, today);

  return res.json({ success: true, data: { ...summary, top_products: topProducts, date: today } });
};

module.exports = { createSale, getSales, getSale, getSaleByReceipt, voidSale, getTodaySummary };
