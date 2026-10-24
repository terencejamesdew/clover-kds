// Clover Kitchen Display — live order queue for Clover POS.
// Needs Node.js 18+.  Run:  npm install && npm start
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('./store');

// ---------- config ----------
loadDotEnv(path.join(__dirname, '.env'));
// "Today's orders" starts at midnight in the shop's time zone; cloud hosts default to UTC.
if (process.env.TIMEZONE) process.env.TZ = process.env.TIMEZONE;
const CFG = {
  merchantId: process.env.CLOVER_MERCHANT_ID || '',
  token: process.env.CLOVER_API_TOKEN || '',
  region: (process.env.CLOVER_REGION || 'us').toLowerCase(),
  port: Number(process.env.PORT || 3000),
  pollSeconds: Math.max(2, Number(process.env.POLL_SECONDS || 5)),
  webhookAuth: process.env.CLOVER_WEBHOOK_AUTH || '',
  databaseUrl: process.env.DATABASE_URL || '',
  demo: process.env.DEMO === '1' || !process.env.CLOVER_API_TOKEN,
};
const API_BASE = {
  us: 'https://api.clover.com',
  ca: 'https://api.clover.com',
  eu: 'https://api.eu.clover.com',
  la: 'https://api.la.clover.com',
  sandbox: 'https://apisandbox.dev.clover.com',
}[CFG.region] || 'https://api.clover.com';

// ---------- state ----------
// orders: id -> normalized order;  stages: id -> {stage, at, done: [item keys], name?}
const STAGES = ['new', 'cooking', 'ready', 'done'];
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'); // point at a persistent volume when hosted
// demo tickets are kept apart from the real merchant's in the database
const store = createStore({ databaseUrl: CFG.databaseUrl, dataDir: DATA_DIR, merchantId: CFG.demo ? 'demo' : CFG.merchantId });
const orders = new Map();
let stages = {};
let settings = { acceptTestOrders: false };
let lastPoll = startOfToday();
let lastError = null;
const clients = new Set();

