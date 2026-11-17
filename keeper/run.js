// The keeper: posts live attention data on-chain every INTERVAL seconds and auto-settles
// filled orders for users. Runs inside GitHub Actions for free (restarts every ~6h).
import { conn, loadKey, send, solBalance, tryAirdrop, sleep } from "./common.js";
import { readSource } from "./sources.js";
import { sendWithUpdate, feedIdOf } from "./oracle.js";
import {
  PROGRAM_ID, marketPda, positionPda, indexPda, quotePda, decodeIndex, pushPriceIx, setFeedIx, settleIx, openPositionIx, depositIx,
  decodeMarket, decodePosition, sharePrice, valueOf, ACCT, decodeDuel, settleDuelIx, createDuelIx,
  createPredictionIx, openBetIx, placeBetIx, resolvePredictionIx, claimBetIx, decodePrediction, decodeBet, predPda,
} from "../app/sdk.js";
import { MARKETS } from "./markets.js";
import bs58 from "bs58";

const keeper = loadKey();
const INTERVAL = Number(process.env.INTERVAL_SEC || 60) * 1000;
const RUN_FOR = Number(process.env.RUN_MINUTES || 345) * 60_000;
const started = Date.now();
console.log("keeper:", keeper.publicKey.toBase58(), "interval", INTERVAL / 1000, "s");

async function pushAll() {
  const keeperIxs = [];
  for (const m of MARKETS) {
    const mk = marketPda(m.id);
    const ii = await conn.getAccountInfo(indexPda(mk));
    const idx = ii ? decodeIndex(ii.data) : null;
    try {
      if (idx?.oracle) {
        // Oracle mode: Switchboard oracles sign the Steam number; the program verifies it.
        const feedId = feedIdOf(m);
        const sig = await sendWithUpdate(keeper, m, pushPriceIx(keeper.publicKey, mk, 0, quotePda(feedId)));
        console.log(`  ${m.name}: oracle update`, sig);
      } else {
        if (!(await conn.getAccountInfo(mk))) continue; // market not created (e.g. Twitch keys missing)
        const reading = await readSource(m);
        keeperIxs.push(pushPriceIx(keeper.publicKey, mk, reading));
        console.log(`  ${m.name}: ${reading}`);
      }
    } catch (e) {
      console.log(`  ${m.name}: skipped (${e.message?.slice(0, 200)})`);
      if (idx?.oracle) {
        // oracle network unavailable: fall back to keeper data so the market never freezes
        await send(keeper, setFeedIx(keeper.publicKey, mk, new Uint8Array(32)))
          .then(() => console.log(`  ${m.name}: oracle unavailable, switched to keeper data`))
          .catch(() => {});
      }
    }
  }
  // a transaction fits ~6 pushes; send in chunks
  for (let i = 0; i < keeperIxs.length; i += 6) {
    try { console.log("  pushed:", await send(keeper, ...keeperIxs.slice(i, i + 6))); }
    catch (e) { console.log("  push failed:", e.message?.slice(0, 200)); }
  }
}

async function settleFilled() {
  const markets = new Map();
  for (const m of MARKETS) {
    const info = await conn.getAccountInfo(marketPda(m.id));
    if (info) markets.set(marketPda(m.id).toBase58(), decodeMarket(info.data));
  }
  const positions = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(ACCT.Position)) } }, { memcmp: { offset: 105, bytes: bs58.encode(Uint8Array.from([1])) } }],
  });
  const ready = positions
    .map((p) => decodePosition(p.account.data))
    .filter((p) => {
      const m = markets.get(p.market.toBase58());
      return m && p.pending && m.epoch >= p.pendingEpoch + 2n;
    });
  for (let i = 0; i < ready.length; i += 4) {
    const batch = ready.slice(i, i + 4).map((p) => settleIx(p.market, p.owner));
    try { console.log(`  settled ${batch.length}:`, await send(keeper, ...batch)); }
    catch (e) { console.log("  settle failed:", e.message); }
  }
}

// ------------------------------------------------------------ DUEL auto-settle
// Settles every duel past its deadline (permissionless): pays winners, refunds unaccepted ones.
async function settleDuels() {
  const now = Math.floor(Date.now() / 1000);
  const list = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(ACCT.Duel)) } }] });
  for (const { pubkey, account } of list) {
    const d = decodeDuel(account.data);
    if (d.state > 1 || now < d.deadline) continue;
    if (d.state === 1) {
      const ii = await conn.getAccountInfo(indexPda(d.market));
      const idx = ii ? decodeIndex(ii.data) : null;
      const fresh = idx && idx.lastTime >= d.deadline && idx.lastTime <= d.deadline + 3600;
      if (!fresh && now <= d.deadline + 3 * 86400) continue; // wait for a reading after the deadline
    }
    const opp = d.state === 1 ? d.opponent : d.creator;
    try { console.log(`  duel ${pubkey.toBase58().slice(0, 6)} settled:`, await send(keeper, settleDuelIx(pubkey, d.market, d.creator, opp))); }
    catch (e) { console.log(`  duel ${pubkey.toBase58().slice(0, 6)} settle failed:`, e.message?.slice(0, 160)); }
  }
}

