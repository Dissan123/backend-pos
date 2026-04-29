// src/db/localDb.js
'use strict';

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { createDatabase } = require('./sqliteCompat');

// Always resolve relative to THIS file's location, not the cwd
// This means the db is always at apps/backend/data/pos_local.db
// regardless of where you run node from
const DB_PATH = process.env.SQLITE_DB_PATH
  ? path.resolve(process.env.SQLITE_DB_PATH)
  : path.resolve(__dirname, '../../data/pos_local.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let _db = null;

const initDb = async () => {
  if (_db) return _db;
  _db = await createDatabase(DB_PATH);
  const { migrate } = require('./migrate');
  await migrate(_db);
  return _db;
};

const getDb = () => {
  if (!_db) throw new Error('Database not initialised. Await initDb() before starting the server.');
  return _db;
};

const closeDb = () => {
  if (_db) { _db.close(); _db = null; }
};

module.exports = { initDb, getDb, closeDb };
