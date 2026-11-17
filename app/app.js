import { Connection, PublicKey, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as P from "./sdk.js";
import { MARKETS } from "../keeper/markets.js";

const RPC = new URLSearchParams(location.search).get("rpc") || "https://api.devnet.solana.com";
const DEMO = new URLSearchParams(location.search).has("demo");
const conn = new Connection(RPC, "confirmed");
const MARKET_IDS = MARKETS.map((m) => m.id);
const META = Object.fromEntries(MARKETS.map((m) => [m.id, m]));
const UNIT = { steam: "playing now", twitch: "watching now", wiki: "views yesterday", github: "stars / day" };
const CATS = [["all", "All"], ["games", "Games"], ["streams", "Streams"], ["code", "Code"], ["topics", "Topics"]];
const unitOf = (x) => UNIT[META[x.m.id]?.kind] || "now";
let cat = "all";
let tab = new URLSearchParams(location.search).has("duel") ? "duels" : "perps";
const SOL = 1_000_000_000n;

const $ = (id) => document.getElementById(id);
let wallet = null; // { publicKey, provider }
let state = { markets: [], positions: new Map(), sol: 0, duels: [] };
let openId = null;
let busy = false;

// ------------------------------------------------------------ helpers
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ""; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
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
        epoch: 120n, longBalance: lb, shortBalance: sb, longShares: lb, shortShares: sb, pendLongDep: [0n, 0n], pendShortDep: [0n, 0n] }, hist, idx: { lastRaw: hist.at(-1).price + 31_000n, oracle: false },
    };
  });
}

async function load() {
  if (DEMO) {
    state.markets = demoData();
    const now = Math.floor(Date.now() / 1000);
    const fake = (n) => new PublicKey(new Uint8Array(32).fill(n));
    state.duels = [
      { pk: fake(41), d: { market: state.markets[0].pk, creator: fake(7), opponent: PublicKey.default, winner: PublicKey.default, stake: 100000000n, target: 600000n, settledValue: 0n, deadline: now + 20 * 3600, created: now, above: true, state: 0, private: false } },
      { pk: fake(42), d: { market: state.markets[3].pk, creator: fake(8), opponent: PublicKey.default, winner: PublicKey.default, stake: 500000000n, target: 25000n, settledValue: 0n, deadline: now + 3 * 86400, created: now - 60, above: false, state: 0, private: false } },
    ];
    $("banner").hidden = false;
    $("banner").innerHTML = "PREVIEW MODE — sample data for design review, not live markets.";
    return;
  }
  const pks = MARKET_IDS.map(P.marketPda);
  const infos = await conn.getMultipleAccountsInfo([...pks, ...pks.map(P.historyPda), ...pks.map(P.indexPda)]);
  const markets = [];
  pks.forEach((pk, i) => {
    const mi = infos[i], hi = infos[i + pks.length], xi = infos[i + 2 * pks.length];
    if (!mi || !P.hasDisc(mi.data, "Market")) return;
    const idx = xi && P.hasDisc(xi.data, "Index") ? P.decodeIndex(xi.data) : null;
    markets.push({ pk, m: P.decodeMarket(mi.data), hist: hi ? P.decodeHistory(hi.data) : [], idx });
  });
  state.markets = markets;
  if (!markets.length) {
    $("banner").hidden = false;
    $("banner").innerHTML = 'Markets are launching. Check back in a few minutes. <a href="?demo">See a preview</a>';
  } else $("banner").hidden = true;

  if (!state.house) {
    try { const ci = await conn.getAccountInfo(P.configPda()); if (ci) state.house = P.decodeConfig(ci.data).keeper; } catch {}
  }
  try {
    const raw = await conn.getProgramAccounts(P.PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: b58(Uint8Array.from(P.ACCT.Duel)) } }] });
    state.duels = raw.map(({ pubkey, account }) => ({ pk: pubkey, d: P.decodeDuel(account.data) })).sort((a, b) => b.d.created - a.d.created);
  } catch (e) { console.warn("duels", e); }

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
  let order = "";
  if (pos.pending) {
    const when = ready ? "filled" : `joins in ~${updatesLeft} min`;
    if (pos.depLong) order = `${P.fmtSol(pos.depLong)} SOL LONG · ${when}`;
    else if (pos.depShort) order = `${P.fmtSol(pos.depShort)} SOL SHORT · ${when}`;
    else order = `Closing ${pos.wdLong ? "long" : "short"} · ${ready ? "paid out" : `pays out in ~${updatesLeft} min`}`;
  }
  return { pos, longVal, shortVal, ready, updatesLeft, order };
}
const pendingOf = (m) => ({ long: m.pendLongDep[0] + m.pendLongDep[1], short: m.pendShortDep[0] + m.pendShortDep[1] });

