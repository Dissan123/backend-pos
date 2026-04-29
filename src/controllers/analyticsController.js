// src/controllers/analyticsController.js
'use strict';

const { getDb } = require('../db/localDb');

const EID = (req) => req.user.enterprise_id;

const dateRange = (from, to) => {
  const today = new Date().toISOString().slice(0, 10);
  return { start: from || `${today}T00:00:00`, end: to || `${today}T23:59:59` };
};

// ── GET /api/analytics/overview ──────────────────────────────────
const getOverview = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { start, end } = dateRange(req.query.from, req.query.to);

  const cur = db.prepare(`
    SELECT COUNT(*) AS transactions,
           COALESCE(SUM(total_amount),0) AS revenue,
           COALESCE(SUM(discount),0)     AS discounts,
           COALESCE(AVG(total_amount),0) AS avg_sale,
           COALESCE(MAX(total_amount),0) AS max_sale
    FROM sales WHERE enterprise_id=? AND status='completed' AND created_at BETWEEN ? AND ?
  `).get(eid, start, end);

  const dur = new Date(end) - new Date(start);
  const prevEnd   = new Date(new Date(start) - 1).toISOString();
  const prevStart = new Date(new Date(start) - dur - 1).toISOString();

  const prev = db.prepare(`
    SELECT COUNT(*) AS transactions, COALESCE(SUM(total_amount),0) AS revenue,
           COALESCE(AVG(total_amount),0) AS avg_sale
    FROM sales WHERE enterprise_id=? AND status='completed' AND created_at BETWEEN ? AND ?
  `).get(eid, prevStart, prevEnd);

  const items = db.prepare(`
    SELECT COALESCE(SUM(si.quantity),0) AS total
    FROM sale_items si JOIN sales s ON si.sale_id=s.id
    WHERE s.enterprise_id=? AND s.status='completed' AND s.created_at BETWEEN ? AND ?
  `).get(eid, start, end);

  const lowStock = db.prepare(`
    SELECT COUNT(*) AS c FROM products
    WHERE enterprise_id=? AND is_active=1 AND stock_quantity<=low_stock_alert
  `).get(eid);

  const pct = (c, p) => p === 0 ? null : (((c - p) / p) * 100).toFixed(1);

  return res.json({ success: true, data: {
    revenue:         { value: cur.revenue,      prev: prev.revenue,      change: pct(cur.revenue, prev.revenue) },
    transactions:    { value: cur.transactions,  prev: prev.transactions,  change: pct(cur.transactions, prev.transactions) },
    avg_sale:        { value: cur.avg_sale,      prev: prev.avg_sale,     change: pct(cur.avg_sale, prev.avg_sale) },
    max_sale:        { value: cur.max_sale },
    items_sold:      { value: items.total },
    discounts_given: { value: cur.discounts },
    low_stock_count: { value: lowStock.c },
    period:          { from: start, to: end },
  }});
};

// ── GET /api/analytics/revenue-trend ────────────────────────────
const getRevenueTrend = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { start, end } = dateRange(req.query.from, req.query.to);
  const fmts = { hour: '%Y-%m-%dT%H:00', day: '%Y-%m-%d', week: '%Y-W%W', month: '%Y-%m' };
  const fmt  = fmts[req.query.group_by] || fmts.day;

  const rows = db.prepare(`
    SELECT strftime('${fmt}', created_at) AS period,
           COUNT(*) AS transactions,
           COALESCE(SUM(total_amount),0) AS revenue,
           COALESCE(AVG(total_amount),0) AS avg_sale
    FROM sales WHERE enterprise_id=? AND status='completed' AND created_at BETWEEN ? AND ?
    GROUP BY period ORDER BY period ASC
  `).all(eid, start, end);

  return res.json({ success: true, data: rows });
};

// ── GET /api/analytics/top-products ─────────────────────────────
const getTopProducts = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { start, end } = dateRange(req.query.from, req.query.to);
  const lim     = parseInt(req.query.limit) || 10;
  const sortCol = req.query.sort_by === 'quantity' ? 'total_qty' : 'total_revenue';

  const rows = db.prepare(`
    SELECT si.product_id, si.product_name, p.category, p.price, p.cost_price,
           SUM(si.quantity)             AS total_qty,
           SUM(si.subtotal)             AS total_revenue,
           SUM(si.quantity * COALESCE(p.cost_price,0)) AS total_cost,
           COUNT(DISTINCT si.sale_id)   AS sale_count
    FROM sale_items si
    JOIN sales s ON si.sale_id=s.id
    LEFT JOIN products p ON si.product_id=p.id
    WHERE s.enterprise_id=? AND s.status='completed' AND s.created_at BETWEEN ? AND ?
    GROUP BY si.product_id ORDER BY ${sortCol} DESC LIMIT ?
  `).all(eid, start, end, lim);

  return res.json({ success: true, data: rows.map(r => ({
    ...r,
    gross_profit: r.total_revenue - r.total_cost,
    margin_pct:   r.total_revenue > 0
      ? (((r.total_revenue - r.total_cost) / r.total_revenue) * 100).toFixed(1) : '0',
  }))});
};

