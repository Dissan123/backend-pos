-- ================================================================
--  POS & INVENTORY SYSTEM — Full Supabase / PostgreSQL Schema
--  Generated from migrate.js + all controllers (v4 — complete)
--
--  HOW TO RUN (fresh database):
--  Supabase Dashboard → SQL Editor → New query → paste → Run
--
--  EXISTING DATABASE: scroll to the ALTER TABLE section at the
--  bottom and run those statements instead to avoid data loss.
-- ================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------
-- 1. ENTERPRISES
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enterprises (
  id             TEXT          PRIMARY KEY,
  name           TEXT          NOT NULL DEFAULT 'My Business',
  address        TEXT,
  phone          TEXT,
  email          TEXT,
  currency       TEXT          NOT NULL DEFAULT 'UGX',
  tax_rate       NUMERIC(10,4) NOT NULL DEFAULT 0,
  receipt_footer TEXT,
  logo_url       TEXT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 2. SUPERADMINS  (developer cross-enterprise access)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS superadmins (
  id         TEXT        PRIMARY KEY,
  name       TEXT        NOT NULL,
  email      TEXT        UNIQUE NOT NULL,
  password   TEXT        NOT NULL DEFAULT 'env-managed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login TIMESTAMPTZ
);

-- ----------------------------------------------------------------
-- 3. BRANCHES
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branches (
  id            TEXT        PRIMARY KEY,
  enterprise_id TEXT        NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  address       TEXT,
  phone         TEXT,
  email         TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  is_hq         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branches_enterprise ON branches(enterprise_id);

-- ----------------------------------------------------------------
-- 4. USERS
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             TEXT        PRIMARY KEY,
  enterprise_id  TEXT        REFERENCES enterprises(id) ON DELETE CASCADE,
  branch_id      TEXT        REFERENCES branches(id) ON DELETE SET NULL,
  name           TEXT        NOT NULL,
  email          TEXT        UNIQUE NOT NULL,
  password       TEXT        NOT NULL,
  role           TEXT        NOT NULL DEFAULT 'cashier'
                 CHECK(role IN ('owner','admin','manager','cashier')),
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  is_verified    BOOLEAN     NOT NULL DEFAULT FALSE,
  otp_code       TEXT,
  otp_expires_at TIMESTAMPTZ,
  otp_type       TEXT,
  google_id      TEXT        UNIQUE,
  avatar_url     TEXT,
  synced         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_enterprise ON users(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_users_branch     ON users(branch_id);
CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);

-- ----------------------------------------------------------------
-- 5. PRODUCTS
--    warehouse_qty  = central warehouse stock (admin manages)
--    stock_quantity = legacy/seeded stock (cashier fallback)
--    image_url      = Supabase Storage public URL after sync
--    expiry_date    = product expiry (shown as badge on POS cards)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id              TEXT          PRIMARY KEY,
  enterprise_id   TEXT          NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  branch_id       TEXT          REFERENCES branches(id) ON DELETE SET NULL,
  name            TEXT          NOT NULL,
  description     TEXT,
  price           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(price >= 0),
  cost_price      NUMERIC(14,2) NOT NULL DEFAULT 0,
  stock_quantity  INTEGER       NOT NULL DEFAULT 0 CHECK(stock_quantity >= 0),
  warehouse_qty   INTEGER       NOT NULL DEFAULT 0 CHECK(warehouse_qty >= 0),
  low_stock_alert INTEGER       NOT NULL DEFAULT 5,
  barcode         TEXT,
  category        TEXT,
  unit            TEXT          NOT NULL DEFAULT 'piece',
  image_url       TEXT,
  expiry_date     DATE,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  synced          BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(enterprise_id, barcode)
);

CREATE INDEX IF NOT EXISTS idx_products_enterprise ON products(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_products_barcode    ON products(enterprise_id, barcode);
CREATE INDEX IF NOT EXISTS idx_products_name       ON products(enterprise_id, name);
CREATE INDEX IF NOT EXISTS idx_products_category   ON products(enterprise_id, category);
CREATE INDEX IF NOT EXISTS idx_products_expiry     ON products(expiry_date) WHERE expiry_date IS NOT NULL;

-- ----------------------------------------------------------------
-- 6. SALES
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
  id             TEXT          PRIMARY KEY,
  enterprise_id  TEXT          NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  branch_id      TEXT          REFERENCES branches(id) ON DELETE SET NULL,
  user_id        TEXT          NOT NULL REFERENCES users(id),
  subtotal       NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax            NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount   NUMERIC(14,2) NOT NULL,
  amount_paid    NUMERIC(14,2) NOT NULL,
  change_given   NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_method TEXT          NOT NULL DEFAULT 'cash',
  status         TEXT          NOT NULL DEFAULT 'completed'
                 CHECK(status IN ('completed','voided','pending')),
  notes          TEXT,
  receipt_number TEXT          NOT NULL,
  synced         BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(enterprise_id, receipt_number)
);

CREATE INDEX IF NOT EXISTS idx_sales_enterprise ON sales(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_sales_branch     ON sales(branch_id);
CREATE INDEX IF NOT EXISTS idx_sales_user_id    ON sales(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(enterprise_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_status     ON sales(enterprise_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_payment    ON sales(enterprise_id, payment_method);

-- ----------------------------------------------------------------
-- 7. SALE ITEMS
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_items (
  id            TEXT          PRIMARY KEY,
  enterprise_id TEXT          NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  branch_id     TEXT          REFERENCES branches(id) ON DELETE SET NULL,
  sale_id       TEXT          NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id    TEXT          NOT NULL,
  product_name  TEXT          NOT NULL,
  quantity      INTEGER       NOT NULL CHECK(quantity > 0),
  unit_price    NUMERIC(14,2) NOT NULL,
  discount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  subtotal      NUMERIC(14,2) NOT NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sale_items_enterprise ON sale_items(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id    ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product_id ON sale_items(product_id);

-- ----------------------------------------------------------------
-- 8. INVENTORY LOGS
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_logs (
  id            TEXT        PRIMARY KEY,
  enterprise_id TEXT        NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  branch_id     TEXT        REFERENCES branches(id) ON DELETE SET NULL,
  product_id    TEXT        NOT NULL,
  change        INTEGER     NOT NULL,
  reason        TEXT        NOT NULL,
  reference_id  TEXT,
  notes         TEXT,
  user_id       TEXT,
  stock_before  INTEGER     NOT NULL DEFAULT 0,
  stock_after   INTEGER     NOT NULL DEFAULT 0,
  synced        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inv_logs_enterprise ON inventory_logs(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_inv_logs_product    ON inventory_logs(enterprise_id, product_id);
CREATE INDEX IF NOT EXISTS idx_inv_logs_branch     ON inventory_logs(branch_id);
CREATE INDEX IF NOT EXISTS idx_inv_logs_created_at ON inventory_logs(enterprise_id, created_at DESC);

-- ----------------------------------------------------------------
-- 9. BRANCH STOCK  (per-branch inventory — source of truth)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branch_stock (
  id            TEXT        PRIMARY KEY,
  enterprise_id TEXT        NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  branch_id     TEXT        NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  product_id    TEXT        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity      INTEGER     NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(branch_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_branch_stock_branch  ON branch_stock(branch_id);
CREATE INDEX IF NOT EXISTS idx_branch_stock_product ON branch_stock(product_id);
CREATE INDEX IF NOT EXISTS idx_branch_stock_ent     ON branch_stock(enterprise_id);

-- ----------------------------------------------------------------
-- 10. STOCK ORDERS  (branch → warehouse stock requests)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_orders (
  id               TEXT        PRIMARY KEY,
  enterprise_id    TEXT        NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  branch_id        TEXT        NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  requested_by     TEXT        NOT NULL REFERENCES users(id),
  approved_by      TEXT        REFERENCES users(id),
  status           TEXT        NOT NULL DEFAULT 'pending'
                   CHECK(status IN ('pending','approved','rejected','fulfilled')),
  notes            TEXT,
  rejection_reason TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_orders_enterprise ON stock_orders(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_stock_orders_branch     ON stock_orders(branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_orders_status     ON stock_orders(enterprise_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_orders_requester  ON stock_orders(requested_by);

-- ----------------------------------------------------------------
-- 11. STOCK ORDER ITEMS
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_order_items (
  id                 TEXT          PRIMARY KEY,
  order_id           TEXT          NOT NULL REFERENCES stock_orders(id) ON DELETE CASCADE,
  enterprise_id      TEXT          NOT NULL,
  product_id         TEXT          NOT NULL,
  product_name       TEXT          NOT NULL,
  quantity_requested INTEGER       NOT NULL CHECK(quantity_requested > 0),
  quantity_fulfilled INTEGER       NOT NULL DEFAULT 0,
  unit_cost          NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes              TEXT
);

CREATE INDEX IF NOT EXISTS idx_soi_order   ON stock_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_soi_product ON stock_order_items(product_id);

-- ----------------------------------------------------------------
-- 12. SYNC QUEUE
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_queue (
  id            TEXT        PRIMARY KEY,
  enterprise_id TEXT,
  action_type   TEXT        NOT NULL,
  entity_type   TEXT        NOT NULL,
  entity_id     TEXT        NOT NULL,
  payload_json  TEXT        NOT NULL DEFAULT '{}',
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','syncing','synced','failed')),
  attempts      INTEGER     NOT NULL DEFAULT 0,
  max_attempts  INTEGER     NOT NULL DEFAULT 5,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_sync_queue_entity ON sync_queue(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_queue_ent    ON sync_queue(enterprise_id);

-- ----------------------------------------------------------------
-- 13. SETTINGS
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  enterprise_id TEXT        NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  key           TEXT        NOT NULL,
  value         TEXT        NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(enterprise_id, key)
);

-- ----------------------------------------------------------------
-- 14. LICENSE
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS license (
  id            TEXT        PRIMARY KEY,
  enterprise_id TEXT        REFERENCES enterprises(id) ON DELETE CASCADE,
  license_key   TEXT        UNIQUE NOT NULL,
  business_name TEXT        NOT NULL,
  plan          TEXT        NOT NULL DEFAULT 'basic'
                CHECK(plan IN ('basic','pro','enterprise')),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 year',
  is_valid      BOOLEAN     NOT NULL DEFAULT TRUE,
  cached_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ================================================================
-- ROW LEVEL SECURITY
-- ================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'enterprises','superadmins','branches','users','products',
    'sales','sale_items','inventory_logs','branch_stock',
    'stock_orders','stock_order_items','sync_queue',
    'settings','license'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END;
$$;


-- ================================================================
-- AUTO updated_at TRIGGER
-- ================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'enterprises','branches','users','products',
    'sales','stock_orders','branch_stock','settings'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I;
       CREATE TRIGGER trg_%s_updated_at
         BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t, t, t
    );
  END LOOP;
END;
$$;


-- ================================================================
-- STORAGE BUCKET — product images
-- ================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  TRUE,
  5242880,
  ARRAY['image/jpeg','image/jpg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public product images read" ON storage.objects;
CREATE POLICY "Public product images read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'product-images');

DROP POLICY IF EXISTS "Service role manages product images" ON storage.objects;
CREATE POLICY "Service role manages product images"
  ON storage.objects FOR ALL
  USING (bucket_id = 'product-images');


-- ================================================================
-- VIEWS
-- ================================================================

-- Branch revenue + today performance
CREATE OR REPLACE VIEW vw_branch_performance AS
SELECT
  b.id                        AS branch_id,
  b.enterprise_id,
  b.name                      AS branch_name,
  b.is_hq,
  b.is_active,
  COUNT(s.id)                 AS total_sales,
  COALESCE(SUM(s.total_amount), 0)   AS total_revenue,
  COALESCE(AVG(s.total_amount), 0)   AS avg_sale,
  COALESCE(SUM(s.discount),     0)   AS total_discounts,
  COUNT(s.id) FILTER (WHERE s.created_at::date = CURRENT_DATE)  AS today_sales,
  COALESCE(SUM(s.total_amount) FILTER (WHERE s.created_at::date = CURRENT_DATE), 0) AS today_revenue
FROM branches b
LEFT JOIN sales s ON s.branch_id = b.id AND s.status = 'completed'
GROUP BY b.id, b.enterprise_id, b.name, b.is_hq, b.is_active;


-- Sales with cashier + branch info
CREATE OR REPLACE VIEW vw_sales AS
SELECT
  s.*,
  u.name  AS cashier_name,
  b.name  AS branch_name,
  b.is_hq AS branch_is_hq
FROM sales s
LEFT JOIN users    u ON u.id = s.user_id
LEFT JOIN branches b ON b.id = s.branch_id;


-- Stock orders with names and item count
CREATE OR REPLACE VIEW vw_stock_orders AS
SELECT
  so.*,
  b.name  AS branch_name,
  b.is_hq AS branch_is_hq,
  u.name  AS requested_by_name,
  a.name  AS approved_by_name,
  (SELECT COUNT(*) FROM stock_order_items soi WHERE soi.order_id = so.id) AS item_count
FROM stock_orders so
LEFT JOIN branches b ON b.id = so.branch_id
LEFT JOIN users    u ON u.id = so.requested_by
LEFT JOIN users    a ON a.id = so.approved_by;


-- Warehouse: products + pending request totals
CREATE OR REPLACE VIEW vw_warehouse AS
SELECT
  p.*,
  COALESCE(pend.total_requested, 0) AS pending_requests
FROM products p
LEFT JOIN (
  SELECT soi.product_id, SUM(soi.quantity_requested) AS total_requested
  FROM stock_order_items soi
  JOIN stock_orders so ON so.id = soi.order_id
  WHERE so.status = 'pending'
  GROUP BY soi.product_id
) pend ON pend.product_id = p.id;


-- Expiring products with status label
CREATE OR REPLACE VIEW vw_expiring_products AS
SELECT
  p.*,
  (p.expiry_date - CURRENT_DATE)::INTEGER AS days_until_expiry,
  CASE
    WHEN p.expiry_date < CURRENT_DATE          THEN 'expired'
    WHEN p.expiry_date <= CURRENT_DATE + 7     THEN 'critical'
    WHEN p.expiry_date <= CURRENT_DATE + 30    THEN 'soon'
    ELSE 'ok'
  END AS expiry_status
FROM products p
WHERE p.expiry_date IS NOT NULL AND p.is_active = TRUE
ORDER BY p.expiry_date ASC;


-- Superadmin platform stats
CREATE OR REPLACE VIEW vw_platform_stats AS
SELECT
  (SELECT COUNT(*)                    FROM enterprises)                           AS enterprises,
  (SELECT COUNT(*)                    FROM users    WHERE is_active = TRUE)       AS active_users,
  (SELECT COUNT(*)                    FROM branches WHERE is_active = TRUE)       AS branches,
  (SELECT COUNT(*)                    FROM products WHERE is_active = TRUE)       AS products,
  (SELECT COUNT(*)                    FROM sales    WHERE status = 'completed')   AS total_sales,
  (SELECT COALESCE(SUM(total_amount),0) FROM sales  WHERE status = 'completed')  AS total_revenue,
  (SELECT COALESCE(SUM(total_amount),0) FROM sales
   WHERE status = 'completed' AND created_at::date = CURRENT_DATE)               AS today_revenue,
  (SELECT COUNT(*) FROM sales
   WHERE status = 'completed' AND created_at::date = CURRENT_DATE)               AS today_sales,
  (SELECT COUNT(*) FROM stock_orders  WHERE status = 'pending')                  AS pending_orders;


-- ================================================================
-- FOR EXISTING DATABASES — run these ALTERs instead of the
-- CREATE TABLE block above. They are all safe to re-run.
-- ================================================================
/*

ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS logo_url       TEXT;
ALTER TABLE branches    ADD COLUMN IF NOT EXISTS is_hq          BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users       ADD COLUMN IF NOT EXISTS branch_id      TEXT REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE users       ADD COLUMN IF NOT EXISTS synced         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users       DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users       ADD  CONSTRAINT users_role_check
  CHECK(role IN ('owner','admin','manager','cashier'));
ALTER TABLE products    ADD COLUMN IF NOT EXISTS branch_id      TEXT REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE products    ADD COLUMN IF NOT EXISTS warehouse_qty  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products    ADD COLUMN IF NOT EXISTS image_url      TEXT;
ALTER TABLE products    ADD COLUMN IF NOT EXISTS expiry_date    DATE;
ALTER TABLE products    ADD COLUMN IF NOT EXISTS synced         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sales       ADD COLUMN IF NOT EXISTS branch_id      TEXT REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE sales       ADD COLUMN IF NOT EXISTS discount       NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sales       DROP CONSTRAINT IF EXISTS sales_status_check;
ALTER TABLE sales       ADD  CONSTRAINT sales_status_check
  CHECK(status IN ('completed','voided','pending'));
ALTER TABLE sale_items  ADD COLUMN IF NOT EXISTS branch_id      TEXT REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE sale_items  ADD COLUMN IF NOT EXISTS discount       NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE inventory_logs ADD COLUMN IF NOT EXISTS branch_id   TEXT REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE inventory_logs ADD COLUMN IF NOT EXISTS stock_before INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_logs ADD COLUMN IF NOT EXISTS stock_after  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_logs ADD COLUMN IF NOT EXISTS synced       BOOLEAN NOT NULL DEFAULT FALSE;

*/

-- ================================================================
-- Verify all 14 tables were created:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' ORDER BY table_name;
-- ================================================================