// ------------------------------------------------------------ render
const livePlayers = (x) => (x.idx && x.idx.lastRaw ? x.idx.lastRaw : x.m.price);
const sourceBadge = (x) => x.idx?.oracle
  ? `<span style="color:var(--up)">✓ Switchboard-verified</span>`
  : `<a href="https://github.com/k58v2hbzkk-del/pulse/actions/workflows/audit.yml" target="_blank" rel="noopener" style="color:var(--brand2);text-decoration:none">audited hourly ↗</a>`;
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
  $("cats").innerHTML = CATS.filter(([c]) => c === "all" || state.markets.some((x) => META[x.m.id]?.cat === c))
    .map(([c, l]) => `<button data-cat="${c}" class="${c === cat ? "on" : ""}">${l}</button>`).join("");
  document.querySelectorAll("#cats button").forEach((b) => (b.onclick = () => { cat = b.dataset.cat; render(); }));
  const shown = state.markets.filter((x) => cat === "all" || META[x.m.id]?.cat === cat);
  $("list").innerHTML = shown.map((x, k) => {
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
      if (pv.order) parts.push(`Order: ${pv.order}`);
      mine = `<div class="mine">${parts.join("<br>")}</div>`;
    }
    return `<button class="mcard" data-id="${x.m.id}">
      <div class="mhead"><span class="glyph" style="background:${GLYPH[k % GLYPH.length]}">${initials(x.m.name)}</span>
        <div><div class="mname">${x.m.name}</div><div class="msub">${x.m.leverage}x · updated ${ago(x.m.lastUpdate)}</div></div></div>
      <div class="mprice"><b>${fmtN(livePlayers(x))}</b><span class="u">${unitOf(x)}</span><span class="chg ${ch >= 0 ? "up" : "down"}">${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%</span></div>
      <div class="msub">24h index <b style="color:var(--text)">${fmtN(x.m.price)}</b> · ${sourceBadge(x)}</div>
      ${chartSvg(vals.length > 1 ? vals : [first, first], 300, 70, "spark")}
      <div class="mfoot"><span>Pools <b>${P.fmtSol(x.m.longBalance + x.m.shortBalance)} SOL</b></span><span class="tbtn">Trade ›</span></div>
      <div class="pools"><i style="width:${(lb / tot) * 100}%;background:var(--up)"></i><i style="width:${(sb / tot) * 100}%;background:var(--down)"></i></div>
      ${mine}
    </button>`;
  }).join("");
  document.querySelectorAll(".mcard").forEach((c) => (c.onclick = () => openSheet(Number(c.dataset.id))));
  renderDuels();
  $("perpsTab").hidden = tab !== "perps"; $("duelsTab").hidden = tab !== "duels";
  document.querySelectorAll("#seg button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("connect").textContent = wallet ? `${wallet.publicKey.toBase58().slice(0, 4)}…${wallet.publicKey.toBase58().slice(-4)}` : "Connect";
  if (openId != null) renderSheet();
}