// ---------- Clover API ----------
async function clover(pathAndQuery) {
  const res = await fetch(API_BASE + pathAndQuery, {
    headers: { Authorization: 'Bearer ' + CFG.token, Accept: 'application/json' },
  });
  if (res.status === 429) throw new Error('Clover rate limit hit (429) — raise POLL_SECONDS');
  if (!res.ok) throw new Error(`Clover API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Item categories (for food vs drink) need Inventory: Read; without it Clover rejects the whole request,
// so drop that expansion on a 401 and fall back to guessing from item names.
let EXPAND = 'expand=lineItems,lineItems.modifications,lineItems.item.categories,orderType,employee,customers,payments';
async function cloverOrders(pathAndQuery) {
  try {
    return await clover(pathAndQuery());
  } catch (e) {
    if (!/Clover API 401/.test(e.message) || !EXPAND.includes('categories')) throw e;
    EXPAND = EXPAND.replace(',lineItems.item.categories', '');
    console.warn('[categories] token lacks Inventory: Read — sorting food vs drink by item name instead');
    return clover(pathAndQuery());
  }
}

async function pollOrders() {
  const since = lastPoll - 60_000; // 1-minute overlap so nothing slips between polls
  const startedAt = Date.now();
  let offset = 0, changed = false;
  try {
    for (;;) {
      const page = await cloverOrders(() => `/v3/merchants/${CFG.merchantId}/orders?filter=modifiedTime>=${since}` +
        `&${EXPAND}&orderBy=modifiedTime%20ASC&limit=100&offset=${offset}`);
      const els = page.elements || [];
      for (const el of els) if (upsert(el)) changed = true;
      if (els.length < 100) break;
      offset += 100;
    }
    lastPoll = startedAt;
    if (lastError) changed = true;
    lastError = null;
  } catch (e) {
    if (lastError !== e.message) changed = true;
    lastError = e.message;
    console.error('[poll]', e.message);
  }
  if (changed) broadcast(); // screens only get a new snapshot when something changed
}

async function fetchOrder(id) {
  try {
    upsert(await cloverOrders(() => `/v3/merchants/${CFG.merchantId}/orders/${id}?${EXPAND}`));
    broadcast();
  } catch (e) {
    console.error('[fetchOrder]', id, e.message);
  }
}

// ---------- normalize ----------
// Returns true when the ticket changed.
function upsert(o) {
  if (!o || !o.id) return false;
  if (o.deleted) { remove(o.id); return true; }
  // only today's orders (the modifiedTime poll also returns older orders that were edited today)
  if ((o.createdTime || Date.now()) < startOfToday()) return orders.delete(o.id);
  const items = (o.lineItems && o.lineItems.elements) || [];
  // every item is its own card, repeats included, so each can be tapped done separately
  const cards = [];
  items.forEach((li, idx) => {
    if (li.refunded || li.exchanged) return;
    if (/^\s*\(R\)/i.test(li.name || '')) return; // "(R)" items are reprints
    const mods = ((li.modifications && li.modifications.elements) || []).map(m => m.name).filter(Boolean);
    const qty = li.unitQty ? li.unitQty / 1000 : 1; // unitQty is in thousandths; whole numbers become separate cards
    const copies = Number.isInteger(qty) && qty > 1 ? qty : 1;
    const note = (li.note || '').trim();
    for (let n = 0; n < copies; n++) {
      cards.push({ key: `${li.id || 'line' + idx}#${n}`, name: li.name || 'Item', mods, note, ...classify(li, mods) });
    }
  });
  if (!cards.length) return false; // empty tickets aren't kitchen-relevant yet
  const { note, validatedName } = splitNote(o.note);
  const prev = orders.get(o.id);
  const customerId = (((o.customers && o.customers.elements) || [])[0] || {}).id || '';
  const { paid, paidAt } = payment(o);
  const next = {
    id: o.id,
    number: o.title || o.id.slice(-4),
    createdTime: o.createdTime || Date.now(),
    queuedAt: paidAt || o.createdTime || Date.now(), // tickets reach the kitchen once they're paid
    modifiedTime: o.modifiedTime || Date.now(),
    state: o.state || 'open',
    paymentState: o.paymentState || '',
    paid,
    testMode: !!o.testMode,
    orderType: normalizeOrderType(o.orderType && o.orderType.label),
    employee: (o.employee && o.employee.name) || '',
    customerId,
    // keep a name already looked up (or restored from the database) while a new lookup is pending
    customer: customerName(o) || (prev && prev.customerId === customerId && prev.customer) || validatedName,
    validatedName,
    note,
    total: typeof o.total === 'number' ? o.total : null,
    items: cards,
  };
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return false;
  orders.set(o.id, next);
  if (!stages[o.id]) stages[o.id] = { stage: 'new', at: next.queuedAt, done: [] };
  persist(o.id);
  return true;
}

// Paid = Clover says PAID, or successful payments cover the total.
// (Clover's order list can report paymentState OPEN for paid orders, so the payments themselves are checked.)
function payment(o) {
  if (CFG.demo && !o.payments) return { paid: true, paidAt: o.createdTime };
  const ok = ((o.payments && o.payments.elements) || []).filter(p => p.result === 'SUCCESS' || p.result === 'AUTH');
  const amount = ok.reduce((sum, p) => sum + (p.amount || 0), 0);
  const paid = o.paymentState === 'PAID' || (ok.length > 0 && amount >= (o.total || 0));
  const paidAt = ok.length ? Math.min(...ok.map(p => p.createdTime || Infinity)) : null;
  return { paid, paidAt: paid && Number.isFinite(paidAt) ? paidAt : null };
}

// Paid orders only; Clover test-mode orders only when the screen's toggle allows them.
const onBoard = o => o.paid && (settings.acceptTestOrders || !o.testMode);

function persist(id) {
  const o = orders.get(id);
  if (o && stages[id]) store.saveTicket(o, stages[id]);
}

// The register adds "Validated customer <name>" (or "... Name Unknown") to the order note.
// Pull that line out so it doesn't show as a flashing note, and use the name when it's known.
function splitNote(raw) {
  let validatedName = '';
  const note = String(raw || '').split(/\r?\n/).filter(line => {
    const m = line.match(/^\s*validated customer\b:?\s*(.*?)\s*$/i);
    if (!m) return true;
    if (!/^(name\s+)?unknown$/i.test(m[1])) validatedName = m[1];
    return false;
  }).join('\n').trim();
  return { note, validatedName };
}

