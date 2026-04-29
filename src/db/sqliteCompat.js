/**
 * sqliteCompat.js
 *
 * A synchronous wrapper around sql.js that exposes the same API as
 * better-sqlite3, so the rest of the codebase needs zero changes.
 *
 * Why: better-sqlite3 is a native C++ addon that requires Visual Studio
 * Build Tools on Windows. sql.js is pure WebAssembly — no build tools needed.
 *
 * Supported API surface (all synchronous, matching better-sqlite3):
 *   db.exec(sql)
 *   db.pragma(str)          — no-op stubs for WAL / foreign_keys / etc.
 *   db.prepare(sql)         → Statement
 *     stmt.run(...params)   → { changes, lastInsertRowid }
 *     stmt.get(...params)   → row object | undefined
 *     stmt.all(...params)   → row object[]
 *   db.transaction(fn)      → wrapped fn (executes in BEGIN/COMMIT)
 *   db.close()
 */

'use strict';

const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');

// ─── Statement ──────────────────────────────────────────────────────────────

class Statement {
  constructor (db, sql) {
    this._db  = db;   // sql.js Database instance
    this._sql = sql;
  }

  /** Resolve named (:name) or positional (?) params into sql.js format */
  _bind (params) {
    if (!params || params.length === 0) return undefined;

    // better-sqlite3 accepts a single object for named params
    if (params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0])) {
      const obj = params[0];
      // sql.js wants { ':name': value }
      const bound = {};
      for (const [k, v] of Object.entries(obj)) {
        const key = k.startsWith(':') || k.startsWith('@') || k.startsWith('$') ? k : `:${k}`;
        bound[key] = v;
      }
      return bound;
    }

    // Positional array
    return params.flat();
  }

  run (...params) {
    const stmt = this._db.prepare(this._sql);
    try {
      stmt.run(this._bind(params));
      const changes          = this._db.getRowsModified();
      const lastInsertRowid  = Number(this._db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? 0);
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  get (...params) {
    const stmt = this._db.prepare(this._sql);
    try {
      stmt.bind(this._bind(params));
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  all (...params) {
    const results = [];
    const stmt    = this._db.prepare(this._sql);
    try {
      stmt.bind(this._bind(params));
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
    } finally {
      stmt.free();
    }
    return results;
  }
}

// ─── Database ───────────────────────────────────────────────────────────────

class Database {
  constructor (filePath, _options) {
    this._filePath = filePath ? path.resolve(filePath) : null;
    this._SQL      = null;   // set in _init()
    this._db       = null;   // sql.js Database
    this._inited   = false;
  }

  /** Must be called (and awaited) once before using the db. */
  async _init () {
    if (this._inited) return;
    this._SQL = await initSqlJs();

    if (this._filePath && fs.existsSync(this._filePath)) {
      const buf   = fs.readFileSync(this._filePath);
      this._db    = new this._SQL.Database(buf);
    } else {
      this._db = new this._SQL.Database();
    }

    this._inited = true;
  }

  /** Persist the in-memory database to disk. Called automatically after write ops. */
  _save () {
    if (!this._filePath) return;
    const data = this._db.export();
    const dir  = path.dirname(this._filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._filePath, Buffer.from(data));
  }

  exec (sql) {
    this._db.run(sql);
    this._save();
    return this;
  }

  /** No-op stubs — sql.js doesn't support PRAGMAs the same way, but the app
   *  still works correctly without WAL mode (sql.js is always in-memory + file). */
  pragma (_str) {
    return this;
  }

  prepare (sql) {
    return new Statement(this._db, sql);
  }

  /** Wraps fn in a BEGIN / COMMIT transaction (ROLLBACK on error).
   *  Returns a callable that accepts the same args as fn. */
  transaction (fn) {
    return (...args) => {
      this._db.run('BEGIN');
      try {
        const result = fn(...args);
        this._db.run('COMMIT');
        this._save();
        return result;
      } catch (err) {
        this._db.run('ROLLBACK');
        throw err;
      }
    };
  }

  close () {
    if (this._db) {
      this._save();
      this._db.close();
      this._db    = null;
      this._inited = false;
    }
  }
}

// ─── Factory (async, called once at startup) ────────────────────────────────

/**
 * createDatabase(filePath)
 *
 * Returns a fully-initialised Database whose synchronous API mirrors
 * better-sqlite3 exactly.
 *
 * Usage:
 *   const { createDatabase } = require('./sqliteCompat');
 *   const db = await createDatabase('./data/pos_local.db');
 */
async function createDatabase (filePath) {
  const db = new Database(filePath);
  await db._init();
  return db;
}

module.exports = { createDatabase, Database };
