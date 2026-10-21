// Creates 5 sample Clover orders, each linked to a named Clover Customer.
// Uses CLOVER_MERCHANT_ID / CLOVER_API_TOKEN / CLOVER_REGION from .env.
// The token needs Orders: Write and Customers: Write.  Run:  node scripts/create-named-orders.js
// Options:  --stagger <seconds>  wait between orders     --start <n>  first ticket number (default 201)
'use strict';

const fs = require('fs');
const path = require('path');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const MID = process.env.CLOVER_MERCHANT_ID;
const TOKEN = process.env.CLOVER_API_TOKEN;
const BASE = {
  us: 'https://api.clover.com', ca: 'https://api.clover.com', eu: 'https://api.eu.clover.com',
  la: 'https://api.la.clover.com', sandbox: 'https://apisandbox.dev.clover.com',
}[(process.env.CLOVER_REGION || 'us').toLowerCase()] + `/v3/merchants/${MID}`;

const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
const STAGGER_MS = arg('--stagger', 0) * 1000;
const START = arg('--start', 201);

// Names rotate with the ticket number, so a second batch gets different people.
const NAMES = [
  ['Maya', 'Johnson'], ['Carlos', 'Rivera'], ['Priya', 'Patel'], ['James', "O'Brien"], ['Aiko', 'Tanaka'],
  ['Fatima', 'Okafor'], ['Liam', 'Nguyen'], ['Sofia', 'Rossi'], ['Daniel', 'Kim'], ['Grace', 'Mensah'],
];
// Item ids are from this merchant's inventory.
const ORDERS = [
  { type: 'to go', items: [['S2ZQ9EGEV0DWP', 'Oat milk'], ['C8K6D7Z7SZGRW']] },
  { type: 'here', items: [['T76CXA4K729Z6'], ['NPF90W40W2CSJ', 'Add egg']] },
  { type: 'to go', items: [['TZ67RPJ5BJQH2'], ['M7CYK2G04GK4G']], note: 'Allergy: gluten' },
  { type: 'here', items: [['ZNCKE9K7NG6FR'], ['ZZ0NCA26KRAJ0'], ['MDE8XN8X4TNKW']] },
  { type: 'to go', items: [['WFP8HKAT9HR2P', 'Extra hot'], ['PSEZAB19D175C'], ['998BZ7WWQXPG4']] },
];

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

(async () => {
  const types = (await api('GET', '/order_types')).elements;
  const typeId = word => (types.find(t => t.label.toLowerCase().includes(word)) || {}).id;

  for (const [i, o] of ORDERS.entries()) {
    if (i && STAGGER_MS) await new Promise(r => setTimeout(r, STAGGER_MS));
    const number = START + i;
    const [first, last] = NAMES[(number - 201 + NAMES.length) % NAMES.length];
    // 1. the person, as a Clover Customer record
    const customer = await api('POST', '/customers', { firstName: first, lastName: last });
    // 2. an open order, then link the customer (Clover ignores `customers` on create, so it's a separate update)
    const order = await api('POST', '/orders', {
      state: 'open',
      title: String(number),
      note: o.note || '',
      ...(typeId(o.type) && { orderType: { id: typeId(o.type) } }),
    });
    await api('POST', `/orders/${order.id}`, { customers: [{ id: customer.id }] });
    // 3. the line items
    for (const [itemId, note] of o.items) {
      await api('POST', `/orders/${order.id}/line_items`, { item: { id: itemId }, ...(note && { note }) });
    }
    console.log(`${new Date().toLocaleTimeString()}  #${order.title}  ${first} ${last}  order ${order.id}  customer ${customer.id}`);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