// ── GET /api/analytics/category-breakdown ───────────────────────
const getCategoryBreakdown = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { start, end } = dateRange(req.query.from, req.query.to);

  const rows = db.prepare(`
    SELECT COALESCE(p.category,'Uncategorised') AS category,
           SUM(si.quantity) AS total_qty,
           SUM(si.subtotal) AS revenue,
           SUM(si.quantity * COALESCE(p.cost_price,0)) AS cost
    FROM sale_items si JOIN sales s ON si.sale_id=s.id
    LEFT JOIN products p ON si.product_id=p.id
    WHERE s.enterprise_id=? AND s.status='completed' AND s.created_at BETWEEN ? AND ?
    GROUP BY p.category ORDER BY revenue DESC
  `).all(eid, start, end);

  const total = rows.reduce((s, r) => s + r.revenue, 0);
  return res.json({ success: true, data: rows.map(r => ({
    ...r,
    profit:     r.revenue - r.cost,
    pct:        total ? ((r.revenue / total) * 100).toFixed(1) : '0',
    margin_pct: r.revenue > 0 ? (((r.revenue - r.cost) / r.revenue) * 100).toFixed(1) : '0',
  }))});
};

// ── GET /api/analytics/hourly-heatmap ───────────────────────────
const getHourlyHeatmap = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const start = req.query.from || thirtyAgo;
  const end   = req.query.to   || new Date().toISOString();

  const rows = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour,
           CAST(strftime('%w', created_at) AS INTEGER) AS dow,
           COUNT(*) AS transactions,
           COALESCE(SUM(total_amount),0) AS revenue
    FROM sales WHERE enterprise_id=? AND status='completed' AND created_at BETWEEN ? AND ?
    GROUP BY hour, dow ORDER BY dow, hour
  `).all(eid, start, end);

  const peakHours = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour,
           COUNT(*) AS transactions,
           COALESCE(SUM(total_amount),0) AS revenue
    FROM sales WHERE enterprise_id=? AND status='completed' AND created_at BETWEEN ? AND ?
    GROUP BY hour ORDER BY revenue DESC LIMIT 5
  `).all(eid, start, end);

  return res.json({ success: true, data: { heatmap: rows, peak_hours: peakHours } });
};

// ── GET /api/analytics/cashier-performance ──────────────────────
const getCashierPerformance = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { start, end } = dateRange(req.query.from, req.query.to);

  const rows = db.prepare(`
    SELECT u.id, u.name, u.role,
           COUNT(s.id)                     AS transactions,
           COALESCE(SUM(s.total_amount),0) AS revenue,
           COALESCE(AVG(s.total_amount),0) AS avg_sale,
           COALESCE(MAX(s.total_amount),0) AS max_sale
    FROM users u
    LEFT JOIN sales s ON s.user_id=u.id AND s.status='completed' AND s.created_at BETWEEN ? AND ?
    WHERE u.enterprise_id=? AND u.is_active=1
    GROUP BY u.id ORDER BY revenue DESC
  `).all(start, end, eid);

  return res.json({ success: true, data: rows });
};

