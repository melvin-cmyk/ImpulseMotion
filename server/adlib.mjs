/**
 * Meta Ad Library, read from its public page (facebook.com/ads/library) with
 * the headless Chromium of the relay: competitors' ads with their picture,
 * video, text, start date — no token, no login (the API needs a person who
 * confirmed their identity, and gives no picture anyway).
 *
 *   searchAdLibrary({ q, country = "FR", limit = 24, active = true }) → { ads, total, ms, cached }
 *     ad = { id, pageName, body, started, platforms, image, video, poster, domain, snapshot }
 *
 * One Chromium at a time (1 vCPU), kept open between searches for 5 minutes,
 * answers cached 10 minutes. puppeteer-core lives in /opt/impulsemotion/tools
 * (outside the app's node_modules: Vercel must not install it).
 */

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const TOOLS_DIR = process.env.ADLIB_NODE_DIR || "/opt/impulsemotion/tools";
const CHROMIUM = process.env.ADLIB_CHROMIUM || "/usr/bin/chromium-browser";
const CACHE_MS = 10 * 60_000;
const IDLE_MS = 5 * 60_000;

let puppeteer = null;
export function adLibraryConfigured() {
  if (!fs.existsSync(CHROMIUM) || !fs.existsSync(path.join(TOOLS_DIR, "node_modules", "puppeteer-core"))) return false;
  if (!puppeteer) { try { puppeteer = createRequire(path.join(TOOLS_DIR, "package.json"))("puppeteer-core"); } catch { return false; } }
  return true;
}

let browser = null;
let idleTimer = null;
let queue = Promise.resolve();
const cache = new Map();

function log(msg) { console.log(`[adlib] ${msg}`); }

async function getBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({ executablePath: CHROMIUM, headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--window-size=1400,2400"] });
  log("chromium lancé");
  return browser;
}
function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => { try { await browser?.close(); } catch { /* fine */ } browser = null; log("chromium arrêté (inactif)"); }, IDLE_MS);
}
const serial = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => undefined); return next; };

/** Runs in the page: one record per « ID dans la bibliothèque » / « Library ID ». */
function extractInPage(max) {
  const ID_RE = /(?:ID dans la biblioth[èe]que|Identifiant de la biblioth[èe]que|Library ID)\s*:?\s*(\d{6,})/;
  const clean = (s) => String(s || "").replace(/[​-‏﻿]/g, "").trim();
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const idNodes = [];
  while (walker.nextNode()) {
    const n = walker.currentNode; const p = n.parentElement;
    if (!p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
    if (ID_RE.test(n.textContent || "")) idNodes.push(n);
  }
  const labels = /^(Active|Inactive|Actif|Started running|Début de diffusion|Platforms|Plateformes|Transparence UE|EU transparency|Sponsored|Sponsorisé|See ad details|Voir les détails|Library ID|ID dans la biblioth|Identifiant|Open Dropdown|Ouvrir la liste|This ad has multiple versions|Cette publicité a plusieurs versions|Learn more|En savoir plus|Shop now|Acheter|Sign up|S'inscrire|Contact us|Nous contacter|Book now|Réserver|Get offer|Obtenir l'offre|Download|Télécharger|Apply now|Postuler|Subscribe|S'abonner|Watch more|Voir plus|Send message|Envoyer un message|\d+ ads use this creative|\d+ publicités utilisent)/i;
  for (const node of idNodes) {
    const id = (clean(node.textContent).match(/(\d{6,})/) || [])[1];
    if (!id || seen.has(id)) continue;
    let el = node.parentElement, card = null;
    for (let depth = 0; el && depth < 14; depth++, el = el.parentElement) {
      const txt = el.innerText || "";
      if ((txt.match(/(?:ID dans la biblioth[èe]que|Identifiant de la biblioth[èe]que|Library ID)\s*:?\s*\d{6,}/g) || []).length > 1) break;
      if (/(Début de diffusion|Started running)/.test(txt) && (el.querySelector("img, video") || depth > 8)) card = el;
    }
    if (!card) continue;
    seen.add(id);
    const txt = card.innerText || "";
    const imgs = [...card.querySelectorAll("img")].map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth || i.width, h: i.naturalHeight || i.height })).filter((i) => /fbcdn|scontent/.test(i.src) && !/emoji|rsrc|static/.test(i.src));
    const big = imgs.filter((i) => i.w >= 120 && i.h >= 120).sort((a, b) => b.w * b.h - a.w * a.h)[0] || null;
    const avatar = imgs.find((i) => i.w <= 80 && i.h <= 80) || null;
    const video = card.querySelector("video");
    const poster = video ? video.poster || null : null;
    const started = clean((txt.match(/(?:Started running on|Début de diffusion le)\s*([^\n]+)/i) || [])[1] || "") || null;
    const platforms = ["Facebook", "Instagram", "Messenger", "Audience Network", "Threads"].filter((p) => new RegExp(`\\b${p}\\b`).test(txt));
    const lines = txt.split("\n").map(clean).filter(Boolean);
    const idx = lines.findIndex((l) => /(ID dans la biblioth|Identifiant de la biblioth|Library ID)/.test(l));
    const after = lines.slice(idx + 1).filter((l) => !labels.test(l) && !/^(https?:\/\/|[a-z0-9.-]+\.[a-z]{2,}$)/i.test(l));
    const pageName = after.find((l) => l.length <= 60) || "";
    const body = after.filter((l) => l !== pageName).sort((a, b) => b.length - a.length)[0] || "";
    const domain = (txt.match(/\b(?:[a-z0-9-]+\.)+(?:fr|com|io|co|net|org|eu|shop|store|be|ch)\b/i) || [])[0] || null;
    out.push({ id, pageName, body: body.slice(0, 500), started, platforms, image: big ? big.src : poster, video: video ? (video.currentSrc || video.src || video.querySelector("source")?.src || null) : null, poster, avatar: avatar ? avatar.src : null, domain: domain ? domain.toLowerCase() : null, snapshot: `https://www.facebook.com/ads/library/?id=${id}` });
    if (out.length >= max) break;
  }
  const results = (document.body.innerText.match(/~?\s?([\d\s., ]+)\s*(r[ée]sultats?|results?)/i) || [])[1] || null;
  return { ads: out, total: results ? Number(String(results).replace(/[^\d]/g, "")) || null : null };
}

