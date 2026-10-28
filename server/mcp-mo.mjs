#!/usr/bin/env node
/**
 * MCP stdio "mo" — Mo's hands. Each tool is forwarded to the application
 * (POST /api/mo/tools, bearer = the relay's shared secret) which runs it as
 * the consultant who is speaking, under their ACL (lib/mo/tools.ts).
 *
 * Launched by the relay with, in env:
 *   MO_TOOLS_URL  — https://<app>/api/mo/tools
 *   MO_TOKEN      — RELAY_SHARED_SECRET
 *   MO_USER       — the consultant's user id (from the app's request, never from the model)
 *   MO_BOARD      — the Mo board of the conversation
 * Refuses to start when one is missing.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const URL_ = process.env.MO_TOOLS_URL || "";
const TOKEN = process.env.MO_TOKEN || "";
const USER = process.env.MO_USER || "";
const BOARD = process.env.MO_BOARD || "";
if (!/^https?:\/\//.test(URL_) || TOKEN.length < 16 || !USER || !BOARD) {
  console.error("[mcp-mo] MO_TOOLS_URL / MO_TOKEN / MO_USER / MO_BOARD manquants — refus de démarrer");
  process.exit(1);
}

async function call(tool, args, timeoutMs) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ userId: USER, boardId: BOARD, tool, args }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || !json?.ok) {
    const error = json?.error || `HTTP ${res.status}`;
    return { content: [{ type: "text", text: `ERREUR ${tool} : ${error}` }], isError: true };
  }
  return { content: [{ type: "text", text: JSON.stringify(json.result) }] };
}

const server = new McpServer({ name: "mo", version: "1.0.0" });

const client = z.string().min(1).max(120).describe("Le client, tel que dit à l'oral (« cours legendre », « naturalia ») ou son identifiant de la liste des clients.");
const period = z.enum(["today", "yesterday", "this_week", "last_week", "last_7d", "last_14d", "last_30d", "this_month", "last_month"]).optional().describe("Période parlée. Semaine = lundi → dimanche. Défaut : 7 derniers jours. Ou donne since/until.");
const since = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Premier jour (YYYY-MM-DD) quand la période est explicite.");
const until = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Dernier jour (YYYY-MM-DD), inclus.");

server.registerTool("creatives", {
  title: "Créas d'un client",
  description: "Les annonces (créas) d'un client sur une période, avec leurs visuels (image https) et leurs chiffres déjà formatés en français (Dépense, CTR, CPA/CPL, ROAS…), depuis l'entrepôt de l'agence (Meta, Google, TikTok). Réponse immédiate. `card_hint` est une carte « creatives » prête à poser sur le tableau (garde les adId : ils servent ensuite à ajouter des chiffres, générer des variantes, publier). launched_in_period=true pour « les créas lancées / postées cette semaine » (date de création), sinon = celles qui ont diffusé sur la période.",
  inputSchema: {
    client, period, since, until,
    platform: z.enum(["meta", "google", "tiktok", "all"]).optional().describe("Défaut : toutes les plateformes du client."),
    launched_in_period: z.boolean().optional(),
    sort: z.enum(["spend", "cpa", "ctr", "roas", "conversions", "leads", "impressions", "hookRate", "launch"]).optional().describe("Tri (défaut : dépense décroissante ; cpa et launch croissants)."),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.number().int().min(1).max(24).optional().describe("Défaut 12."),
    min_spend: z.number().min(0).optional(),
    name_contains: z.string().max(80).optional(),
  },
}, async (args) => call("creatives", args, 60_000));

server.registerTool("creative_metrics", {
  title: "Chiffres d'annonces précises",
  description: "Les chiffres (formatés en français) d'annonces désignées par leur adId sur une période — pour « mets les chiffres sous chaque créa » quand les visuels sont déjà sur le tableau : réécris alors la carte existante (update) avec ces metrics.",
  inputSchema: { client, adIds: z.array(z.string().max(40)).min(1).max(40), period, since, until, platform: z.enum(["meta", "google", "tiktok", "all"]).optional() },
}, async (args) => call("creative_metrics", args, 60_000));

server.registerTool("generate_creatives", {
  title: "Générer des créas (fal.ai)",
  description: "Crée 1 à 4 nouveaux visuels publicitaires avec fal.ai (Agnes en secours), les enregistre dans les Créas du client (origine Mo) et les dépose dans son dossier Drive « Créas ». Prend 15 à 90 s. Donne un prompt précis en anglais ou en français (sujet, style, cadrage, ambiance, texte à éviter) ; `references` = adId d'annonces du client ou assetId de visuels déjà générés pour s'en inspirer (3 max). Respecte les quotas du jour (refus 429 sinon). `card_hint` est la carte prête à poser (garde les assetId pour publier ensuite).",
  inputSchema: {
    client,
    prompt: z.string().min(3).max(4000),
    n: z.number().int().min(1).max(4).optional().describe("Nombre de visuels (défaut 1)."),
    ratio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"]).optional().describe("Défaut 1:1 ; 3:4 pour le feed vertical, 9:16 pour les stories."),
    references: z.array(z.string().max(500)).max(3).optional(),
    engine: z.string().max(60).optional().describe("Modèle fal (fal-ai/flux/schnell, fal-ai/nano-banana, fal-ai/nano-banana/edit, fal-ai/flux-pro/v1.1-ultra, fal-ai/ideogram/v3). Défaut : celui de l'application."),
  },
}, async (args) => call("generate_creatives", args, 240_000));

server.registerTool("meta_targets", {
  title: "Campagnes et ensembles Meta d'un client",
  description: "Les campagnes et ensembles de publicités Meta du client (identifiants, statut, dépense 30 jours) pour choisir où ajouter une publicité. `query` filtre par nom (« prospection », « retargeting »…).",
  inputSchema: { client, query: z.string().max(80).optional() },
}, async (args) => call("meta_targets", args, 60_000));

server.registerTool("meta_publish_ad", {
  title: "Publier un visuel en publicité Meta (en pause)",
  description: "Ajoute un visuel généré (assetId) comme nouvelle publicité IMAGE dans un ensemble Meta du client, créée EN PAUSE. Deux temps obligatoires : 1) sans confirm → tout est vérifié et préparé, rien n'est envoyé : lis le résumé à la personne (ensemble, page, texte, lien) et attends un « oui » explicite ; 2) avec confirm=true et l'actionId reçu → la publicité est créée (en pause) et consignée dans HQ et dans le Pilotage. Ne mets jamais confirm=true sans que la personne ait dit oui à CE résumé.",
  inputSchema: {
    client,
    assetId: z.string().max(40).optional().describe("Visuel généré par Mo ou le Studio (phase 1)."),
    adsetId: z.string().regex(/^\d{5,25}$/).optional().describe("Ensemble de publicités cible (voir meta_targets) (phase 1)."),
    accountId: z.string().max(40).optional().describe("Seulement si le client a plusieurs comptes Meta."),
    name: z.string().max(255).optional().describe("Nom de la publicité (défaut : généré)."),
    primaryText: z.string().max(2000).optional().describe("Texte principal (phase 1, requis)."),
    headline: z.string().max(255).optional(),
    description: z.string().max(255).optional(),
    linkUrl: z.string().max(2000).optional().describe("Lien de destination https (phase 1, requis) : prends la landing d'une créa existante du client si la personne n'en donne pas, et dis-le."),
    callToAction: z.string().max(40).optional().describe("SHOP_NOW, LEARN_MORE, SIGN_UP, CONTACT_US, BOOK_TRAVEL, DOWNLOAD, GET_OFFER, SUBSCRIBE, APPLY_NOW, GET_QUOTE, ORDER_NOW, NO_BUTTON…"),
    pageId: z.string().max(30).optional().describe("Page Facebook ; devinée quand le compte n'en a qu'une."),
    instagramUserId: z.string().max(30).optional(),
    why: z.string().max(2000).optional().describe("Pourquoi (écrit dans HQ)."),
    confirm: z.boolean().optional().describe("true = la personne a dit oui au résumé : envoi."),
    actionId: z.string().max(40).optional().describe("Identifiant reçu en phase 1 (requis avec confirm)."),
  },
}, async (args) => call("meta_publish_ad", args, 180_000));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp-mo] prêt (board ${BOARD})`);
