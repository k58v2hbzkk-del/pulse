import { Connection, PublicKey, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as P from "./sdk.js";

const RPC = new URLSearchParams(location.search).get("rpc") || "https://api.devnet.solana.com";
const DEMO = new URLSearchParams(location.search).has("demo");
const conn = new Connection(RPC, "confirmed");
const MARKET_IDS = [1, 2, 3, 4, 5];
const SOL = 1_000_000_000n;

const $ = (id) => document.getElementById(id);
let wallet = null; // { publicKey, provider }
let state = { markets: [], positions: new Map(), sol: 0 };
let openId = null;
let busy = false;

// ------------------------------------------------------------ helpers
const fmtN = (n) => Number(n).toLocaleString();
const pct = (a, b) => (b === 0 ? 0 : ((a - b) / b) * 100);
function toast(html, ms = 4000) {
  const t = $("toast");
  t.innerHTML = html;
  t.style.display = "block";
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.style.display = "none"), ms);
}
function linePath(vals, w, h, pad = 2) {
  if (vals.length < 2) return "";
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  return vals
    .map((v, i) => `${i ? "L" : "M"}${((i / (vals.length - 1)) * (w - pad * 2) + pad).toFixed(1)},${(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1)}`)
    .join(" ");
}
function chartSvg(vals, w, h, cls) {
  const up = vals.length > 1 && vals[vals.length - 1] >= vals[0];
  const color = up ? "var(--up)" : "var(--down)";
  const d = linePath(vals, w, h);
  const area = d ? `${d} L${w - 2},${h} L2,${h} Z` : "";
  return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="g${cls}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".25"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#g${cls})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}
const ago = (t) => { const s = Math.max(0, Math.floor(Date.now() / 1000 - t)); return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };

// ------------------------------------------------------------ data
function demoData() {
  const names = ["Counter-Strike 2", "Dota 2", "PUBG: Battlegrounds", "Marvel Rivals", "Apex Legends"];
  const bases = [1_250_000, 620_000, 410_000, 140_000, 95_000];
  const now = Math.floor(Date.now() / 1000);
  return names.map((name, k) => {
    const hist = Array.from({ length: 120 }, (_, i) => {
      const t = now - (119 - i) * 60;
      const price = BigInt(Math.round(bases[k] * (1 + 0.08 * Math.sin(i / 18 + k) + 0.01 * Math.sin(i * 1.7 + k))));
      return { epoch: BigInt(i), price, longSp: P.SCALE, shortSp: P.SCALE, time: t };
    });
    const lb = BigInt(80 + k * 30) * SOL, sb = BigInt(110 - k * 15) * SOL;
    return {
      pk: P.marketPda(k + 1), m: { id: k + 1, name, leverage: k > 2 ? 5 : 3, active: true, price: hist.at(-1).price, lastUpdate: now - 20,
        epoch: 120n, longBalance: lb, shortBalance: sb, longShares: lb, shortShares: sb }, hist,
    };
  });
}

async function load() {
  if (DEMO) {
    state.markets = demoData();
    $("banner").hidden = false;
    $("banner").innerHTML = "PREVIEW MODE — sample data for design review, not live markets.";
    return;
  }
  const pks = MARKET_IDS.map(P.marketPda);
  const infos = await conn.getMultipleAccountsInfo([...pks, ...pks.map(P.historyPda)]);
  const markets = [];
  pks.forEach((pk, i) => {
    const mi = infos[i], hi = infos[i + pks.length];
    if (!mi || !P.hasDisc(mi.data, "Market")) return;
    markets.push({ pk, m: P.decodeMarket(mi.data), hist: hi ? P.decodeHistory(hi.data) : [] });
  });
  state.markets = markets;
  if (!markets.length) {
    $("banner").hidden = false;
    $("banner").innerHTML = 'Markets are launching. Check back in a few minutes. <a href="?demo">See a preview</a>';
  } else $("banner").hidden = true;

  if (wallet) {
    const posPks = markets.map((x) => P.positionPda(x.pk, wallet.publicKey));
    const [posInfos, sol] = await Promise.all([
      conn.getMultipleAccountsInfo(posPks),
      conn.getBalance(wallet.publicKey),
    ]);
    state.positions = new Map();
    posInfos.forEach((pi, i) => { if (pi) state.positions.set(markets[i].pk.toBase58(), P.decodePosition(pi.data)); });
    state.sol = sol / LAMPORTS_PER_SOL;
  }
}

function positionView(x) {
  const pos = state.positions.get(x.pk.toBase58());
  if (!pos) return null;
  const lsp = P.sharePrice(x.m.longBalance, x.m.longShares);
  const ssp = P.sharePrice(x.m.shortBalance, x.m.shortShares);
  const longVal = P.valueOf(pos.longShares, lsp);
  const shortVal = P.valueOf(pos.shortShares, ssp);
  const ready = pos.pending && x.m.epoch >= pos.pendingEpoch + 2n;
  const updatesLeft = pos.pending ? Number(pos.pendingEpoch + 2n - x.m.epoch) : 0;
  return { pos, longVal, shortVal, ready, updatesLeft };
}

// ------------------------------------------------------------ render
const GLYPH = ["linear-gradient(135deg,#ff8a1f,#ff4d2e)", "linear-gradient(135deg,#e0483e,#7a1d16)", "linear-gradient(135deg,#f2b33d,#a0661a)", "linear-gradient(135deg,#d6336c,#5c1230)", "linear-gradient(135deg,#ff6b3d,#8a2a10)"];
const initials = (n) => n.split(/[\s:-]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 3).toUpperCase();

function render() {
  const top = state.markets[0];
  if (top) {
    const vals = top.hist.map((h) => Number(h.price));
    $("heroCard").innerHTML = `<div class="mhead"><span class="glyph" style="background:${GLYPH[0]}">${initials(top.m.name)}</span>
      <div><div class="mname">${top.m.name}</div><div class="msub">${top.m.leverage}x perpetual</div></div></div>
      ${chartSvg(vals.length > 1 ? vals : [1, 1], 400, 170, "vline")}`;
    $("heroPlayers").textContent = fmtN(top.m.price);
  }
  $("list").innerHTML = state.markets.map((x, k) => {
    const vals = x.hist.map((h) => Number(h.price));
    const first = vals.length ? vals[0] : Number(x.m.price);
    const ch = pct(Number(x.m.price), first);
    const lb = Number(x.m.longBalance), sb = Number(x.m.shortBalance), tot = lb + sb || 1;
    const pv = positionView(x);
    let mine = "";
    if (pv && (pv.longVal || pv.shortVal || pv.pos.pending)) {
      const parts = [];
      if (pv.longVal) parts.push(`LONG ${P.fmtSol(pv.longVal)} SOL`);
      if (pv.shortVal) parts.push(`SHORT ${P.fmtSol(pv.shortVal)} SOL`);
      if (pv.pos.pending) parts.push(pv.ready ? "order filled" : `filling · ${pv.updatesLeft} update${pv.updatesLeft === 1 ? "" : "s"}`);
      mine = `<div class="mine">You: ${parts.join(" · ")}</div>`;
    }
    return `<button class="mcard" data-id="${x.m.id}">
      <div class="mhead"><span class="glyph" style="background:${GLYPH[k % GLYPH.length]}">${initials(x.m.name)}</span>
        <div><div class="mname">${x.m.name}</div><div class="msub">${x.m.leverage}x · updated ${ago(x.m.lastUpdate)}</div></div></div>
      <div class="mprice"><b>${fmtN(x.m.price)}</b><span class="u">players</span><span class="chg ${ch >= 0 ? "up" : "down"}">${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%</span></div>
      ${chartSvg(vals.length > 1 ? vals : [first, first], 300, 70, "spark")}
      <div class="mfoot"><span>Pools <b>${P.fmtSol(x.m.longBalance + x.m.shortBalance)} SOL</b></span><span class="tbtn">Trade ›</span></div>
      <div class="pools"><i style="width:${(lb / tot) * 100}%;background:var(--up)"></i><i style="width:${(sb / tot) * 100}%;background:var(--down)"></i></div>
      ${mine}
    </button>`;
  }).join("");
  document.querySelectorAll(".mcard").forEach((c) => (c.onclick = () => openSheet(Number(c.dataset.id))));
  $("connect").textContent = wallet ? `${wallet.publicKey.toBase58().slice(0, 4)}…${wallet.publicKey.toBase58().slice(-4)}` : "Connect";
  if (openId != null) renderSheet();
}

function renderSheet() {
  const x = state.markets.find((y) => y.m.id === openId);
  if (!x) return;
  const vals = x.hist.map((h) => Number(h.price));
  const first = x.hist[0], last = x.hist.at(-1);
  const sens = P.sensitivity(x.m);
  const pv = positionView(x);
  const pending = pv?.pos.pending;
  let action = "";
  if (!wallet) action = `<button class="btn" style="width:100%;padding:15px;justify-content:center" id="sConnect">Connect wallet to trade</button>`;
  else {
    action = `
      <div class="row" style="font-size:12px;color:var(--mute);display:flex;justify-content:space-between;align-items:center"><span>Your balance: <b style="color:var(--text)">${state.sol.toLocaleString(undefined, { maximumFractionDigits: 3 })} SOL</b></span>
        <button class="btn ghost" id="faucet" style="padding:6px 10px;font-size:12px">Get free devnet SOL</button></div>
      <div class="amt"><input id="amt" inputmode="decimal" value="0.1" aria-label="Amount in SOL" /></div>
      <div class="chips">${[0.05, 0.1, 0.5, 1].map((v) => `<button data-v="${v}">${v} SOL</button>`).join("")}</div>
      <div class="trade"><button class="goLong" id="long" ${pending && !pv.ready ? "disabled" : ""}>Long ↑</button>
        <button class="goShort" id="short" ${pending && !pv.ready ? "disabled" : ""}>Short ↓</button></div>
      ${pv && (pv.longVal || pv.shortVal) ? `<div class="close2">
        <button class="btn ghost" id="closeL" ${!pv.longVal || (pending && !pv.ready) ? "disabled" : ""}>Close long ${P.fmtSol(pv.longVal)} SOL</button>
        <button class="btn ghost" id="closeS" ${!pv.shortVal || (pending && !pv.ready) ? "disabled" : ""}>Close short ${P.fmtSol(pv.shortVal)} SOL</button></div>` : ""}
      ${pending ? `<p class="hint">${pv.ready ? "Your last order is filled. Your next action finishes it automatically (the keeper also does this for you)." : `Your order fills after ${pv.updatesLeft} more price update${pv.updatesLeft === 1 ? "" : "s"} (about ${pv.updatesLeft} min).`}</p>` : ""}`;
  }
  $("panel").innerHTML = `<div class="grab"></div>
    <div class="row"><span class="mname" style="font-size:20px">${x.m.name}</span><span class="net">${x.m.leverage}x PERPETUAL</span></div>
    <div class="mprice"><b>${fmtN(x.m.price)}</b><span class="u">players right now</span></div>
    ${chartSvg(vals.length > 1 ? vals : [1, 1], 600, 160, "chart")}
    <div class="axis"><span>${first ? new Date(first.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span><span>live Steam data · on-chain</span><span>${last ? new Date(last.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span></div>
    <div class="stat">
      <div><span>If players +1%, longs earn</span><b class="up">+${(sens.longGain * 100).toFixed(2)}%</b></div>
      <div><span>If players −1%, shorts earn</span><b class="up">+${(sens.shortGain * 100).toFixed(2)}%</b></div>
      <div><span>Long pool</span><b>${P.fmtSol(x.m.longBalance)} SOL</b></div>
      <div><span>Short pool</span><b>${P.fmtSol(x.m.shortBalance)} SOL</b></div>
    </div>
    ${action}
    <p class="hint">Losses are capped at what you put in. Winners are paid from the other side's pool, never from a house.</p>`;
  const bind = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  bind("sConnect", connect);
  bind("faucet", () => run(faucet, true));
  bind("long", () => run(() => trade(x, 0)));
  bind("short", () => run(() => trade(x, 1)));
  bind("closeL", () => run(() => closeSide(x, 0)));
  bind("closeS", () => run(() => closeSide(x, 1)));
  document.querySelectorAll(".chips button").forEach((b) => (b.onclick = () => ($("amt").value = b.dataset.v)));
}

function openSheet(id) { openId = id; $("sheet").classList.add("open"); renderSheet(); }
$("sheet").onclick = (e) => { if (e.target.id === "sheet") { openId = null; $("sheet").classList.remove("open"); } };

// ------------------------------------------------------------ wallet + tx
function provider() {
  return window.phantom?.solana || window.solflare || window.backpack || window.solana || null;
}
async function connect() {
  const p = provider();
  if (!p) {
    const url = encodeURIComponent(location.href);
    toast(`No wallet found. <a href="https://phantom.app/ul/browse/${url}?ref=${url}">Open PULSE in Phantom</a>`, 9000);
    return;
  }
  const res = await p.connect();
  const pk = res?.publicKey || p.publicKey;
  wallet = { publicKey: new PublicKey(pk.toString()), provider: p };
  await refresh();
}
$("connect").onclick = () => (wallet ? null : connect());

async function sendTx(ixs) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  // Sign in the wallet, send to devnet ourselves (works whatever network the wallet is set to)
  const signed = await wallet.provider.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function ensureSol() {
  if (state.sol >= 0.003) return;
  try {
    const sig = await conn.requestAirdrop(wallet.publicKey, 0.5 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  } catch {
    throw new Error(`You need devnet SOL (free). Get it at <a href="https://faucet.solana.com" target="_blank">faucet.solana.com</a> for ${wallet.publicKey.toBase58().slice(0, 6)}…`);
  }
}

async function run(fn, skipSolCheck = false) {
  if (busy || DEMO) { if (DEMO) toast("Preview mode — connect on the live page to trade."); return; }
  busy = true;
  try {
    if (!skipSolCheck) await ensureSol();
    const sig = await fn();
    toast(`Done ✓ <a href="https://explorer.solana.com/tx/${sig}?cluster=devnet" target="_blank">view</a>`);
    await refresh();
  } catch (e) {
    console.error(e);
    toast(e.message?.includes("<a") ? e.message : `Failed: ${e.message || e}`, 8000);
  } finally { busy = false; }
}

async function faucet() {
  try {
    const sig = await conn.requestAirdrop(wallet.publicKey, 1 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    return sig;
  } catch {
    window.open("https://faucet.solana.com", "_blank");
    throw new Error(`Devnet airdrop is busy. Opened faucet.solana.com — paste ${wallet.publicKey.toBase58().slice(0, 6)}… and pick devnet.`);
  }
}

function preIxs(x) {
  const pv = positionView(x);
  const ixs = [];
  if (!pv) ixs.push(P.openPositionIx(wallet.publicKey, x.pk));
  else if (pv.pos.pending && pv.ready) ixs.push(P.settleIx(x.pk, wallet.publicKey));
  return ixs;
}

async function trade(x, side) {
  const amt = Number($("amt").value);
  if (!(amt >= 0.01)) throw new Error("Minimum is 0.01 SOL");
  const lamports = BigInt(Math.round(amt * 1e9));
  if (amt + 0.01 > state.sol) throw new Error("Not enough SOL — tap Get free devnet SOL");
  return sendTx([...preIxs(x), P.depositIx(wallet.publicKey, x.pk, side, lamports)]);
}

async function closeSide(x, side) {
  const pv = positionView(x);
  const shares = side === 0 ? pv.pos.longShares : pv.pos.shortShares;
  return sendTx([...preIxs(x), P.withdrawIx(wallet.publicKey, x.pk, side, shares)]);
}

// ------------------------------------------------------------ loop
async function refresh() {
  try { await load(); render(); } catch (e) { console.error(e); }
}
refresh();
setInterval(refresh, 15_000);
const p = provider();
if (p?.isConnected && p.publicKey) wallet = { publicKey: new PublicKey(p.publicKey.toString()), provider: p };
