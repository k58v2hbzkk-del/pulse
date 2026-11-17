// Every PULSE market: id, on-chain name (≤32 bytes), data source, leverage.
// kind/ref: steam=app id · wiki=English Wikipedia article · github=owner/repo · twitch=category (game) id
export const MARKETS = [
  { id: 1, name: "Counter-Strike 2", kind: "steam", ref: 730, sourceId: 730, leverage: 3, cat: "games" },
  { id: 2, name: "Dota 2", kind: "steam", ref: 570, sourceId: 570, leverage: 3, cat: "games" },
  { id: 3, name: "PUBG: Battlegrounds", kind: "steam", ref: 578080, sourceId: 578080, leverage: 3, cat: "games" },
  { id: 4, name: "Marvel Rivals", kind: "steam", ref: 2767030, sourceId: 2767030, leverage: 5, cat: "games" },
  { id: 5, name: "Apex Legends", kind: "steam", ref: 1172470, sourceId: 1172470, leverage: 5, cat: "games" },
  { id: 6, name: "GTA V", kind: "steam", ref: 271590, sourceId: 271590, leverage: 3, cat: "games" },
  { id: 7, name: "Rust", kind: "steam", ref: 252490, sourceId: 252490, leverage: 3, cat: "games" },
  { id: 8, name: "Bitcoin on Wikipedia", kind: "wiki", ref: "Bitcoin", sourceId: 0, leverage: 3, cat: "crypto" },
  { id: 9, name: "AI on Wikipedia", kind: "wiki", ref: "Artificial_intelligence", sourceId: 0, leverage: 3, cat: "topics" },
  { id: 10, name: "Taylor Swift on Wikipedia", kind: "wiki", ref: "Taylor_Swift", sourceId: 0, leverage: 3, cat: "topics" },
  { id: 11, name: "Ollama GitHub stars/day", kind: "github", ref: "ollama/ollama", sourceId: 0, leverage: 2, cat: "code" },
  { id: 12, name: "VS Code GitHub stars/day", kind: "github", ref: "microsoft/vscode", sourceId: 0, leverage: 2, cat: "code" },
  { id: 13, name: "Just Chatting on Twitch", kind: "twitch", ref: 509658, sourceId: 509658, leverage: 3, cat: "streams" },
  { id: 14, name: "Counter-Strike on Twitch", kind: "twitch", ref: 32399, sourceId: 32399, leverage: 3, cat: "streams" },
  // crypto attention & narratives (not prices)
  { id: 15, name: "AI Agents narrative", kind: "narrative", ref: "ai-agents", sourceId: 0, leverage: 3, cat: "crypto" },
  { id: 16, name: "Memecoin narrative", kind: "narrative", ref: "meme-token", sourceId: 0, leverage: 3, cat: "crypto" },
  { id: 17, name: "RWA narrative", kind: "narrative", ref: "real-world-assets-rwa", sourceId: 0, leverage: 3, cat: "crypto" },
  { id: 18, name: "DePIN narrative", kind: "narrative", ref: "depin", sourceId: 0, leverage: 3, cat: "crypto" },
  { id: 19, name: "Crypto Fear & Greed", kind: "fng", ref: "fng", sourceId: 0, leverage: 3, cat: "crypto" },
  { id: 20, name: "Solana TPS", kind: "solana", ref: "tps", sourceId: 0, leverage: 3, cat: "crypto" },
  { id: 21, name: "Solana on Wikipedia", kind: "wiki", ref: "Solana_(blockchain_platform)", sourceId: 0, leverage: 3, cat: "crypto" },
  { id: 22, name: "Ethereum on Wikipedia", kind: "wiki", ref: "Ethereum", sourceId: 0, leverage: 3, cat: "crypto" },
  { id: 23, name: "Dogecoin on Wikipedia", kind: "wiki", ref: "Dogecoin", sourceId: 0, leverage: 3, cat: "crypto" },
  // crypto prices (stored × 10^dec) — home of the "Up or Down" predictions
  { id: 24, name: "Bitcoin price", kind: "price", ref: "bitcoin", sym: "BTC", dec: 2, sourceId: 0, leverage: 5, cat: "crypto" },
  { id: 25, name: "Ethereum price", kind: "price", ref: "ethereum", sym: "ETH", dec: 2, sourceId: 0, leverage: 5, cat: "crypto" },
  { id: 26, name: "Solana price", kind: "price", ref: "solana", sym: "SOL", dec: 2, sourceId: 0, leverage: 5, cat: "crypto" },
  { id: 27, name: "BNB price", kind: "price", ref: "binancecoin", sym: "BNB", dec: 2, sourceId: 0, leverage: 5, cat: "crypto" },
  { id: 28, name: "XRP price", kind: "price", ref: "ripple", sym: "XRP", dec: 4, sourceId: 0, leverage: 5, cat: "crypto" },
  { id: 29, name: "Dogecoin price", kind: "price", ref: "dogecoin", sym: "DOGE", dec: 5, sourceId: 0, leverage: 5, cat: "crypto" },
  { id: 30, name: "Total crypto market cap", kind: "global", ref: "mcap", dec: 0, sourceId: 0, leverage: 5, cat: "crypto" },
  { id: 31, name: "Bitcoin dominance", kind: "global", ref: "dominance", dec: 2, sourceId: 0, leverage: 10, cat: "crypto" },
  // weather (°C × 10 + 1000 so it stays positive)
  { id: 32, name: "New York temperature", kind: "weather", ref: "40.71,-74.01", dec: 1, off: 1000, sourceId: 0, leverage: 3, cat: "weather" },
  { id: 33, name: "London temperature", kind: "weather", ref: "51.51,-0.13", dec: 1, off: 1000, sourceId: 0, leverage: 3, cat: "weather" },
  { id: 34, name: "Tokyo temperature", kind: "weather", ref: "35.68,139.69", dec: 1, off: 1000, sourceId: 0, leverage: 3, cat: "weather" },
];

/** A reading as people read it: "$92,450.12", "18.4°C", "54.21%" */
const UNITS = { price: ["$", ""], global: ["", ""], weather: ["", "°C"] };
export function fmtValue(m, raw) {
  if (!m || !m.dec && !m.off && m.kind !== "price" && m.kind !== "global") return Number(raw).toLocaleString();
  const v = (Number(raw) - (m.off || 0)) / 10 ** (m.dec || 0);
  const s = v.toLocaleString(undefined, { minimumFractionDigits: m.kind === "weather" ? 1 : Math.min(m.dec || 0, 2), maximumFractionDigits: m.dec || 0 });
  if (m.kind === "global") return m.ref === "mcap" ? `$${s}B` : `${s}%`;
  const [pre, post] = UNITS[m.kind] || ["", ""];
  return `${pre}${s}${post}`;
}

export function steamFeed(m) {
  return {
    name: `PULSE ${m.name} players`,
    jobs: [{ tasks: [
      { httpTask: { url: `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${m.sourceId}` } },
      { jsonParseTask: { path: "$.response.player_count" } },
    ] }],
    minOracleSamples: 1, minJobResponses: 1, maxJobRangePct: 0,
  };
}