function renderSheet() {
  const x = state.markets.find((y) => y.m.id === openId);
  if (!x) return;
  const vals = x.hist.map((h) => Number(h.price));
  const first = x.hist[0], last = x.hist.at(-1);
  const pend = pendingOf(x.m);
  const sens = P.sensitivity({ ...x.m, longBalance: x.m.longBalance + pend.long, shortBalance: x.m.shortBalance + pend.short });
  const pv = positionView(x);
  const joining = (v) => (v ? ` <span style="font-size:11px;color:var(--brand2)">+${P.fmtSol(v)} joining</span>` : "");
  const yours = pv && (pv.longVal || pv.shortVal || pv.order) ? `<div class="stat" style="grid-template-columns:1fr">
      <div style="border-color:#3d2a12;background:#1c1309"><span>Your position</span>
      ${pv.longVal ? `<b class="up">LONG ${P.fmtSol(pv.longVal)} SOL</b>` : ""}${pv.shortVal ? `<b class="down">SHORT ${P.fmtSol(pv.shortVal)} SOL</b>` : ""}
      ${pv.order ? `<b style="font-size:13px;color:var(--brand2)">Order: ${pv.order}</b>` : ""}</div></div>` : "";
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
      ${pending ? `<p class="hint">${pv.ready ? "Your order is in. It shows in your position within a minute." : `Your order is waiting to join the pool. It joins after ${pv.updatesLeft} more price update${pv.updatesLeft === 1 ? "" : "s"} (about ${pv.updatesLeft} min), so nobody can trade on a number they've already seen.`}</p>` : ""}`;
  }
  $("panel").innerHTML = `<div class="grab"></div>
    <div class="row"><span class="mname" style="font-size:20px">${x.m.name}</span><span class="net">${x.m.leverage}x PERPETUAL</span></div>
    <div class="mprice"><b>${fmtN(livePlayers(x))}</b><span class="u">${unitOf(x)}</span></div>
    <div class="msub">You trade the <b style="color:var(--text)">24h average: ${fmtN(x.m.price)}</b> · ${sourceBadge(x)}</div>
    ${chartSvg(vals.length > 1 ? vals : [1, 1], 600, 160, "chart")}
    <div class="axis"><span>${first ? new Date(first.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span><span>24h index · on-chain</span><span>${last ? new Date(last.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span></div>
    <div class="stat">
      <div><span>If the index +1%, longs earn</span><b class="up">+${(sens.longGain * 100).toFixed(2)}%</b></div>
      <div><span>If the index −1%, shorts earn</span><b class="up">+${(sens.shortGain * 100).toFixed(2)}%</b></div>
      <div><span>Long pool</span><b>${P.fmtSol(x.m.longBalance)} SOL${joining(pend.long)}</b></div>
      <div><span>Short pool</span><b>${P.fmtSol(x.m.shortBalance)} SOL${joining(pend.short)}</b></div>
    </div>
    ${yours}
    ${action}
    <p class="hint"><b style="color:var(--brand2)">Always someone on the other side.</b> When a market is one-sided, the PULSE Backstop matches your trade (up to 0.5 SOL per market), so you can win even when nobody else is online.</p>
    <p class="hint">You can't lose more than the SOL you put in. Winners are paid from the other side's pool.</p>
    <div class="lbl" style="margin-top:16px">Market chat</div>
    ${chatBox(x.pk.toBase58())}`;
  const bind = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  bind("sConnect", connect);
  bind("faucet", () => run(faucet, true));
  bind("long", () => run(() => trade(x, 0)));
  bind("short", () => run(() => trade(x, 1)));
  bind("closeL", () => run(() => closeSide(x, 0)));
  bind("closeS", () => run(() => closeSide(x, 1)));
  document.querySelectorAll(".chips button").forEach((b) => (b.onclick = () => ($("amt").value = b.dataset.v)));
  bindChat();
}

function openSheet(id) {
  openId = id; $("sheet").classList.add("open"); renderSheet();
  const x = state.markets.find((y) => y.m.id === id);
  if (x && !DEMO) loadChat(x.pk.toBase58()).then(() => openId === id && renderSheet());
}
$("sheet").onclick = (e) => { if (e.target.id === "sheet") { openId = null; $("sheet").classList.remove("open"); } };
document.querySelectorAll("#seg button").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));
$("newDuel").onclick = () => openDuelSheet();
$("joinBtn").onclick = () => joinWithCode();

