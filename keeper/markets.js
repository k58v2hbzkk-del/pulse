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
  { id: 8, name: "Bitcoin on Wikipedia", kind: "wiki", ref: "Bitcoin", sourceId: 0, leverage: 3, cat: "topics" },
  { id: 9, name: "AI on Wikipedia", kind: "wiki", ref: "Artificial_intelligence", sourceId: 0, leverage: 3, cat: "topics" },
  { id: 10, name: "Taylor Swift on Wikipedia", kind: "wiki", ref: "Taylor_Swift", sourceId: 0, leverage: 3, cat: "topics" },
  { id: 11, name: "Ollama GitHub stars/day", kind: "github", ref: "ollama/ollama", sourceId: 0, leverage: 2, cat: "code" },
  { id: 12, name: "VS Code GitHub stars/day", kind: "github", ref: "microsoft/vscode", sourceId: 0, leverage: 2, cat: "code" },
  { id: 13, name: "Just Chatting on Twitch", kind: "twitch", ref: 509658, sourceId: 509658, leverage: 3, cat: "streams" },
  { id: 14, name: "Counter-Strike on Twitch", kind: "twitch", ref: 32399, sourceId: 32399, leverage: 3, cat: "streams" },
];

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
