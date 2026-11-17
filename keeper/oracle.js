// Switchboard On-Demand: fetch oracle-signed updates for our Steam feeds.
import * as sb from "@switchboard-xyz/on-demand";
import { CrossbarClient, FeedHash } from "@switchboard-xyz/common";
import { conn } from "./common.js";
import { SB_DEVNET_QUEUE } from "../app/sdk.js";
import { steamFeed } from "./markets.js";

let ctx = null;
async function init(keeper) {
  if (ctx) return ctx;
  const wallet = {
    publicKey: keeper.publicKey,
    signTransaction: async (t) => { t.sign?.([keeper]); return t; },
    signAllTransactions: async (ts) => ts,
    payer: keeper,
  };
  const program = await sb.AnchorUtils.loadProgramFromConnection(conn, wallet);
  const queue = new sb.Queue(program, SB_DEVNET_QUEUE);
  ctx = { program, queue, crossbar: CrossbarClient.default() };
  return ctx;
}

export const feedIdOf = (m) => new Uint8Array(FeedHash.computeOracleFeedId(steamFeed(m)));

/** Instructions that verify + store a fresh signed reading in the feed's quote account. */
export async function updateIxs(keeper, m) {
  const { queue, crossbar } = await init(keeper);
  return queue.fetchManagedUpdateIxs(crossbar, [steamFeed(m)], { numSignatures: 1, payer: keeper.publicKey });
}

/** Send managed update + our push in one v0 transaction. */
export async function sendWithUpdate(keeper, m, pushIx) {
  const ixs = await updateIxs(keeper, m);
  const tx = await sb.asV0Tx({ connection: conn, ixs: [...ixs, pushIx], signers: [keeper], computeUnitPrice: 10_000, computeUnitLimitMultiple: 1.3 });
  const sig = await conn.sendTransaction(tx, { preflightCommitment: "processed" });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}
