/**
 * Sphere AutoVend — an autonomous on-network vending agent for the Unicity v2 testnet.
 *
 * What it does, with no human in the loop per sale:
 *   1. Boots a Sphere wallet (persisted to ./data so the identity/nametag survive restarts).
 *   2. Registers an @nametag and self-mints a small UCT treasury (there is no faucet).
 *   3. Advertises its menu (and, best-effort, posts an offer intent to the market).
 *   4. Listens for direct messages. When a buyer sends `buy <item>`, the agent:
 *        - issues a SIGNED PAYMENT REQUEST for the item price,
 *        - waits for SETTLEMENT on testnet2,
 *        - on payment, DELIVERS the digital good over DM and records the sale.
 *
 * The agent decides when to act, finds its counterparty through messaging, and
 * executes the payment-request -> settlement -> delivery cycle programmatically in
 * a loop. A human only sets the goals (inventory + prices). That is the campaign's
 * definition of "agentic".
 *
 * Built with @unicitylabs/sphere-sdk against network preset "testnet" (= testnet2 v2).
 */

import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  Sphere,
  getCoinIdBySymbol,
  parseTokenAmount,
  toHumanReadable,
  randomHex,
} from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// ----------------------------------------------------------------------------
// Configuration (all overridable via .env)
// ----------------------------------------------------------------------------
const CONFIG = {
  network: process.env.NETWORK || 'testnet',          // testnet === testnet2 (v2 gateway)
  nametag: (process.env.NAMETAG || 'autovend').toLowerCase(),
  apiKey: process.env.UNICITY_API_KEY || 'sk_ddc3cfcc001e4a28ac3fad7407f99590', // public testnet2 key (not a secret)
  coinSymbol: (process.env.COIN_SYMBOL || 'UCT').toUpperCase(),
  mintAmount: process.env.MINT_AMOUNT || '1000',      // human units to self-mint if treasury is empty
  paymentTimeoutMs: Number(process.env.PAYMENT_TIMEOUT_MS || 120000), // 2 min to settle
  dataDir: process.env.DATA_DIR || './data/wallet',
  tokensDir: process.env.TOKENS_DIR || './data/tokens',
  salesFile: process.env.SALES_FILE || './data/sales.json',
};

// ----------------------------------------------------------------------------
// Inventory — edit this to sell whatever you like. `deliver()` returns the
// digital good handed to the buyer after payment settles.
// ----------------------------------------------------------------------------
const INVENTORY = [
  {
    id: 'code',
    name: 'One-time access code',
    price: '1',            // 1 UCT
    stock: 50,
    deliver: () => `ACCESS-${randomHex(4).toUpperCase()}-${randomHex(4).toUpperCase()}`,
  },
  {
    id: 'luck',
    name: 'Lucky number draw (1-100)',
    price: '0.5',          // 0.5 UCT
    stock: 100,
    deliver: () => `Your lucky number is ${1 + Math.floor(Math.random() * 100)}. Good fortune on-chain.`,
  },
  {
    id: 'badge',
    name: 'AutoVend supporter badge (collectible note)',
    price: '2',            // 2 UCT
    stock: 25,
    deliver: () => `BADGE #${1000 + Math.floor(Math.random() * 9000)} — verified AutoVend supporter.`,
  },
];

// ----------------------------------------------------------------------------
// Small utilities
// ----------------------------------------------------------------------------
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

const findItem = (id) => INVENTORY.find((i) => i.id === (id || '').toLowerCase());

function buildMenu() {
  const lines = INVENTORY.map(
    (i) => `  - ${i.id}: ${i.name} — ${i.price} ${CONFIG.coinSymbol}` +
      (i.stock <= 0 ? ' (SOLD OUT)' : '')
  );
  return [
    `AutoVend menu (DM me "buy <id>"):`,
    ...lines,
    `Type "menu" to see this again.`,
  ].join('\n');
}

// Where do we reply / request payment? Prefer the human-readable nametag, fall
// back to the raw pubkey. A nametag is required for the buyer to *receive* the
// access code reliably and for payment requests to resolve.
function replyTarget(msg) {
  if (msg.senderNametag) return `@${msg.senderNametag.replace(/^@/, '')}`;
  return msg.senderPubkey;
}

async function recordSale(sale) {
  try {
    let sales = [];
    try {
      sales = JSON.parse(await fs.readFile(CONFIG.salesFile, 'utf8'));
    } catch { /* first sale, file may not exist */ }
    sales.push(sale);
    await fs.mkdir(path.dirname(CONFIG.salesFile), { recursive: true });
    await fs.writeFile(CONFIG.salesFile, JSON.stringify(sales, null, 2));
  } catch (e) {
    log('Could not persist sale (non-fatal):', e.message);
  }
}

