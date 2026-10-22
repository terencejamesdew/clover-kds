// Where tickets and settings are kept between restarts.
// With DATABASE_URL set: MySQL / MariaDB (every ticket, its state, by timestamp).
// Without it: JSON files in DATA_DIR (stages and settings only; orders are re-read from Clover).
'use strict';

const fs = require('fs');
const path = require('path');

function createStore({ databaseUrl, dataDir, merchantId }) {
  return databaseUrl ? mysqlStore(databaseUrl, merchantId) : fileStore(dataDir);
}

// ---------- MySQL ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kds_tickets (
    order_id      VARCHAR(32)  NOT NULL PRIMARY KEY,
    merchant_id   VARCHAR(32)  NOT NULL,
    ticket_number VARCHAR(64)  NOT NULL,
    created_time  BIGINT       NOT NULL COMMENT 'Clover createdTime, ms since epoch',
    created_at    DATETIME(3)  NOT NULL COMMENT 'created_time as a UTC date, for reading',
    queued_time   BIGINT       NOT NULL COMMENT 'when it was paid and reached the kitchen',
    stage         VARCHAR(16)  NOT NULL COMMENT 'new, cooking, ready or deleted',
    stage_time    BIGINT       NOT NULL,
    ready_time    BIGINT       NULL,
    done_items    JSON         NOT NULL,
    name_override VARCHAR(128) NULL COMMENT 'name typed on the kitchen screen',
    customer_name VARCHAR(128) NULL,
    paid          TINYINT(1)   NOT NULL,
    test_mode     TINYINT(1)   NOT NULL,
    order_json    JSON         NOT NULL,
    updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_merchant_created (merchant_id, created_time)
  )`,
  `CREATE TABLE IF NOT EXISTS kds_settings (
    merchant_id VARCHAR(32) NOT NULL,
    name        VARCHAR(64) NOT NULL,
    value       JSON        NOT NULL,
    PRIMARY KEY (merchant_id, name)
  )`,
];

function mysqlStore(url, merchantId) {
  const mysql = require('mysql2/promise');
  const u = new URL(url);
  const sslMode = (u.searchParams.get('ssl-mode') || u.searchParams.get('sslmode') || '').toUpperCase();
  const pool = mysql.createPool({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
    ssl: sslMode && sslMode !== 'DISABLED' ? { rejectUnauthorized: true } : undefined,
    timezone: 'Z',
    connectionLimit: 4,
    enableKeepAlive: true,
  });
  const json = v => (typeof v === 'string' ? JSON.parse(v) : v);
  let error = null;

  // writes for one ticket run in order, unchanged rows are skipped, failed rows are retried
  const chains = new Map(), lastWritten = new Map(), failed = new Map();
  function write(id, params) {
    const sig = JSON.stringify(params);
    if (lastWritten.get(id) === sig) return;
    lastWritten.set(id, sig);
    const run = () => pool.execute(
      `INSERT INTO kds_tickets (order_id, merchant_id, ticket_number, created_time, created_at, queued_time, stage, stage_time,
         ready_time, done_items, name_override, customer_name, paid, test_mode, order_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE ticket_number = VALUES(ticket_number), queued_time = VALUES(queued_time),
         stage = VALUES(stage), stage_time = VALUES(stage_time), ready_time = VALUES(ready_time),
         done_items = VALUES(done_items), name_override = VALUES(name_override), customer_name = VALUES(customer_name),
         paid = VALUES(paid), test_mode = VALUES(test_mode), order_json = VALUES(order_json)`, params)
      .then(() => { failed.delete(id); error = null; })
      .catch(e => {
        failed.set(id, params);
        lastWritten.delete(id);
        error = 'Database save failed: ' + e.message;
        console.error('[db]', id, e.message);
      });
    chains.set(id, (chains.get(id) || Promise.resolve()).then(run));
  }
  setInterval(() => { for (const [id, params] of failed) { failed.delete(id); write(id, params); } }, 10_000).unref();

  return {
    kind: 'mysql',
    status: () => error,

    async init(since) {
      for (const sql of SCHEMA) await pool.query(sql);
      const [rows] = await pool.execute(
        `SELECT order_json, stage, stage_time, done_items, name_override FROM kds_tickets
         WHERE merchant_id = ? AND created_time >= ? AND stage <> 'deleted'`, [merchantId, since]);
      const [settings] = await pool.execute('SELECT name, value FROM kds_settings WHERE merchant_id = ?', [merchantId]);
      return {
        tickets: rows.map(r => ({
          order: json(r.order_json),
          stage: { stage: r.stage, at: Number(r.stage_time), done: json(r.done_items) || [], ...(r.name_override ? { name: r.name_override } : {}) },
        })),
        settings: Object.fromEntries(settings.map(s => [s.name, json(s.value)])),
      };
    },

    saveTicket(order, s) {
      write(order.id, [
        order.id, merchantId, String(order.number), order.createdTime, new Date(order.createdTime), order.queuedAt,
        s.stage, s.at, s.stage === 'ready' || s.stage === 'done' ? s.at : null, JSON.stringify(s.done || []),
        s.name || null, order.customer || null, order.paid ? 1 : 0, order.testMode ? 1 : 0, JSON.stringify(order),
      ]);
    },

    markDeleted(id) {
      chains.set(id, (chains.get(id) || Promise.resolve()).then(() =>
        pool.execute(`UPDATE kds_tickets SET stage = 'deleted', stage_time = ? WHERE order_id = ?`, [Date.now(), id])
          .catch(e => console.error('[db] delete', id, e.message))));
      lastWritten.delete(id);
    },

    async saveSetting(name, value) {
      await pool.execute(
        'INSERT INTO kds_settings (merchant_id, name, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [merchantId, name, JSON.stringify(value)]);
    },
  };
}

// ---------- JSON files ----------
function fileStore(dataDir) {
  const stagesFile = path.join(dataDir, 'stages.json');
  const settingsFile = path.join(dataDir, 'settings.json');
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const stages = read(stagesFile, {});
  let settings = read(settingsFile, {});
  let error = null;
  function save(f, data) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(f, JSON.stringify(data));
      error = null;
    } catch (e) {
      error = 'Could not save ticket stages — set DATA_DIR to a writable folder';
      console.error('[stages]', e.message); // board keeps working from memory
    }
  }
  function saveStages() {
    const keepAfter = Date.now() - 2 * 86_400_000; // keep only the last 2 days
    for (const [id, s] of Object.entries(stages)) if (s.at < keepAfter) delete stages[id];
    save(stagesFile, stages);
  }
  return {
    kind: 'file',
    status: () => error,
    async init() { return { tickets: [], stages: structuredClone(stages), settings }; },
    saveTicket(order, s) {
      if (JSON.stringify(stages[order.id]) === JSON.stringify(s)) return;
      stages[order.id] = structuredClone(s);
      saveStages();
    },
    markDeleted(id) { delete stages[id]; saveStages(); },
    async saveSetting(name, value) { settings = { ...settings, [name]: value }; save(settingsFile, settings); },
  };
}

module.exports = { createStore };
