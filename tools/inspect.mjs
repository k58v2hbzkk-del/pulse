// Prints on-chain state of every market and the Backstop's positions.
import { Connection, PublicKey } from "@solana/web3.js";
import * as P from "../app/sdk.js";
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const keeper = new PublicKey(process.env.KEEPER || "7EGXZbPkDnDy2z8oWpKRJhufQnCRKT3MBPmFcNhqGbXk");
console.log("keeper SOL", (await conn.getBalance(keeper)) / 1e9);
for (const id of [1, 2, 3, 4, 5]) {
  const mk = P.marketPda(id);
  const [mi, pi, ii] = await conn.getMultipleAccountsInfo([mk, P.positionPda(mk, keeper), P.indexPda(mk)]);
  const m = P.decodeMarket(mi.data);
  const pos = pi ? P.decodePosition(pi.data) : null;
  const idx = ii ? P.decodeIndex(ii.data) : null;
  console.log(`#${id} ${m.name} epoch=${m.epoch} price=${m.price} raw=${idx?.lastRaw} L=${m.longBalance} S=${m.shortBalance} pendL=${m.pendLongDep} pendS=${m.pendShortDep}`,
    pos ? `| backstop long=${pos.longShares} short=${pos.shortShares} pending=${pos.pending} depL=${pos.depLong} depS=${pos.depShort}` : "| backstop: no position");
}
