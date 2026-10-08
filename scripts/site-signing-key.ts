import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { publicKeyOf } from "../lib/sites/sign";

/**
 * Make the portal's site-signing key pair (lib/sites/sign.ts).
 *
 *   npx tsx scripts/site-signing-key.ts <key id> <file for the private half>
 *
 * The PRIVATE half is written to the file, never printed, so it does not end up
 * in a terminal's scrollback or a log: put the file's contents in
 * SITE_SIGNING_KEY on the app service, then delete the file. The PUBLIC half is
 * printed, in the form a site puts in its TENXID_PUBLIC_KEYS setting.
 */
const [id, file] = process.argv.slice(2);
if (!id || !/^[A-Za-z0-9._-]{1,40}$/.test(id) || !file) {
  console.error("Usage: npx tsx scripts/site-signing-key.ts <key id> <file for the private half>");
  process.exit(1);
}

const { privateKey } = generateKeyPairSync("ed25519");
const der = privateKey.export({ format: "der", type: "pkcs8" });
writeFileSync(file, `${id}:${der.toString("base64url")}\n`, { mode: 0o600, flag: "wx" });

console.log(`Private half written to ${file} — put it in SITE_SIGNING_KEY, then delete the file.`);
console.log(`For each site's TENXID_PUBLIC_KEYS: ${JSON.stringify({ [id]: publicKeyOf(privateKey) })}`);
