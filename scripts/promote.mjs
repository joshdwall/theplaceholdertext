#!/usr/bin/env node
/**
 * Promote ThePlaceholderText (Cloudflare Worker + assets).
 *
 * Cloud-only Done: GitHub Actions `.github/workflows/promote.yml` runs this.
 * Laptop runs are bootstrap/debug — not Done.
 *
 *   node scripts/promote.mjs preview [--dry-run]
 *   node scripts/promote.mjs promote --confirm [--dry-run]
 *   node scripts/promote.mjs verify [https://theplaceholdertext.com/]
 *   node scripts/promote.mjs current
 *
 * Credentials (first match wins):
 *   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
 *   Infisical Universal Auth → /cloudflare (CLOUDFLARE_* or agents-write)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "site.config.json"), "utf8"));
const INFISICAL = process.env.INFISICAL_API_URL || "https://app.infisical.com";
const CF = "https://api.cloudflare.com/client/v4";
/** Cloudflare account ids are 32 hex chars (no dashes). Also accept dashed UUID. */
const ACCOUNT_ID_RE =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const argv = process.argv.slice(2);
const cmd = argv[0] || "";
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positionals = argv.slice(1).filter((a) => !a.startsWith("--"));
const dryRun = flags.has("--dry-run");
const confirmed =
  flags.has("--confirm") ||
  process.env.CONFIRM_PRODUCTION === "promote-production";

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function usage() {
  die(
    `Usage: node scripts/promote.mjs <preview|promote|verify|current> [flags]
  preview [--dry-run]           wrangler versions upload (non-prod version)
  promote --confirm [--dry-run] production wrangler deploy + live verify
  verify [url]                  HTTP checks against publicUrl (default) or url
  current                       print live Worker version id
`,
    2,
  );
}

function assertAccountId(account) {
  const id = String(account || "").trim();
  if (!ACCOUNT_ID_RE.test(id)) {
    die(
      `CLOUDFLARE_ACCOUNT_ID looks invalid (len=${id.length}). Expected 32 hex chars (Cloudflare account id). CF 7003 usually means a bad account id.`,
    );
  }
  return id.replace(/-/g, "").toLowerCase();
}

