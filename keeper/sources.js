// Attention data sources. Each returns a positive integer reading.
// Steam: live players · Wikipedia: yesterday's page views · GitHub: stars/day momentum · Twitch: live viewers.
const UA = { "User-Agent": "PULSE-keeper/1.0 (https://github.com/k58v2hbzkk-del/pulse)" };
const get = async (url, headers = {}) => {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} http ${res.status}`);
  return res;
};

export async function steamPlayers(appId) {
  const j = await (await get(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`)).json();
  const n = j?.response?.player_count;
  if (!(n > 0)) throw new Error(`steam ${appId} bad response`);
  return n;
}

/** Most recent full day of English Wikipedia page views (people, not bots). */
export async function wikiViews(article) {
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const end = new Date(Date.now() - 86_400_000), start = new Date(Date.now() - 8 * 86_400_000);
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(article)}/daily/${ymd(start)}/${ymd(end)}`;
  const j = await (await get(url)).json();
  const items = j?.items || [];
  const n = items.length ? items[items.length - 1].views : 0;
  if (!(n > 0)) throw new Error(`wiki ${article} no data`);
  return n;
}

/** Stars per day, measured from the repo's recent star events (can rise and fall, unlike total stars). */
export async function githubStarsPerDay(repo) {
  const headers = { Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const times = [];
  let oldest = Date.now();
  for (let page = 1; page <= 3; page++) {
    const ev = await (await get(`https://api.github.com/repos/${repo}/events?per_page=100&page=${page}`, headers)).json();
    if (!Array.isArray(ev) || !ev.length) break;
    for (const e of ev) {
      const t = Date.parse(e.created_at);
      oldest = Math.min(oldest, t);
      if (e.type === "WatchEvent") times.push(t);
    }
  }
  const spanH = Math.max(1, (Date.now() - oldest) / 3_600_000);
  const windowH = Math.min(24, spanH);
  const recent = times.filter((t) => Date.now() - t <= windowH * 3_600_000).length;
  const perDay = Math.round((recent / windowH) * 24);
  if (!(perDay > 0)) throw new Error(`github ${repo} no recent stars`);
  return perDay;
}

/** 24h trading volume (in $M) of a CoinGecko narrative category, matched by name. */
let cgCats = null, cgAt = 0;
export async function coingeckoCategoryVolume(match) {
  if (!cgCats || Date.now() - cgAt > 10 * 60_000) {
    cgCats = await (await get("https://api.coingecko.com/api/v3/coins/categories")).json();
    cgAt = Date.now();
  }
  const want = match.toLowerCase();
  const hit = cgCats.find((c) => c.id?.toLowerCase() === want) || cgCats.find((c) => c.name?.toLowerCase() === want)
    || cgCats.find((c) => c.name?.toLowerCase().includes(want));
  const v = Math.round((hit?.volume_24h || 0) / 1e6);
  if (!(v > 0)) throw new Error(`coingecko category ${match} not found`);
  return v;
}

/** Crypto Fear & Greed Index (0-100), alternative.me, updated daily. */
export async function fearGreed() {
  const j = await (await get("https://api.alternative.me/fng/?limit=1")).json();
  const v = Number(j?.data?.[0]?.value);
  if (!(v > 0)) throw new Error("fear & greed no data");
  return v;
}

/** Solana mainnet transactions per second (average of the latest 60s samples). */
export async function solanaTps() {
  const res = await fetch("https://api.mainnet-beta.solana.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getRecentPerformanceSamples", params: [3] }), signal: AbortSignal.timeout(15_000) });
  const j = await res.json();
  const s = j?.result || [];
  const tx = s.reduce((a, x) => a + x.numTransactions, 0), sec = s.reduce((a, x) => a + x.samplePeriodSecs, 0);
  const v = sec ? Math.round(tx / sec) : 0;
  if (!(v > 0)) throw new Error("solana tps no data");
  return v;
}

