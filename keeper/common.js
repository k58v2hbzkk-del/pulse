import { Connection, Keypair, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";

export const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
export const conn = new Connection(RPC, "confirmed");

export function loadKey(envName = "ADMIN_KEY") {
  const raw = process.env[envName];
  if (!raw) throw new Error(`Missing ${envName} secret (JSON array of the keypair)`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

export async function send(payer, ...ixs) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

export async function solBalance(pk) {
  return (await conn.getBalance(pk)) / LAMPORTS_PER_SOL;
}

export async function tryAirdrop(pk) {
  try {
    const sig = await conn.requestAirdrop(pk, 1 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    console.log("airdrop ok");
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
