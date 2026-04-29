// src/controllers/syncController.js
'use strict';

const { runSync, getSyncStatus, retryFailed } = require('../services/syncEngine');
const { getSupabase, isCloudAvailable }       = require('../db/supabase');
const { getDb }                               = require('../db/localDb');

// GET /api/sync/status
const getStatus = (req, res) => {
  try {
    const status = getSyncStatus();
    return res.json({ success: true, data: status });
  } catch (err) {
    return res.json({ success: true, data: {
      pending_count: 0, syncing_count: 0,
      synced_count:  0, failed_count:  0, last_sync_at: null,
    }});
  }
};

// POST /api/sync/trigger
const triggerSync = async (req, res) => {
  res.json({ success: true, message: 'Sync started' });
  await runSync();
};

// POST /api/sync/retry
const retrySync = async (req, res) => {
  res.json({ success: true, message: 'Retry started' });
  await retryFailed();
};

// GET /api/sync/diagnose  — tells you exactly what is wrong with sync
const diagnose = async (req, res) => {
  const result = {
    supabase_url_set:     !!process.env.SUPABASE_URL,
    supabase_key_set:     !!process.env.SUPABASE_SERVICE_KEY,
    supabase_reachable:   false,
    tables_exist:         {},
    pending_items:        0,
    failed_items:         0,
    errors:               [],
  };

  try {
    const supabase = getSupabase();
    if (!supabase) {
      result.errors.push('Supabase client not initialised — check SUPABASE_URL and SUPABASE_SERVICE_KEY in .env');
      return res.json({ success: false, data: result });
    }

    // Test connection
    const { error: pingErr } = await supabase.from('enterprises').select('id').limit(1);
    if (pingErr) {
      result.errors.push(`Cannot reach Supabase: ${pingErr.message}`);
    } else {
      result.supabase_reachable = true;
    }

    // Check each table exists
    for (const table of ['enterprises', 'users', 'products', 'sales', 'sale_items', 'settings']) {
      const { error } = await supabase.from(table).select('*').limit(0);
      result.tables_exist[table] = !error;
      if (error) result.errors.push(`Table "${table}" error: ${error.message}`);
    }

    // Check local queue
    const db = getDb();
    const pending = db.prepare(`SELECT COUNT(*) AS c FROM sync_queue WHERE status='pending'`).get();
    const failed  = db.prepare(`SELECT COUNT(*) AS c FROM sync_queue WHERE status='failed'`).get();
    const failedItems = db.prepare(`SELECT action_type, error_message FROM sync_queue WHERE status='failed' LIMIT 5`).all();

    result.pending_items = pending.c;
    result.failed_items  = failed.c;
    if (failedItems.length) {
      result.errors.push(...failedItems.map(f => `${f.action_type}: ${f.error_message}`));
    }

  } catch (err) {
    result.errors.push(`Diagnostic error: ${err.message}`);
  }

  return res.json({ success: true, data: result });
};

// POST /api/sync/queue-all — re-queue everything for a full upload
const queueAll = async (req, res) => {
  const { queueAll: qa } = require('../services/syncEngine');
  const total = qa();
  res.json({ success: true, message: `Queued ${total} items. Run sync to upload.` });
  // Immediately start syncing
  const { runSync } = require('../services/syncEngine');
  await runSync();
};

module.exports = { getStatus, triggerSync, retrySync, diagnose, queueAll };
