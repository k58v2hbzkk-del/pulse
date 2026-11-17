// The keeper: posts live attention data on-chain every INTERVAL seconds and auto-settles
// filled orders for users. Runs inside GitHub Actions for free (restarts every ~6h).
import { conn, loadKey, send, solBalance, tryAirdrop, steamPlayers, sleep } from "./common.js";
import {
  PROGRAM_ID, marketPda, pushPriceIx, settleIx, decodeMarket, decodePosition, ACCT,
} from "../app/sdk.js";
import { MARKETS } from "./markets.js";
import bs58 from "bs58";

const keeper = loadKey();
const INTERVAL = Number(process.env.INTERVAL_SEC || 60) * 1000;
const RUN_FOR = Number(process.env.RUN_MINUTES || 345) * 60_000;
const started = Date.now();
console.log("keeper:", keeper.publicKey.toBase58(), "interval", INTERVAL / 1000, "s");

async function pushAll() {
  const ixs = [];
  for (const m of MARKETS) {
    try {
      const players = await steamPlayers(m.sourceId);
      ixs.push(pushPriceIx(keeper.publicKey, marketPda(m.id), players));
      console.log(`  ${m.name}: ${players}`);
    } catch (e) {
      console.log(`  ${m.name}: skipped (${e.message})`);
    }
  }
  if (ixs.length) console.log("  pushed:", await send(keeper, ...ixs));
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

while (Date.now() - started < RUN_FOR) {
  const t = Date.now();
  console.log(new Date().toISOString());
  try {
    if ((await solBalance(keeper.publicKey)) < 0.2) await tryAirdrop(keeper.publicKey);
    await pushAll();
    await settleFilled();
  } catch (e) {
    console.log("round error:", e.message);
  }
  await sleep(Math.max(1000, INTERVAL - (Date.now() - t)));
}
console.log("keeper run finished; next scheduled run takes over");