// ------------------------------------------------------------ House duels
// Keeps a few open challenges alive at all times, so there's always something to take.
const HOUSE_OPEN = Number(process.env.HOUSE_DUELS || 3);
const sol = (env, d) => BigInt(Math.round(Number(process.env[env] || d) * 1e9));
const HOUSE_STAKE = sol("HOUSE_STAKE_SOL", 0.05);
let lastHouse = 0;
async function houseDuels() {
  if (Date.now() - lastHouse < 10 * 60_000) return;
  lastHouse = Date.now();
  const now = Math.floor(Date.now() / 1000);
  const list = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(ACCT.Duel)) } }, { memcmp: { offset: 40, bytes: keeper.publicKey.toBase58() } }] });
  const open = list.map((x) => decodeDuel(x.account.data)).filter((d) => d.state === 0 && d.deadline - 600 > now);
  let need = HOUSE_OPEN - open.length;
  const live = (await liveReadings()).filter(({ mk }) => !open.some((d) => d.market.equals(mk)));
  live.sort(() => Math.random() - 0.5);
  for (const { m, mk, raw } of live) {
    if (need <= 0) break;
    const hours = [3, 6, 12, 24][Math.floor(Math.random() * 4)];
    const above = Math.random() < 0.5;
    // target a bit away from now, rounded so it reads well
    const mag = 10 ** Math.max(0, Math.floor(Math.log10(raw)) - 2);
    const target = Math.max(1, Math.round((raw * (above ? 1.02 : 0.98)) / mag) * mag);
    try {
      const sig = await send(keeper, createDuelIx(keeper.publicKey, mk, { nonce: BigInt(Date.now()), above, target: BigInt(target), deadline: now + hours * 3600, stake: HOUSE_STAKE }));
      console.log(`  house duel: ${m.name} ${above ? "ABOVE" : "BELOW"} ${target} in ${hours}h`, sig);
      need--;
    } catch (e) { console.log("  house duel failed:", e.message?.slice(0, 160)); }
  }
}

/** Latest fresh on-chain reading of every market, in one RPC call. */
async function liveReadings() {
  const now = Math.floor(Date.now() / 1000);
  const mks = MARKETS.map((m) => marketPda(m.id));
  const infos = await conn.getMultipleAccountsInfo(mks.map(indexPda));
  const out = [];
  infos.forEach((ii, i) => {
    if (!ii) return;
    const idx = decodeIndex(ii.data);
    if (idx.lastRaw > 0n && now - idx.lastTime < 600) out.push({ m: MARKETS[i], mk: mks[i], raw: Number(idx.lastRaw) });
  });
  return out;
}

