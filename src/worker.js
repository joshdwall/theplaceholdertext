import { EmailMessage } from "cloudflare:email";

const MAX_BODY = 20_000;
const WINDOW_SECONDS = 60;
const MAX_PER_WINDOW = 3;
const SEND_MS = 12_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname === "www.theplaceholdertext.com") {
      url.hostname = "theplaceholdertext.com";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
      }
      return handleContact(request, env, ctx);
    }
    if (
      url.pathname === "/products" ||
      url.pathname === "/products.html" ||
      url.pathname === "/projects" ||
      url.pathname === "/projects/"
    ) {
      return Response.redirect(new URL("/products/", url).toString(), 301);
    }
    return renderAsset(request, env);
  },
};

async function handleContact(request, env, ctx) {
  const to = env.CONTACT_TO;
  const from = env.CONTACT_FROM;

  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY) {
    return reply(request, env, "error");
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await overLimit(ip)) {
    return reply(request, env, "limited");
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return reply(request, env, "error");
  }

  if (String(form.get("company_url") || "").trim()) {
    return reply(request, env, "sent");
  }

  const token = String(form.get("cf-turnstile-response") || "");
  const turnstileOk = await verifyTurnstile(token, ip, env.TURNSTILE_SECRET_KEY);
  if (!turnstileOk) {
    return reply(request, env, "error");
  }

  const email = oneLine(form.get("email"), 200);
  const organization = oneLine(form.get("organization"), 160);
  const message = String(form.get("message") || "").replace(/\r/g, "").trim().slice(0, 4000);
  if (!isEmail(email) || !message) {
    return reply(request, env, "error");
  }
  const name =
    oneLine(form.get("name"), 120) ||
    email.split("@")[0].slice(0, 80) ||
    "Visitor";

  const site = await loadSite(env, request);
  const brand = headerName(site.name);
  const raw = [
    `From: "${brand}" <${from}>`,
    `To: ${to}`,
    `Reply-To: ${email}`,
    `Subject: ${brand} — ${name}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Name: ${name}`,
    `Email: ${email}`,
    `Organization: ${organization || "(none)"}`,
    "",
    message,
  ].join("\r\n");

  let lead;
  try {
    lead = await within(SEND_MS, env.SEND_EMAIL.send(new EmailMessage(from, to, raw)));
  } catch {
    return reply(request, env, "error");
  }
  if (lead.timedOut) {
    ctx.waitUntil(lead.promise.catch(() => {}));
    return reply(request, env, "slow");
  }

  ctx.waitUntil(sendVisitorReceipt(env, from, email, brand, name).catch(() => {}));
  return reply(request, env, "sent");
}

