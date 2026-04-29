// src/db/supabase.js
'use strict';

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('⚠️  SUPABASE_URL or SUPABASE_SERVICE_KEY missing in .env — cloud sync disabled.');
} else {
  console.log(`✅ Supabase configured: ${SUPABASE_URL}`);
}

let _client = null;

const getSupabase = () => {
  if (_client) return _client;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;

  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
};

const isCloudAvailable = async () => {
  try {
    const sb = getSupabase();
    if (!sb) return false;

    // Try a simple query — if table doesn't exist this will error, which is fine
    // We just want to know if Supabase is reachable
    const { error } = await sb.from('enterprises').select('id').limit(1);
    if (error) {
      console.error(`☁️  Supabase connection test failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`☁️  Supabase unreachable: ${err.message}`);
    return false;
  }
};

module.exports = { getSupabase, isCloudAvailable };
