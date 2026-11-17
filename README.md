# PULSE — trade attention

[![Audit](https://github.com/k58v2hbzkk-del/pulse/actions/workflows/audit.yml/badge.svg)](https://github.com/k58v2hbzkk-del/pulse/actions/workflows/audit.yml) [![Tests](https://github.com/k58v2hbzkk-del/pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/k58v2hbzkk-del/pulse/actions/workflows/ci.yml)

**Perpetual markets and 1v1 duels on what the internet is paying attention to.** Go long or short on live attention data (Steam players, Twitch viewers, GitHub star momentum, Wikipedia views), or challenge anyone to a duel on where a number lands. Built on Solana for the Solana Foundation *Perps and Prediction Markets* hackathon.

> Will Marvel Rivals keep growing tonight? Is Counter-Strike past its daily peak? Today you can only have an opinion. On PULSE you can take a position.

## Why it's different

Every perp DEX trades the same thing: token prices. Prediction markets trade yes/no events that expire. PULSE trades **a live number that never stops moving** (how many people are playing a game right now), and the market never closes.

| | Typical perp DEX | Prediction market | **PULSE** |
|---|---|---|---|
| What you trade | token prices | yes/no events | **live attention data** |
| Expiry | none | yes | **none** |
| Needs liquidity providers | yes | yes | **no** |
| Liquidations | yes | no | **no** |
| Can the protocol go insolvent | yes | no | **no** |

## How it works

Each market has a **LONG pool** and a **SHORT pool**, funded in SOL.

1. **Bounded, audited data.** A keeper posts Steam's public player count every minute. The program caps each reading's move at 15% (`MAX_STEP_BPS`), and an independent **Audit** workflow compares every on-chain reading to Steam's live API hourly (red run = bad data). The program also has a Switchboard-verified mode (anyone can crank, nobody can choose the number); Switchboard wound down in Sept 2026, so devnet runs the audited keeper and mainnet targets a zkTLS feed.
2. **24h attention index, computed on-chain.** The program keeps hourly buckets and trades on the 24-hour rolling average. Daily peaks and dips cancel out, so the predictable cycle can't be farmed; only real trends move the price.
3. When the index moves, value flows **from the losing pool to the winning pool**, scaled by the market's leverage. The transfer is `x / (1 + x)` of the losing pool, where `x = leverage × |move|`: about linear for small moves, and never more than 100%, so a pool is never wiped out.
4. Traders hold **shares** of a pool. Share value rises and falls with the pool.
5. **Fair fills:** orders are queued and filled at the share price recorded one full update *after* the update you ordered in. Nobody can trade on a number they already saw.

**Always a counterparty — the Backstop.** A one-sided market has no one to pay winners, so the keeper runs a Backstop that automatically takes the thinner side (matching user flow up to a per-market cap, never holding both sides). Solo traders can win even when nobody else is online. On devnet it runs on free faucet SOL; on mainnet it becomes a vault anyone can deposit into to earn trading fees.

Winners are only ever paid from the other side's pool. No house, no LPs, no liquidations, no bad debt. Losses are capped at what you put in.

## What's in the repo

```
programs/pulse/   Anchor program (Rust)
  src/lib.rs      instructions: create_market, push_price, deposit, withdraw, settle
  src/math.rs     pool math + unit tests (solvency, conservation, never-wiped)
app/              mobile-first web app (Phantom / Solflare / Backpack)
  sdk.js          hand-written client: PDAs, instruction encoding, account decoding
keeper/           oracle keeper + setup scripts (Node)
.github/workflows tests, devnet deploy, 24/7 keeper, GitHub Pages
```

Program ID (devnet): `FEf5G58pDPipsFQJJzUTqHrnPkHaXqS2HABaU5Po9kTx`

## DUEL mode (prediction markets)

Call it: "Counter-Strike 2 will be ABOVE 600,000 players at Sunday 20:00", stake SOL, share the link. Anyone can take the other side by matching the stake. After the deadline anyone can settle: the program reads the first audited reading posted after the deadline (within 1 hour) and pays the winner the pot minus 1%. Unaccepted duels refund the creator; ties refund both; a duel with no usable reading for 3 days refunds both. The keeper settles every duel automatically.

## Launch markets

| Market | Index | Leverage |
|---|---|---|
| Counter-Strike 2 | live Steam players (app 730) | 3x |
| Dota 2 | live Steam players (app 570) | 3x |
| PUBG: Battlegrounds | live Steam players (app 578080) | 3x |
| Marvel Rivals | live Steam players (app 2767030) | 5x |
| Apex Legends | live Steam players (app 1172470) | 5x |
| GTA V, Rust | live Steam players | 3x |
| Bitcoin, AI, Taylor Swift | English Wikipedia daily views | 3x |
| Ollama, VS Code | GitHub stars per day (from recent star events) | 2x |
| Just Chatting, Counter-Strike on Twitch | live viewers, top 100 streams | 3x |

## Roadmap

- More attention indexes: YouTube views, Wikipedia pageviews, GitHub stars, Twitch viewers
- Permissionless market creation with a staked oracle
- Prediction-market layer: dated "will X pass Y by Friday?" markets on the same data
- Mainnet with real SOL

## Run it

Everything runs on free GitHub infrastructure:

1. Add repo secrets `ADMIN_KEY` and `PROGRAM_KEY` (keypair JSON arrays).
2. Fund the admin address with devnet SOL at https://faucet.solana.com
3. Actions → **Deploy to devnet** → Run workflow
4. Actions → **Keeper** → Run workflow (then it runs hourly by itself)
5. Settings → Pages → Source: **GitHub Actions**. The app goes live at `https://<user>.github.io/pulse/`

Local: `cargo test --lib` · `npm ci && npm run build` · open `dist/index.html?demo` for a design preview.

---

Built by Tajudeen · [@Tajudeen](https://x.com/Tajudeen)