/** USD prices for many coins in one call (CoinGecko), Coinbase spot as a fallback. */
let cgPrices = null, cgPricesAt = 0;
export async function coinPrice(id, symbol) {
  if (!cgPrices || Date.now() - cgPricesAt > 45_000) {
    try {
      const ids = "bitcoin,ethereum,solana,binancecoin,ripple,dogecoin";
      cgPrices = await (await get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`)).json();
      cgPricesAt = Date.now();
    } catch (e) { cgPrices = cgPrices || {}; }
  }
  let v = Number(cgPrices?.[id]?.usd);
  if (!(v > 0) && symbol) {
    const j = await (await get(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`)).json();
    v = Number(j?.data?.amount);
  }
  if (!(v > 0)) throw new Error(`price ${id} no data`);
  return v;
}

/** Whole-market stats from CoinGecko /global: total market cap ($B) or BTC dominance (%). */
let cgGlobal = null, cgGlobalAt = 0;
export async function cryptoGlobal(what) {
  if (!cgGlobal || Date.now() - cgGlobalAt > 5 * 60_000) {
    cgGlobal = (await (await get("https://api.coingecko.com/api/v3/global")).json())?.data;
    cgGlobalAt = Date.now();
  }
  const v = what === "mcap" ? cgGlobal?.total_market_cap?.usd / 1e9 : cgGlobal?.market_cap_percentage?.btc;
  if (!(v > 0)) throw new Error(`global ${what} no data`);
  return v;
}

/** Current air temperature (°C) in a city, from Open-Meteo (free, no key). ref = "lat,lon". */
export async function cityTemp(ref) {
  const [lat, lon] = String(ref).split(",");
  const j = await (await get(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m`)).json();
  const v = Number(j?.current?.temperature_2m);
  if (!Number.isFinite(v)) throw new Error(`weather ${ref} no data`);
  return v;
}

let twitchToken = null;
async function twitchAuth() {
  const id = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) throw new Error("twitch keys not set");
  if (twitchToken && twitchToken.exp > Date.now()) return { id, token: twitchToken.v };
  const res = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`, { method: "POST", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`twitch auth http ${res.status}`);
  const j = await res.json();
  twitchToken = { v: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return { id, token: j.access_token };
}
/** Total live viewers across the top 100 streams in a Twitch category. */
export async function twitchCategoryViewers(gameId) {
  const { id, token } = await twitchAuth();
  const j = await (await get(`https://api.twitch.tv/helix/streams?game_id=${gameId}&first=100`, { "Client-Id": id, Authorization: `Bearer ${token}` })).json();
  const n = (j?.data || []).reduce((a, s) => a + (s.viewer_count || 0), 0);
  if (!(n > 0)) throw new Error(`twitch ${gameId} no viewers`);
  return n;
}

// cache so slow-moving sources aren't hammered every minute
const TTL = { steam: 0, twitch: 0, github: 10 * 60_000, wiki: 60 * 60_000, narrative: 10 * 60_000, fng: 30 * 60_000, solana: 0, price: 0, global: 0, weather: 10 * 60_000 };
/** On-chain readings are positive integers: real value × 10^dec + off (off keeps temperatures positive). */
export const toRaw = (m, v) => Math.round(v * 10 ** (m.dec || 0)) + (m.off || 0);
const cache = new Map();
export async function readSource(m) {
  const key = `${m.kind}:${m.ref}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL[m.kind]) return hit.v;
  const v = m.kind === "steam" ? await steamPlayers(m.ref)
    : m.kind === "wiki" ? await wikiViews(m.ref)
    : m.kind === "github" ? await githubStarsPerDay(m.ref)
    : m.kind === "twitch" ? await twitchCategoryViewers(m.ref)
    : m.kind === "narrative" ? await coingeckoCategoryVolume(m.ref)
    : m.kind === "fng" ? await fearGreed()
    : m.kind === "solana" ? await solanaTps()
    : m.kind === "price" ? toRaw(m, await coinPrice(m.ref, m.sym))
    : m.kind === "global" ? toRaw(m, await cryptoGlobal(m.ref))
    : m.kind === "weather" ? toRaw(m, await cityTemp(m.ref))
    : Promise.reject(new Error(`unknown source ${m.kind}`));
  cache.set(key, { v, t: Date.now() });
  return v;
}
