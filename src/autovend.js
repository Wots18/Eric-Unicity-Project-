/**
 * Sphere AutoVend — autonomous on-network vending agent (Unicity v2 testnet).
 *
 * Settlement, no human in the loop:
 *   - On "buy <id>", the agent records a pending order (and sends a payment request).
 *   - When a payment ARRIVES, the agent settles straight from the transfer itself:
 *       * the `transfer:incoming` event fires, and/or
 *       * `payments.receive()` pulls the transfer in,
 *     then it matches the SENDER to their pending order and delivers the good.
 *   - No balance math: the arrival of the transfer IS the proof of payment.
 * Double-delivery is prevented via a per-order `delivered` flag.
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

const STATUS = { nametag: CONFIG.nametag, address: null, pubkey: null, live: false, salesCount: 0, startedAt: new Date().toISOString() };
function startStatusServer() {
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer((req, res) => {
    const body = {
      service: 'Sphere AutoVend', nametag: `@${STATUS.nametag}`, address: STATUS.address,
      live: STATUS.live, salesCompleted: STATUS.salesCount, startedAt: STATUS.startedAt,
      menu: INVENTORY.map(({ id, name, price }) => ({ id, name, price: `${price} ${CONFIG.coinSymbol}` })),
      howToBuy: `DM @${STATUS.nametag} "menu", then "buy <id>", then send that amount of ${CONFIG.coinSymbol}.`,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  });
  server.on('error', (e) => log('Status server error (non-fatal):', e.message));
  server.listen(port, () => log(`Status page live on port ${port}.`));
}

// Orders awaiting payment.
const pendingOrders = [];

async function safeDM(sphere, target, text) {
  try { await sphere.communications.sendDM(target, text); } catch (e) { log(`Failed to DM ${target}:`, e.message); }
}

async function deliverOrder(sphere, order, via) {
  if (order.delivered) return;
  order.delivered = true;
  const idx = pendingOrders.indexOf(order);
  if (idx >= 0) pendingOrders.splice(idx, 1);
  const good = order.item.deliver();
  order.item.stock -= 1;
  STATUS.salesCount += 1;
  await safeDM(sphere, order.buyer, `Payment received. Here is your ${order.item.name}:\n${good}\n\nThanks for shopping at AutoVend!`);
  await recordSale({ at: new Date().toISOString(), buyer: order.buyer, item: order.item.id, price: order.item.price, coin: CONFIG.coinSymbol, via, delivered: good });
  log(`SOLD ${order.item.id} to ${order.buyer} (${via}). Stock left: ${order.item.stock}`);
}

// Settle by matching a payment's SENDER to a pending order.
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

// Pull any pending incoming transfers and settle each one.
async function processReceived(sphere, via) {
  let res;
  try { res = typeof sphere.payments.receive === 'function' ? await sphere.payments.receive() : null; }
  catch (e) { log('receive() error:', e.message); return; }
  if (!res) return;
  let transfers = [];
  if (Array.isArray(res)) transfers = res;
  else if (Array.isArray(res.transfers)) transfers = res.transfers;
  else if (Array.isArray(res.received)) transfers = res.received;
  if (transfers.length === 0) {
    if (res && (res.count || res.received || res.transfers)) log('receive() returned (shape):', JSON.stringify(res).slice(0, 300));
    return;
  }
  for (const t of transfers) {
    log(`Pulled transfer from ${transferSender(t) || 'unknown'} (${(t.tokens && t.tokens.length) || '?'} token(s)).`);
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
  const order = { buyer: target, item, createdAt: Date.now(), delivered: false };
  pendingOrders.push(order);
  log(`Order from ${target}: ${item.id} (${item.price} ${CONFIG.coinSymbol}) — awaiting payment.`);

  // Also send a payment request; if the buyer approves it, that arrives as a transfer too.
  try {
    await sphere.payments.sendPaymentRequest(target, { amount: uctToBase(item.price).toString(), coinId: CONFIG.coinSymbol, message: `AutoVend: ${item.name}` });
  } catch (e) { log('payment request send (non-fatal):', e.message); }

  const mins = Math.round(CONFIG.orderTtlMs / 60000);
  await safeDM(sphere, target, `Order received: ${item.name}.\nSend exactly ${item.price} ${CONFIG.coinSymbol} to @${STATUS.nametag} (or approve the payment request if your wallet shows one).\nI'll deliver automatically the moment it arrives. (Order expires in ${mins} min.)`);
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
  // Ignore our own messages — the network echoes sent DMs back, which would loop.
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

  // Settle the instant a payment arrives.
  if (typeof sphere.on === 'function') {
    sphere.on('transfer:incoming', (t) => {
      log(`transfer:incoming from ${transferSender(t) || 'unknown'} (${(t && t.tokens && t.tokens.length) || '?'} token(s)).`);
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
  log(`AutoVend is LIVE. Buyers: DM @${STATUS.nametag} "menu", then "buy <id>", then send the amount.`);

  // Safety-net poller: pull any pending transfers and expire stale orders.
  setInterval(() => { processReceived(sphere, 'poll receive').catch((e) => log('poll error:', e.message)); expireOldOrders(sphere); }, CONFIG.pollMs);
  setInterval(() => advertiseToMarket(sphere).catch(() => {}), 30 * 60 * 1000);
  setInterval(() => log(`heartbeat — live, pending orders: ${pendingOrders.length}`), 5 * 60 * 1000);

  const shutdown = () => { log('Shutting down AutoVend.'); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('Fatal error during startup:', e); process.exit(1); });
