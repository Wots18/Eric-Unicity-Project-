/**
 * Sphere AutoVend — autonomous on-network vending agent (Unicity v2 testnet).
 * Settlement: on "buy", record a pending order + send a payment request. When a
 * payment ARRIVES (transfer:incoming event or receive()), match the SENDER to their
 * pending order and deliver. The agent publishes its transport binding at boot so it
 * can receive.
 *
 * Web storefront: GET / serves shop.html. POST /order creates a web order.
 * GET /order/:id polls delivery. GET /inventory returns item list.
 */

import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Sphere, getCoinIdBySymbol, randomHex } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const CONFIG = {
  network: process.env.NETWORK || 'testnet',
  mnemonic: (process.env.WALLET_MNEMONIC || '').trim(),
  nametag: (process.env.NAMETAG || 'autovend').toLowerCase(),
  apiKey: process.env.UNICITY_API_KEY || 'sk_ddc3cfcc001e4a28ac3fad7407f99590',
  coinSymbol: (process.env.COIN_SYMBOL || 'UCT').toUpperCase(),
  decimals: Number(process.env.COIN_DECIMALS || 6),
  mintAmount: process.env.MINT_AMOUNT || '1000',
  orderTtlMs: Number(process.env.PAYMENT_TIMEOUT_MS || 600000),
  pollMs: Number(process.env.POLL_INTERVAL_MS || 8000),
  dataDir: process.env.DATA_DIR || './data/wallet',
  tokensDir: process.env.TOKENS_DIR || './data/tokens',
  salesFile: process.env.SALES_FILE || './data/sales.json',
  appUrl: (process.env.APP_URL || 'https://eric-unicity-project-production.up.railway.app').replace(/\/$/, ''),
};

const INVENTORY = [
  { id: 'code', name: 'One-time access code', price: '1', stock: 50,
    deliver: () => `ACCESS-${randomHex(4).toUpperCase()}-${randomHex(4).toUpperCase()}` },
  { id: 'luck', name: 'Lucky number draw (1-100)', price: '0.5', stock: 100,
    deliver: () => `Your lucky number is ${1 + Math.floor(Math.random() * 100)}. Good fortune on-chain.` },
  { id: 'badge', name: 'AutoVend supporter badge (collectible note)', price: '2', stock: 25,
    deliver: () => `BADGE #${1000 + Math.floor(Math.random() * 9000)} — verified AutoVend supporter.` },
];

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const findItem = (id) => INVENTORY.find((i) => i.id === (id || '').toLowerCase());

function uctToBase(human) {
  const [i, f = ''] = String(human).split('.');
  const frac = (f + '0'.repeat(CONFIG.decimals)).slice(0, CONFIG.decimals);
  return BigInt(i || '0') * (10n ** BigInt(CONFIG.decimals)) + BigInt(frac || '0');
}

function buildMenu() {
  const lines = INVENTORY.map((i) => `  - ${i.id}: ${i.name} — ${i.price} ${CONFIG.coinSymbol}` + (i.stock <= 0 ? ' (SOLD OUT)' : ''));
  return [`AutoVend menu (DM me "buy <id>"):`, ...lines, `Type "menu" to see this again.`].join('\n');
}

function replyTarget(msg) {
  if (msg.senderNametag) return `@${String(msg.senderNametag).replace(/^@/, '')}`;
  return msg.senderPubkey;
}
function normId(x) { return x ? String(x).replace(/^@/, '').toLowerCase() : x; }

async function recordSale(sale) {
  try {
    let sales = [];
    try { sales = JSON.parse(await fs.readFile(CONFIG.salesFile, 'utf8')); } catch {}
    sales.push(sale);
    await fs.mkdir(path.dirname(CONFIG.salesFile), { recursive: true });
    await fs.writeFile(CONFIG.salesFile, JSON.stringify(sales, null, 2));
  } catch (e) { log('Could not persist sale (non-fatal):', e.message); }
}