// ----------------------------------------------------------------------------
// Treasury — self-mint test tokens if the wallet is empty (no faucet on testnet)
// ----------------------------------------------------------------------------
async function getCoinBalance(sphere) {
  try {
    const assets = await Promise.resolve(
      sphere.payments.getAssets ? sphere.payments.getAssets() : sphere.payments.getBalance()
    );
    const a = (assets || []).find(
      (x) => (x.symbol || '').toUpperCase() === CONFIG.coinSymbol
    );
    return a ? a.totalAmount : 0n;
  } catch (e) {
    log('Balance check failed (treating as empty):', e.message);
    return 0n;
  }
}

async function ensureTreasury(sphere) {
  const balance = await getCoinBalance(sphere);
  const isEmpty = !balance || balance === 0n || balance === '0';
  if (!isEmpty) {
    log(`Treasury OK: ${toHumanReadable(balance)} ${CONFIG.coinSymbol}`);
    return;
  }
  log(`Treasury empty — self-minting ${CONFIG.mintAmount} ${CONFIG.coinSymbol}...`);
  try {
    const coinId = getCoinIdBySymbol(CONFIG.coinSymbol);
    if (!coinId) {
      log(`Could not resolve coin id for ${CONFIG.coinSymbol}; skipping mint.`);
      return;
    }
    const result = await sphere.payments.mintFungibleToken(
      coinId,
      parseTokenAmount(CONFIG.mintAmount)
    );
    if (result && result.success !== false) {
      log('Mint succeeded. Treasury funded.');
    } else {
      log('Mint returned an error result:', result && result.error);
    }
  } catch (e) {
    log('Mint failed (non-fatal — you can fund the wallet manually):', e.message);
  }
}

// ----------------------------------------------------------------------------
// Best-effort market advertisement. The exact market API may differ between SDK
// versions, so this never throws — DM-based discovery always works regardless.
// ----------------------------------------------------------------------------
async function advertiseToMarket(sphere) {
  const summary = `AutoVend storefront: DM @${CONFIG.nametag} "buy <id>" — ` +
    INVENTORY.map((i) => `${i.id}@${i.price}${CONFIG.coinSymbol}`).join(', ');
  try {
    const market = sphere.market;
    if (!market) { log('Market module not present; relying on DM discovery.'); return; }
    const payload = { kind: 'offer', summary, items: INVENTORY.map(({ id, name, price }) => ({ id, name, price })) };
    if (typeof market.publishIntent === 'function') {
      await market.publishIntent(payload);
      log('Published offer intent to the market.');
    } else if (typeof market.createIntent === 'function') {
      await market.createIntent(payload);
      log('Published offer intent to the market.');
    } else if (typeof market.post === 'function') {
      await market.post(payload);
      log('Published offer intent to the market.');
    } else {
      log('Market intent API not detected on this SDK build; relying on DM discovery.');
    }
  } catch (e) {
    log('Market advertise failed (non-fatal):', e.message);
  }
}

// ----------------------------------------------------------------------------
// Core order handler — the autonomous sell cycle
// ----------------------------------------------------------------------------
const inFlight = new Set(); // prevent double-processing the same buyer concurrently

async function handleOrder(sphere, msg, item) {
  const target = replyTarget(msg);
  if (inFlight.has(target)) {
    await safeDM(sphere, target, 'You already have an order in progress — finish that one first.');
    return;
  }
  if (item.stock <= 0) {
    await safeDM(sphere, target, `Sorry, "${item.id}" is sold out.`);
    return;
  }

  inFlight.add(target);
  try {
    log(`Order from ${target}: ${item.id} (${item.price} ${CONFIG.coinSymbol})`);

    const amount = parseTokenAmount(item.price).toString();
    const req = await sphere.payments.sendPaymentRequest(target, {
      amount,
      coinId: CONFIG.coinSymbol,
      message: `AutoVend: ${item.name}`,
    });

    if (!req || !req.success || !req.requestId) {
      log('Payment request failed to send:', req && req.error);
      await safeDM(sphere, target,
        `I could not send you a payment request. If you have not set a nametag yet, register one in your Sphere wallet and try again.`);
      return;
    }

    await safeDM(sphere, target,
      `Payment request sent for ${item.price} ${CONFIG.coinSymbol}. Approve it in your wallet within ${Math.round(CONFIG.paymentTimeoutMs / 1000)}s to receive: ${item.name}.`);

    const response = await sphere.payments.waitForPaymentResponse(req.requestId, CONFIG.paymentTimeoutMs);

    if (response && response.responseType === 'paid') {
      const good = item.deliver();
      item.stock -= 1;
      await safeDM(sphere, target, `Payment received. Here is your ${item.name}:\n${good}\n\nThanks for shopping at AutoVend!`);
      await recordSale({
        at: new Date().toISOString(),
        buyer: target,
        item: item.id,
        price: item.price,
        coin: CONFIG.coinSymbol,
        transferId: response.transferId || null,
        delivered: good,
      });
      log(`SOLD ${item.id} to ${target}. Stock left: ${item.stock}`);
    } else {
      const why = response ? response.responseType : 'timeout';
      await safeDM(sphere, target, `Order cancelled (${why}). No payment was taken. DM "buy ${item.id}" to try again.`);
      log(`Order not completed for ${target}: ${why}`);
    }
  } catch (e) {
    log('Order handling error:', e.message);
    await safeDM(sphere, target, 'Something went wrong handling your order. No payment was taken. Please try again.');
  } finally {
    inFlight.delete(target);
  }
}

