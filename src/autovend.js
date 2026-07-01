/**
 * Sphere AutoVend — autonomous on-network vending agent (Unicity v2 testnet).
 *
 * Dual settlement, no human in the loop:
 *   1) Payment-request path: on "buy", the agent issues a signed payment request.
 *      If the buyer approves it, the agent gets a "paid" signal and delivers.
 *   2) Direct-pay path: the agent pulls incoming transfers with receive(), watches
 *      its balance, and delivers when the exact amount arrives.
 * Whichever fires first delivers the good; double-delivery is prevented.
 */

import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Sphere, getCoinIdBySymbol, randomHex } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const CONFIG = {
  network: process.env.NETWORK || 'testnet',
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
function baseToUct(base) {
  const b = BigInt(base);
  const d = 10n ** BigInt(CONFIG.decimals);
  const whole = b / d;
  const frac = (b % d).toString().padStart(CONFIG.decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function buildMenu() {
  const lines = INVENTORY.map((i) => `  - ${i.id}: ${i.name} — ${i.price} ${CONFIG.coinSymbol}` + (i.stock <= 0 ? ' (SOLD OUT)' : ''));
  return [`AutoVend menu (DM me "buy <id>"):`, ...lines, `Type "menu" to see this again.`].join('\n');
}

function replyTarget(msg) {
  if (msg.senderNametag) return `@${String(msg.senderNametag).replace(/^@/, '')}`;
  return msg.senderPubkey;
}

async function recordSale(sale) {
  try {
    let sales = [];
    try { sales = JSON.parse(await fs.readFile(CONFIG.salesFile, 'utf8')); } catch {}
    sales.push(sale);
    await fs.mkdir(path.dirname(CONFIG.salesFile), { recursive: true });
    await fs.writeFile(CONFIG.salesFile, JSON.stringify(sales, null, 2));
  } catch (e) { log('Could not persist sale (non-fatal):', e.message); }
}

async function getUctBaseBalance(sphere) {
  try {
    const assets = await Promise.resolve(
      sphere.payments.getBalance ? sphere.payments.getBalance() : sphere.payments.getAssets()
    );
    const a = (assets || []).find((x) => (x.symbol || '').toUpperCase() === CONFIG.coinSymbol);
    if (!a) return 0n;
    const v = a.totalAmount;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return BigInt(Math.trunc(v));
    const s = String(v);
    return s.includes('.') ? uctToBase(s) : BigInt(s);
  } catch (e) { log('Balance read failed:', e.message); return null; }
}

async function ensureTreasury(sphere) {
  const bal = await getUctBaseBalance(sphere);
  if (bal && bal > 0n) { log(`Treasury OK: ${baseToUct(bal)} ${CONFIG.coinSymbol}`); return; }
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

const STATUS = { nametag: CONFIG.nametag, address: null, pubkey: null, live: false, salesCount: 0, startedAt: new Date().toISOString() };
function startStatusServer() {
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer((req, res) => {
    const body = {
      service: 'Sphere AutoVend', nametag: `@${STATUS.nametag}`, address: STATUS.address,
      live: STATUS.live, salesCompleted: STATUS.salesCount, startedAt: STATUS.startedAt,
      menu: INVENTORY.map(({ id, name, price }) => ({ id, name, price: `${price} ${CONFIG.coinSymbol}` })),
      howToBuy: `DM @${STATUS.nametag} "menu", then "buy <id>", then approve the request or send that amount of ${CONFIG.coinSymbol}.`,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  });
  server.on('error', (e) => log('Status server error (non-fatal):', e.message));
  server.listen(port, () => log(`Status page live on port ${port}.`));
}

// Orders awaiting payment; settled by request-response OR by detecting funds.
const pendingOrders = [];
let creditedBaseline = 0n;
let baselineReady = false;

async function safeDM(sphere, target, text) {
  try { await sphere.communications.sendDM(target, text); } catch (e) { log(`Failed to DM ${target}:`, e.message); }
}

async function deliverOrder(sphere, order, via) {
  if (order.delivered) return;
  order.delivered = true;
  const idx = pendingOrders.indexOf(order);
  if (idx >= 0) pendingOrders.splice(idx, 1);
  creditedBaseline += order.priceBase; // account for this payment so the poller doesn't double-count
  const good = order.item.deliver();
  order.item.stock -= 1;
  STATUS.salesCount += 1;
  await safeDM(sphere, order.buyer, `Payment received. Here is your ${order.item.name}:\n${good}\n\nThanks for shopping at AutoVend!`);
  await recordSale({ at: new Date().toISOString(), buyer: order.buyer, item: order.item.id, price: order.item.price, coin: CONFIG.coinSymbol, via, delivered: good });
  log(`SOLD ${order.item.id} to ${order.buyer} (${via}). Stock left: ${order.item.stock}`);
}

async function handleOrder(sphere, msg, item) {
  const target = replyTarget(msg);
  if (item.stock <= 0) { await safeDM(sphere, target, `Sorry, "${item.id}" is sold out.`); return; }
  if (pendingOrders.find((o) => o.buyer === target && o.item.id === item.id && !o.delivered)) {
    await safeDM(sphere, target, `You already have a pending order for ${item.name}. Approve the request or send exactly ${item.price} ${CONFIG.coinSymbol} to @${STATUS.nametag}.`);
    return;
  }
  const priceBase = uctToBase(item.price);
  const order = { buyer: target, item, priceBase, createdAt: Date.now(), delivered: false };
  pendingOrders.push(order);
  log(`Order from ${target}: ${item.id} (${item.price} ${CONFIG.coinSymbol}) — awaiting payment.`);

  // Path 1: payment request + response signal (non-blocking).
  let req = null;
  try {
    req = await sphere.payments.sendPaymentRequest(target, { amount: priceBase.toString(), coinId: CONFIG.coinSymbol, message: `AutoVend: ${item.name}` });
  } catch (e) { log('payment request send (non-fatal):', e.message); }
  if (req && req.success && req.requestId) {
    sphere.payments.waitForPaymentResponse(req.requestId, CONFIG.orderTtlMs)
      .then((resp) => { if (resp && resp.responseType === 'paid') return deliverOrder(sphere, order, 'payment request'); })
      .catch((e) => log('payment response wait ended:', e.message));
  }

  const mins = Math.round(CONFIG.orderTtlMs / 60000);
  await safeDM(sphere, target, `Order received: ${item.name}.\nEither approve the payment request in your wallet, OR send exactly ${item.price} ${CONFIG.coinSymbol} to @${STATUS.nametag}.\nI'll deliver automatically within a minute. (Order expires in ${mins} min.)`);
}

async function pollSettlements(sphere) {
  // Incoming transfers are NOT auto-credited — pull anything sent to us first.
  try { if (typeof sphere.payments.receive === 'function') await sphere.payments.receive(); } catch (e) { log('receive (non-fatal):', e.message); }
  try { if (typeof sphere.payments.sync === 'function') await sphere.payments.sync(); } catch {}
  const bal = await getUctBaseBalance(sphere);
  if (bal === null) return;
  if (!baselineReady) { creditedBaseline = bal; baselineReady = true; log(`Settlement baseline set: ${baseToUct(bal)} ${CONFIG.coinSymbol}.`); return; }

  const now = Date.now();
  for (let i = pendingOrders.length - 1; i >= 0; i--) {
    const o = pendingOrders[i];
    if (!o.delivered && now - o.createdAt > CONFIG.orderTtlMs) {
      pendingOrders.splice(i, 1);
      await safeDM(sphere, o.buyer, `Your order for ${o.item.name} expired (no payment received). DM "buy ${o.item.id}" to try again.`);
      log(`Order expired for ${o.buyer}: ${o.item.id}`);
    }
  }

  let available = bal - creditedBaseline;
  if (available <= 0n) return;
  log(`Detected ${baseToUct(available)} ${CONFIG.coinSymbol} unsettled; pending orders: ${pendingOrders.length}.`);

  for (const o of [...pendingOrders]) {
    if (!o.delivered && o.priceBase <= available) {
      available -= o.priceBase;
      await deliverOrder(sphere, o, 'direct payment');
    }
  }
}

async function handleMessage(sphere, msg) {
  // Ignore our own messages — this network echoes sent DMs back to us, which would
  // otherwise cause an infinite self-reply loop.
  const senderTag = (msg.senderNametag || '').replace(/^@/, '').toLowerCase();
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

async function main() {
  log('Starting Sphere AutoVend...');
  log(`Network: ${CONFIG.network} | Nametag target: @${CONFIG.nametag} | Coin: ${CONFIG.coinSymbol}`);

  const providers = createNodeProviders({
    network: CONFIG.network, dataDir: CONFIG.dataDir, tokensDir: CONFIG.tokensDir,
    oracle: { apiKey: CONFIG.apiKey },
  });
  const { sphere, created, generatedMnemonic } = await Sphere.init({ ...providers, network: CONFIG.network, autoGenerate: true });

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

  await ensureTreasury(sphere);
  await advertiseToMarket(sphere);

  sphere.communications.onDirectMessage((msg) => { handleMessage(sphere, msg).catch((e) => log('message error:', e.message)); });

  // Settle instantly the moment a payment arrives (in addition to the poller).
  if (typeof sphere.on === 'function') {
    sphere.on('transfer:incoming', (t) => {
      log(`Incoming transfer detected${t && (t.senderNametag || t.senderPubkey) ? ' from ' + (t.senderNametag || t.senderPubkey) : ''}.`);
      pollSettlements(sphere).catch((e) => log('settle-on-incoming error:', e.message));
    });
  }

  STATUS.live = true;
  startStatusServer();

  log('--------------------------------------------------------------');
  log(buildMenu());
  log('--------------------------------------------------------------');
  log(`AutoVend is LIVE. Buyers: DM @${STATUS.nametag} "menu", then "buy <id>", then approve or send.`);

  setInterval(() => pollSettlements(sphere).catch((e) => log('poll error:', e.message)), CONFIG.pollMs);
  setInterval(() => advertiseToMarket(sphere).catch(() => {}), 30 * 60 * 1000);
  setInterval(() => log(`heartbeat — live, pending orders: ${pendingOrders.length}`), 5 * 60 * 1000);

  const shutdown = () => { log('Shutting down AutoVend.'); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('Fatal error during startup:', e); process.exit(1); });
