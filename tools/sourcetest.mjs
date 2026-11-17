import { readSource } from "../keeper/sources.js";
import { MARKETS } from "../keeper/markets.js";
for (const m of MARKETS) {
  try { console.log(`OK   #${m.id} ${m.name}: ${await readSource(m)}`); }
  catch (e) { console.log(`FAIL #${m.id} ${m.name}: ${e.message}`); }
}
