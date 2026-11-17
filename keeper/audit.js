// Public auditor: checks every market's latest on-chain reading against Steam's live number.
// Anyone can fork this repo and run it. A red run = the posted data didn't match Steam.
import fs from "fs";
import { conn, steamPlayers, sleep } from "./common.js";
import { marketPda, indexPda, decodeIndex, decodeMarket } from "../app/sdk.js";
import { MARKETS } from "./markets.js";

const ROUNDS = Number(process.env.AUDIT_ROUNDS || 5);
const TOLERANCE = Number(process.env.AUDIT_TOLERANCE_PCT || 5); // Steam moves a little between reads
const rows = [];
let flagged = 0;

for (let r = 0; r < ROUNDS; r++) {
  for (const m of MARKETS) {
    const mk = marketPda(m.id);
    const [mi, ii] = await conn.getMultipleAccountsInfo([mk, indexPda(mk)]);
    if (!mi || !ii) continue;
    const idx = decodeIndex(ii.data);
    const market = decodeMarket(mi.data);
    let steam;
    try { steam = await steamPlayers(m.sourceId); } catch { continue; }
    const onchain = Number(idx.lastRaw);
    const age = Math.round(Date.now() / 1000 - idx.lastTime);
    const dev = (Math.abs(onchain - steam) / steam) * 100;
    const ok = dev <= TOLERANCE && age < 600;
    if (!ok) flagged++;
    rows.push({ time: new Date().toISOString().slice(11, 19), market: m.name, steam, onchain, dev: dev.toFixed(2), age, index: Number(market.price), ok });
    console.log(`${ok ? "OK  " : "FLAG"} ${m.name}: steam=${steam} on-chain=${onchain} (${dev.toFixed(2)}%, ${age}s old) index=${market.price}`);
  }
  if (r < ROUNDS - 1) await sleep(60_000);
}

const md = [
  `## PULSE data audit`,
  `Checked ${rows.length} readings against Steam's public API. Tolerance ${TOLERANCE}%, max age 10 min.`,
  ``,
  `| time (UTC) | market | Steam now | on-chain | diff | age | result |`,
  `|---|---|---|---|---|---|---|`,
  ...rows.map((x) => `| ${x.time} | ${x.market} | ${x.steam.toLocaleString()} | ${x.onchain.toLocaleString()} | ${x.dev}% | ${x.age}s | ${x.ok ? "✅" : "🚩"} |`),
  ``,
  flagged ? `**🚩 ${flagged} reading(s) did not match Steam.**` : `**✅ All readings matched Steam.**`,
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
if (flagged) process.exit(1);
