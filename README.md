# Clover Kitchen Display

A live order queue for a Clover POS. Every order rung up on Clover appears on the screen within a few seconds, with a chime, and staff tap tickets through **New → In progress → Ready → Complete**.

- Items grouped with quantities, modifiers and item/order notes (allergy notes highlighted)
- Order number, customer name, order type (Dine In / To Go…), server, and a running timer per ticket — amber at 8 min, red at 15
- Back button and **Recall** to undo a mis-tap
- Works on any browser: a wall TV, a tablet, or several screens at once (they stay in sync)
- No database or runtime dependencies — Node.js 18 or newer

## 1. Try it with sample orders

```bash
npm install
npm start
```

Open http://localhost:3000. With no Clover token set, it makes a sample order every 20 seconds.

## 2. Connect your Clover account

1. In the Clover web dashboard go to **Account & Setup → Business Operations → API Tokens**, create a token with **Orders: Read** (plus **Employees: Read** for server names, **Customers: Read** for customer names, and **Inventory: Read** so items are split into food and drinks by category).
2. Find your **Merchant ID** under **Account & Setup → Merchants** (it's also in the dashboard URL).
3. Copy `.env.example` to `.env` and fill in `CLOVER_MERCHANT_ID` and `CLOVER_API_TOKEN` (set `CLOVER_REGION` if you're not in the US/Canada).
4. Run `npm start` again. The header says **Live** and today's open orders load.

The app checks Clover every 5 seconds for orders created or changed since the last check, so new tickets and edits (items added, voids) show up automatically. Keep the token private — it can read your sales data. Don't put the `.env` file anywhere public.

## 3. Put it on the kitchen screen

Run the server on any always-on computer at the restaurant (a mini PC, a Raspberry Pi, the back-office PC), then open `http://<that-computer's-IP>:3000` on the kitchen screen and press ⛶ for full screen. Tap 🔔 once so the browser allows the chime.

To keep it running after reboots, use a process manager, e.g. `npx pm2 start server.js --name kds && npx pm2 save`.

### Or host it in the cloud (Railway)

The display needs an always-on server: it checks Clover every few seconds and keeps a live connection open to each screen. **Serverless hosts such as Vercel or Netlify don't work** — they freeze the app between requests, so it never pulls orders. Railway (or Render / Fly.io) runs it as-is:

1. Push this repo to GitHub (the `.env` file stays out of it — `.gitignore` covers that).
2. At [railway.com](https://railway.com) create a project → **Deploy from GitHub repo** → pick this repo. It detects Node and runs `npm start`.
3. In the service's **Variables**, add `CLOVER_MERCHANT_ID`, `CLOVER_API_TOKEN`, `CLOVER_REGION`, `TIMEZONE` (e.g. `America/New_York`) and `DATA_DIR=/data`. Railway sets `PORT` itself.
4. Right-click the service → **Attach volume**, mount path `/data`, so ticket stages survive redeploys.
5. **Settings → Networking → Generate Domain**, then open that address on the kitchen screen. The header should say **Live** and today's orders load within a few seconds; `/health` shows the last sync time.

Run only one copy of the server per Clover token — two copies share Clover's rate limit and can trip "429" errors.

## Optional: instant updates with webhooks

Polling is plenty fast for most kitchens. If you want near-instant updates, Clover can push events — but this requires a Clover developer app and a public HTTPS address for this server (Clover won't call `localhost`):

1. Create an app at the Clover Developer Dashboard and install it on your merchant account with Orders: Read.
2. Expose this server over HTTPS (e.g. a Cloudflare Tunnel or ngrok) and set the webhook URL to `https://your-address/webhook`.
3. Click **Send Verification Code** — the code prints in this server's console; paste it back and click **Verify**.
4. Subscribe to **Orders**, copy the **Clover Auth Code** into `CLOVER_WEBHOOK_AUTH` in `.env`, and restart.

Polling keeps running as a safety net, so nothing is lost if a webhook is missed.

## Notes

- Kitchen stages (New / In progress / Ready) live in this app, not in Clover, and are saved to `data/stages.json` so a restart doesn't lose them.
- Orders with no items yet don't appear until something is added. Deleted orders disappear.
- Tweak the timer thresholds at the top of the script in `public/index.html` (`WARN_MIN`, `LATE_MIN`).