async function sendVisitorReceipt(env, from, email, brand, name) {
  if (!env.SEND_VISITOR) return false;
  const reply = [
    `From: "${brand}" <${from}>`,
    `To: ${email}`,
    `Reply-To: ${from}`,
    `Subject: We received your note`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Hello ${name},`,
    "",
    "We have your message. A person will reply from this address.",
    "",
    brand,
  ].join("\r\n");
  try {
    await env.SEND_VISITOR.send(new EmailMessage(from, email, reply));
    return true;
  } catch {
    return false;
  }
}

function within(ms, promise) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, promise }), ms);
  });
  const done = promise.then(() => ({ timedOut: false }));
  return Promise.race([done, timeout]).finally(() => clearTimeout(timer));
}

function wantsJson(request) {
  return (request.headers.get("accept") || "").includes("application/json");
}

async function reply(request, env, code) {
  if (wantsJson(request)) {
    const ok = code === "sent" || code === "slow";
    const status = ok ? 200 : code === "limited" ? 429 : 400;
    return new Response(JSON.stringify({ ok, code }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return redirect(request, env, code);
}

async function redirect(request, env, code) {
  const copy = {
    sent: ["Message sent.", "We have it. A confirmation is on its way to the address you entered.", "success"],
    slow: ["Message sent.", "The mail service was slow to answer. If you do not hear back, try again in a few minutes.", "warning"],
    "sent-noconfirm": ["Message sent.", "We have it. The confirmation to your address did not go out. We will still reply.", "warning"],
    limited: ["Too many sends from this network.", "Wait a minute and try again.", "warning"],
    error: ["That message did not send.", "Check the fields and try again.", "danger"],
  };
  const [title, detail, kind] = copy[code] || copy.error;
  const site = await loadSite(env, request);
  const html = applyHtml(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>__FONT_LINK__<style>:root{--brand-font:__FONT_FAMILY__}</style><link rel="stylesheet" href="/theme/moss.css"></head><body><main class="page-main"><div class="note${kind === "success" ? "" : kind === "warning" ? " note-warn" : " note-bad"}" role="status"><h1>${title}</h1><p>${detail}</p></div><p class="intro"><a class="button" href="/#contact">Back to __SITE_NAME__</a></p></main></body></html>`,
    site,
  );
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

const FALLBACK_SITE = {
  name: "ThePlaceholderText",
  tagline: "We Fit Your Need.",
  summary: "ThePlaceholderText turns the work your staff already do into automations they will use.",
  font: "bricolage",
  fonts: {
    bricolage: {
      family: '"Bricolage Grotesque", "Segoe UI", sans-serif',
      stylesheet: "/vendor/fonts/bricolage-grotesque/font.css",
    },
  },
  hero: {
    image: "/media/moss-rocks.jpg",
    alt: "Lush green moss growing over forest rocks",
    credit: "Photograph by Marianne Gagnon. Public domain.",
  },
  theme: {
    bar: "#e5f2e8",
    card: "#e5f2e8",
    barInk: "#122018",
    line: "#c5d9cb",
  },
  configUrl: "https://raw.githubusercontent.com/joshdwall/theplaceholdertext/main/public/config/site.json",
};

async function renderAsset(request, env) {
  const url = new URL(request.url);
  const response = await env.ASSETS.fetch(request);
  const type = response.headers.get("content-type") || "";
  if (url.pathname === "/config/site.json") {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-cache");
    return new Response(response.body, { status: response.status, headers });
  }
  if (!type.includes("text/html")) return response;
  const site = await loadSite(env, request);
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache");
  headers.delete("content-length");
  return new Response(applyHtml(await response.text(), site), { status: response.status, headers });
}

async function loadSite(env, request) {
  const remote = env.CONFIG_URL || FALLBACK_SITE.configUrl;
  try {
    const res = await fetch(remote, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (res.ok) {
      const json = await res.json();
      if (json && typeof json === "object") return json;
    }
  } catch {
    /* fall through to the copy shipped with the Worker */
  }
  try {
    const url = new URL("/config/site.json", request.url);
    const res = await env.ASSETS.fetch(new Request(url));
    if (!res.ok) return FALLBACK_SITE;
    const json = await res.json();
    return json && typeof json === "object" ? json : FALLBACK_SITE;
  } catch {
    return FALLBACK_SITE;
  }
}

function resolveFont(site) {
  if (typeof site.fontFamily === "string" && site.fontFamily.trim()) {
    return { family: site.fontFamily, stylesheet: site.fontStylesheet || "" };
  }
  const choice = site.fonts && site.fonts[site.font];
  if (choice && choice.family) return choice;
  return FALLBACK_SITE.fonts.bricolage;
}

function applyHtml(html, site) {
  const font = resolveFont(site);
  const href = fontHref(font.stylesheet);
  const link = href ? `<link rel="stylesheet" href="${esc(href)}" />` : "";
  const hero = site.hero || FALLBACK_SITE.hero;
  const theme = themeStyle(site.theme);
  const pairs = [
    ["__FONT_LINK__", link],
    ["__FONT_FAMILY__", cssFamily(font.family)],
    ["__SITE_NAME__", esc(site.name || FALLBACK_SITE.name)],
    ["__SITE_TAGLINE__", esc(site.tagline || FALLBACK_SITE.tagline)],
    ["__SITE_SUMMARY__", esc(site.summary || FALLBACK_SITE.summary)],
    ["__HERO_IMAGE__", esc(assetPath(hero.image, FALLBACK_SITE.hero.image))],
    ["__HERO_ALT__", esc(hero.alt || FALLBACK_SITE.hero.alt)],
    ["__HERO_CREDIT__", esc(hero.credit || "")],
    ["__THEME_STYLE__", theme],
  ];
  let out = html;
  for (const [token, value] of pairs) out = out.replaceAll(token, value);
  if (!html.includes("__THEME_STYLE__") && theme) {
    out = out.replace("</head>", `${theme}</head>`);
  }
  return out;
}

function themeStyle(theme) {
  const src = theme && typeof theme === "object" ? theme : FALLBACK_SITE.theme;
  const hex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  const pick = (key, fallback) => (hex.test(String(src[key] || "")) ? String(src[key]) : fallback);
  const bar = pick("bar", FALLBACK_SITE.theme.bar);
  const card = pick("card", FALLBACK_SITE.theme.card);
  const ink = pick("barInk", FALLBACK_SITE.theme.barInk);
  const line = pick("line", FALLBACK_SITE.theme.line);
  return `<style id="site-theme">:root{--color-bar:${bar};--color-card:${card};--color-bar-ink:${ink};--color-line:${line}}</style>`;
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cssFamily(value) {
  const family = String(value || FALLBACK_SITE.fonts.bricolage.family).replace(/[<>{};\r\n]/g, "");
  return family.trim() || FALLBACK_SITE.fonts.bricolage.family;
}

function fontHref(value) {
  const path = String(value || "");
  if (!path.startsWith("/vendor/fonts/") || /["'<>\s]/.test(path)) return "";
  return path;
}

function assetPath(value, fallback) {
  const path = String(value || "");
  if (!path.startsWith("/") || /["'()\\\s<>]/.test(path)) return fallback;
  return path;
}

function headerName(value) {
  return String(value || FALLBACK_SITE.name).replace(/[\r\n"]/g, "").slice(0, 80) || FALLBACK_SITE.name;
}

function oneLine(value, max) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function isEmail(value) {
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value);
}

async function overLimit(ip) {
  const key = new Request(`https://theplaceholdertext.com/__contact-limit/${ip}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  const count = hit ? Number(await hit.text()) : 0;
  if (count >= MAX_PER_WINDOW) return true;
  await cache.put(
    key,
    new Response(String(count + 1), {
      headers: { "Cache-Control": `max-age=${WINDOW_SECONDS}` },
    }),
  );
  return false;
}

async function verifyTurnstile(token, ip, secret) {
  if (!token || !secret) return false;
  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  body.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  if (!res.ok) return false;
  const json = await res.json().catch(() => ({}));
  return json.success === true;
}
