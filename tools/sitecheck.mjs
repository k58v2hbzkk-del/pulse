// Opens the live site headless and reports errors + what rendered.
// Runs Chromium and WebKit (Safari), with and without a connected wallet.
import { chromium, webkit } from "playwright";
const url = process.env.SITE || "https://k58v2hbzkk-del.github.io/pulse/";
const WALLET = process.env.WALLET || "7EGXZbPkDnDy2z8oWpKRJhufQnCRKT3MBPmFcNhqGbXk";
for (const [name, type] of [["chromium", chromium], ["webkit", webkit]]) {
  for (const withWallet of [false, true]) {
    const b = await type.launch();
    const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
    if (withWallet) await pg.addInitScript((pk) => {
      const p = { isPhantom: true, isConnected: true, publicKey: { toString: () => pk, toBase58: () => pk },
        connect: async () => ({ publicKey: { toString: () => pk } }), on() {}, signTransaction: async (t) => t };
      window.solana = p; window.phantom = { solana: p };
    }, WALLET);
    const logs = [];
    pg.on("console", (m) => { if (m.type() !== "log") logs.push(`[${m.type()}] ${m.text()}`); });
    pg.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
    pg.on("requestfailed", (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    pg.on("response", async (r) => { if (r.url().includes("solana.com") && r.status() !== 200) logs.push(`[rpc ${r.status()}] ${(await r.text().catch(() => "")).slice(0, 200)}`); });
    await pg.goto(url, { waitUntil: "load" });
    await pg.waitForTimeout(15000);
    const cards = await pg.$$eval(".mcard", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 90)));
    console.log(`\n===== ${name} wallet=${withWallet} CARDS: ${cards.length}`);
    cards.slice(0, 3).forEach((c) => console.log("  ", c));
    console.log("BANNER:", await pg.$eval("#banner", (e) => (e.hidden ? "(hidden)" : e.innerText)).catch(() => "?"));
    console.log("CHIPS:", await pg.$$eval("#cats button, .chip", (els) => els.map((e) => e.innerText).join(" | ")).catch(() => "?"));
    await pg.click("text=Duels").catch(() => {});
    await pg.waitForTimeout(1500);
    console.log("OPEN DUELS:", (await pg.$eval("#openDuels", (e) => e.innerText).catch(() => "?")).replace(/\s+/g, " ").slice(0, 400));
    console.log("LOGS:\n" + logs.slice(0, 15).join("\n"));
    await pg.screenshot({ path: `site-${name}-${withWallet}.png` });
    await b.close();
  }
}
