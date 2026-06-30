# Sphere AutoVend 🏪🤖

An **autonomous on-network vending agent** for the Unicity v2 testnet, built on the
[Sphere SDK](https://github.com/unicity-sphere/sphere-sdk).

AutoVend is a Node.js service that owns a Sphere wallet and runs a self-service shop
with **no human in the loop per sale**. A buyer simply direct-messages the agent;
the agent decides to act, requests payment, waits for settlement on testnet2, and
delivers the digital good automatically.

```
Buyer DMs "buy code"
        │
        ▼
AutoVend issues a signed PAYMENT REQUEST  ──►  buyer approves in wallet
        │
        ▼
Payment SETTLES on testnet2  ──►  AutoVend DMs the access code + records the sale
```

The only thing a human sets is the goal: the inventory and prices. Everything
economic — requesting payment, detecting settlement, delivering, bookkeeping —
the agent does on its own, in a loop. That is the campaign's definition of *agentic*.

---

## What it uses from the network

| Primitive | How AutoVend uses it |
| --- | --- |
| Identity + nametag | Registers `@autovend` so buyers can find and message it |
| Self-mint (token engine) | Funds its own UCT treasury on first run (no faucet exists) |
| Payment requests | Issues a signed request for each order |
| Settlement | Waits for the payment to settle before delivering |
| Direct messages (NIP-17) | Receives orders and delivers goods, end-to-end encrypted |
| Market intents | Best-effort: posts an offer so other agents can discover the shop |

---

## Run it on your phone with GitHub Codespaces

You do **not** need a computer. Everything below works in a phone browser.

**1. Put this folder in a GitHub repo**
- Create a new **public** repository on GitHub (public is required for the submission).
- Upload these files (`src/`, `package.json`, `.env.example`, `.gitignore`, `README.md`).

**2. Open a Codespace**
- On the repo page, tap the green **Code** button → **Codespaces** → **Create codespace on main**.
- Wait for the in-browser editor + terminal to load.

**3. Configure your environment**
In the Codespace terminal, run:
```bash
cp .env.example .env
```
Open `.env` and set a unique `NAMETAG` (e.g. `ra-autovend`). The API key is already
filled in — it's the public testnet key, safe to use.

**4. Install and start**
```bash
npm install
npm start
```
You should see the agent boot, print its address and nametag, fund its treasury,
print the menu, and then: `AutoVend is LIVE`.

**5. Test it (the fun part)**
- Open the **Sphere wallet** (web/app) and create a wallet if you don't have one.
- Get some test UCT in it (self-mint via the wallet, same idea as the agent does).
- DM your agent's nametag (e.g. `@ra-autovend`) the word `menu`.
- Reply `buy code`. Approve the payment request when it arrives.
- The agent DMs you back your access code. That round trip is your demo. 🎉

> Keep the Codespace tab open while testing — the agent runs as long as the
> process is alive. For a longer-lived demo you can run the same repo on a free
> host like Railway or Render (Start command: `npm start`).

---

## Customising the shop

Open `src/autovend.js` and edit the `INVENTORY` array. Each item has an `id`,
`name`, `price` (in UCT), `stock`, and a `deliver()` function that returns whatever
the buyer receives. Sell access codes, lucky numbers, collectible notes — anything
expressible as text.

---

## How this maps to the judging criteria

- **Depth of SDK use** — payment requests, settlement, DMs, nametags, self-mint, and a best-effort market intent, not a wallet bolted on the surface.
- **Autonomy** — the agent initiates and completes each sale on its own; the human only sets inventory/prices. Qualifies for the **Agentic Build** bonus.
- **Usefulness** — a self-running storefront is real infrastructure other agents and users can transact with.
- **Completeness & craft** — error handling on every network call, persistent identity, a sales ledger, graceful shutdown, and this README.
- **Contribution to the network** — exposes a live service (and an offer intent) that others can interact with.

## Submission checklist (per the campaign rules)

- [ ] Code is public in a repo a reviewer can read and run ✔ (make the repo public)
- [ ] App is live on a publicly viewable location (Codespace running, or Railway/Render URL)
- [ ] Short description + build path + run instructions ✔ (this README)
- [ ] State that it **is agentic** ✔ and whether it runs on AstridOS (it does not, by default)
- [ ] Shipped within the campaign window
- [ ] Submit via the developer portal: https://developers.unicity.network/

**Build path chosen:** Autonomous agents (with a Payments & markets storefront flavour).
**Agentic:** Yes. **Runs on AstridOS:** No.

---

## Troubleshooting

Every network call is wrapped and logs a clear, timestamped message, so the logs
tell you exactly what's happening at each step.

- **Nametag won't register** — it's already owned by another wallet. Set a new `NAMETAG` in `.env` and restart.
- **Treasury looks empty** — the agent self-mints on first run; check the startup log for the mint result, or adjust `MINT_AMOUNT`.
- **Market advertisement skipped** — posting an offer intent is best-effort by design. If it's unavailable the agent logs a note and keeps selling over DMs, so orders are never blocked.

Built for the Unicity "build the machine economy" call. MIT licensed.
