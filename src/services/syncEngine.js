// src/services/syncEngine.js
'use strict';

const fs                               = require('fs');
const path                             = require('path');
const { getDb }                        = require('../db/localDb');
const { getSupabase, isCloudAvailable } = require('../db/supabase');
const { v4: uuidv4 }                   = require('uuid');

let isSyncing = false;

// ── Main entry ───────────────────────────────────────────────────
const runSync = async () => {
  if (isSyncing) return;
  const online = await isCloudAvailable();
  if (!online) { console.log('📡 No internet connection. Sync deferred.'); return; }

  isSyncing = true;
  console.log('🔄 Syncing...');
  try {
    await push();
    await pull();
    console.log('✅ Sync complete.');
  } catch (err) {
    console.error('❌ Sync error:', err.message);
  } finally {
    isSyncing = false;
  }
};

// ── PUSH local → cloud ───────────────────────────────────────────
const push = async () => {
  const db       = getDb();
  const supabase = getSupabase();
  if (!supabase) return;

  const pending = db.prepare(
    `SELECT * FROM sync_queue WHERE status='pending' AND attempts<max_attempts ORDER BY created_at ASC LIMIT 100`
  ).all();

  if (pending.length === 0) { console.log('✅ Nothing to push.'); return; }
  console.log(`📤 Pushing ${pending.length} items...`);

  for (const item of pending) {
    db.prepare(`UPDATE sync_queue SET status='syncing', attempts=attempts+1 WHERE id=?`).run(item.id);
    try {
      const payload = JSON.parse(item.payload_json);
      await processItem(supabase, item.action_type, payload, db);
      db.prepare(`UPDATE sync_queue SET status='synced', synced_at=?, error_message=NULL WHERE id=?`)
        .run(new Date().toISOString(), item.id);
      markSynced(db, item.entity_type, item.entity_id);
      console.log(`  ✅ ${item.action_type} ${item.entity_id}`);
    } catch (err) {
      const maxed = item.attempts + 1 >= item.max_attempts;
      db.prepare(`UPDATE sync_queue SET status=?, error_message=? WHERE id=?`)
        .run(maxed ? 'failed' : 'pending', err.message, item.id);
      console.error(`  ❌ ${item.action_type} FAILED: ${err.message}`);
      if (maxed) console.error(`     ⚠️  Max attempts reached — marked as failed`);
    }
  }
};

// ── Upload image to Supabase Storage ─────────────────────────────
// Returns the public URL, or the original url if it's already remote
const uploadImageIfLocal = async (supabase, imageUrl, productId, enterpriseId) => {
  if (!imageUrl) return null;

  // Already a remote URL (Supabase or any https) — nothing to do
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    return imageUrl;
  }

  // Local file path (file:// URI or absolute path)
  const filePath = imageUrl.replace('file://', '');

  if (!fs.existsSync(filePath)) {
    console.warn(`  ⚠️  Image file not found: ${filePath}`);
    return null;
  }

  const ext        = path.extname(filePath).toLowerCase() || '.jpg';
  const mimeTypes  = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.gif':'image/gif' };
  const mimeType   = mimeTypes[ext] || 'image/jpeg';
  const storagePath = `${enterpriseId}/${productId}${ext}`;

  console.log(`  📸 Uploading image for product ${productId}...`);

  const fileBuffer = fs.readFileSync(filePath);

  const { error } = await supabase.storage
    .from('product-images')
    .upload(storagePath, fileBuffer, {
      contentType:  mimeType,
      upsert:       true,  // overwrite if exists
    });

  if (error) {
    console.error(`  ❌ Image upload failed: ${error.message}`);
    return null;
  }

  // Get the public URL
  const { data: urlData } = supabase.storage
    .from('product-images')
    .getPublicUrl(storagePath);

  const publicUrl = urlData?.publicUrl || null;
  console.log(`  ✅ Image uploaded → ${publicUrl}`);

  return publicUrl;
};