function remove(id) {
  orders.delete(id);
  delete stages[id];
  store.markDeleted(id);
}

function setStage(id, stage, save = true) {
  const prev = stages[id] || {};
  const back = STAGES.indexOf(stage) < STAGES.indexOf(prev.stage);
  const o = orders.get(id);
  // reaching Ready greys every item; moving back un-greys them so they can be tapped again
  const done = stage === 'ready' && o ? o.items.map(i => i.key) : back ? [] : prev.done || [];
  stages[id] = { ...prev, stage, at: Date.now(), done, v: Date.now() };
  if (save) persist(id);
}

// A name typed on the kitchen screen; an empty name goes back to the one from Clover.
function setName(id, name) {
  const o = orders.get(id);
  const s = stages[id] || (stages[id] = { stage: 'new', at: o.queuedAt, done: [] });
  if (name) s.name = name; else delete s.name;
  s.v = Date.now();
  persist(id);
}

// Tap an item to grey it out. The first tap starts a new ticket; greying the last item makes it Ready.
// Tapping an item on a Ready ticket sends it back to In progress with just that item un-greyed.
function setItemDone(id, key, done) {
  const o = orders.get(id);
  const s = stages[id] || (stages[id] = { stage: 'new', at: o.queuedAt, done: [] });
  if (!done && isFinished(s.stage)) {
    stages[id] = { ...s, stage: 'cooking', at: Date.now(), done: o.items.map(i => i.key).filter(k => k !== key), v: Date.now() };
    return persist(id);
  }
  const set = new Set(s.done || []);
  done ? set.add(key) : set.delete(key);
  s.done = [...set];
  if (done && s.stage === 'new') setStage(id, 'cooking', false);
  if (o.items.every(i => set.has(i.key)) && (s.stage === 'new' || s.stage === 'cooking')) setStage(id, 'ready', false);
  stages[id].v = Date.now();
  persist(id);
}

const isFinished = stage => stage === 'ready' || stage === 'done';

function withStage(o) {
  const s = stages[o.id] || { stage: 'new', at: o.queuedAt };
  const done = new Set(s.done || []);
  return {
    ...o, stage: s.stage, stageAt: s.at, customer: s.name || o.customer, nameEdited: !!s.name,
    items: o.items.map(i => ({ ...i, done: done.has(i.key) })),
  };
}

// The orders list only returns customer ids, so names are looked up once per customer and cached.
const customerNames = new Map(); // customer id -> name (or a pending Promise)
function customerName(o) {
  const c = ((o.customers && o.customers.elements) || [])[0];
  if (!c) return '';
  if (c.firstName || c.lastName) return [c.firstName, c.lastName].filter(Boolean).join(' ');
  const known = customerNames.get(c.id);
  if (typeof known === 'string') return known;
  if (!known && !CFG.demo) { customerNames.set(c.id, null); customerQueue.push(c.id); }
  return '';
}

// Look names up one at a time so a full day of orders doesn't hit Clover's rate limit.
const customerQueue = [];
setInterval(async function lookupNext() {
  if (lookupNext.busy || !customerQueue.length || Date.now() < (lookupNext.pauseUntil || 0)) return;
  lookupNext.busy = true;
  const id = customerQueue.shift();
  try {
    const c = await clover(`/v3/merchants/${CFG.merchantId}/customers/${id}`);
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
    customerNames.set(id, name);
    for (const o of orders.values()) if (o.customerId === id) { o.customer = name || o.validatedName; persist(o.id); }
    if (customerQueue.length % 20 === 0) broadcast(); // refresh screens every 20 names and at the end
  } catch (e) {
    if (/429/.test(e.message)) { customerQueue.unshift(id); lookupNext.pauseUntil = Date.now() + 3000; } // back off, then retry
    else { customerNames.delete(id); console.error('[customer]', id, e.message); } // retry on a later poll
  }
  lookupNext.busy = false;
}, 300);