async function safeDM(sphere, target, text) {
  try {
    await sphere.communications.sendDM(target, text);
  } catch (e) {
    log(`Failed to DM ${target}:`, e.message);
  }
}

// ----------------------------------------------------------------------------
// Message router
// ----------------------------------------------------------------------------
async function handleMessage(sphere, msg) {
  const text = (msg.content || '').trim();
  const target = replyTarget(msg);
  log(`DM from ${target}: ${text}`);

  const lower = text.toLowerCase();
  if (lower === 'menu' || lower === 'help' || lower === 'hi' || lower === 'hello' || lower === '') {
    await safeDM(sphere, target, buildMenu());
    return;
  }

  if (lower.startsWith('buy')) {
    const parts = lower.split(/\s+/);
    const itemId = parts[1];
    const item = findItem(itemId);
    if (!item) {
      await safeDM(sphere, target, `I don't sell "${itemId || '(nothing specified)'}".\n\n${buildMenu()}`);
      return;
    }
    await handleOrder(sphere, msg, item);
    return;
  }

  // Unknown command
  await safeDM(sphere, target, `I didn't understand that.\n\n${buildMenu()}`);
}

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
async function main() {
  log('Starting Sphere AutoVend...');
  log(`Network: ${CONFIG.network} | Nametag target: @${CONFIG.nametag} | Coin: ${CONFIG.coinSymbol}`);

  const providers = createNodeProviders({
    network: CONFIG.network,
    dataDir: CONFIG.dataDir,
    tokensDir: CONFIG.tokensDir,
    oracle: { apiKey: CONFIG.apiKey },
  });

  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    network: CONFIG.network,
    autoGenerate: true,
    nametag: CONFIG.nametag,
  });

  if (created && generatedMnemonic) {
    log('A NEW WALLET WAS CREATED. Back up this mnemonic to keep the same identity/nametag:');
    log(`  ${generatedMnemonic}`);
    log('(Set it later as WALLET_MNEMONIC, or just keep the ./data folder.)');
  }

  log(`Identity address: ${sphere.identity?.directAddress}`);
  log(`Nametag: @${sphere.identity?.nametag || CONFIG.nametag}`);

  // Make sure the nametag is actually registered to this wallet.
  if (!sphere.identity?.nametag) {
    try {
      const free = await sphere.isNametagAvailable(CONFIG.nametag);
      if (free) {
        await sphere.registerNametag(CONFIG.nametag);
        log(`Registered @${CONFIG.nametag}`);
      } else {
        log(`@${CONFIG.nametag} is taken by another wallet. Set a different NAMETAG in .env.`);
      }
    } catch (e) {
      log('Nametag registration issue (non-fatal):', e.message);
    }
  }

  await ensureTreasury(sphere);
  await advertiseToMarket(sphere);

  // Subscribe to incoming DMs — this is the agent's "ear".
  sphere.communications.onDirectMessage((msg) => {
    handleMessage(sphere, msg).catch((e) => log('Unhandled message error:', e.message));
  });

  log('--------------------------------------------------------------');
  log(buildMenu());
  log('--------------------------------------------------------------');
  log(`AutoVend is LIVE. To test it: open the Sphere wallet, DM @${sphere.identity?.nametag || CONFIG.nametag} the word "menu".`);

  // Re-advertise to the market every 30 minutes so the offer stays fresh.
  setInterval(() => advertiseToMarket(sphere).catch(() => {}), 30 * 60 * 1000);

  // Heartbeat so you can see it's alive in the logs.
  setInterval(() => log('heartbeat — AutoVend running, waiting for orders.'), 5 * 60 * 1000);

  // Graceful shutdown
  const shutdown = () => { log('Shutting down AutoVend. Goodbye.'); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Fatal error during startup:', e);
  process.exit(1);
});