// ── Process one queue item ────────────────────────────────────────
const processItem = async (sb, action, payload, db) => {
  switch (action) {

    case 'CREATE_ENTERPRISE': {
      const { error } = await sb.from('enterprises').upsert(toCloud(payload), { onConflict: 'id' });
      if (error) throw new Error(error.message);
      break;
    }

    case 'CREATE_SALE': {
      const { sale, items } = payload;

      // Ensure enterprise exists in Supabase before inserting sale (FK constraint)
      if (sale.enterprise_id && db) {
        const ent = db.prepare(`SELECT * FROM enterprises WHERE id=?`).get(sale.enterprise_id);
        if (ent) {
          await sb.from('enterprises').upsert(toCloud(ent), { onConflict: 'id' });
        }
        // Also ensure the user exists
        if (sale.user_id) {
          const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(sale.user_id);
          if (u) {
            const safeU = toCloud(u);
            delete safeU.password; delete safeU.otp_code;
            delete safeU.otp_expires_at; delete safeU.otp_type;
            await sb.from('users').upsert(safeU, { onConflict: 'id' });
          }
        }
      }

      const { error: se } = await sb.from('sales').upsert(toCloud(sale), { onConflict: 'id' });
      if (se) throw new Error(`Sale: ${se.message}`);
      if (items?.length) {
        const { error: ie } = await sb.from('sale_items').upsert(items.map(toCloud), { onConflict: 'id' });
        if (ie) throw new Error(`Items: ${ie.message}`);
      }
      // Also sync updated product stock
      for (const item of (items || [])) {
        const p = db.prepare(`SELECT * FROM products WHERE id=?`).get(item.product_id);
        if (p) {
          await sb.from('products')
            .update({ stock_quantity: p.stock_quantity, warehouse_qty: p.warehouse_qty || 0, updated_at: p.updated_at })
            .eq('id', p.id);
        }
      }
      break;
    }

    case 'VOID_SALE': {
      const { error } = await sb.from('sales')
        .update({ status: 'voided', updated_at: new Date().toISOString() })
        .eq('id', payload.id);
      if (error) throw new Error(error.message);
      break;
    }

    case 'CREATE_PRODUCT':
    case 'UPDATE_PRODUCT':
    case 'UPDATE_STOCK': {
      const p = toCloud(payload);

      // Handle image: upload local files, skip missing/broken paths
      if (p.image_url) {
        if (p.image_url.startsWith('http://') || p.image_url.startsWith('https://')) {
          // Already a remote URL — keep as-is
        } else {
          // Local file path — try to upload
          const publicUrl = await uploadImageIfLocal(sb, p.image_url, p.id, p.enterprise_id);
          if (publicUrl) {
            p.image_url = publicUrl;
            // Update local record with public URL so future syncs skip upload
            if (db) {
              db.prepare(`UPDATE products SET image_url=? WHERE id=?`).run(publicUrl, p.id);
            }
          } else {
            // File missing or upload failed — sync product without image, don't fail
            p.image_url = null;
            if (db) {
              db.prepare(`UPDATE products SET image_url=NULL WHERE id=?`).run(p.id);
            }
          }
        }
      }

      // Upsert only columns that exist in Supabase — omit image_url if null to avoid schema errors
      const productRow = { ...p };
      if (!productRow.image_url) delete productRow.image_url;

      const { error } = await sb.from('products').upsert(productRow, { onConflict: 'id' });
      if (error) throw new Error(error.message);
      break;
    }

    case 'DELETE_PRODUCT': {
      const { error } = await sb.from('products')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', payload.id);
      if (error) throw new Error(error.message);
      break;
    }

    case 'CREATE_USER':
    case 'UPDATE_USER': {
      const safe = toCloud(payload);
      delete safe.password; delete safe.otp_code;
      delete safe.otp_expires_at; delete safe.otp_type;
      const { error } = await sb.from('users').upsert(safe, { onConflict: 'id' });
      if (error) throw new Error(error.message);
      break;
    }

    case 'CREATE_BRANCH':
    case 'UPDATE_BRANCH': {
      const { error } = await sb.from('branches').upsert(toCloud(payload), { onConflict: 'id' });
      if (error) throw new Error(error.message);
      break;
    }

    case 'APPROVE_STOCK_ORDER': {
      // Sync the stock order status + updated branch_stock levels
      const { order_id, branch_id, items } = payload;
      await sb.from('stock_orders')
        .update({ status: 'fulfilled', updated_at: new Date().toISOString() })
        .eq('id', order_id);
      // Upsert updated branch_stock rows
      if (items?.length) {
        for (const item of items) {
          const bs = db.prepare(
            `SELECT * FROM branch_stock WHERE branch_id=? AND product_id=?`
          ).get(branch_id, item.product_id);
          if (bs) {
            await sb.from('branch_stock').upsert(toCloud(bs), { onConflict: 'branch_id,product_id' });
          }
        }
      }
      break;
    }

    default:
      console.warn(`⚠️ Unknown action: ${action}`);
  }
};

