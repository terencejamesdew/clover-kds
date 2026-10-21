// Clover Kitchen Display — live order queue for Clover POS.
// Zero dependencies: needs Node.js 18+ only.  Run:  node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  hideDoneMinutes: Number(process.env.HIDE_DONE_MINUTES || 10),
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
// orders: id -> normalized order;  stages: id -> {stage, at}
const STAGES = ['new', 'cooking', 'ready', 'done'];
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'); // point at a persistent volume when hosted
const STATUS_FILE = path.join(DATA_DIR, 'stages.json');
const orders = new Map();
let stages = readJson(STATUS_FILE, {});
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
let EXPAND = 'expand=lineItems,lineItems.modifications,lineItems.item.categories,orderType,employee,customers';
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
  let offset = 0;
  try {
    for (;;) {
      const page = await cloverOrders(() => `/v3/merchants/${CFG.merchantId}/orders?filter=modifiedTime>=${since}` +
        `&${EXPAND}&orderBy=modifiedTime%20ASC&limit=100&offset=${offset}`);
      const els = page.elements || [];
      els.forEach(upsert);
      if (els.length < 100) break;
      offset += 100;
    }
    lastPoll = startedAt;
    lastError = null;
  } catch (e) {
    lastError = e.message;
    console.error('[poll]', e.message);
  }
  broadcast();
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
function upsert(o) {
  if (!o || !o.id) return;
  if (o.deleted) return remove(o.id);
  // only today's orders (the modifiedTime poll also returns older orders that were edited today)
  if ((o.createdTime || Date.now()) < startOfToday()) return orders.delete(o.id);
  const items = (o.lineItems && o.lineItems.elements) || [];
  const grouped = new Map();
  for (const li of items) {
    if (li.refunded || li.exchanged) continue;
    if (/^\s*\(R\)/i.test(li.name || '')) continue; // "(R)" items are reprints
    const mods = ((li.modifications && li.modifications.elements) || []).map(m => m.name).filter(Boolean);
    const qty = li.unitQty && li.unitQty !== 1000 ? li.unitQty / 1000 : 1; // unitQty is in thousandths
    const note = (li.note || '').trim();
    const key = [li.name, mods.join('|'), note].join('§');
    const g = grouped.get(key) || { key, name: li.name || 'Item', mods, note, qty: 0, ...classify(li, mods) };
    g.qty += qty;
    grouped.set(key, g);
  }
  if (!grouped.size) return; // empty tickets aren't kitchen-relevant yet
  const { note, validatedName } = splitNote(o.note);
  orders.set(o.id, {
    id: o.id,
    number: o.title || o.id.slice(-4),
    createdTime: o.createdTime || Date.now(),
    modifiedTime: o.modifiedTime || Date.now(),
    state: o.state || 'open',
    paymentState: o.paymentState || '',
    orderType: normalizeOrderType(o.orderType && o.orderType.label),
    employee: (o.employee && o.employee.name) || '',
    customerId: (((o.customers && o.customers.elements) || [])[0] || {}).id || '',
    customer: customerName(o) || validatedName,
    validatedName,
    note,
    total: typeof o.total === 'number' ? o.total : null,
    items: [...grouped.values()],
  });
  if (!stages[o.id]) setStage(o.id, 'new', false);
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
  saveStages();
}

function setStage(id, stage, persist = true) {
  const prev = stages[id] || {};
  // moving a ticket back un-greys its items so they can be tapped again
  const back = STAGES.indexOf(stage) < STAGES.indexOf(prev.stage);
  const o = orders.get(id);
  // reaching Ready greys every item; moving back un-greys them so they can be tapped again
  const done = stage === 'ready' && o ? o.items.map(i => i.key) : back ? [] : prev.done || [];
  stages[id] = { stage, at: Date.now(), done };
  if (persist) saveStages();
}

// Tap an item to grey it out. The first tap starts a new ticket; greying the last item makes it Ready.
// Tapping an item on a Ready ticket sends it back to In progress with just that item un-greyed.
function setItemDone(id, key, done) {
  const o = orders.get(id);
  const s = stages[id] || (stages[id] = { stage: 'new', at: o.createdTime, done: [] });
  if (!done && isFinished(s.stage)) {
    stages[id] = { stage: 'cooking', at: Date.now(), done: o.items.map(i => i.key).filter(k => k !== key) };
    return saveStages();
  }
  const set = new Set(s.done || []);
  done ? set.add(key) : set.delete(key);
  s.done = [...set];
  if (done && s.stage === 'new') setStage(id, 'cooking', false);
  if (o.items.every(i => set.has(i.key)) && (s.stage === 'new' || s.stage === 'cooking')) setStage(id, 'ready', false);
  saveStages();
}

const isFinished = stage => stage === 'ready' || stage === 'done';

function withStage(o) {
  const s = stages[o.id] || { stage: 'new', at: o.createdTime };
  const done = new Set(s.done || []);
  return { ...o, stage: s.stage, stageAt: s.at, items: o.items.map(i => ({ ...i, done: done.has(i.key) })) };
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
    for (const o of orders.values()) if (o.customerId === id) o.customer = name || o.validatedName;
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

function snapshot() {
  const cutoff = Date.now() - CFG.hideDoneMinutes * 60_000;
  const list = [];
  const today = startOfToday();
  for (const o of orders.values()) {
    if (o.createdTime < today) { orders.delete(o.id); continue; } // drop yesterday's tickets after midnight
    const t = withStage(o);
    if (isFinished(t.stage) && t.stageAt < cutoff) continue; // still findable under All tickets
    list.push(t);
  }
  list.sort((a, b) => a.createdTime - b.createdTime);
  return {
    orders: list,
    demo: CFG.demo,
    lastSync: CFG.demo ? Date.now() : lastPoll,
    error: lastError,
    serverTime: Date.now(),
  };
}

// ---------- live push (Server-Sent Events) ----------
function broadcast() {
  const data = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const res of clients) res.write(data);
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n');
      res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tickets') {
      const today = startOfToday();
      const list = [...orders.values()].filter(o => o.createdTime >= today).map(withStage);
      list.sort((a, b) => b.createdTime - a.createdTime);
      return send(res, 200, { orders: list });
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
    id: crypto.randomBytes(7).toString('hex').toUpperCase(),
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
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function saveStages() {
  // keep only the last 2 days of stage data
  const keepAfter = Date.now() - 2 * 86_400_000;
  for (const [id, s] of Object.entries(stages)) if (s.at < keepAfter) delete stages[id];
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(stages));
  } catch (e) {
    console.error('[stages] could not save — set DATA_DIR to a writable folder:', e.message); // board keeps working from memory
  }
}
function loadDotEnv(f) {
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- start ----------
server.listen(CFG.port, () => {
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
  setInterval(broadcast, 30_000); // refresh hidden/aged tickets
});