// ------------------------------------------------------------ duels
const short = (pk) => `${pk.toBase58().slice(0, 4)}…${pk.toBase58().slice(-4)}`;
const when = (ts) => new Date(ts * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const mkOf = (pk) => state.markets.find((x) => x.pk.equals(pk));
let duelDraft = null; // { id, above, target, hours, stake, priv }
let focusDuel = new URLSearchParams(location.search).get("duel");
const codes = {}; // duel address -> join secret the user knows
try { Object.assign(codes, JSON.parse(localStorage.getItem("pulse_codes") || "{}")); } catch {}
const saveCodes = () => { try { localStorage.setItem("pulse_codes", JSON.stringify(codes)); } catch {} };
{ const q = new URLSearchParams(location.search); if (q.get("duel") && q.get("code")) { codes[q.get("duel")] = q.get("code"); saveCodes(); } }
let chatOpen = null;           // target address whose chat is open
const chatCache = {};          // target -> messages
async function loadChat(targetStr) {
  try { chatCache[targetStr] = await P.fetchChat(conn, new PublicKey(targetStr), 25); } catch (e) { console.warn("chat", e); chatCache[targetStr] = chatCache[targetStr] || []; }
}
function chatBox(targetStr) {
  const msgs = chatCache[targetStr];
  const me = wallet?.publicKey?.toBase58();
  const list = !msgs ? `<div class="hint">Loading chat…</div>` : !msgs.length ? `<div class="hint">No messages yet. Say something.</div>`
    : msgs.map((m) => `<div class="msg ${m.author.toBase58() === me ? "me" : ""}"><span>${m.author.toBase58() === me ? "you" : short(m.author)}</span>${esc(m.text)}</div>`).join("");
  return `<div class="chat" data-room="${targetStr}"><div class="msgs">${list}</div>
    ${wallet ? `<div class="send"><input maxlength="280" placeholder="Talk your talk…" data-chatin="${targetStr}"/><button class="btn sm" data-chatsend="${targetStr}">Send</button></div>` : `<div class="hint">Connect your wallet to chat.</div>`}</div>`;
}
const esc = (t) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function bindChat() {
  document.querySelectorAll("[data-chatsend]").forEach((b) => (b.onclick = () => {
    const t = b.dataset.chatsend; const inp = document.querySelector(`[data-chatin="${t}"]`);
    const text = inp.value.trim(); if (!text) return;
    run(async () => { const sig = await sendTx([P.postMessageIx(wallet.publicKey, new PublicKey(t), text)]); inp.value = ""; await loadChat(t); return sig; });
  }));
  document.querySelectorAll(".chat .msgs").forEach((el) => (el.scrollTop = el.scrollHeight));
}

function duelCard(item, mine) {
  const { pk, d } = item;
  const x = mkOf(d.market);
  const name = x ? x.m.name : "a market";
  const unit = x ? unitOf(x) : "";
  const now = Date.now() / 1000;
  const me = wallet?.publicKey;
  const isCreator = me && d.creator.equals(me), isOpp = me && d.opponent.equals(me);
  let status = "";
  if (d.state === 0) status = now >= d.deadline ? `<span class="tag" style="background:#2a2a2a">expired · refunding</span>` : `<span class="tag" style="background:#1c1309;color:var(--brand2)">open</span>`;
  if (d.state === 1) status = now >= d.deadline ? `<span class="tag" style="background:#2a2a2a">settling…</span>` : `<span class="tag" style="background:#10291c;color:var(--up)">matched</span>`;
  if (d.state === 2) { const won = me && d.winner.equals(me); status = `<span class="tag" style="background:${won ? "#10291c" : "#2a1416"};color:${won ? "var(--up)" : "var(--down)"}">${won ? "you won" : mine ? "you lost" : "settled"} · ${fmtN(d.settledValue)}</span>`; }
  if (d.state === 3) status = `<span class="tag" style="background:#2a2a2a">refunded</span>`;
  const btns = [];
  if (d.state === 0 && now < d.deadline - 600 && !isCreator && (!d.private || codes[pk.toBase58()])) btns.push(`<button class="btn sm" data-accept="${pk.toBase58()}">Take the other side · ${P.fmtSol(d.stake)} SOL</button>`);
  if (d.state === 0 && isCreator) btns.push(`<button class="btn ghost sm" data-cancel="${pk.toBase58()}">Cancel</button>`);
  if (d.state === 0 && isCreator) btns.push(`<button class="btn ghost sm" data-share="${pk.toBase58()}">Share challenge</button>`);
  btns.push(`<button class="btn ghost sm" data-chat="${pk.toBase58()}">${chatOpen === pk.toBase58() ? "Hide chat" : "Chat"}</button>`);
  const priv = d.private ? `<span class="tag" style="background:#1d1630;color:#c8b6ff">private${isCreator && codes[pk.toBase58()] ? " · code " + pk.toBase58().slice(0, 6) + "-" + codes[pk.toBase58()] : ""}</span>` : "";
  const side = isOpp ? `<span class="tag" style="background:#2a2a2a">you said ${d.above ? "BELOW" : "ABOVE"}</span>` : "";
  return `<div class="duel" style="${focusDuel === pk.toBase58() ? "border-color:var(--brand)" : ""}">
    <div class="claim"><span class="muted">${isCreator ? "You" : state.house && d.creator.equals(state.house) ? "🏠 PULSE House" : short(d.creator)} say${isCreator ? "" : "s"}</span> <b>${name}</b> will be <b style="color:${d.above ? "var(--up)" : "var(--down)"}">${d.above ? "ABOVE" : "BELOW"} ${fmtN(d.target)}</b> <span class="muted">${unit}</span> at <b>${when(d.deadline)}</b></div>
    <div class="meta"><span>stake ${P.fmtSol(d.stake)} SOL each</span><span>pot ${P.fmtSol(d.stake * 2n)} SOL</span>${x ? `<span>now ${fmtN(livePlayers(x))}</span>` : ""}</div>
    <div class="row2">${status}${priv}${side}</div>
    ${btns.length ? `<div class="row2">${btns.join("")}</div>` : ""}
    ${chatOpen === pk.toBase58() ? chatBox(pk.toBase58()) : ""}
  </div>`;
}

function renderDuels() {
  const now = Date.now() / 1000;
  const me = wallet?.publicKey;
  const open = state.duels.filter((x) => x.d.state === 0 && now < x.d.deadline - 600 && !(me && x.d.creator.equals(me)) && (!x.d.private || codes[x.pk.toBase58()]));
  if (focusDuel) open.sort((a, b) => (a.pk.toBase58() === focusDuel ? -1 : b.pk.toBase58() === focusDuel ? 1 : 0));
  const mine = me ? state.duels.filter((x) => x.d.creator.equals(me) || x.d.opponent.equals(me)) : [];
  $("openDuels").innerHTML = open.length ? open.map((x) => duelCard(x, false)).join("") : `<div class="empty">No open challenges right now. Start one and share the link.</div>`;
  const board = new Map();
  for (const { d } of state.duels) {
    if (d.state !== 2 || d.winner.equals(PublicKey.default)) continue;
    const k = d.winner.toBase58(); const won = Number(d.stake) * 0.98 / 1e9; // pot minus fee minus own stake
    const e = board.get(k) || { w: d.winner, wins: 0, sol: 0 }; e.wins++; e.sol += won; board.set(k, e);
  }
  const top = [...board.values()].sort((a, b) => b.sol - a.sol).slice(0, 5);
  $("board").innerHTML = top.length ? top.map((e, i) => `<div class="lrow"><b>${i + 1}</b><span>${me && e.w.equals(me) ? "you" : state.house && e.w.equals(state.house) ? "🏠 PULSE House" : short(e.w)}</span><span class="muted">${e.wins} win${e.wins > 1 ? "s" : ""}</span><span class="up">+${e.sol.toFixed(3)} SOL</span></div>`).join("")
    : `<div class="empty">No duels settled yet. Win the first one and take #1.</div>`;
  $("myDuels").innerHTML = !me ? `<div class="empty">Connect your wallet to see your duels.</div>` : mine.length ? mine.map((x) => duelCard(x, true)).join("") : `<div class="empty">You haven't joined a duel yet.</div>`;
  document.querySelectorAll("[data-accept]").forEach((b) => (b.onclick = () => run(() => acceptDuel(b.dataset.accept))));
  document.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => run(() => cancelDuel(b.dataset.cancel))));
  document.querySelectorAll("[data-share]").forEach((b) => (b.onclick = () => shareDuel(b.dataset.share)));
  document.querySelectorAll("[data-chat]").forEach((b) => (b.onclick = async () => {
    const t = b.dataset.chat; chatOpen = chatOpen === t ? null : t; renderDuels();
    if (chatOpen) { await loadChat(t); renderDuels(); }
  }));
  bindChat();
}
function joinWithCode() {
  const raw = ($("joinCode").value || "").trim().replace(/\s/g, "");
  const [prefix, secret] = raw.split("-");
  if (!prefix || !secret) return toast("Codes look like 7Hk2Pq-X9F3KD");
  const hit = state.duels.find((x) => x.pk.toBase58().startsWith(prefix) && x.d.private);
  if (!hit) return toast("No private duel found for that code. Check it, or wait a few seconds and try again.");
  codes[hit.pk.toBase58()] = secret.toUpperCase(); saveCodes();
  focusDuel = hit.pk.toBase58(); tab = "duels"; render();
  toast("Found it. Tap Take the other side to join.");
}