// ── GET /api/analytics/inventory-value ──────────────────────────
const getInventoryValue = (req, res) => {
  const db  = getDb();
  const eid = EID(req);

  const summary = db.prepare(`
    SELECT COUNT(*) AS total_products,
           COALESCE(SUM(stock_quantity),0)                     AS total_units,
           COALESCE(SUM(stock_quantity*cost_price),0)           AS cost_value,
           COALESCE(SUM(stock_quantity*price),0)                AS retail_value,
           COALESCE(SUM(stock_quantity*price - stock_quantity*cost_price),0) AS potential_profit,
           COUNT(CASE WHEN stock_quantity=0 THEN 1 END)         AS out_of_stock,
           COUNT(CASE WHEN stock_quantity>0 AND stock_quantity<=low_stock_alert THEN 1 END) AS low_stock
    FROM products WHERE enterprise_id=? AND is_active=1
  `).get(eid);

  const byCategory = db.prepare(`
    SELECT COALESCE(category,'Uncategorised') AS category,
           COUNT(*) AS products,
           COALESCE(SUM(stock_quantity),0)           AS units,
           COALESCE(SUM(stock_quantity*cost_price),0) AS cost_value,
           COALESCE(SUM(stock_quantity*price),0)      AS retail_value
    FROM products WHERE enterprise_id=? AND is_active=1
    GROUP BY category ORDER BY retail_value DESC
  `).all(eid);

  const slowMoving = db.prepare(`
    SELECT p.id, p.name, p.stock_quantity, p.category,
           COALESCE(SUM(si.quantity),0) AS sold_30d
    FROM products p
    LEFT JOIN sale_items si ON si.product_id=p.id
    LEFT JOIN sales s ON si.sale_id=s.id
      AND s.status='completed'
      AND s.created_at >= datetime('now','-30 days')
    WHERE p.enterprise_id=? AND p.is_active=1 AND p.stock_quantity > 0
    GROUP BY p.id ORDER BY sold_30d ASC, p.stock_quantity DESC
    LIMIT 5
  `).all(eid);

  return res.json({ success: true, data: { summary, by_category: byCategory, slow_moving: slowMoving } });
};

// ── GET /api/analytics/profit ────────────────────────────────────
const getProfitAnalysis = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { start, end } = dateRange(req.query.from, req.query.to);

  // Totals — join sale_items to get COGS
  const totals = db.prepare(`
    SELECT COALESCE(SUM(s.total_amount),0) AS total_revenue,
           COALESCE(SUM(si.quantity * COALESCE(p.cost_price,0)),0) AS total_cogs,
           COALESCE(SUM(s.discount),0) AS total_discounts
    FROM sales s
    JOIN sale_items si ON si.sale_id=s.id
    LEFT JOIN products p ON si.product_id=p.id
    WHERE s.enterprise_id=? AND s.status='completed' AND s.created_at BETWEEN ? AND ?
  `).get(eid, start, end);

  // Daily revenue vs profit trend — simple, no nested subqueries
  const trend = db.prepare(`
    SELECT strftime('%Y-%m-%d', s.created_at) AS date,
           COALESCE(SUM(s.total_amount),0) AS revenue,
           COALESCE(SUM(si.quantity * COALESCE(p.cost_price,0)),0) AS cogs,
           COUNT(DISTINCT s.id) AS transactions
    FROM sales s
    JOIN sale_items si ON si.sale_id=s.id
    LEFT JOIN products p ON si.product_id=p.id
    WHERE s.enterprise_id=? AND s.status='completed' AND s.created_at BETWEEN ? AND ?
    GROUP BY date ORDER BY date ASC
  `).all(eid, start, end);

  // Best margin products
  const bestMargin = db.prepare(`
    SELECT si.product_name, p.category,
           SUM(si.subtotal) AS revenue,
           SUM(si.quantity * COALESCE(p.cost_price,0)) AS cost
    FROM sale_items si
    JOIN sales s ON si.sale_id=s.id
    LEFT JOIN products p ON si.product_id=p.id
    WHERE s.enterprise_id=? AND s.status='completed' AND s.created_at BETWEEN ? AND ?
    GROUP BY si.product_id
    HAVING revenue > 0
    ORDER BY (revenue - cost) / revenue DESC
    LIMIT 8
  `).all(eid, start, end);

  // Payment method breakdown
  const payments = db.prepare(`
    SELECT payment_method,
           COUNT(*) AS count,
           COALESCE(SUM(total_amount),0) AS revenue
    FROM sales
    WHERE enterprise_id=? AND status='completed' AND created_at BETWEEN ? AND ?
    GROUP BY payment_method ORDER BY revenue DESC
  `).all(eid, start, end);

  const grossProfit  = (totals.total_revenue || 0) - (totals.total_cogs || 0);
  const profitMargin = totals.total_revenue > 0
    ? ((grossProfit / totals.total_revenue) * 100).toFixed(1) : '0';

  // Add profit to trend rows and margin to best margin products
  const trendWithProfit = trend.map(r => ({
    ...r,
    profit: r.revenue - r.cogs,
  }));

  const bestMarginWithPct = bestMargin.map(r => ({
    ...r,
    profit:     r.revenue - r.cost,
    margin_pct: r.revenue > 0 ? (((r.revenue - r.cost) / r.revenue) * 100).toFixed(1) : '0',
  }));

  return res.json({ success: true, data: {
    summary: {
      total_revenue:   totals.total_revenue  || 0,
      total_cogs:      totals.total_cogs     || 0,
      gross_profit:    grossProfit,
      profit_margin:   parseFloat(profitMargin),
      total_discounts: totals.total_discounts || 0,
    },
    trend:                trendWithProfit,
    best_margin_products: bestMarginWithPct,
    payment_breakdown:    payments,
  }});
};

