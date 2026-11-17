// One-time (safe to re-run): creates the config, test-dollar mint and the launch markets.
import { conn, loadKey, send, solBalance, tryAirdrop, steamPlayers } from "./common.js";
import { configPda, marketPda, initConfigIx, createMarketIx, PROGRAM_ID } from "../app/sdk.js";
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
  const initialPrice = await steamPlayers(m.sourceId);
  const sig = await send(admin, createMarketIx(admin.publicKey, { ...m, initialPrice }));
  console.log(`created market ${m.id} ${m.name} @ ${initialPrice} players:`, sig);
}
console.log("setup done");
