// One-time (safe to re-run): creates the config, test-dollar mint and the launch markets.
import { conn, loadKey, send, solBalance, tryAirdrop } from "./common.js";
import { readSource } from "./sources.js";
import {
  configPda, marketPda, indexPda, quotePda, initConfigIx, createMarketIx, initIndexIx, setFeedIx, pushPriceIx, PROGRAM_ID,
} from "../app/sdk.js";
import { feedIdOf, sendWithUpdate } from "./oracle.js";
import { MARKETS } from "./markets.js";

const admin = loadKey();
console.log("admin/keeper:", admin.publicKey.toBase58(), "SOL:", await solBalance(admin.publicKey));
if ((await solBalance(admin.publicKey)) < 0.5) await tryAirdrop(admin.publicKey);

const prog = await conn.getAccountInfo(PROGRAM_ID);
if (!prog) throw new Error("Program not deployed yet — run the Deploy workflow first");

if (!(await conn.getAccountInfo(configPda()))) {
  console.log("init config:", await send(admin, initConfigIx(admin.publicKey, admin.publicKey, 30)));
} else console.log("config exists");

for (const m of MARKETS) {
  if (await conn.getAccountInfo(marketPda(m.id))) { console.log(`market ${m.id} exists`); continue; }
  let initialPrice;
  try { initialPrice = await readSource(m); } catch (e) { console.log(`skip market ${m.id} ${m.name}: ${e.message}`); continue; }
  const sig = await send(admin, createMarketIx(admin.publicKey, { ...m, initialPrice }));
  console.log(`created market ${m.id} ${m.name} @ ${initialPrice}:`, sig);
}
// 24h index accounts (start in keeper mode)
for (const m of MARKETS) {
  const mk = marketPda(m.id);
  if (!(await conn.getAccountInfo(mk))) continue;
  if (await conn.getAccountInfo(indexPda(mk))) { console.log(`index ${m.id} exists`); continue; }
  console.log(`index ${m.id}:`, await send(admin, initIndexIx(admin.publicKey, mk)));
}

// Switch each market to the Switchboard oracle, but only after a real signed update works.
if (process.env.ENABLE_ORACLE === "1") {
  for (const m of MARKETS.filter((x) => x.kind === "steam")) {
    const mk = marketPda(m.id);
    const feedId = feedIdOf(m);
    try {
      // turn oracle mode on and immediately crank one verified update in the same step
      await send(admin, setFeedIx(admin.publicKey, mk, feedId));
      const sig = await sendWithUpdate(admin, m, pushPriceIx(admin.publicKey, mk, 0, quotePda(feedId)));
      console.log(`oracle ON for ${m.name} (feed 0x${Buffer.from(feedId).toString("hex")}):`, sig);
    } catch (e) {
      console.log(`oracle not available for ${m.name}, staying in keeper mode: ${e.message?.slice(0, 300)}`);
      await send(admin, setFeedIx(admin.publicKey, mk, new Uint8Array(32))).catch(() => {});
    }
  }
}
console.log("setup done");
