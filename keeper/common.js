import bs58 from "bs58";
import { Connection, Keypair, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";

export const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
export const conn = new Connection(RPC, { commitment: "confirmed", disableRetryOnRateLimit: false });
// One failed request must never kill the keeper.
process.on("unhandledRejection", (e) => console.log("unhandled:", e?.message || e));
process.on("uncaughtException", (e) => console.log("uncaught:", e?.message || e));

export function loadKey(envName = "ADMIN_KEY") {
  const raw = process.env[envName];
  if (!raw) throw new Error(`Missing ${envName} secret (JSON array of the keypair)`);
  const t = raw.trim();
  // accepts a JSON array (Solana CLI) or a base58 private key (exported from Phantom/Solflare)
  const bytes = t.startsWith("[") ? Uint8Array.from(JSON.parse(t)) : bs58.decode(t);
  return Keypair.fromSecretKey(bytes);
}

// Send + confirm by polling (no websocket — the free devnet RPC rate-limits websockets hard).
export async function send(payer, ...ixs) {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`tx failed ${JSON.stringify(st.err)} ${sig}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    if (i % 10 === 9 && (await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error(`tx expired ${sig}`);
  }
  throw new Error(`tx not confirmed in time ${sig}`);
}

export async function solBalance(pk) {
  return (await conn.getBalance(pk)) / LAMPORTS_PER_SOL;
}

export async function tryAirdrop(pk) {
  try {
    const sig = await conn.requestAirdrop(pk, 1 * LAMPORTS_PER_SOL);
    console.log("airdrop requested", sig);
  } catch (e) {
    console.log("airdrop failed (devnet faucet is rate-limited) — top up at https://faucet.solana.com :", pk.toBase58());
  }
}

/** Live player count for a Steam app — the attention index. */
export async function steamPlayers(appId) {
  const url = `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`steam ${appId} http ${res.status}`);
  const j = await res.json();
  const n = j?.response?.player_count;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`steam ${appId} bad response`);
  return n;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
