import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const next = process.argv[2];
if (!next || !next.includes("@")) {
  console.error("Usage: node tools/set-contact-to.mjs you@example.com");
  process.exit(1);
}

const contactPath = path.join(root, "config", "contact.json");
const contact = JSON.parse(fs.readFileSync(contactPath, "utf8"));
contact.to = next.trim();
fs.writeFileSync(contactPath, JSON.stringify(contact, null, 2) + "\n");

const wranglerPath = path.join(root, "wrangler.jsonc");
let wrangler = fs.readFileSync(wranglerPath, "utf8");
wrangler = wrangler.replace(/"CONTACT_TO":\s*"[^"]*"/, `"CONTACT_TO": "${contact.to}"`);
wrangler = wrangler.replace(/"destination_address":\s*"[^"]*"/, `"destination_address": "${contact.to}"`);
fs.writeFileSync(wranglerPath, wrangler);
console.log(`Contact recipient is now ${contact.to}. Redeploy, and confirm that address is a verified Email Routing destination.`);