export async function searchAdLibrary({ q, country = "FR", limit = 24, active = true } = {}) {
  if (!adLibraryConfigured()) throw new Error("bibliothèque Meta non configurée sur le relay (chromium ou puppeteer-core absent)");
  const term = String(q || "").trim().slice(0, 100);
  if (!term) return { ads: [], total: 0, ms: 0, cached: false };
  const key = `${country}|${active ? "a" : "all"}|${limit}|${term.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, cached: true };
  return serial(async () => {
    const t0 = Date.now();
    const b = await getBrowser();
    touch();
    const page = await b.newPage();
    try {
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36");
      await page.setExtraHTTPHeaders({ "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" });
      await page.setViewport({ width: 1400, height: 2400 });
      const url = `https://www.facebook.com/ads/library/?active_status=${active ? "active" : "all"}&ad_type=all&country=${encodeURIComponent(country)}&q=${encodeURIComponent(term)}&search_type=keyword_unordered&media_type=all`;
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
      for (const label of ["Refuser les cookies optionnels", "Decline optional cookies"]) {
        const ok = await page.$$eval("div[role=button], button", (els, l) => { const e = els.find((x) => (x.textContent || "").trim() === l); if (e) { e.click(); return true; } return false; }, label).catch(() => false);
        if (ok) break;
      }
      await new Promise((r) => setTimeout(r, 2500));
      const scrolls = limit > 10 ? 2 : 1;
      for (let i = 0; i < scrolls; i++) { await page.evaluate(() => window.scrollBy(0, 2200)); await new Promise((r) => setTimeout(r, 1800)); }
      const out = await page.evaluate(extractInPage, Math.min(60, Math.max(1, limit)));
      // The advertiser named in the query first (a keyword search also lists ads that only mention it).
      const t = term.toLowerCase();
      out.ads.sort((a, b) => Number((b.pageName || "").toLowerCase().includes(t)) - Number((a.pageName || "").toLowerCase().includes(t)));
      const value = { ads: out.ads, total: out.total, ms: Date.now() - t0 };
      cache.set(key, { at: Date.now(), value });
      log(`« ${term} » (${country}) : ${out.ads.length} pubs sur ${out.total ?? "?"} en ${value.ms} ms`);
      return { ...value, cached: false };
    } finally {
      try { await page.close(); } catch { /* fine */ }
    }
  });
}
