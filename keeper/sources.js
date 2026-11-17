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
const TTL = { steam: 0, twitch: 0, github: 10 * 60_000, wiki: 60 * 60_000 };
const cache = new Map();
export async function readSource(m) {
  const key = `${m.kind}:${m.ref}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL[m.kind]) return hit.v;
  const v = m.kind === "steam" ? await steamPlayers(m.ref)
    : m.kind === "wiki" ? await wikiViews(m.ref)
    : m.kind === "github" ? await githubStarsPerDay(m.ref)
    : m.kind === "twitch" ? await twitchCategoryViewers(m.ref)
    : Promise.reject(new Error(`unknown source ${m.kind}`));
  cache.set(key, { v, t: Date.now() });
  return v;
}