// ── PULL cloud → local ────────────────────────────────────────────
const pull = async () => {
  const db       = getDb();
  const supabase = getSupabase();
  if (!supabase) return;

  const enterprises = db.prepare(`SELECT DISTINCT id FROM enterprises`).all();
  for (const { id: eid } of enterprises) {
    await pullEnterprise(db, supabase, eid);
  }
};

const pullEnterprise = async (db, sb, eid) => {
  const row   = db.prepare(`SELECT value FROM settings WHERE enterprise_id=? AND key='last_pull_at'`).get(eid);
  const since = row?.value || '1970-01-01T00:00:00.000Z';

  // Pull products — includes image_url (now a Supabase public URL)
  const { data: products, error } = await sb
    .from('products')
    .select('*')
    .eq('enterprise_id', eid)
    .gt('updated_at', since)
    .order('updated_at');

  if (error) { console.error(`Pull error: ${error.message}`); return; }

  if (products?.length) {
    console.log(`📥 ${products.length} product(s) from cloud`);
    const upsert = db.prepare(`
      INSERT INTO products
        (id, enterprise_id, branch_id, name, description, price, cost_price,
         stock_quantity, warehouse_qty, low_stock_alert, barcode, category,
         unit, image_url, is_active, created_at, updated_at, synced)
      VALUES
        (@id,@enterprise_id,@branch_id,@name,@description,@price,@cost_price,
         @stock_quantity,@warehouse_qty,@low_stock_alert,@barcode,@category,
         @unit,@image_url,@is_active,@created_at,@updated_at,1)
      ON CONFLICT(id) DO UPDATE SET
        name           = CASE WHEN excluded.updated_at > products.updated_at THEN excluded.name           ELSE products.name END,
        price          = CASE WHEN excluded.updated_at > products.updated_at THEN excluded.price          ELSE products.price END,
        cost_price     = CASE WHEN excluded.updated_at > products.updated_at THEN excluded.cost_price     ELSE products.cost_price END,
        stock_quantity = CASE WHEN excluded.updated_at > products.updated_at THEN excluded.stock_quantity ELSE products.stock_quantity END,
        warehouse_qty  = CASE WHEN excluded.updated_at > products.updated_at THEN excluded.warehouse_qty  ELSE products.warehouse_qty END,
        image_url      = CASE WHEN excluded.updated_at > products.updated_at THEN excluded.image_url      ELSE products.image_url END,
        is_active      = CASE WHEN excluded.updated_at > products.updated_at THEN excluded.is_active      ELSE products.is_active END,
        updated_at     = CASE WHEN excluded.updated_at > products.updated_at THEN excluded.updated_at     ELSE products.updated_at END,
        synced = 1
    `);
    db.transaction(ps => {
      for (const p of ps) {
        upsert.run({
          id: p.id, enterprise_id: p.enterprise_id, branch_id: p.branch_id || null,
          name: p.name, description: p.description || null,
          price: p.price, cost_price: p.cost_price || 0,
          stock_quantity: p.stock_quantity || 0, warehouse_qty: p.warehouse_qty || 0,
          low_stock_alert: p.low_stock_alert || 5,
          barcode: p.barcode || null, category: p.category || null,
          unit: p.unit || 'piece',
          image_url: p.image_url || null,   // ← Supabase public URL synced back
          is_active: p.is_active ? 1 : 0,
          created_at: p.created_at, updated_at: p.updated_at,
        });
      }
    })(products);
  }

  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO settings (enterprise_id, key, value, updated_at) VALUES (?,?,?,?)`)
    .run(eid, 'last_pull_at', now, now);
};

// ── Helpers ───────────────────────────────────────────────────────
const markSynced = (db, entityType, entityId) => {
  const tables = { products:'products', sales:'sales', users:'users', enterprises:'enterprises', branches:'branches' };
  if (tables[entityType]) db.prepare(`UPDATE ${tables[entityType]} SET synced=1 WHERE id=?`).run(entityId);
};

// Convert SQLite row → Supabase-safe object
const toCloud = (obj) => {
  const out = { ...obj };
  delete out.synced;
  for (const k of ['is_active','is_verified','is_hq','synced']) {
    if (k in out) out[k] = Boolean(out[k]);
  }
  Object.keys(out).forEach(k => { if (out[k] === undefined) delete out[k]; });
  return out;
};

const retryFailed = async () => {
  const db = getDb();
  const { changes } = db.prepare(`UPDATE sync_queue SET status='pending', attempts=0 WHERE status='failed'`).run();
  if (changes > 0) { console.log(`🔁 Reset ${changes} failed items`); await runSync(); }
};

const getSyncStatus = () => {
  const db   = getDb();
  const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM sync_queue GROUP BY status`).all();
  const map  = Object.fromEntries(rows.map(r => [r.status, r.count]));
  const last = db.prepare(`SELECT synced_at FROM sync_queue WHERE status='synced' ORDER BY synced_at DESC LIMIT 1`).get();
  return {
    pending_count: map.pending  || 0,
    syncing_count: map.syncing  || 0,
    synced_count:  map.synced   || 0,
    failed_count:  map.failed   || 0,
    last_sync_at:  last?.synced_at || null,
  };
};