// ------------------------------------------------------------ House predictions (Polymarket-style)
// Keeps a full board of YES/NO questions open and seeds both sides, so there are always odds
// and always someone on the other side. nonce = deadline × 100 + template code
// (codes 1–19 are "Up or Down" questions; the app reads that to title them).
const PRED_SEED = sol("PRED_SEED_SOL", 0.05);
const byId = Object.fromEntries(MARKETS.map((m) => [m.id, m]));
const H = 3600, D = 86400;
const nextAt = (now, period, offset, minGap) => { let t = Math.floor((now - offset) / period) * period + offset + period; while (t - now < minGap) t += period; return t; };
// daily volatility guess per kind, used only to seed fair-ish starting odds
const VOL = { price: 0.03, global: 0.02, steam: 0.1, fng: 0.15, solana: 0.2, narrative: 0.15, wiki: 0.25, github: 0.4, twitch: 0.2 };
function predTemplates(now) {
  const hourly = nextAt(now, H, 0, 70 * 60);           // end of the next full hour
  const daily = nextAt(now, D, 0, 3 * H);              // next 00:00 UTC
  const evening = nextAt(now, D, 20 * H, 3 * H);       // next 20:00 UTC
  const sunday = nextAt(now, 7 * D, 3 * D + 20 * H, D); // Sunday 20:00 UTC (epoch day 0 was a Thursday)
  const t = [];
  [24, 25, 26].forEach((id, i) => t.push({ id, code: 1 + i, deadline: hourly, kind: "updown" }));
  [24, 25, 26, 27, 28, 29].forEach((id, i) => t.push({ id, code: 4 + i, deadline: daily, kind: "updown" }));
  [1, 2, 4, 19, 20, 15, 16, 30, 31, 10, 32, 33, 34, 5, 9].forEach((id, i) => t.push({ id, code: 20 + i, deadline: evening, kind: "line" }));
  t.push({ id: 24, code: 40, deadline: sunday, kind: "round", step: 5000_00 });
  t.push({ id: 25, code: 41, deadline: sunday, kind: "round", step: 250_00 });
  t.push({ id: 26, code: 42, deadline: sunday, kind: "round", step: 10_00 });
  return t;
}
function roundNice(v, m) {
  if (m.kind === "weather") return Math.round(v / 5) * 5; // half degrees
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(1, v))) - 2);
  return Math.max(1, Math.round(v / mag) * mag);
}
function seedOdds(m, raw, target, above, hours) {
  // P(YES) under a rough normal move; clamped so both sides get at least 0.01 SOL
  const sd = m.kind === "weather" ? 30 * Math.sqrt(hours / 24) / raw : (VOL[m.kind] || 0.1) * Math.sqrt(Math.max(hours, 1) / 24);
  const z = (target / raw - 1) / sd;
  const pAbove = 1 / (1 + Math.exp(1.7 * z));
  return Math.min(0.8, Math.max(0.2, above ? pAbove : 1 - pAbove));
}
let lastPreds = 0;
async function housePredictions() {
  if (Date.now() - lastPreds < 5 * 60_000) return;
  lastPreds = Date.now();
  const now = Math.floor(Date.now() / 1000);
  const live = Object.fromEntries((await liveReadings()).map((r) => [r.m.id, r]));
  for (const tp of predTemplates(now)) {
    const r = live[tp.id];
    if (!r) continue;
    const nonce = BigInt(tp.deadline) * 100n + BigInt(tp.code);
    const pred = predPda(r.mk, keeper.publicKey, nonce);
    if (await conn.getAccountInfo(pred)) continue;
    const m = byId[tp.id];
    let above = true, target = r.raw;
    if (tp.kind === "line") {
      above = Math.random() < 0.5;
      const span = m.kind === "weather" ? 15 + Math.random() * 15 : r.raw * (VOL[m.kind] || 0.1) * (0.3 + Math.random() * 0.5);
      target = roundNice(r.raw + (above ? span : -span), m);
    } else if (tp.kind === "round") {
      target = Math.ceil(r.raw / tp.step) * tp.step;
    }
    if (target === r.raw && tp.kind !== "updown") target += 1;
    const hours = (tp.deadline - now) / 3600;
    const p = tp.kind === "updown" ? 0.5 : seedOdds(m, r.raw, target, above, hours);
    const yesAmt = BigInt(Math.round(Number(PRED_SEED) * p)), noAmt = PRED_SEED - yesAmt;
    try {
      const sig = await send(keeper,
        createPredictionIx(keeper.publicKey, r.mk, { nonce, above, target: BigInt(target), deadline: BigInt(tp.deadline) }),
        openBetIx(keeper.publicKey, pred),
        placeBetIx(keeper.publicKey, pred, true, yesAmt),
        placeBetIx(keeper.publicKey, pred, false, noAmt));
      console.log(`  question: ${m.name} ${tp.kind} ${above ? ">" : "<"} ${target} @${new Date(tp.deadline * 1000).toISOString().slice(5, 16)} p=${p.toFixed(2)}`, sig.slice(0, 12));
    } catch (e) { console.log(`  question ${m.name} failed:`, e.message?.slice(0, 160)); }
    await sleep(400);
  }
}

/** Resolves finished questions and pays every winning slip (anyone's) straight to its wallet. */
async function settlePredictions() {
  const now = Math.floor(Date.now() / 1000);
  const preds = (await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(ACCT.Prediction)) } }] }))
    .map((x) => ({ pk: x.pubkey, p: decodePrediction(x.account.data) }));
  for (const { pk, p } of preds) {
    if (p.state !== 0 || now < p.deadline + 30) continue;
    try { console.log("  resolved question", pk.toBase58().slice(0, 8), await send(keeper, resolvePredictionIx(pk, p.market))); }
    catch (e) { if (!/TooEarly|NotFilledYet|0x177/.test(e.message)) console.log("  resolve failed:", e.message?.slice(0, 120)); }
  }
  const done = new Map(preds.filter((x) => x.p.state !== 0).map((x) => [x.pk.toBase58(), x]));
  // re-read states we may have just changed
  const fresh = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(ACCT.Prediction)) } }] });
  for (const x of fresh) { const p = decodePrediction(x.account.data); if (p.state !== 0) done.set(x.pubkey.toBase58(), { pk: x.pubkey, p }); }
  if (!done.size) return;
  const bets = (await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(ACCT.Bet)) } }] }))
    .map((x) => decodeBet(x.account.data)).filter((b) => done.has(b.prediction.toBase58()));
  for (let i = 0; i < bets.length; i += 5) {
    const ixs = bets.slice(i, i + 5).map((b) => claimBetIx(b.prediction, b.owner));
    try { console.log(`  paid ${ixs.length} bet slip(s)`, await send(keeper, ...ixs)); } catch (e) { console.log("  claim failed:", e.message?.slice(0, 120)); }
  }
}