function normalizeOrderType(label) {
  const value = String(label || '').trim();
  if (/\bto\s+go\b/i.test(value)) return 'To Go';
  if (/\bdine\s+in\b/i.test(value) || /\bhere\b/i.test(value)) return 'For Here';
  return value;
}

// Food vs drink: the Munchies and Something Sweet categories are food, every other category is a drink.
// Items with no category (custom items, demo mode) are guessed from the name.
const FOOD_CATEGORY_RE = /munchies|something sweet/i;
const DRINK_NAME_RE = /latte|cappuccino|americano|espresso|doppio|macchiato|cortado|flat white|mocha|coffee|cold brew|drip|\btea\b|chai|matcha|chocolate|cocoa|london fog|mocktail|spritz|lemonade|juice|smoothie|shake|soda|water|\bipa\b|\bale\b|beer|wine|\d+\s?oz\b/i;
// Hot vs iced comes from the shop's Hot / Iced modifiers (or the name); otherwise the side bar is grey.
function classify(li, mods) {
  const cats = ((li.item && li.item.categories && li.item.categories.elements) || []).map(c => c.name || '');
  const kind = cats.length ? (cats.some(c => FOOD_CATEGORY_RE.test(c)) ? 'food' : 'drink')
    : DRINK_NAME_RE.test(li.name || '') ? 'drink' : 'food';
  const all = [li.name, ...mods, li.note].join(' ');
  let temp = '';
  if (kind === 'drink') {
    if (/pour[\s-]?over|\bdrip\b/i.test(li.name || '')) temp = 'hot'; // pour overs and drip coffee are always hot
    else if (/\biced?\b|cold brew|light ice|over ice|on ice/i.test(all)) temp = 'iced';
    else if (/\bhot\b/i.test(all)) temp = 'hot';
  }
  return { kind, temp };
}

// Today's tickets on the board. Ready tickets stay all day; at midnight the board starts fresh.
function boardTickets() {
  closePreviousDays();
  const list = [];
  for (const o of orders.values()) if (onBoard(o)) list.push(withStage(o));
  return list.sort((a, b) => a.queuedAt - b.queuedAt);
}

// When a day ends, its unfinished tickets are marked Ready as of midnight (saved that way) and leave the board.
// Returns true if any tickets were removed.
function closePreviousDays() {
  const today = startOfToday();
  let removed = false;
  for (const o of orders.values()) {
    if (o.createdTime >= today) continue;
    const s = stages[o.id];
    if (s && !isFinished(s.stage)) {
      stages[o.id] = { ...s, stage: 'ready', at: endOfDay(o.createdTime), done: o.items.map(i => i.key), auto: true, v: Date.now() };
      persist(o.id);
    }
    orders.delete(o.id);
    delete stages[o.id];
    removed = true;
  }
  return removed;
}

function snapshot() {
  return {
    version,
    orders: boardTickets(),
    settings,
    demo: CFG.demo,
    lastSync: CFG.demo ? Date.now() : lastPoll,
    error: lastError || store.status(),
    serverTime: Date.now(),
  };
}

// ---------- live push (Server-Sent Events) ----------
// Every change goes to every screen at once, numbered. A once-a-second heartbeat carries the latest number,
// so a screen that missed an update (or whose connection quietly died) notices within a couple of seconds.
let version = 0;
function broadcast() {
  version++;
  const data = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const res of clients) res.write(data);
}
setInterval(() => {
  const ping = `event: ping\ndata: ${version}\n\n`;
  for (const res of clients) res.write(ping);
}, 1000);