async function ensureTreasury(sphere) {
  try {
    const assets = await Promise.resolve(sphere.payments.getBalance ? sphere.payments.getBalance() : sphere.payments.getAssets());
    const a = (assets || []).find((x) => (x.symbol || '').toUpperCase() === CONFIG.coinSymbol);
    if (a && a.totalAmount && BigInt(a.totalAmount) > 0n) { log(`Treasury OK for ${CONFIG.coinSymbol}.`); return; }
  } catch (e) { log('Balance check failed (will try to mint):', e.message); }
  log(`Treasury empty — self-minting ${CONFIG.mintAmount} ${CONFIG.coinSymbol}...`);
  try {
    const coinId = getCoinIdBySymbol(CONFIG.coinSymbol);
    if (!coinId) { log(`Could not resolve coin id for ${CONFIG.coinSymbol}; skipping mint.`); return; }
    const res = await sphere.payments.mintFungibleToken(coinId, uctToBase(CONFIG.mintAmount));
    if (res && res.success !== false) log('Mint succeeded. Treasury funded.');
    else log('Mint returned an error result:', res && res.error);
  } catch (e) { log('Mint failed (non-fatal):', e.message); }
}

async function advertiseToMarket(sphere) {
  const summary = `AutoVend storefront: DM @${STATUS.nametag} "buy <id>" — ` +
    INVENTORY.map((i) => `${i.id}@${i.price}${CONFIG.coinSymbol}`).join(', ');
  try {
    const m = sphere.market;
    if (!m) { log('Market module not present; relying on DM discovery.'); return; }
    const payload = { kind: 'offer', summary, items: INVENTORY.map(({ id, name, price }) => ({ id, name, price })) };
    if (typeof m.publishIntent === 'function') { await m.publishIntent(payload); log('Published offer intent to the market.'); }
    else if (typeof m.createIntent === 'function') { await m.createIntent(payload); log('Published offer intent to the market.'); }
    else if (typeof m.post === 'function') { await m.post(payload); log('Published offer intent to the market.'); }
    else log('Market intent API not detected; relying on DM discovery.');
  } catch (e) { log('Market advertise failed (non-fatal):', e.message); }
}

// ─── Order state ─────────────────────────────────────────────────────────────
const STATUS = {
  nametag: CONFIG.nametag,
  address: null,
  pubkey: null,
  live: false,
  salesCount: 0,
  startedAt: new Date().toISOString(),
};

const pendingOrders = [];
const orderMap = new Map(); // orderId → order, persists after delivery so frontend can poll
let SHOP_HTML = '';

function getStatusBody() {
  return {
    service: 'Sphere AutoVend',
    nametag: `@${STATUS.nametag}`,
    address: STATUS.address,
    live: STATUS.live,
    salesCompleted: STATUS.salesCount,
    startedAt: STATUS.startedAt,
    inventory: INVENTORY.map(({ id, name, price, stock }) => ({ id, name, price: `${price} ${CONFIG.coinSymbol}`, stock })),
    howToBuy: `Visit ${CONFIG.appUrl} and connect your Sphere wallet. Or DM @${STATUS.nametag} on Sphere: send "menu" then "buy <id>".`,
    shopUrl: CONFIG.appUrl,
  };
}

// ─── Core agent logic ─────────────────────────────────────────────────────────

async function safeDM(sphere, target, text) {
  try { await sphere.communications.sendDM(target, text); } catch (e) { log(`Failed to DM ${target}:`, e.message); }
}

async function deliverOrder(sphere, order, via) {
  if (order.delivered) return;
  order.delivered = true;
  const idx = pendingOrders.indexOf(order);
  if (idx >= 0) pendingOrders.splice(idx, 1);
  const good = order.item.deliver();
  order.delivery = good; // stored so frontend can poll /order/:id
  order.item.stock -= 1;
  STATUS.salesCount += 1;
  await safeDM(sphere, order.buyer,
    `Payment received! Here is your ${order.item.name}:\n\n${good}\n\nThanks for shopping at AutoVend! 🎉\nShop again: ${CONFIG.appUrl}`
  );
  await recordSale({ at: new Date().toISOString(), buyer: order.buyer, item: order.item.id, price: order.item.price, coin: CONFIG.coinSymbol, via, delivered: good });
  log(`SOLD ${order.item.id} to ${order.buyer} (${via}). Stock left: ${order.item.stock}`);
}

async function settleFromSender(sphere, sender, via) {
  const s = normId(sender);
  let order = pendingOrders.find((o) => !o.delivered && normId(o.buyer) === s);
  if (!order) {
    const open = pendingOrders.filter((o) => !o.delivered);
    if (open.length === 1) { order = open[0]; log(`No exact sender match; delivering the single open order (${via}).`); }
  }
  if (order) await deliverOrder(sphere, order, via);
  else log(`Payment arrived (${via}) from ${sender || 'unknown'} but no matching pending order.`);
}

function transferSender(t) {
  if (!t) return null;
  if (t.senderNametag) return `@${String(t.senderNametag).replace(/^@/, '')}`;
  return t.senderPubkey || t.sender || t.fromNametag || t.from || null;
}