// ------------------------------------------------------------ Backstop
// Takes the thin side so every trader always has a counterparty. Matches user flow
// up to MM_MAX_PER_MARKET_SOL per market. Never holds both sides of a market.
const MM_ON = process.env.MM_ENABLED !== "0";
const MM_MAX = sol("MM_MAX_PER_MARKET_SOL", 0.5);
const MM_RESERVE = sol("MM_RESERVE_SOL", 0.5); // always keep for keeper fees
const MIN_ORDER = 10_000_000n; // 0.01 SOL

async function backstop() {
  if (!MM_ON) return;
  let budget = BigInt(await conn.getBalance(keeper.publicKey)) - MM_RESERVE;
  for (const cfg of MARKETS) {
    if (budget < MIN_ORDER) { console.log("  backstop: budget used up, top up the keeper wallet"); return; }
    const mk = marketPda(cfg.id);
    const [mi, pi] = await conn.getMultipleAccountsInfo([mk, positionPda(mk, keeper.publicKey)]);
    if (!mi) continue;
    const m = decodeMarket(mi.data);
    const pos = pi ? decodePosition(pi.data) : null;
    const ixs = [];
    if (pos?.pending) {
      if (m.epoch >= pos.pendingEpoch + 2n) ixs.push(settleIx(mk, keeper.publicKey));
      else continue; // our last order is still filling
    }
    const L = m.longBalance + m.pendLongDep[0] + m.pendLongDep[1];
    const S = m.shortBalance + m.pendShortDep[0] + m.pendShortDep[1];
    if (L === S) { if (ixs.length) await send(keeper, ...ixs).catch(() => {}); continue; }
    const side = L > S ? 1 : 0; // take the thinner side
    const botLong = pos ? valueOf(pos.longShares, sharePrice(m.longBalance, m.longShares)) : 0n;
    const botShort = pos ? valueOf(pos.shortShares, sharePrice(m.shortBalance, m.shortShares)) : 0n;
    if ((side === 1 && botLong > 0n) || (side === 0 && botShort > 0n)) continue; // never both sides
    const room = MM_MAX - (botLong + botShort + (pos ? pos.depLong + pos.depShort : 0n));
    let amt = L > S ? L - S : S - L;
    if (amt > room) amt = room;
    if (amt > budget) amt = budget;
    if (amt < MIN_ORDER) { if (ixs.length) await send(keeper, ...ixs).catch(() => {}); continue; }
    if (!pos) ixs.push(openPositionIx(keeper.publicKey, mk));
    ixs.push(depositIx(keeper.publicKey, mk, side, amt));
    try {
      console.log(`  backstop ${cfg.name}: ${side ? "SHORT" : "LONG"} ${Number(amt) / 1e9} SOL`, await send(keeper, ...ixs));
      budget -= amt;
    } catch (e) { console.log(`  backstop ${cfg.name} failed:`, e.message); }
  }
}

let round = 0;
while (Date.now() - started < RUN_FOR) {
  const t = Date.now();
  console.log(new Date().toISOString());
  round++;
  const step = async (name, fn) => { try { await fn(); } catch (e) { console.log(`${name} error:`, e.message); } };
  if (round % 10 === 1) await step("balance", async () => { if ((await solBalance(keeper.publicKey)) < 0.2) await tryAirdrop(keeper.publicKey); });
  await step("push", pushAll);
  await step("settle", settleFilled);
  // lighter steps every 3rd round to stay under the free RPC rate limit
  if (round % 3 === 1) {
    await step("duels", settleDuels);
    await step("house", houseDuels);
    await step("backstop", backstop);
    await step("predictions", settlePredictions);
    await step("house questions", housePredictions);
  }
  await sleep(Math.max(1000, INTERVAL - (Date.now() - t)));
}
console.log("keeper run finished; next scheduled run takes over");
