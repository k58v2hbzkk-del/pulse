// Writes ADMIN_KEY (JSON array or base58) as a Solana CLI keypair file: node keeper/keyfile.js out.json
import fs from "fs";
import { loadKey } from "./common.js";
const k = loadKey();
fs.writeFileSync(process.argv[2], JSON.stringify(Array.from(k.secretKey)));
console.log("deployer:", k.publicKey.toBase58());