async function infisicalLogin() {
  const { INFISICAL_CLIENT_ID: clientId, INFISICAL_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Set INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.",
    );
  }
  const res = await fetch(`${INFISICAL}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!res.ok) throw new Error(`Infisical login failed (${res.status})`);
  return (await res.json()).accessToken;
}

async function infisicalPath(secretPath) {
  const tok = await infisicalLogin();
  const q = new URLSearchParams({
    workspaceId: cfg.infisical.projectId,
    environment: cfg.infisical.env,
    secretPath,
  });
  const res = await fetch(`${INFISICAL}/api/v3/secrets/raw?${q}`, {
    headers: { authorization: `Bearer ${tok}` },
  });
  if (!res.ok) throw new Error(`Infisical read ${secretPath} failed (${res.status})`);
  return Object.fromEntries((await res.json()).secrets.map((s) => [s.secretKey, s.secretValue]));
}

async function cloudflareCreds() {
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    return {
      token: process.env.CLOUDFLARE_API_TOKEN.trim(),
      account: assertAccountId(process.env.CLOUDFLARE_ACCOUNT_ID),
      source: "env",
    };
  }
  const s = await infisicalPath(cfg.infisical.cloudflarePath);
  const token =
    s[cfg.infisical.tokenKey] ||
    s[cfg.infisical.agentsWriteKey] ||
    "";
  const account = s[cfg.infisical.accountKey] || "";
  if (!token || !account) {
    throw new Error("Infisical /cloudflare is missing Cloudflare token or account id");
  }
  return { token: token.trim(), account: assertAccountId(account), source: "infisical" };
}

function wranglerEnv(creds) {
  return {
    ...process.env,
    CLOUDFLARE_API_TOKEN: creds.token,
    CLOUDFLARE_ACCOUNT_ID: creds.account,
    WRANGLER_SEND_METRICS: "false",
  };
}

function wrangler(args, creds) {
  const isWin = process.platform === "win32";
  const localBin = path.join(
    root,
    "node_modules",
    ".bin",
    isWin ? "wrangler.cmd" : "wrangler",
  );
  const useLocal = fs.existsSync(localBin);
  const cmd = useLocal ? localBin : isWin ? "npx.cmd" : "npx";
  const cmdArgs = useLocal ? args : ["--yes", "wrangler@4", ...args];
  const r = spawnSync(cmd, cmdArgs, {
    cwd: root,
    encoding: "utf8",
    env: wranglerEnv(creds),
    shell: isWin,
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (out.trim()) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  if (r.status !== 0) die(`wrangler ${args.join(" ")} failed (${r.status})`);
  return out;
}

function parseVersionId(out) {
  const m =
    out.match(/Current Version ID:\s*([0-9a-f-]{36})/i) ||
    out.match(/Worker Version ID:\s*([0-9a-f-]{36})/i) ||
    out.match(/Version ID:\s*([0-9a-f-]{36})/i);
  return m ? m[1] : "";
}

async function verify(baseUrl = cfg.publicUrl) {
  const origin = baseUrl.replace(/\/$/, "");
  const paths = cfg.verifyPaths || ["/"];
  for (const p of paths) {
    const url = p.startsWith("http") ? p : `${origin}${p.startsWith("/") ? p : `/${p}`}`;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) die(`verify fail ${url} -> HTTP ${res.status}`);
    const ctype = res.headers.get("content-type") || "";
    if (p.endsWith(".css") && !ctype.includes("css")) {
      die(`verify fail ${url} -> expected css, got ${ctype}`);
    }
    if ((p === "/" || p.endsWith("/")) && ctype.includes("html")) {
      const html = await res.text();
      if (!html.includes("ThePlaceholderText") && !html.includes("__SITE_NAME__")) {
        die(`verify fail ${url} -> missing brand marker`);
      }
    }
    console.log(`verify ok ${url}`);
  }
  console.log(`checks=pass`);
  console.log(`live=${cfg.publicUrl}`);
}

async function current(creds) {
  const out = wrangler(["deployments", "list", "--name", cfg.workerName], creds);
  const id = parseVersionId(out);
  if (id) console.log(`current=${id}`);
  return id;
}

async function preview(creds) {
  if (dryRun) {
    console.log("dry-run: would wrangler versions upload");
    wrangler(["deploy", "--dry-run"], creds);
    return;
  }
  const out = wrangler(["versions", "upload"], creds);
  const id = parseVersionId(out);
  console.log(`preview_version=${id || "(see wrangler output)"}`);
  console.log(`note=custom domain stays on production until promote`);
}

async function promote(creds) {
  if (!confirmed && !dryRun) {
    die('Production promote needs --confirm (or CONFIRM_PRODUCTION=promote-production)');
  }
  if (dryRun) {
    console.log("dry-run: would wrangler deploy + verify");
    wrangler(["deploy", "--dry-run"], creds);
    return;
  }
  const out = wrangler(["deploy"], creds);
  const id = parseVersionId(out);
  console.log(`version=${id || "(see wrangler output)"}`);
  await verify(cfg.publicUrl);
  // www should 301/200 to apex content
  try {
    const res = await fetch(cfg.wwwUrl, { redirect: "follow" });
    if (!res.ok) console.warn(`www verify warn HTTP ${res.status}`);
    else console.log(`verify ok ${cfg.wwwUrl}`);
  } catch (e) {
    console.warn(`www verify warn ${e.message || e}`);
  }
}

async function main() {
  if (!cmd || flags.has("--help") || flags.has("-h")) usage();
  if (!["preview", "promote", "verify", "current", "config"].includes(cmd)) usage();

  if (cmd === "config") {
    const raw = fs.readFileSync(path.join(root, "public/config/site.json"), "utf8");
    const json = JSON.parse(raw);
    if (!json.theme || !json.theme.bar || !json.theme.card) {
      die("public/config/site.json theme.bar and theme.card are required");
    }
    console.log("config_ok=true");
    console.log("config_url=https://raw.githubusercontent.com/joshdwall/theplaceholdertext/main/public/config/site.json");
    console.log("note=push to main updates the live site within about a minute; this does not deploy the Worker");
    return;
  }

  if (cmd === "verify") {
    await verify(positionals[0] || cfg.publicUrl);
    return;
  }

  const creds = await cloudflareCreds();
  console.log(`cf_source=${creds.source}`);
  console.log(`account=${creds.account}`);

  if (cmd === "current") {
    await current(creds);
    return;
  }
  if (cmd === "preview") {
    await preview(creds);
    return;
  }
  if (cmd === "promote") {
    await promote(creds);
    return;
  }
  usage();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