// ── GET /api/analytics/staff ─────────────────────────────────────
const getStaffLeaderboard = (req, res) => {
  const db  = getDb();
  const eid = EID(req);
  const { start, end } = dateRange(req.query.from, req.query.to);

  // Main staff stats — no correlated subquery, plain aggregates only
  const staff = db.prepare(`
    SELECT u.id, u.name, u.role,
           COUNT(s.id)                     AS transactions,
           COALESCE(SUM(s.total_amount),0) AS revenue,
           COALESCE(AVG(s.total_amount),0) AS avg_sale,
           COALESCE(MAX(s.total_amount),0) AS best_sale,
           COALESCE(SUM(s.discount),0)     AS discounts
    FROM users u
    LEFT JOIN sales s ON s.user_id=u.id
      AND s.status='completed'
      AND s.created_at BETWEEN ? AND ?
    WHERE u.enterprise_id=? AND u.is_active=1
    GROUP BY u.id ORDER BY revenue DESC
  `).all(start, end, eid);

  // Items sold per cashier — separate query, no correlated subquery
  const itemsPerUser = db.prepare(`
    SELECT s.user_id,
           COALESCE(SUM(si.quantity),0) AS items_sold
    FROM sales s
    JOIN sale_items si ON si.sale_id=s.id
    WHERE s.enterprise_id=? AND s.status='completed' AND s.created_at BETWEEN ? AND ?
    GROUP BY s.user_id
  `).all(eid, start, end);

  const itemsMap = {};
  itemsPerUser.forEach(r => { itemsMap[r.user_id] = r.items_sold; });

  const staffWithItems = staff.map(s => ({
    ...s,
    items_sold: itemsMap[s.id] || 0,
  }));

  // Daily revenue per cashier for sparklines
  const dailyPerStaff = db.prepare(`
    SELECT s.user_id, u.name,
           strftime('%Y-%m-%d', s.created_at) AS date,
           COUNT(s.id) AS transactions,
           COALESCE(SUM(s.total_amount),0) AS revenue
    FROM sales s
    JOIN users u ON u.id=s.user_id
    WHERE s.enterprise_id=? AND s.status='completed' AND s.created_at BETWEEN ? AND ?
    GROUP BY s.user_id, date ORDER BY date ASC
  `).all(eid, start, end);

  return res.json({ success: true, data: { staff: staffWithItems, daily_trend: dailyPerStaff } });
};

// ── GET /api/analytics/live ──────────────────────────────────────
const getLive = (req, res) => {
  const db    = getDb();
  const eid   = EID(req);
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const start = `${today}T00:00:00`;
  const end   = now.toISOString();

  const todaySales = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(total_amount),0) AS revenue,
           COALESCE(AVG(total_amount),0) AS avg
    FROM sales WHERE enterprise_id=? AND status='completed' AND created_at BETWEEN ? AND ?
  `).get(eid, start, end);

  const recent = db.prepare(`
    SELECT s.id, s.receipt_number, s.total_amount, s.payment_method,
           s.created_at, u.name AS cashier
    FROM sales s LEFT JOIN users u ON s.user_id=u.id
    WHERE s.enterprise_id=? AND s.status='completed'
    ORDER BY s.created_at DESC LIMIT 5
  `).all(eid);

  const hourly = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour,
           COUNT(*) AS count,
           COALESCE(SUM(total_amount),0) AS revenue
    FROM sales WHERE enterprise_id=? AND status='completed' AND created_at BETWEEN ? AND ?
    GROUP BY hour ORDER BY hour ASC
  `).all(eid, start, end);

  const activeCashiers = db.prepare(`
    SELECT u.id, u.name,
           COUNT(s.id) AS sales_today,
           COALESCE(SUM(s.total_amount),0) AS revenue_today,
           MAX(s.created_at) AS last_sale
    FROM users u
    JOIN sales s ON s.user_id=u.id
      AND s.status='completed'
      AND s.created_at BETWEEN ? AND ?
    WHERE u.enterprise_id=?
    GROUP BY u.id ORDER BY revenue_today DESC
  `).all(start, end, eid);

  return res.json({ success: true, data: {
    today:           todaySales,
    recent_sales:    recent,
    hourly_today:    hourly,
    active_cashiers: activeCashiers,
    generated_at:    now.toISOString(),
  }});
};

module.exports = {
  getOverview, getRevenueTrend, getTopProducts, getCategoryBreakdown,
  getHourlyHeatmap, getCashierPerformance, getInventoryValue,
  getProfitAnalysis, getStaffLeaderboard, getLive,
};
