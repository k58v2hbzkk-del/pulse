// PULSE client SDK — shared by the web app (browser) and the keeper (Node).
// No Anchor client needed: instructions and accounts are encoded by hand.
import { PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { Buffer } from "buffer";

export const PROGRAM_ID = new PublicKey("FEf5G58pDPipsFQJJzUTqHrnPkHaXqS2HABaU5Po9kTx");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
export const DECIMALS = 6;
export const SCALE = 1_000_000_000n;
export const HISTORY_LEN = 240;

const IX = {
  init_config: [23, 235, 115, 232, 168, 96, 1, 231],
  set_keeper: [102, 94, 23, 78, 157, 222, 243, 214],
  faucet: [0, 98, 59, 30, 144, 142, 113, 12],
  create_market: [103, 226, 97, 235, 200, 188, 251, 254],
  set_active: [29, 16, 225, 132, 38, 216, 206, 33],
  push_price: [113, 238, 232, 235, 60, 71, 127, 203],
  open_position: [135, 128, 47, 77, 15, 152, 240, 49],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  settle: [175, 42, 185, 87, 144, 131, 102, 212],
  init_index: [206, 236, 58, 58, 171, 221, 237, 57],
  set_feed: [79, 150, 2, 207, 41, 104, 77, 41],
};
export const ACCT = {
  Config: [155, 12, 170, 224, 30, 250, 204, 130],
  Market: [219, 190, 213, 55, 0, 227, 198, 154],
  History: [31, 216, 60, 33, 213, 209, 70, 101],
  Position: [170, 188, 143, 228, 122, 64, 247, 208],
  Index: [140, 66, 194, 132, 78, 26, 135, 186],
};
export const QUOTE_PROGRAM = new PublicKey("orac1eFjzWL5R3RbbdMV68K9H6TaCVVcL6LjvQQWAbz");
export const SB_DEVNET_QUEUE = new PublicKey("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7");
/** Canonical Switchboard quote account for one feed on the devnet queue. */
export const quotePda = (feedId) =>
  PublicKey.findProgramAddressSync([SB_DEVNET_QUEUE.toBuffer(), Buffer.from(feedId)], QUOTE_PROGRAM)[0];

// ------------------------------------------------------------ encoding helpers
const u8 = (v) => Buffer.from([v]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u128 = (v) => {
  const x = BigInt(v);
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(x & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(x >> 64n, 8);
  return b;
};
const str = (s) => { const d = Buffer.from(s, "utf8"); return Buffer.concat([u32(d.length), d]); };
const data = (name, ...parts) => Buffer.concat([Buffer.from(IX[name]), ...parts]);
const ix = (keys, d) => new TransactionInstruction({ programId: PROGRAM_ID, keys, data: d });
const w = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

// ------------------------------------------------------------ PDAs
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const configPda = () => pda([Buffer.from("config")]);
export const mintPda = () => pda([Buffer.from("mint")]);
export const marketPda = (id) => pda([Buffer.from("market"), u32(id)]);
export const historyPda = (market) => pda([Buffer.from("history"), market.toBuffer()]);
export const vaultPda = (market) => pda([Buffer.from("vault"), market.toBuffer()]);
export const indexPda = (market) => pda([Buffer.from("index"), market.toBuffer()]);
export const positionPda = (market, owner) => pda([Buffer.from("position"), market.toBuffer(), owner.toBuffer()]);
export const ataOf = (owner, mint = mintPda()) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

// ------------------------------------------------------------ instructions
export function createAtaIx(payer, owner, mint = mintPda()) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [w(payer, true), w(ataOf(owner, mint)), r(owner), r(mint), r(SystemProgram.programId), r(TOKEN_PROGRAM)],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

export const initConfigIx = (admin, keeper, feeBps) =>
  ix([w(admin, true), w(configPda()), w(mintPda()), r(TOKEN_PROGRAM), r(SystemProgram.programId), r(RENT)],
    data("init_config", keeper.toBuffer(), u16(feeBps)));

export const setKeeperIx = (admin, keeper) => ix([r(admin, true), w(configPda())], data("set_keeper", keeper.toBuffer()));

export const faucetIx = (user, amount) =>
  ix([r(configPda()), w(mintPda()), w(ataOf(user)), r(TOKEN_PROGRAM)], data("faucet", u64(amount)));

export function createMarketIx(admin, { id, name, sourceId, leverage, initialPrice }) {
  const market = marketPda(id);
  return ix(
    [w(admin, true), r(configPda()), r(mintPda()), w(market), w(historyPda(market)), w(vaultPda(market)),
      r(TOKEN_PROGRAM), r(SystemProgram.programId), r(RENT)],
    data("create_market", u32(id), str(name), u64(sourceId), u8(leverage), u64(initialPrice)),
  );
}

export const setActiveIx = (admin, market, active) =>
  ix([r(admin, true), r(configPda()), w(market)], data("set_active", u8(active ? 1 : 0)));

/** quote = Switchboard quote account in oracle mode, any account (e.g. SystemProgram) in keeper mode */
export const pushPriceIx = (cranker, market, price, quote = SystemProgram.programId) =>
  ix([r(cranker, true), r(configPda()), w(market), w(historyPda(market)), w(indexPda(market)), r(quote)],
    data("push_price", u64(price)));

export const initIndexIx = (admin, market, feedId = new Uint8Array(32)) =>
  ix([w(admin, true), r(configPda()), r(market), w(indexPda(market)), r(SystemProgram.programId)],
    data("init_index", Buffer.from(feedId)));

export const setFeedIx = (admin, market, feedId) =>
  ix([r(admin, true), r(configPda()), r(market), w(indexPda(market))], data("set_feed", Buffer.from(feedId)));

export const openPositionIx = (owner, market) =>
  ix([w(owner, true), r(market), w(positionPda(market, owner)), r(SystemProgram.programId)], data("open_position"));

/** amount is in lamports (1 SOL = 1e9) */
export const depositIx = (owner, market, side, amount) =>
  ix([w(owner, true), r(configPda()), w(market), w(positionPda(market, owner)), r(SystemProgram.programId)],
    data("deposit", u8(side), u64(amount)));

export const withdrawIx = (owner, market, side, shares) =>
  ix([r(owner, true), w(market), w(positionPda(market, owner))], data("withdraw", u8(side), u128(shares)));

export const settleIx = (market, owner) =>
  ix([r(configPda()), w(market), r(historyPda(market)), w(positionPda(market, owner)), w(owner)], data("settle"));

// ------------------------------------------------------------ decoding
const view = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const rd64 = (dv, o) => dv.getBigUint64(o, true);
const rd128 = (dv, o) => dv.getBigUint64(o, true) + (dv.getBigUint64(o + 8, true) << 64n);
const key = (buf, o) => new PublicKey(buf.subarray(o, o + 32));
export const hasDisc = (buf, name) => ACCT[name].every((b, i) => buf[i] === b);

export function decodeConfig(buf) {
  const dv = view(buf);
  return { admin: key(buf, 8), keeper: key(buf, 40), mint: key(buf, 72), feeBps: dv.getUint16(104, true) };
}

export function decodeMarket(buf) {
  const dv = view(buf);
  const nameBytes = buf.subarray(16, 48);
  const end = nameBytes.indexOf(0);
  return {
    id: dv.getUint32(8, true),
    leverage: buf[14],
    active: buf[15] === 1,
    name: new TextDecoder().decode(end === -1 ? nameBytes : nameBytes.subarray(0, end)),
    sourceId: rd64(dv, 48),
    price: rd64(dv, 56),
    lastUpdate: Number(dv.getBigInt64(64, true)),
    epoch: rd64(dv, 72),
    history: key(buf, 80),
    longBalance: rd64(dv, 112),
    shortBalance: rd64(dv, 120),
    longShares: rd128(dv, 128),
    shortShares: rd128(dv, 144),
    pendLongDep: [rd64(dv, 160), rd64(dv, 168)],
    pendShortDep: [rd64(dv, 176), rd64(dv, 184)],
    reserved: rd64(dv, 256),
    fees: rd64(dv, 264),
  };
}

export function decodePosition(buf) {
  const dv = view(buf);
  return {
    owner: key(buf, 8),
    market: key(buf, 40),
    longShares: rd128(dv, 73),
    shortShares: rd128(dv, 89),
    pending: buf[105] === 1,
    pendingEpoch: rd64(dv, 106),
    depLong: rd64(dv, 114),
    depShort: rd64(dv, 122),
    wdLong: rd128(dv, 130),
    wdShort: rd128(dv, 146),
  };
}

export function decodeIndex(buf) {
  const dv = view(buf);
  const feedId = buf.subarray(40, 72);
  return {
    market: key(buf, 8),
    feedId: Uint8Array.from(feedId),
    oracle: feedId.some((b) => b !== 0),
    lastRaw: rd64(dv, 72),
    lastTime: Number(dv.getBigInt64(80, true)),
  };
}

/** Returns history points sorted oldest -> newest: {epoch, price, longSp, shortSp, time} */
export function decodeHistory(buf) {
  const dv = view(buf);
  const base = 40, n = HISTORY_LEN, out = [];
  for (let i = 0; i < n; i++) {
    const e = rd64(dv, base + i * 8);
    if (e === 0n) continue;
    out.push({
      epoch: e - 1n,
      price: rd64(dv, base + n * 8 + i * 8),
      longSp: rd64(dv, base + n * 16 + i * 8),
      shortSp: rd64(dv, base + n * 24 + i * 8),
      time: Number(dv.getBigInt64(base + n * 32 + i * 8, true)),
    });
  }
  return out.sort((a, b) => (a.epoch < b.epoch ? -1 : 1));
}

// ------------------------------------------------------------ pool math (mirror of math.rs)
export const sharePrice = (balance, shares) => {
  if (shares === 0n) return SCALE;
  const sp = (balance * SCALE) / shares;
  return sp < 1n ? 1n : sp;
};
export const valueOf = (shares, sp) => (shares * sp) / SCALE;

/** Payout multiple for a +/-1% index move, given current pool sizes. */
export function sensitivity(m) {
  const L = BigInt(m.leverage);
  const lb = Number(m.longBalance), sb = Number(m.shortBalance);
  // winners gain transfer/winnerPool where transfer ~= L*1% of loser pool
  const longGain = lb > 0 ? (Number(L) * 0.01 * sb) / lb : Number(L) * 0.01;
  const shortGain = sb > 0 ? (Number(L) * 0.01 * lb) / sb : Number(L) * 0.01;
  return { longGain, shortGain };
}

export const LAMPORTS = 1_000_000_000n;
/** lamports -> "1.234" SOL */
export const fmtSol = (lamports) => (Number(lamports) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 3 });
