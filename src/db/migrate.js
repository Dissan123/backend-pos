// src/db/migrate.js
'use strict';

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { createDatabase } = require('./sqliteCompat');

const DB_PATH = process.env.SQLITE_DB_PATH
  ? path.resolve(process.env.SQLITE_DB_PATH)
  : path.resolve(__dirname, '../../data/pos_local.db');

const SQL = `
  -- ─── ENTERPRISES ──────────────────────────────────────────────
  -- Each signup creates one enterprise. All data belongs to an enterprise.
  CREATE TABLE IF NOT EXISTS enterprises (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL DEFAULT 'My Business',
    address      TEXT,
    phone        TEXT,
    email        TEXT,
    currency     TEXT NOT NULL DEFAULT 'UGX',
    tax_rate     REAL NOT NULL DEFAULT 0,
    receipt_footer TEXT,
    logo_url     TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );



  -- ─── SUPERADMIN (developer access — cross-enterprise) ────────
  CREATE TABLE IF NOT EXISTS superadmins (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_login  TEXT
  );

  -- ─── BRANCHES ──────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS branches (
    id              TEXT PRIMARY KEY,
    enterprise_id   TEXT NOT NULL REFERENCES enterprises(id),
    name            TEXT NOT NULL,
    address         TEXT,
    phone           TEXT,
    email           TEXT,
    expiry_date     TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    is_hq           INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_branches_enterprise ON branches(enterprise_id);

  -- ─── USERS ────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS users (
    id                TEXT PRIMARY KEY,
    enterprise_id     TEXT REFERENCES enterprises(id),
    name              TEXT NOT NULL,
    email             TEXT UNIQUE NOT NULL,
    password          TEXT NOT NULL,
    role              TEXT NOT NULL DEFAULT 'cashier' CHECK(role IN ('owner', 'admin', 'manager', 'cashier')),
    is_active         INTEGER NOT NULL DEFAULT 1,
    is_verified       INTEGER NOT NULL DEFAULT 0,
    otp_code          TEXT,
    otp_expires_at    TEXT,
    otp_type          TEXT,
    google_id         TEXT UNIQUE,
    avatar_url        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    branch_id         TEXT,
    synced            INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_users_enterprise ON users(enterprise_id);
  CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id);

  -- ─── PRODUCTS ─────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS products (
    id              TEXT PRIMARY KEY,
    enterprise_id   TEXT NOT NULL REFERENCES enterprises(id),
    name            TEXT NOT NULL,
    description     TEXT,
    price           REAL NOT NULL CHECK(price >= 0),
    cost_price      REAL DEFAULT 0,
    stock_quantity  INTEGER NOT NULL DEFAULT 0 CHECK(stock_quantity >= 0),
    low_stock_alert INTEGER NOT NULL DEFAULT 5,
    barcode         TEXT,
    category        TEXT,
    unit            TEXT DEFAULT 'piece',
    image_url       TEXT,
    expiry_date     TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    branch_id       TEXT,
    synced          INTEGER NOT NULL DEFAULT 0,
    UNIQUE(enterprise_id, barcode)
  );

  CREATE INDEX IF NOT EXISTS idx_products_enterprise ON products(enterprise_id);
  CREATE INDEX IF NOT EXISTS idx_products_barcode    ON products(enterprise_id, barcode);
  CREATE INDEX IF NOT EXISTS idx_products_name       ON products(enterprise_id, name);

  -- ─── SALES ────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS sales (
    id              TEXT PRIMARY KEY,
    enterprise_id   TEXT NOT NULL REFERENCES enterprises(id),
    user_id         TEXT NOT NULL REFERENCES users(id),
    subtotal        REAL NOT NULL DEFAULT 0,
    discount        REAL NOT NULL DEFAULT 0,
    tax             REAL NOT NULL DEFAULT 0,
    total_amount    REAL NOT NULL,
    amount_paid     REAL NOT NULL,
    change_given    REAL NOT NULL DEFAULT 0,
    payment_method  TEXT NOT NULL DEFAULT 'cash',
    branch_id       TEXT,
    status          TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed', 'voided', 'pending')),
    notes           TEXT,
    receipt_number  TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    synced          INTEGER NOT NULL DEFAULT 0,
    UNIQUE(enterprise_id, receipt_number)
  );

  CREATE INDEX IF NOT EXISTS idx_sales_enterprise   ON sales(enterprise_id);
  CREATE INDEX IF NOT EXISTS idx_sales_branch       ON sales(branch_id);
  CREATE INDEX IF NOT EXISTS idx_sales_created_at   ON sales(enterprise_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sales_user_id      ON sales(user_id);

  -- ─── SALE ITEMS ───────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS sale_items (
    id           TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprises(id),
    sale_id      TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id   TEXT NOT NULL,
    product_name TEXT NOT NULL,
    quantity     INTEGER NOT NULL CHECK(quantity > 0),
    unit_price   REAL NOT NULL,
    discount     REAL NOT NULL DEFAULT 0,
    branch_id    TEXT,
    subtotal     REAL NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sale_items_enterprise ON sale_items(enterprise_id);
  CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id    ON sale_items(sale_id);

  -- ─── INVENTORY LOGS ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS inventory_logs (
    id            TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprises(id),
    product_id    TEXT NOT NULL,
    change        INTEGER NOT NULL,
    reason        TEXT NOT NULL,
    reference_id  TEXT,
    notes         TEXT,
    user_id       TEXT,
    stock_before  INTEGER NOT NULL,
    stock_after   INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    branch_id     TEXT,
    synced        INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_inv_logs_enterprise ON inventory_logs(enterprise_id);
  CREATE INDEX IF NOT EXISTS idx_inv_logs_product_id ON inventory_logs(enterprise_id, product_id);



  -- ─── BRANCH STOCK (per-branch inventory levels) ──────────────
  -- This is the source of truth for what stock each branch has.
  -- Products in the warehouse have stock tracked via products.warehouse_qty.
  -- When admin approves a stock order, branch_stock is incremented.
  CREATE TABLE IF NOT EXISTS branch_stock (
    id              TEXT PRIMARY KEY,
    enterprise_id   TEXT NOT NULL REFERENCES enterprises(id),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    product_id      TEXT NOT NULL REFERENCES products(id),
    quantity        INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(branch_id, product_id)
  );

  CREATE INDEX IF NOT EXISTS idx_branch_stock_branch  ON branch_stock(branch_id);
  CREATE INDEX IF NOT EXISTS idx_branch_stock_product ON branch_stock(product_id);

  -- ─── STOCK ORDERS (branch requests from warehouse) ───────────
  CREATE TABLE IF NOT EXISTS stock_orders (
    id              TEXT PRIMARY KEY,
    enterprise_id   TEXT NOT NULL REFERENCES enterprises(id),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    requested_by    TEXT NOT NULL REFERENCES users(id),
    approved_by     TEXT REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','approved','rejected','fulfilled')),
    notes           TEXT,
    rejection_reason TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stock_order_items (
    id              TEXT PRIMARY KEY,
    order_id        TEXT NOT NULL REFERENCES stock_orders(id) ON DELETE CASCADE,
    enterprise_id   TEXT NOT NULL,
    product_id      TEXT NOT NULL,
    product_name    TEXT NOT NULL,
    quantity_requested INTEGER NOT NULL CHECK(quantity_requested > 0),
    quantity_fulfilled INTEGER NOT NULL DEFAULT 0,
    unit_cost       REAL NOT NULL DEFAULT 0,
    notes           TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_stock_orders_enterprise ON stock_orders(enterprise_id);
  CREATE INDEX IF NOT EXISTS idx_stock_orders_branch     ON stock_orders(branch_id);
  CREATE INDEX IF NOT EXISTS idx_stock_orders_status     ON stock_orders(status);
  CREATE INDEX IF NOT EXISTS idx_stock_order_items_order ON stock_order_items(order_id);

  -- ─── SYNC QUEUE ───────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS sync_queue (
    id            TEXT PRIMARY KEY,
    enterprise_id TEXT,
    action_type   TEXT NOT NULL,
    entity_type   TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 5,
    error_message TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    synced_at     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);

  -- ─── SETTINGS (per enterprise) ────────────────────────────────
  CREATE TABLE IF NOT EXISTS settings (
    enterprise_id TEXT NOT NULL,
    key           TEXT NOT NULL,
    value         TEXT NOT NULL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (enterprise_id, key)
  );

  -- ─── LICENSE ──────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS license (
    id              TEXT PRIMARY KEY,
    enterprise_id   TEXT,
    license_key     TEXT UNIQUE NOT NULL,
    business_name   TEXT NOT NULL,
    plan            TEXT NOT NULL DEFAULT 'basic',
    expires_at      TEXT NOT NULL,
    is_valid        INTEGER NOT NULL DEFAULT 1,
    cached_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const migrate = async (existingDb) => {
  let db = existingDb;
  let shouldClose = false;

  if (!db) {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    db = await createDatabase(DB_PATH);
    shouldClose = true;
  }

  console.log('🔄 Running SQLite migrations...');
  db.exec(SQL);

  // Safe column additions for existing databases
  const safeAlter = [
    { table: 'users',      col: 'enterprise_id',  def: 'TEXT' },
    { table: 'users',      col: 'is_verified',    def: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'users',      col: 'otp_code',       def: 'TEXT' },
    { table: 'users',      col: 'otp_expires_at', def: 'TEXT' },
    { table: 'users',      col: 'otp_type',       def: 'TEXT' },
    { table: 'users',      col: 'google_id',      def: 'TEXT' },
    { table: 'users',      col: 'avatar_url',     def: 'TEXT' },
    { table: 'products',   col: 'enterprise_id',  def: 'TEXT' },
    { table: 'sales',      col: 'enterprise_id',  def: 'TEXT' },
    { table: 'sale_items', col: 'enterprise_id',  def: 'TEXT' },
    { table: 'inventory_logs', col: 'enterprise_id', def: 'TEXT' },
    { table: 'sync_queue',      col: 'enterprise_id',  def: 'TEXT' },
    { table: 'users',           col: 'branch_id',      def: 'TEXT' },
    { table: 'products',        col: 'branch_id',      def: 'TEXT' },
    { table: 'sales',           col: 'branch_id',      def: 'TEXT' },
    { table: 'sale_items',      col: 'branch_id',      def: 'TEXT' },
    { table: 'inventory_logs',  col: 'branch_id',      def: 'TEXT' },
    { table: 'users',           col: 'role',           def: "TEXT NOT NULL DEFAULT 'cashier'" },
    { table: 'products',        col: 'warehouse_qty',  def: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'products',        col: 'expiry_date',    def: 'TEXT' },
    { table: 'products',   col: 'image_url',      def: 'TEXT' },
  ];

  for (const { table, col, def } of safeAlter) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (_) {}
  }

  console.log('✅ SQLite migrations complete.');
  if (shouldClose) db.close();
};

if (require.main === module) {
  migrate().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { migrate };
