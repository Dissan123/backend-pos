// tests/api.test.js
// Tests: auth, products, sales, sync, conflict resolution

const request = require('supertest');
const app = require('../src/index');
const { getDb } = require('../src/db/localDb');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

let adminToken;
let cashierToken;
let testProductId;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.SQLITE_DB_PATH = './data/test_pos.db';

  require('../src/db/migrate');
  const db = getDb();

  // Insert test users
  const hashed = await bcrypt.hash('test1234', 10);
  const adminId = uuidv4();
  const cashierId = uuidv4();

  db.prepare(`INSERT OR IGNORE INTO users (id, name, email, password, role) VALUES (?, 'Admin', 'admin@test.com', ?, 'admin')`).run(adminId, hashed);
  db.prepare(`INSERT OR IGNORE INTO users (id, name, email, password, role) VALUES (?, 'Cashier', 'cashier@test.com', ?, 'cashier')`).run(cashierId, hashed);
});

describe('Auth', () => {
  it('should login admin', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@test.com', password: 'test1234' });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeDefined();
    adminToken = res.body.data.token;
  });

  it('should reject wrong password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@test.com', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('should get current user', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('admin@test.com');
  });
});

describe('Products', () => {
  it('should create a product', async () => {
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Test Cola', price: 2000, stock_quantity: 20, barcode: 'TEST001', category: 'Beverages' });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Test Cola');
    testProductId = res.body.data.id;
  });

  it('should fetch all products', async () => {
    const res = await request(app).get('/api/products').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('should find by barcode', async () => {
    const res = await request(app).get('/api/products/barcode/TEST001').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.barcode).toBe('TEST001');
  });

  it('should reject duplicate barcode', async () => {
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Duplicate', price: 1000, barcode: 'TEST001' });
    expect(res.status).toBe(409);
  });
});

describe('Sales', () => {
  it('should create a sale and deduct stock', async () => {
    const db = getDb();
    const before = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(testProductId);

    const res = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [{ product_id: testProductId, quantity: 2 }],
        amount_paid: 10000,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.sale.total_amount).toBe(4000);
    expect(res.body.data.sale.change_given).toBe(6000);

    const after = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(testProductId);
    expect(after.stock_quantity).toBe(before.stock_quantity - 2);
  });

  it('should reject sale with insufficient stock', async () => {
    const res = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [{ product_id: testProductId, quantity: 9999 }],
        amount_paid: 999999,
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Insufficient stock');
  });

  it('should get today summary', async () => {
    const res = await request(app).get('/api/sales/summary/today').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.total_transactions).toBeGreaterThan(0);
  });
});

describe('Inventory', () => {
  it('should return low stock alerts', async () => {
    const res = await request(app).get('/api/inventory/low-stock').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('should return inventory logs after sale', async () => {
    const res = await request(app)
      .get(`/api/inventory/logs?product_id=${testProductId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});

describe('Sync Queue', () => {
  it('should have pending items after offline operations', async () => {
    const db = getDb();
    const pending = db.prepare(`SELECT COUNT(*) as count FROM sync_queue WHERE status = 'pending'`).get();
    expect(pending.count).toBeGreaterThan(0);
  });

  it('should get sync status', async () => {
    const res = await request(app).get('/api/sync/status').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.queue).toBeDefined();
  });
});
