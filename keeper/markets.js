// The launch markets. Index = live Steam player count (public, free, no API key).
export const MARKETS = [
  { id: 1, name: "Counter-Strike 2", sourceId: 730, leverage: 3 },
  { id: 2, name: "Dota 2", sourceId: 570, leverage: 3 },
  { id: 3, name: "PUBG: Battlegrounds", sourceId: 578080, leverage: 3 },
  { id: 4, name: "Marvel Rivals", sourceId: 2767030, leverage: 5 },
  { id: 5, name: "Apex Legends", sourceId: 1172470, leverage: 5 },
];

/** Switchboard feed: oracles fetch Steam's public API and sign the player count. */
export function steamFeed(m) {
  return {
    name: `PULSE ${m.name} players`,
    jobs: [{ tasks: [
      { httpTask: { url: `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${m.sourceId}` } },
      { jsonParseTask: { path: "$.response.player_count" } },
    ] }],
    minOracleSamples: 1,
    minJobResponses: 1,
    maxJobRangePct: 0,
  };
}