let lastEmptyReceiveLog = 0;
async function processReceived(sphere, via) {
  let res;
  try { res = typeof sphere.payments.receive === 'function' ? await sphere.payments.receive() : null; }
  catch (e) { log('receive() error:', e.message); return; }
  if (!res) {
    // DIAGNOSTIC: log once a minute even when nothing came back, so we can
    // tell "receive() runs fine and returns empty" apart from "receive()
    // never gets called" in the logs.
    const now = Date.now();
    if (now - lastEmptyReceiveLog > 60000) { log(`receive() returned nothing (via ${via}).`); lastEmptyReceiveLog = now; }
    return;
  }
  let transfers = [];
  if (Array.isArray(res)) transfers = res;
  else if (Array.isArray(res.transfers)) transfers = res.transfers;
  else if (Array.isArray(res.received)) transfers = res.received;
  if (transfers.length === 0) {
    const now = Date.now();
    if (now - lastEmptyReceiveLog > 60000) { log(`receive() returned an empty list (via ${via}). Raw shape:`, JSON.stringify(res).slice(0, 200)); lastEmptyReceiveLog = now; }
    return;
  }
  for (const t of transfers) {
    log(`Pulled transfer from ${transferSender(t) || 'unknown'} (${(t.tokens && t.tokens.length) || '?'} token(s)). Raw:`, JSON.stringify(t).slice(0, 300));
    await settleFromSender(sphere, transferSender(t), via);
  }
}

async function handleOrder(sphere, msg, item) {
  const target = replyTarget(msg);
  if (item.stock <= 0) { await safeDM(sphere, target, `Sorry, "${item.id}" is sold out.`); return; }
  if (pendingOrders.find((o) => o.buyer === target && o.item.id === item.id && !o.delivered)) {
    await safeDM(sphere, target, `You already have a pending order for ${item.name}. Send exactly ${item.price} ${CONFIG.coinSymbol} to @${STATUS.nametag} to complete it.`);
    return;
  }
  const orderId = randomHex(8);
  const order = { id: orderId, buyer: target, item, createdAt: Date.now(), delivered: false, delivery: null };
  pendingOrders.push(order);
  orderMap.set(orderId, order);
  log(`Order from ${target}: ${item.id} (${item.price} ${CONFIG.coinSymbol}) [${orderId}] — awaiting payment.`);
  try {
    await sphere.payments.sendPaymentRequest(target, { amount: uctToBase(item.price).toString(), coinId: CONFIG.coinSymbol, message: `AutoVend: ${item.name}` });
  } catch (e) { log('payment request send (non-fatal):', e.message); }
  const mins = Math.round(CONFIG.orderTtlMs / 60000);
  const shopHost = CONFIG.appUrl.replace('https://', '');
  await safeDM(sphere, target,
    `Order received: ${item.name}.\n` +
    `Send exactly ${item.price} ${CONFIG.coinSymbol} to @${STATUS.nametag} ` +
    `(or approve the payment request in your wallet).\n\n` +
    `Track and pay via the shop:\nunicity-connect://${shopHost}?order=${orderId}\n\n` +
    `Delivery is automatic the moment payment arrives. (Expires in ${mins} min.)`
  );
}

function expireOldOrders(sphere) {
  const now = Date.now();
  for (let i = pendingOrders.length - 1; i >= 0; i--) {
    const o = pendingOrders[i];
    if (!o.delivered && now - o.createdAt > CONFIG.orderTtlMs) {
      pendingOrders.splice(i, 1);
      safeDM(sphere, o.buyer, `Your order for ${o.item.name} expired (no payment received). DM "buy ${o.item.id}" to try again.`);
      log(`Order expired for ${o.buyer}: ${o.item.id}`);
    }
  }
}

async function handleMessage(sphere, msg) {
  const senderTag = normId(msg.senderNametag || '');
  if ((senderTag && senderTag === STATUS.nametag) || (STATUS.pubkey && msg.senderPubkey === STATUS.pubkey)) return;
  const text = (msg.content || '').trim();
  const target = replyTarget(msg);
  log(`DM from ${target}: ${text}`);
  const lower = text.toLowerCase();
  if (['menu', 'help', 'hi', 'hello', ''].includes(lower)) { await safeDM(sphere, target, buildMenu()); return; }
  if (lower.startsWith('buy')) {
    const itemId = lower.split(/\s+/)[1];
    const item = findItem(itemId);
    if (!item) { await safeDM(sphere, target, `I don't sell "${itemId || '(nothing specified)'}".\n\n${buildMenu()}`); return; }
    await handleOrder(sphere, msg, item);
    return;
  }
  await safeDM(sphere, target, `I didn't understand that.\n\n${buildMenu()}`);
}