// Another server sharing the database (a second copy, or two overlapping during a deploy) may have changed
// tickets. Check every second and take any newer kitchen change, so all screens agree within ~2 seconds.
async function syncFromStore() {
  if (syncFromStore.busy) return;
  syncFromStore.busy = true;
  try {
    const got = await store.changes(startOfToday());
    if (!got) return;
    let changed = false;
    for (const { order, stage } of got.tickets) {
      if (stage.stage === 'deleted') {
        if (orders.delete(order.id)) { delete stages[order.id]; changed = true; }
        continue;
      }
      if (!orders.has(order.id)) { orders.set(order.id, order); changed = true; }
      const local = stages[order.id];
      if (!local || stage.v > (local.v || 0)) { stages[order.id] = stage; changed = true; }
    }
    for (const [name, value] of Object.entries(got.settings)) {
      if (settings[name] !== value) { settings = { ...settings, [name]: value }; changed = true; }
    }
    if (changed) broadcast();
  } catch (e) {
    console.error('[sync]', e.message);
  } finally {
    syncFromStore.busy = false;
  }
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // ask hosting proxies not to hold events back
      });
      req.socket.setNoDelay(true);
      res.write('retry: 1000\n');
      res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tickets') {
      return send(res, 200, { orders: boardTickets().reverse() });
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const { acceptTestOrders } = JSON.parse((await readBody(req)) || '{}');
      if (typeof acceptTestOrders !== 'boolean') return send(res, 400, { error: 'acceptTestOrders must be true or false' });
      settings = { ...settings, acceptTestOrders };
      await store.saveSetting('acceptTestOrders', acceptTestOrders)
        .catch(e => console.error('[settings] not saved:', e.message)); // still applies until restart
      broadcast();
      return send(res, 200, { ok: true, settings });
    }

    if (req.method === 'POST' && /^\/api\/orders\/[^/]+\/name$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const { name } = JSON.parse((await readBody(req)) || '{}');
      if (!orders.has(id) || typeof name !== 'string') return send(res, 400, { error: 'bad order or name' });
      setName(id, name.trim().slice(0, 60));
      broadcast();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && /^\/api\/orders\/[^/]+\/items$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const { key, done } = JSON.parse((await readBody(req)) || '{}');
      const o = orders.get(id);
      if (!o || !o.items.some(i => i.key === key)) return send(res, 400, { error: 'bad order or item' });
      setItemDone(id, key, !!done);
      broadcast();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/orders/')) {
      const id = decodeURIComponent(url.pathname.split('/')[3] || '');
      const body = await readBody(req);
      const { stage } = JSON.parse(body || '{}');
      if (!orders.has(id) || !STAGES.includes(stage)) return send(res, 400, { error: 'bad order or stage' });
      setStage(id, stage);
      broadcast();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/webhook') {
      const body = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch {}
      if (payload.verificationCode) {
        console.log('\n=== Clover webhook verification code: ' + payload.verificationCode + ' ===\n' +
          'Paste it into Clover Developer Dashboard → App Settings → Webhooks, then click Verify.\n');
        return send(res, 200, { ok: true });
      }
      if (CFG.webhookAuth) {
        const got = req.headers['x-clover-auth'] || '';
        if (!safeEqual(got, CFG.webhookAuth)) return send(res, 401, { error: 'bad X-Clover-Auth' });
      }
      const events = (payload.merchants && payload.merchants[CFG.merchantId]) || [];
      for (const ev of events) {
        const [key, objId] = String(ev.objectId || '').split(':');
        if (key !== 'O' || !objId) continue;
        if (ev.type === 'DELETE') { remove(objId); broadcast(); }
        else fetchOrder(objId);
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, snapshot());

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

// ---------- demo mode (no Clover token) ----------
const DEMO_MENU = [
  ['Cheeseburger', ['No onion', 'Add bacon', 'Medium']], ['Chicken sandwich', ['Spicy']],
  ['Fries', ['Large']], ['Caesar salad', ['Dressing on side']], ['Fish tacos', []],
  ['Milkshake', ['Chocolate']], ['Onion rings', []], ['Veggie wrap', ['No cheese']], ['Iced tea', []],
  ['Caffe Latte', ['Oat milk', 'Iced', 'Extra shot']], ['Cappuccino', ['Almond milk']], ['Americano', ['Hot']],
  ['Flat White', ['Whole milk']], ['Matcha Latte', ['Soy milk', 'Iced']], ['Croissant', []], ['(R) Caffe Latte', []],
];
const DEMO_NAMES = [['Maya', 'Johnson'], ['Carlos', 'Rivera'], ['Priya', 'Patel'], ['James', "O'Brien"], ['Aiko', 'Tanaka']];
function demoOrder() {
  const n = 1 + Math.floor(Math.random() * 4);
  const lineItems = [];
  for (let i = 0; i < n; i++) {
    const [name, mods] = DEMO_MENU[Math.floor(Math.random() * DEMO_MENU.length)];
    const pick = mods.filter(() => Math.random() < 0.4).map(m => ({ name: m }));
    const copies = Math.random() < 0.25 ? 2 : 1;
    const note = DRINK_NAME_RE.test(name) && Math.random() < 0.2 ? 'Light ice' : '';
    for (let c = 0; c < copies; c++) lineItems.push({ name, note, modifications: { elements: pick } });
  }
  demoOrder.count = (demoOrder.count || 100) + 1;
  const [firstName, lastName] = DEMO_NAMES[demoOrder.count % DEMO_NAMES.length];
  upsert({
    id: 'DEMO' + crypto.randomBytes(5).toString('hex').toUpperCase(),
    title: String(demoOrder.count),
    createdTime: Date.now(), modifiedTime: Date.now(), state: 'open',
    orderType: { label: ['Dine In', 'To Go', 'Delivery'][Math.floor(Math.random() * 3)] },
    note: Math.random() < 0.15 ? 'Allergy: peanuts' : '',
    lineItems: { elements: lineItems },
    customers: { elements: [{ firstName, lastName }] },
  });
  broadcast();
}

// ---------- helpers ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function retry(fn, tries, waitMs) {
  for (let n = 1; ; n++) {
    try { return await fn(); } catch (e) {
      if (n >= tries) throw e;
      console.warn(`[db] attempt ${n} failed (${e.message}); retrying in ${waitMs / 1000}s`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function endOfDay(ms) { const d = new Date(ms); d.setHours(24, 0, 0, 0); return d.getTime(); } // the following midnight
function loadDotEnv(f) {
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- start ----------
async function start() {
  // restore today's tickets (Ready ones included) before the first Clover check;
  // a database that's briefly unreachable gets three tries before the board starts without it
  try {
    const saved = await retry(() => store.init(startOfToday()), 3, 5000);
    for (const { order, stage } of saved.tickets) { orders.set(order.id, order); stages[order.id] = stage; }
    Object.assign(stages, saved.stages || {});
    settings = { ...settings, ...saved.settings };
    console.log(store.kind === 'mysql'
      ? `Database connected — restored ${saved.tickets.length} of today's tickets`
      : `Saving ticket stages to ${DATA_DIR} (set DATABASE_URL to keep full ticket history in MySQL)`);
  } catch (e) {
    lastError = 'Database unavailable — tickets won’t be saved: ' + e.message;
    console.error('[db] could not connect:', e.message);
  }
  await closeOldInStore();
  server.listen(CFG.port, onListen);
}

// Tickets from earlier days the server never saw finish (it was off at midnight): mark them Ready in the database.
let oldClosed = false;
async function closeOldInStore() {
  if (oldClosed) return;
  try {
    const n = await store.closeOpenBefore(startOfToday(), endOfDay);
    if (n) console.log(`Marked ${n} unfinished ticket(s) from earlier days as Ready`);
    oldClosed = true;
  } catch (e) {
    console.error('[db] could not close earlier days yet:', e.message); // tried again every minute
  }
}

function onListen() {
  console.log(`Clover kitchen display → http://localhost:${CFG.port}`);
  if (CFG.demo) {
    console.log('DEMO MODE: no CLOVER_API_TOKEN set — generating sample orders.');
    for (let i = 0; i < 5; i++) demoOrder();
    setInterval(demoOrder, 20_000);
  } else {
    if (!CFG.merchantId || /PASTE/i.test(CFG.merchantId)) {
      console.error('Open the .env file and set CLOVER_MERCHANT_ID to your 13-character Clover merchant ID.');
      process.exit(1);
    }
    console.log(`Polling Clover (${API_BASE}) every ${CFG.pollSeconds}s for merchant ${CFG.merchantId}`);
    pollOrders();
    setInterval(pollOrders, CFG.pollSeconds * 1000);
  }
  setInterval(broadcast, 30_000); // keep screens in step even when nothing changed
  setInterval(() => { if (closePreviousDays()) broadcast(); closeOldInStore(); }, 60_000); // clear the board soon after midnight
  setInterval(syncFromStore, 1000);
}

start();
