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
    auto_closed   TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'moved to Ready automatically when its day ended',
    kitchen_time  BIGINT       NOT NULL DEFAULT 0 COMMENT 'last change made on a kitchen screen, ms since epoch',
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
  // tables created before auto_closed existed
  `ALTER TABLE kds_tickets ADD COLUMN IF NOT EXISTS auto_closed TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'moved to Ready automatically when its day ended' AFTER test_mode`,
  `ALTER TABLE kds_tickets ADD COLUMN IF NOT EXISTS kitchen_time BIGINT NOT NULL DEFAULT 0
    COMMENT 'last change made on a kitchen screen, ms since epoch' AFTER auto_closed`,
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
  const TICKET_COLUMNS = 'order_json, stage, stage_time, done_items, name_override, kitchen_time';
  const ticket = r => ({
    order: json(r.order_json),
    stage: {
      stage: r.stage, at: Number(r.stage_time), done: json(r.done_items) || [], v: Number(r.kitchen_time) || 0,
      ...(r.name_override ? { name: r.name_override } : {}),
    },
  });
  const readSettings = async () => {
    const [rows] = await pool.execute('SELECT name, value FROM kds_settings WHERE merchant_id = ?', [merchantId]);
    return Object.fromEntries(rows.map(r => [r.name, json(r.value)]));
  };
  let error = null;
  let cursor = null; // database clock (seconds) at the last changes() check

  // Create / update the tables once; if the database can't be reached, try again before the next query.
  let schema = null;
  const ensureSchema = () => schema || (schema = (async () => { for (const sql of SCHEMA) await pool.query(sql); })()
    .catch(e => { schema = null; throw e; }));

  // writes for one ticket run in order, unchanged rows are skipped, failed rows are retried
  const chains = new Map(), lastWritten = new Map(), failed = new Map();
  function write(id, params) {
    const sig = JSON.stringify(params);
    if (lastWritten.get(id) === sig) return;
    lastWritten.set(id, sig);
    const run = () => ensureSchema().then(() => pool.execute(
      `INSERT INTO kds_tickets (order_id, merchant_id, ticket_number, created_time, created_at, queued_time, stage, stage_time,
         ready_time, done_items, name_override, customer_name, paid, test_mode, auto_closed, kitchen_time, order_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE ticket_number = VALUES(ticket_number), queued_time = VALUES(queued_time),
         customer_name = VALUES(customer_name), paid = VALUES(paid), test_mode = VALUES(test_mode),
         order_json = VALUES(order_json),
         -- kitchen state only moves forward: an older change (e.g. from a second server) never overwrites a newer one
         stage = IF(VALUES(kitchen_time) >= kitchen_time, VALUES(stage), stage),
         stage_time = IF(VALUES(kitchen_time) >= kitchen_time, VALUES(stage_time), stage_time),
         ready_time = IF(VALUES(kitchen_time) >= kitchen_time, VALUES(ready_time), ready_time),
         done_items = IF(VALUES(kitchen_time) >= kitchen_time, VALUES(done_items), done_items),
         name_override = IF(VALUES(kitchen_time) >= kitchen_time, VALUES(name_override), name_override),
         auto_closed = IF(VALUES(kitchen_time) >= kitchen_time, VALUES(auto_closed), auto_closed),
         kitchen_time = GREATEST(kitchen_time, VALUES(kitchen_time))`, params))
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
      await ensureSchema();
      const [[{ now }]] = await pool.query('SELECT UNIX_TIMESTAMP() AS now');
      cursor = Number(now);
      const [rows] = await pool.execute(
        `SELECT ${TICKET_COLUMNS} FROM kds_tickets
         WHERE merchant_id = ? AND created_time >= ? AND stage <> 'deleted'`, [merchantId, since]);
      return { tickets: rows.map(ticket), settings: await readSettings() };
    },

    // Rows changed since the last check, by this server or another one sharing the database.
    // Looks back 2 extra seconds (updated_at has whole-second precision); re-reading a row is harmless.
    async changes(since) {
      await ensureSchema();
      const [[{ now }]] = await pool.query('SELECT UNIX_TIMESTAMP() AS now');
      const from = (cursor ?? Number(now)) - 2;
      cursor = Number(now);
      const [rows] = await pool.execute(
        `SELECT ${TICKET_COLUMNS} FROM kds_tickets
         WHERE merchant_id = ? AND updated_at >= FROM_UNIXTIME(?) AND created_time >= ?`, [merchantId, from, since]);
      return { tickets: rows.map(ticket), settings: await readSettings() };
    },

    saveTicket(order, s) {
      write(order.id, [
        order.id, merchantId, String(order.number), order.createdTime, new Date(order.createdTime), order.queuedAt,
        s.stage, s.at, s.stage === 'ready' || s.stage === 'done' ? s.at : null, JSON.stringify(s.done || []),
        s.name || null, order.customer || null, order.paid ? 1 : 0, order.testMode ? 1 : 0, s.auto ? 1 : 0,
        s.v || 0, JSON.stringify(order),
      ]);
    },

    // Tickets from before `cutoff` still in New / In progress (the server wasn't running at midnight):
    // mark them Ready as of the end of their own day. Returns how many were closed.
    async closeOpenBefore(cutoff, endOfDay) {
      await ensureSchema();
      const [rows] = await pool.execute(
        `SELECT order_id, created_time FROM kds_tickets
         WHERE merchant_id = ? AND created_time < ? AND stage IN ('new', 'cooking')`, [merchantId, cutoff]);
      for (const r of rows) {
        const at = endOfDay(Number(r.created_time));
        await pool.execute(
          `UPDATE kds_tickets SET stage = 'ready', stage_time = ?, ready_time = ?, auto_closed = 1,
             kitchen_time = GREATEST(kitchen_time, ?) WHERE order_id = ?`, [at, at, at, r.order_id]);
      }
      return rows.length;
    },

    markDeleted(id) {
      chains.set(id, (chains.get(id) || Promise.resolve()).then(() =>
        pool.execute(`UPDATE kds_tickets SET stage = 'deleted', stage_time = ?, kitchen_time = ? WHERE order_id = ?`,
          [Date.now(), Date.now(), id])
          .catch(e => console.error('[db] delete', id, e.message))));
      lastWritten.delete(id);
    },

    async saveSetting(name, value) {
      await ensureSchema();
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
    async closeOpenBefore() { return 0; }, // only today's stages matter without a database
    async changes() { return null; },       // one server only: nothing to pick up
    async saveSetting(name, value) { settings = { ...settings, [name]: value }; save(settingsFile, settings); },
  };
}

module.exports = { createStore };
