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
  description: "Les annonces (créas) d'un client sur une période, avec leurs visuels et leurs chiffres formatés en français (Dépense, CTR, CPA/CPL, ROAS…), depuis l'entrepôt de l'agence (Meta par défaut, 3 s). POSE LUI-MÊME la carte « creatives » sur le tableau (posted_card) : tu n'as que la phrase à dire, ne recopie pas les items. Les adId de la réponse servent ensuite (chiffres, variantes, publication). launched_in_period=true pour « lancées / postées cette semaine » (date de création) ; « les 10 dernières créas » = sort launch, order desc, limit 10.",
  inputSchema: {
    client, period, since, until,
    platform: z.enum(["meta", "google", "tiktok", "all"]).optional().describe("Défaut : toutes les plateformes du client."),
    launched_in_period: z.boolean().optional(),
    sort: z.enum(["spend", "cpa", "ctr", "roas", "conversions", "leads", "impressions", "hookRate", "launch"]).optional().describe("Tri (défaut : dépense décroissante ; cpa et launch croissants)."),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.number().int().min(1).max(24).optional().describe("Défaut 12."),
    min_spend: z.number().min(0).optional(),
    name_contains: z.string().max(80).optional(),
    with_metrics: z.boolean().optional().describe("false = seulement la dépense sous chaque visuel (défaut : tous les chiffres)."),
    title: z.string().max(90).optional().describe("Titre de la carte (défaut : généré)."),
    post: z.boolean().optional().describe("false = ne pose pas la carte (rare)."),
  },
}, async (args) => call("creatives", args, 60_000));

server.registerTool("metrics", {
  title: "Chiffres d'un client",
  description: "Les chiffres d'un client sur une période (dépense, leads/conversions, CPL/CPA, CTR, CPM, ROAS) avec l'écart contre la période précédente de même longueur, depuis l'entrepôt (Meta + Google + TikTok, 3 s). POSE LUI-MÊME la carte KPI (et un tableau par campagne / ensemble / format avec `by`) : tu n'as que la phrase à dire. La réponse à « le CPA de Naturalia cette semaine », « ça donne quoi sur LPEV ce mois-ci », « par campagne ».",
  inputSchema: { client, period, since, until, platform: z.enum(["meta", "google", "tiktok", "all"]).optional().describe("Défaut : toutes."), by: z.enum(["campaign", "adset", "format"]).optional().describe("Ajoute un tableau par campagne / ensemble / format."), compare: z.boolean().optional().describe("false = sans comparaison (défaut : période précédente)."), title: z.string().max(90).optional(), post: z.boolean().optional().describe("false = ne pose pas la carte (rare).") },
}, async (args) => call("metrics", args, 60_000));

