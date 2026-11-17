// Opens the live site in headless Chrome and reports console errors + what rendered.
import { chromium } from "playwright";
const url = process.env.SITE || "https://k58v2hbzkk-del.github.io/pulse/";
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
const logs = [];
pg.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
pg.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
pg.on("requestfailed", (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
pg.on("response", async (r) => { if (r.url().includes("solana.com") && r.status() !== 200) logs.push(`[rpc ${r.status()}] ${(await r.text().catch(() => "")).slice(0, 300)}`); });
await pg.goto(url, { waitUntil: "networkidle" });
await pg.waitForTimeout(8000);
const cards = await pg.$$eval(".mcard", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 160)));
console.log("CARDS:", cards.length); cards.forEach((c) => console.log("  ", c));
console.log("BANNER:", await pg.$eval("#banner", (e) => (e.hidden ? "(hidden)" : e.innerText)).catch(() => "?"));
console.log("LOGS:\n" + logs.join("\n"));
await pg.screenshot({ path: "site.png", fullPage: false });
await b.close();