const queueAll = () => {
  const db  = getDb();
  const now = new Date().toISOString();
  const q   = require('uuid');

  const enterprises = db.prepare('SELECT * FROM enterprises').all();
  for (const e of enterprises) {
    db.prepare(`INSERT OR REPLACE INTO sync_queue
      (id,enterprise_id,action_type,entity_type,entity_id,payload_json,status,attempts,created_at)
      VALUES (?,?,'CREATE_ENTERPRISE','enterprises',?,?,'pending',0,?)`)
      .run(q.v4(), e.id, e.id, JSON.stringify(e), now);
  }

  const branches = db.prepare('SELECT * FROM branches WHERE enterprise_id IS NOT NULL').all();
  for (const b of branches) {
    db.prepare(`INSERT OR REPLACE INTO sync_queue
      (id,enterprise_id,action_type,entity_type,entity_id,payload_json,status,attempts,created_at)
      VALUES (?,?,'CREATE_BRANCH','branches',?,?,'pending',0,?)`)
      .run(q.v4(), b.enterprise_id, b.id, JSON.stringify(b), now);
  }

  const users = db.prepare('SELECT * FROM users WHERE enterprise_id IS NOT NULL').all();
  for (const u of users) {
    const safe = { ...u };
    delete safe.password; delete safe.otp_code;
    delete safe.otp_expires_at; delete safe.otp_type;
    db.prepare(`INSERT OR REPLACE INTO sync_queue
      (id,enterprise_id,action_type,entity_type,entity_id,payload_json,status,attempts,created_at)
      VALUES (?,?,'CREATE_USER','users',?,?,'pending',0,?)`)
      .run(q.v4(), u.enterprise_id, u.id, JSON.stringify(safe), now);
  }

  // Products — includes image_url (will be uploaded during sync)
  const products = db.prepare('SELECT * FROM products WHERE enterprise_id IS NOT NULL').all();
  for (const p of products) {
    db.prepare(`INSERT OR REPLACE INTO sync_queue
      (id,enterprise_id,action_type,entity_type,entity_id,payload_json,status,attempts,created_at)
      VALUES (?,?,'CREATE_PRODUCT','products',?,?,'pending',0,?)`)
      .run(q.v4(), p.enterprise_id, p.id, JSON.stringify(p), now);
  }

  const sales = db.prepare(`SELECT * FROM sales WHERE enterprise_id IS NOT NULL AND status='completed'`).all();
  for (const s of sales) {
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(s.id);
    db.prepare(`INSERT OR REPLACE INTO sync_queue
      (id,enterprise_id,action_type,entity_type,entity_id,payload_json,status,attempts,created_at)
      VALUES (?,?,'CREATE_SALE','sales',?,?,'pending',0,?)`)
      .run(q.v4(), s.enterprise_id, s.id, JSON.stringify({ sale: s, items }), now);
  }

  const total = enterprises.length + branches.length + users.length + products.length + sales.length;
  console.log(`📦 Queued ${total} items for full re-sync`);
  console.log(`   (${enterprises.length} enterprises, ${branches.length} branches, ${users.length} users, ${products.length} products [images will upload], ${sales.length} sales)`);
  return total;
};

module.exports = { runSync, getSyncStatus, retryFailed, queueAll };