server.registerTool("creative_metrics", {
  title: "Chiffres d'annonces précises",
  description: "Les chiffres (formatés en français) d'annonces désignées par leur adId sur une période — « mets les chiffres sous chaque créa » : ils sont ÉCRITS DIRECTEMENT sous les visuels des cartes du tableau (updated_cards). Tu n'as que la phrase à dire.",
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
    names: z.array(z.string().max(60)).max(4).optional().describe("Un nom court par visuel, pour la carte."),
    title: z.string().max(90).optional(),
    post: z.boolean().optional(),
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

server.registerTool("competitor_ads", {
  title: "Pubs d'une marque (bibliothèque Meta)",
  description: "Les publicités qu'une marque (un concurrent) diffuse EN CE MOMENT, lues dans la bibliothèque publicitaire Meta (page publique, 15 à 20 s) : visuel, texte, date de début, plateformes. POSE LUI-MÊME la carte (posted_card). La réponse à « montre-moi les pubs de La Fourche », « qu'est-ce que font les concurrents de Naturalia » (cherche alors chaque marque). Les libraryId servent ensuite à keep_template.",
  inputSchema: { query: z.string().min(2).max(100).describe("Marque ou mot-clé."), country: z.string().length(2).optional().describe("Pays (défaut FR)."), limit: z.number().int().min(1).max(24).optional().describe("Défaut 12."), all: z.boolean().optional().describe("true = aussi les pubs inactives."), title: z.string().max(90).optional(), post: z.boolean().optional() },
}, async (args) => call("competitor_ads", args, 120_000));

server.registerTool("keep_template", {
  title: "Garder une pub comme template",
  description: "Garde une pub de la bibliothèque (donne son imageUrl reçu de competitor_ads — le plus rapide — ou libraryId + la query de la recherche) ou n'importe quelle image https comme TEMPLATE du client (Créas › Templates & concurrents) : l'image est copiée, l'IA l'analyse (accroche, structure, zones de texte, style, brief). Ensuite generate_creatives avec references=[templateId] en fait une version à la marque du client.",
  inputSchema: { libraryId: z.string().max(40).optional(), query: z.string().max(100).optional().describe("La marque cherchée dans competitor_ads (pour retrouver la pub)."), imageUrl: z.string().max(2000).optional(), client: z.string().max(120).optional().describe("Le client pour qui on garde ce template (sinon template d'agence)."), brand: z.string().max(120).optional(), name: z.string().max(120).optional(), title: z.string().max(500).optional(), body: z.string().max(4000).optional(), tags: z.string().max(300).optional(), country: z.string().length(2).optional() },
}, async (args) => call("keep_template", args, 120_000));

server.registerTool("brand_playbook", {
  title: "Étudier une marque (playbook)",
  description: "Étudie la bibliothèque publicitaire Meta d'une marque (ses pubs actives, complétées par les passées) : chaque pub avec image est lue par l'IA, puis regroupée en FORMATS récurrents (avant/après, témoignage, liste de bénéfices…) avec leur fréquence et s'ils sont polyvalents (réutilisables pour un autre client). 1 à 2 minutes la première fois (dis-le avant), immédiat ensuite (cache 7 jours). POSE LUI-MÊME deux cartes : les pubs numérotées (format sous chacune) et le playbook. La réponse à « étudie la bibliothèque de Huel », « quels formats fait Acadomia ». Ensuite « garde la 2 » sur la carte ou keep_template (imageUrl + client) en fait des templates du client.",
  inputSchema: { brand: z.string().min(2).max(100).describe("La marque à étudier."), client: z.string().max(120).optional().describe("Le client pour qui on étudie (les templates gardés seront les siens)."), country: z.string().length(2).optional().describe("Défaut FR."), limit: z.number().int().min(4).max(30).optional().describe("Pubs lues par l'IA (défaut 18)."), fresh: z.boolean().optional().describe("true = refaire l'étude même si elle est en cache."), post: z.boolean().optional() },
}, async (args) => call("brand_playbook", args, 280_000));

server.registerTool("factory_propose", {
  title: "Fabrique de statics : proposer des copys",
  description: "Lance une FABRIQUE DE STATICS pour un client : à partir de ses templates (templateIds, sinon ses derniers templates gardés), l'IA lit le contexte du client (brief et fichiers HQ, gagnantes de l'entrepôt, angles jamais testés, retours passés) et propose des copys (titre, sous-titre, bouton, angle, source). 30 s à 1 min. POSE LUI-MÊME la table « Copys à valider » (numérotée), une note « Contexte lu » et des puces. Avec run (ou again=true) : repropose sur la fabrique en cours (les copys validés restent). Ne génère AUCUNE image : la personne valide d'abord.",
  inputSchema: {
    client: client.optional(), templateIds: z.array(z.string().max(40)).max(12).optional().describe("Templates choisis (keep_template / brand_playbook les donnent)."),
    templates: z.number().int().min(1).max(12).optional().describe("Sans templateIds : combien des derniers templates du client (défaut 4)."), tag: z.string().max(60).optional().describe("Sans templateIds : seulement les templates portant ce tag (ex. playbook:huel)."),
    kind: z.enum(["offer", "evergreen", "iteration"]).optional().describe("offer = une offre (donne-la dans instructions), evergreen (défaut), iteration = nouvelles formulations d'angles gagnants."),
    per_template: z.number().int().min(1).max(6).optional().describe("Copys par template (défaut 3)."), instructions: z.string().max(1500).optional().describe("Ce que veut la personne : offre, produit, ton, interdits."),
    persona: z.string().max(200).optional(), season: z.string().max(200).optional(), reviews: z.string().max(20000).optional().describe("Avis clients collés, s'il y en a."),
    run: z.string().max(40).optional().describe("Reproposer sur cette fabrique."), again: z.boolean().optional().describe("true = reproposer sur la fabrique en cours du tableau."), post: z.boolean().optional(),
  },
}, async (args) => call("factory_propose", args, 280_000));

server.registerTool("factory_approve", {
  title: "Fabrique de statics : valider des copys",
  description: "Valide des copys de la fabrique en cours (la table « Copys à valider » du tableau) : numbers = les numéros dits (« valide 1 à 5 » → [1,2,3,4,5], « valide 1, 4 et 7 » → [1,4,7]) ou all=true ; les autres sont écartés (reject_others=false pour les laisser). La table est réécrite en place (colonne ✓). Ensuite propose factory_generate en disant le prix (~0,06 $ l'image).",
  inputSchema: { run: z.string().max(40).optional().describe("Défaut : la fabrique de la table du tableau."), numbers: z.array(z.number().int().min(1).max(60)).max(60).optional(), all: z.boolean().optional(), reject_others: z.boolean().optional() },
}, async (args) => call("factory_approve", args, 60_000));

server.registerTool("factory_generate", {
  title: "Fabrique de statics : générer les visuels",
  description: "Génère les visuels des copys validés de la fabrique en cours (fal Nano Banana 2, le template et les éléments de marque en référence), par passes de 12, rangés dans les Créas et le Drive du client ; respecte les quotas (refus sinon). 1 à 3 minutes (dis-le avant). POSE LUI-MÊME la grille des visuels (garder / couper / publier marchent dessus). n = visuels voulus (défaut 8, 100 max ; au-delà de 12 la suite part en arrière-plan et la grille se pose toute seule à la fin : dis-le) — seulement après un accord explicite de la personne sur le nombre et le prix.",
  inputSchema: { run: z.string().max(40).optional(), n: z.number().int().min(1).max(100).optional(), ratio: z.enum(["1:1", "3:4", "9:16", "16:9"]).optional().describe("Défaut 1:1."), engine: z.string().max(80).optional(), textless: z.boolean().optional().describe("true = sans texte dans l'image (textes posés ensuite dans FigCraft)."), post: z.boolean().optional() },
}, async (args) => call("factory_generate", args, 290_000));

server.registerTool("factory_variations", {
  title: "Fabrique de statics : variations des gardées",
  description: "Décline les visuels GARDÉS d'une fabrique pour une autre persona, une saison ou une consigne (« fais-moi des variations Noël des gardées », « la même chose pour les parents de lycéens ») : nouvelle fabrique dont les copys repassent en validation (table posée, puces), puis factory_approve et factory_generate ; chaque nouveau visuel part de son visuel gardé. Il faut au moins une de : persona, season, instructions.",
  inputSchema: { run: z.string().max(40).optional().describe("Défaut : la fabrique du tableau."), persona: z.string().max(200).optional(), season: z.string().max(200).optional(), instructions: z.string().max(1500).optional(), per_template: z.number().int().min(1).max(4).optional().describe("Copys par template (défaut 2).") },
}, async (args) => call("factory_variations", args, 280_000));

server.registerTool("factory_publish", {
  title: "Fabrique de statics : publier les gardées (Meta, en pause)",
  description: "Publie les visuels GARDÉS d'une fabrique en publicités Meta image, une par visuel (titre = son copy), toutes EN PAUSE, via le Pilotage. DEUX TEMPS obligatoires : 1) sans confirm → tout est vérifié sur Meta, rien n'est envoyé (si needs revient, demande l'ensemble / la Page) ; lis le résumé (combien, quel ensemble, en pause) ; 2) seulement après un « oui » explicite à CE résumé → confirm=true + actionId. Texte et lien : ceux donnés, sinon ceux de la pub la plus dépensée du client (dis-le).",
  inputSchema: {
    run: z.string().max(40).optional(), adsetId: z.string().regex(/^\d{5,25}$/).optional(), accountId: z.string().max(40).optional(), pageId: z.string().max(30).optional(),
    primaryText: z.string().max(2000).optional(), linkUrl: z.string().max(2000).optional(), callToAction: z.string().max(40).optional(), why: z.string().max(2000).optional(),
    confirm: z.boolean().optional(), actionId: z.string().max(40).optional(),
  },
}, async (args) => call("factory_publish", args, 280_000));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp-mo] prêt (board ${BOARD})`);