// ─── Identity publishing ──────────────────────────────────────────────────────

async function publishIdentity(sphere) {
  const steps = ['ensureUnicityIdInTransport', 'syncIdentityWithTransport'];
  for (const m of steps) {
    try {
      if (typeof sphere[m] === 'function') {
        const r = sphere[m]();
        const res = (r && typeof r.then === 'function') ? await r : r;
        log(`PUBLISH ${m}: ok`, res ? JSON.stringify(res).slice(0, 160) : '');
      } else {
        log(`PUBLISH ${m}: not present on this SDK build`);
      }
    } catch (e) { log(`PUBLISH ${m} failed (non-fatal):`, e.message); }
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

function startStatusServer() {
  const port = Number(process.env.PORT || 3000);

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = reqUrl.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj, null, 2));
    };

    const readBody = () => new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 1e5) reject(new Error('body too large')); });
      req.on('end', () => resolve(raw));
      req.on('error', reject);
    });

    // GET / → storefront HTML
    if (req.method === 'GET' && pathname === '/') {
      if (SHOP_HTML) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SHOP_HTML);
      } else {
        json(200, getStatusBody());
      }
      return;
    }

    // GET /status → JSON status
    if (req.method === 'GET' && pathname === '/status') {
      json(200, getStatusBody());
      return;
    }

    // GET /inventory → item list for frontend
    if (req.method === 'GET' && pathname === '/inventory') {
      json(200, INVENTORY.map(({ id, name, price, stock }) => ({
        id, name, price, priceDisplay: `${price} ${CONFIG.coinSymbol}`, stock, available: stock > 0,
      })));
      return;
    }

    // POST /order → web buyer creates an order
    if (req.method === 'POST' && pathname === '/order') {
      try {
        const body = JSON.parse(await readBody());
        const { itemId, buyerNametag } = body;
        const item = findItem(itemId);
        if (!item) { json(400, { error: 'Item not found' }); return; }
        if (item.stock <= 0) { json(400, { error: 'Sold out' }); return; }
        const target = `@${String(buyerNametag || '').replace(/^@/, '').toLowerCase()}`;
        if (!target || target === '@') { json(400, { error: 'buyerNametag required' }); return; }
        const existing = pendingOrders.find(o => o.buyer === target && o.item.id === item.id && !o.delivered);
        if (existing) {
          json(200, { orderId: existing.id, status: 'pending', amountBase: uctToBase(item.price).toString(), priceUct: item.price, recipient: `@${STATUS.nametag}`, coinId: CONFIG.coinSymbol });
          return;
        }
        const orderId = randomHex(8);
        const order = { id: orderId, buyer: target, item, createdAt: Date.now(), delivered: false, delivery: null };
        pendingOrders.push(order);
        orderMap.set(orderId, order);
        log(`[WEB] Order from ${target}: ${item.id} (${item.price} ${CONFIG.coinSymbol}) [${orderId}]`);
        json(200, { orderId, status: 'pending', amountBase: uctToBase(item.price).toString(), priceUct: item.price, recipient: `@${STATUS.nametag}`, coinId: CONFIG.coinSymbol });
      } catch (e) {
        json(400, { error: 'Bad request: ' + e.message });
      }
      return;
    }

    // GET /order/:id → delivery status
    if (req.method === 'GET' && pathname.startsWith('/order/')) {
      const orderId = pathname.split('/')[2] || '';
      const order = orderMap.get(orderId);
      if (!order) { json(404, { error: 'Order not found' }); return; }
      json(200, {
        orderId: order.id,
        status: order.delivered ? 'delivered' : 'pending',
        item: order.item.id,
        itemName: order.item.name,
        delivery: order.delivery || null,
        createdAt: order.createdAt,
      });
      return;
    }

    json(404, { error: 'Not found' });
  });

  server.on('error', (e) => log('Status server error (non-fatal):', e.message));
  server.listen(port, () => log(`Server live on port ${port}. Storefront: ${CONFIG.appUrl}`));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('Starting Sphere AutoVend...');
  log(`Network: ${CONFIG.network} | Nametag target: @${CONFIG.nametag} | Coin: ${CONFIG.coinSymbol}`);

  // Load shop HTML
  try {
    const shopPath = new URL('./shop.html', import.meta.url);
    SHOP_HTML = await fs.readFile(shopPath, 'utf8');
    log('Storefront HTML loaded OK.');
  } catch (e) {
    log('shop.html not found — serving JSON at /. Add src/shop.html to enable the storefront.');
  }

  const providers = createNodeProviders({
    network: CONFIG.network, dataDir: CONFIG.dataDir, tokensDir: CONFIG.tokensDir,
    oracle: { apiKey: CONFIG.apiKey },
  });
  const initOpts = { ...providers, network: CONFIG.network, autoGenerate: true };
  if (CONFIG.mnemonic) { initOpts.mnemonic = CONFIG.mnemonic; log('Restoring wallet from WALLET_MNEMONIC...'); }
  const { sphere, created, generatedMnemonic } = await Sphere.init(initOpts);
  if (CONFIG.mnemonic && created && typeof sphere.initializeIdentityFromMnemonic === 'function') {
    try { await sphere.initializeIdentityFromMnemonic(CONFIG.mnemonic); log('Identity restored via initializeIdentityFromMnemonic.'); }
    catch (e) { log('initializeIdentityFromMnemonic failed (non-fatal):', e.message); }
  }

  if (created && generatedMnemonic) {
    log('A NEW WALLET WAS CREATED. Back up this mnemonic:');
    log(`  ${generatedMnemonic}`);
  }

  log(`Identity address: ${sphere.identity?.directAddress}`);
  if (!sphere.identity?.nametag) {
    try {
      const free = await sphere.isNametagAvailable(CONFIG.nametag);
      if (free) { await sphere.registerNametag(CONFIG.nametag); log(`Registered @${CONFIG.nametag}`); }
      else log(`@${CONFIG.nametag} is taken by another wallet. Set a different NAMETAG.`);
    } catch (e) { log('Nametag registration issue (non-fatal):', e.message); }
  }
  STATUS.nametag = sphere.identity?.nametag || CONFIG.nametag;
  STATUS.address = sphere.identity?.directAddress || null;
  STATUS.pubkey = sphere.identity?.publicKey || sphere.identity?.pubkey || null;

  // DIAGNOSTIC: dump everything we know about our own identity at boot.
  // If STATUS.nametag doesn't match your expected @eric-autovend, or if this
  // wallet's address/pubkey looks unfamiliar between deploys, the persistent
  // volume isn't holding the wallet and a NEW identity is being created every
  // redeploy — which would explain payments never arriving here.
  log('IDENTITY DIAGNOSTIC:', JSON.stringify({
    nametag: STATUS.nametag,
    address: STATUS.address,
    pubkey: STATUS.pubkey,
    usingMnemonicEnv: Boolean(CONFIG.mnemonic),
    walletCreatedThisBoot: created,
  }));

  await publishIdentity(sphere);
  await ensureTreasury(sphere);
  await advertiseToMarket(sphere);

  sphere.communications.onDirectMessage((msg) => {
    handleMessage(sphere, msg).catch((e) => log('message error:', e.message));
  });

  if (typeof sphere.on === 'function') {
    sphere.on('transfer:incoming', (t) => {
      log(`transfer:incoming from ${transferSender(t) || 'unknown'} (${(t && t.tokens && t.tokens.length) || '?'} token(s)). Raw:`, JSON.stringify(t).slice(0, 300));
      (async () => { try { await sphere.payments.receive(); } catch {} await settleFromSender(sphere, transferSender(t), 'incoming event'); })()
        .catch((e) => log('settle-on-incoming error:', e.message));
    });
    sphere.on('transfer:confirmed', (t) => {
      settleFromSender(sphere, transferSender(t), 'confirmed event').catch((e) => log('settle-on-confirm error:', e.message));
    });
  }

  STATUS.live = true;
  startStatusServer();

  log('--------------------------------------------------------------');
  log(buildMenu());
  log('--------------------------------------------------------------');
  log(`AutoVend is LIVE. Shop: ${CONFIG.appUrl} | DM: @${STATUS.nametag}`);

  setInterval(() => { processReceived(sphere, 'poll receive').catch((e) => log('poll error:', e.message)); expireOldOrders(sphere); }, CONFIG.pollMs);
  setInterval(() => advertiseToMarket(sphere).catch(() => {}), 30 * 60 * 1000);
  setInterval(() => log(`heartbeat — live, pending orders: ${pendingOrders.length}`), 5 * 60 * 1000);

  const shutdown = () => { log('Shutting down AutoVend.'); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('Fatal error during startup:', e); process.exit(1); });