function openDuelSheet() {
  if (!state.markets.length) return toast("Markets are still loading.");
  const x = state.markets[0];
  duelDraft = duelDraft || { id: x.m.id, above: true, target: Number(livePlayers(x)), hours: 24, stake: 0.1, priv: false };
  openId = null;
  $("sheet").classList.add("open");
  renderDuelSheet();
}
function renderDuelSheet() {
  const dd = duelDraft;
  const x = state.markets.find((y) => y.m.id === dd.id) || state.markets[0];
  const cur = Number(livePlayers(x));
  $("panel").innerHTML = `<div class="grab"></div>
    <div class="mname" style="font-size:20px">New duel</div>
    <p class="hint" style="margin-top:4px">Call where a number lands. Your SOL is locked until someone takes the other side, or you cancel.</p>
    <div class="lbl">Market</div>
    <div class="opt">${state.markets.map((y) => `<button data-mk="${y.m.id}" class="${y.m.id === x.m.id ? "on" : ""}">${y.m.name}</button>`).join("")}</div>
    <div class="lbl">It will be… (now ${fmtN(cur)} ${unitOf(x)})</div>
    <div class="opt"><button data-dir="1" class="${dd.above ? "on" : ""}" style="${dd.above ? "color:var(--up)" : ""}">ABOVE ↑</button><button data-dir="0" class="${!dd.above ? "on" : ""}" style="${!dd.above ? "color:var(--down)" : ""}">BELOW ↓</button></div>
    <div class="amt"><input id="dTarget" inputmode="numeric" value="${dd.target}" aria-label="Target number" /></div>
    <div class="lbl">When</div>
    <div class="opt">${[[1, "1 hour"], [6, "6 hours"], [24, "24 hours"], [72, "3 days"], [168, "7 days"]].map(([h, l]) => `<button data-h="${h}" class="${dd.hours === h ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="lbl">Who can join</div>
    <div class="opt"><button data-pv="0" class="${!dd.priv ? "on" : ""}">Anyone (public)</button><button data-pv="1" class="${dd.priv ? "on" : ""}">Friends with code (private)</button></div>
    <div class="lbl">Stake (each side)</div>
    <div class="opt">${[0.05, 0.1, 0.5, 1].map((v) => `<button data-st="${v}" class="${dd.stake === v ? "on" : ""}">${v} SOL</button>`).join("")}</div>
    ${wallet ? `<button class="btn" id="dCreate" style="width:100%;justify-content:center;padding:15px">Lock ${dd.stake} SOL and create duel</button>` : `<button class="btn" id="sConnect" style="width:100%;justify-content:center;padding:15px">Connect wallet</button>`}
    <p class="hint">Settles from the first audited reading after the deadline. Winner takes the pot minus 1%. Nobody accepts? You get your SOL back. Ties refund both.</p>`;
  const save = () => { const v = Number($("dTarget").value.replace(/[^0-9]/g, "")); if (v > 0) dd.target = v; };
  document.querySelectorAll("[data-mk]").forEach((b) => (b.onclick = () => { dd.id = Number(b.dataset.mk); const y = state.markets.find((z) => z.m.id === dd.id); dd.target = Number(livePlayers(y)); renderDuelSheet(); }));
  document.querySelectorAll("[data-dir]").forEach((b) => (b.onclick = () => { save(); dd.above = b.dataset.dir === "1"; renderDuelSheet(); }));
  document.querySelectorAll("[data-h]").forEach((b) => (b.onclick = () => { save(); dd.hours = Number(b.dataset.h); renderDuelSheet(); }));
  document.querySelectorAll("[data-st]").forEach((b) => (b.onclick = () => { save(); dd.stake = Number(b.dataset.st); renderDuelSheet(); }));
  document.querySelectorAll("[data-pv]").forEach((b) => (b.onclick = () => { save(); dd.priv = b.dataset.pv === "1"; renderDuelSheet(); }));
  if ($("sConnect")) $("sConnect").onclick = connect;
  if ($("dCreate")) $("dCreate").onclick = () => { save(); run(() => createDuel(x)); };
}

async function createDuel(x) {
  const dd = duelDraft;
  if (dd.stake + 0.01 > state.sol) throw new Error("Not enough SOL. Tap Get free devnet SOL in any market");
  const nonce = BigInt(Date.now());
  const deadline = Math.floor(Date.now() / 1000) + dd.hours * 3600;
  const duelPk = P.duelPda(x.pk, wallet.publicKey, nonce);
  let codeHash = new Uint8Array(32);
  if (dd.priv) { const secret = P.makeSecret(); codes[duelPk.toBase58()] = secret; saveCodes(); codeHash = await P.joinCodeHash(duelPk, secret); }
  const sig = await sendTx([P.createDuelIx(wallet.publicKey, x.pk, { nonce, above: dd.above, target: BigInt(dd.target), deadline, stake: BigInt(Math.round(dd.stake * 1e9)), codeHash })]);
  const pk = duelPk.toBase58();
  $("sheet").classList.remove("open"); tab = "duels"; focusDuel = pk;
  setTimeout(() => shareDuel(pk), 600);
  return sig;
}
async function acceptDuel(pkStr) { return sendTx([P.acceptDuelIx(wallet.publicKey, new PublicKey(pkStr), codes[pkStr] || "")]); }
async function cancelDuel(pkStr) { return sendTx([P.cancelDuelIx(wallet.publicKey, new PublicKey(pkStr))]); }
function shareDuel(pkStr) {
  const item = state.duels.find((x) => x.pk.toBase58() === pkStr);
  const url = `${location.origin}${location.pathname}?duel=${pkStr}${codes[pkStr] ? `&code=${codes[pkStr]}` : ""}`;
  const x = item && mkOf(item.d.market);
  const text = item && x ? `I'm calling ${x.m.name} ${item.d.above ? "ABOVE" : "BELOW"} ${fmtN(item.d.target)} ${unitOf(x)} by ${when(item.d.deadline)}. ${P.fmtSol(item.d.stake)} SOL says I'm right. Take the other side:` : "Take the other side of my PULSE duel:";
  navigator.clipboard?.writeText(url).catch(() => {});
  const code = codes[pkStr] ? ` Join code: <b>${pkStr.slice(0, 6)}-${codes[pkStr]}</b>.` : "";
  toast(`Link copied.${code} <a href="https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}" target="_blank">Post it on X</a>`, 9000);
}

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
  try {
    const res = await p.connect();
    const pk = res?.publicKey || p.publicKey;
    wallet = { publicKey: new PublicKey(pk.toString()), provider: p };
  } catch (e) {
    toast(`Wallet didn't connect: ${e.message || e}. Open PULSE inside Phantom's browser and try again.`, 8000);
    return;
  }
  render(); // show the wallet as connected right away
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
let fails = 0;
async function refresh() {
  try {
    await load();
    fails = 0;
  } catch (e) {
    console.error(e);
    fails++;
    $("banner").hidden = false;
    $("banner").innerHTML = `Couldn't reach Solana devnet (${String(e.message || e).slice(0, 80)}). Retrying${fails > 2 ? " — if this keeps happening, switch between Wi-Fi and mobile data" : ""}…`;
    setTimeout(refresh, Math.min(30_000, 2_000 * fails));
  }
  render(); // always update the page, even when the network call failed
}
refresh();
setInterval(refresh, 15_000);
setInterval(async () => {
  if (DEMO) return;
  const room = chatOpen || (openId != null && state.markets.find((y) => y.m.id === openId)?.pk.toBase58());
  if (!room) return;
  const typing = document.activeElement?.dataset?.chatin;
  await loadChat(room);
  if (typing) return; // don't wipe what someone is typing
  if (chatOpen) renderDuels(); else renderSheet();
}, 12_000);
const p = provider();
if (p?.isConnected && p.publicKey) wallet = { publicKey: new PublicKey(p.publicKey.toString()), provider: p };
