// src/db/seed.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const bcrypt         = require('bcryptjs');
const path           = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { initDb, getDb } = require('./localDb');

const seed = async () => {
  await initDb();
  const db = getDb();

  console.log('🌱 Seeding database...');

  const now            = new Date().toISOString();
  const hashed         = await bcrypt.hash('password123', 10);
  const enterpriseId   = uuidv4();
  const adminId        = uuidv4();
  const cashierId      = uuidv4();

  // ── Enterprise ────────────────────────────────────────────────
  db.prepare(`
    INSERT OR IGNORE INTO enterprises (id, name, address, phone, currency, receipt_footer, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(enterpriseId, 'My Store', '123 Main Street, Kampala', '+256 700 000000',
         'UGX', 'Thank you for shopping with us!', now, now);

  // ── HQ Branch ─────────────────────────────────────────────────
  const hqBranchId = uuidv4();
  db.prepare(`
    INSERT OR IGNORE INTO branches (id, enterprise_id, name, address, phone, is_active, is_hq, created_at, updated_at)
    VALUES (?,?,?,?,?,1,1,?,?)
  `).run(hqBranchId, enterpriseId, 'Main Branch', '123 Main Street, Kampala', '+256 700 000000', now, now);

  // ── Settings ──────────────────────────────────────────────────
  const upsertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (enterprise_id, key, value, updated_at) VALUES (?, ?, ?, ?)
  `);
  [
    ['store_name',     'My Store'],
    ['store_address',  '123 Main Street, Kampala'],
    ['store_phone',    '+256 700 000000'],
    ['currency',       'UGX'],
    ['tax_rate',       '0'],
    ['receipt_footer', 'Thank you for shopping with us!'],
  ].forEach(([k, v]) => upsertSetting.run(enterpriseId, k, v, now));

  // ── Users ─────────────────────────────────────────────────────
  db.prepare(`
    INSERT OR IGNORE INTO users
      (id, enterprise_id, branch_id, name, email, password, role, is_active, is_verified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `).run(adminId, enterpriseId, hqBranchId, 'Admin User', 'admin@posystem.com', hashed, 'admin', now, now);

  db.prepare(`
    INSERT OR IGNORE INTO users
      (id, enterprise_id, branch_id, name, email, password, role, is_active, is_verified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `).run(cashierId, enterpriseId, hqBranchId, 'Jane Cashier', 'cashier@posystem.com', hashed, 'cashier', now, now);

  // ── Products ──────────────────────────────────────────────────
  const products = [
    { name: 'Coca Cola 500ml',    price: 2000,  cost: 1500,  stock: 50, barcode: '5000112637922', category: 'Beverages' },
    { name: 'Bread (White Loaf)', price: 5000,  cost: 3500,  stock: 20, barcode: '6001007037025', category: 'Bakery'    },
    { name: 'Sugar 1kg',          price: 4500,  cost: 3200,  stock: 30, barcode: '6001234500001', category: 'Groceries' },
    { name: 'Milk 500ml',         price: 3000,  cost: 2200,  stock: 15, barcode: '6001234500002', category: 'Dairy'     },
    { name: 'Eggs (Tray of 30)',  price: 15000, cost: 12000, stock: 10, barcode: '6001234500003', category: 'Dairy'     },
    { name: 'Rice 1kg',           price: 6000,  cost: 4500,  stock: 25, barcode: '6001234500004', category: 'Groceries' },
    { name: 'Cooking Oil 1L',     price: 12000, cost: 9500,  stock: 18, barcode: '6001234500005', category: 'Groceries' },
    { name: 'Soap Bar',           price: 2500,  cost: 1800,  stock: 40, barcode: '6001234500006', category: 'Hygiene'   },
    { name: 'Mineral Water 1L',   price: 1500,  cost: 800,   stock: 60, barcode: '6001234500007', category: 'Beverages' },
    { name: 'Biscuits (Pack)',    price: 3500,  cost: 2500,  stock: 35, barcode: '6001234500008', category: 'Snacks'    },
  ];

  const insertProduct = db.prepare(`
    INSERT OR IGNORE INTO products
      (id, enterprise_id, branch_id, name, price, cost_price, stock_quantity, barcode, category, unit, low_stock_alert, is_active, created_at, updated_at, synced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'piece', 5, 1, ?, ?, 1)
  `);

  db.transaction((prods) => {
    for (const p of prods) {
      insertProduct.run(uuidv4(), enterpriseId, hqBranchId, p.name, p.price, p.cost, p.stock, p.barcode, p.category, now, now);
    }
  })(products);

  console.log(`✅ Seeded: 1 enterprise, 2 users, ${products.length} products`);
  console.log('\n🔑 Login credentials:');
  // ── Seed HQ branch_stock from initial product stock ──────────
  // HQ branch has access to all warehouse stock by default.
  // branch_stock is auto-populated when warehouse is restocked,
  // but we seed it here so the app works immediately out of the box.
  const allProducts = db.prepare(`SELECT * FROM products WHERE enterprise_id=?`).all(enterpriseId);
  const insertBS = db.prepare(`
    INSERT OR IGNORE INTO branch_stock (id, enterprise_id, branch_id, product_id, quantity, updated_at)
    VALUES (?,?,?,?,?,?)
  `);
  db.transaction(ps => {
    for (const p of ps) {
      const qty = (p.warehouse_qty || 0) > 0 ? p.warehouse_qty : (p.stock_quantity || 0);
      if (qty > 0) {
        insertBS.run(uuidv4(), enterpriseId, hqBranchId, p.id, qty, now);
      }
    }
  })(allProducts);

  console.log('   Admin:   admin@posystem.com   / password123');
  console.log('   Cashier: cashier@posystem.com / password123\n');

  process.exit(0);
};

seed().catch(err => { console.error(err); process.exit(1); });
