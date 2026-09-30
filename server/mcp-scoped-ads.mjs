#!/usr/bin/env node
/**
 * MCP stdio "scoped-ads" — proxy de périmètre devant un serveur MCP n8n.
 *
 * Les serveurs Meta Ads / Google Ads / GA4 / TikTok Ads sont des endpoints SSE
 * n8n qui parlent au Business Manager ENTIER via le jeton partagé de l'agence. Le
 * relay ne pouvait restreindre le LLM à un compte qu'en le lui demandant dans
 * le system prompt — une consigne, pas un contrôle : une injection dans le
 * message d'un consultant, ou dans celui d'un client via son bot privé,
 * suffisait à faire sortir les données d'un autre client.
 *
 * Ce proxy applique le même modèle que mcp-client-data : le périmètre vient de
 * l'environnement, jamais du prompt. Il relaie tools/list tel quel, et sur
 * tools/call il refuse tout identifiant de compte hors périmètre avant de
 * transmettre la requête en amont.
 *
 * Lancé par le relay avec, en env :
 *   SCOPED_SERVER_NAME  — meta-ads-impulse | mcp-google-ads | mcp-google-analytics | mcp-tiktok-ads
 *   SCOPED_UPSTREAM_URL — URL SSE du serveur n8n
 *   SCOPED_ACCOUNTS     — identifiants autorisés, séparés par des virgules
 *   SCOPED_TOOLS        — (option) seuls outils ouverts, séparés par des virgules
 * Refuse de démarrer si l'une manque ou si le périmètre est vide (fail-closed).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { compactToolResult } from "./mcp-compact.mjs";
import { followDailyPages } from "./mcp-meta-paging.mjs";
import { prepareTikTokArgs, describeTikTokTool } from "./mcp-tiktok-args.mjs";

const SERVER_NAME = process.env.SCOPED_SERVER_NAME || "";
const UPSTREAM_URL = process.env.SCOPED_UPSTREAM_URL || "";
const RAW_ACCOUNTS = process.env.SCOPED_ACCOUNTS || "";

const die = (msg) => {
  console.error(`[mcp-scoped-ads] ${msg} — refus de démarrer`);
  process.exit(1);
};

/**
 * Comment on reconnaît et compare un identifiant de compte, par serveur.
 *  - `keys`  : un nom de paramètre qui matche désigne un compte.
 *  - `norm`  : forme canonique pour la comparaison (act_/tirets/préfixes).
 *  - `deny`  : outils de découverte, qui énumèrent tout le BM ou tout le MCC
 *              sans prendre de paramètre de compte. Rien à valider dessus :
 *              on les coupe. Le modèle reçoit déjà ses comptes autorisés dans
 *              le system prompt, il n'a pas besoin de les découvrir.
 *  - `requireId` : un appel sans aucun identifiant de compte est refusé (au
 *              lieu d'être laissé à l'amont).
 *  - `prepare` / `describe` : arguments complétés avant l'envoi, et description
 *              de l'outil corrigée en conséquence (server/mcp-tiktok-args.mjs).
 */
export const PROFILES = {
  "meta-ads-impulse": {
    label: "Meta Ads",
    keys: /account/i,
    norm: (v) => String(v).trim().replace(/^act_/i, ""),
    deny: new Set(["List_Ad_Accounts1"]),
  },
  "mcp-google-ads": {
    label: "Google Ads",
    keys: /customer/i,
    norm: (v) => String(v).trim().replace(/-/g, "").replace(/^0+/, ""),
    deny: new Set(["List_Customers"]),
    // Outils d'écriture (Create_Conversion_Action…) : jamais depuis un chat,
    // même règle que GA4. Le bot d'un client y aurait sinon accès.
    denyPattern: /^(create|update|delete|remove|mutate|archive)_/i,
  },
  "mcp-google-analytics": {
    label: "Google Analytics",
    keys: /propert/i,
    norm: (v) => String(v).trim().replace(/^properties\//i, ""),
    deny: new Set(["list_accounts", "list_properties"]),
    // Outils d'administration / écriture GA4 : jamais depuis un chat.
    denyPattern: /^(create|update|archive|delete)_/,
  },
  "mcp-tiktok-ads": {
    label: "TikTok Ads",
    keys: /advertiser/i,
    // Un identifiant TikTok est une suite de chiffres. Toute autre forme est
    // gardée telle quelle : elle n'est jamais dans le périmètre, donc refusée,
    // plutôt qu'ignorée puis interprétée autrement par TikTok.
    norm: (v) => String(v).trim(),
    // Énumère tous les annonceurs de l'agence, et demande le secret de
    // l'application TikTok en paramètre : jamais depuis un chat.
    deny: new Set(["list_advertisers"]),
    // Le serveur n8n est en lecture seule aujourd'hui ; un outil d'écriture
    // ajouté plus tard resterait fermé.
    denyPattern: /^(create|update|delete|remove|upload|modify|set|enable|disable)_/i,
    requireId: true,
    prepare: prepareTikTokArgs,
    describe: describeTikTokTool,
  },
};

const profile = PROFILES[SERVER_NAME];
if (!profile) die(`SCOPED_SERVER_NAME inconnu ou manquant: "${SERVER_NAME}"`);
if (!/^https:\/\//.test(UPSTREAM_URL)) die("SCOPED_UPSTREAM_URL manquante ou non https");

// "*" = périmètre illimité (admins, Business Manager entier) : le proxy ne
// filtre alors aucun compte mais compacte toujours les réponses.
const UNRESTRICTED = RAW_ACCOUNTS.trim() === "*";
const allowed = new Set(
  UNRESTRICTED ? [] : RAW_ACCOUNTS.split(",").map((s) => profile.norm(s)).filter(Boolean),
);
if (!UNRESTRICTED && allowed.size === 0) die(`périmètre vide pour ${SERVER_NAME}`);

// Liste fermée d'outils, posée par le relay (bot client : moins d'outils que
// l'équipe). Absente = tous les outils de l'amont, moins `deny` et les écritures.
const ONLY_TOOLS = (process.env.SCOPED_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean);
const onlyTools = ONLY_TOOLS.length ? new Set(ONLY_TOOLS) : null;

// ── Extraction des identifiants ──────────────────────────────────────────────

/**
 * Parcourt les arguments d'un appel et renvoie toute valeur qui désigne un
 * compte. Les outils n8n attendent un objet JSON *sérialisé* : une chaîne qui
 * ressemble à du JSON est donc reparcourue, sinon `{"input":"{\"ad_account_id\"
 * :\"act_999\"}"}` passerait à travers le contrôle.
 */
export function collectAccountIds(value, keys, depth = 0) {
  const found = [];
  if (depth > 6 || value == null) return found;

  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return collectAccountIds(JSON.parse(t), keys, depth + 1);
      } catch { /* chaîne ordinaire */ }
    }
    return found;
  }

  if (Array.isArray(value)) {
    for (const item of value) found.push(...collectAccountIds(item, keys, depth + 1));
    return found;
  }

  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (keys.test(k)) {
        // The value under an account-ish key may be a scalar OR a list of them
        // ({"accounts": ["act_111", "act_999"]}): take every scalar it holds,
        // then keep walking in case it also nests objects.
        found.push(...scalars(v));
      }
      found.push(...collectAccountIds(v, keys, depth + 1));
    }
  }
  return found;
}

/**
 * The scalar values held directly by v (v itself, or the items of an array).
 * A string that is a serialised JSON array (`"[\"123\"]"`, the form TikTok's
 * advertiser_ids takes) is read as that array: taken whole, it was neither a
 * known id nor — once normalised to nothing — a refused one.
 */
function scalars(v, depth = 0) {
  if (typeof v === "number") return [String(v)];
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[") && depth < 4) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return scalars(parsed, depth + 1);
      } catch { /* chaîne ordinaire */ }
    }
    return [v];
  }
  if (Array.isArray(v) && depth < 4) return v.flatMap((x) => (typeof x === "string" || typeof x === "number" || Array.isArray(x) ? scalars(x, depth + 1) : []));
  return [];
}

/** Identifiants demandés qui ne sont pas dans le périmètre. */
export function outOfScope(args, { keys, norm }, allowedSet) {
  const ids = collectAccountIds(args, keys);
  const bad = [];
  for (const id of ids) {
    const n = norm(id);
    // Une valeur vide ou un placeholder laissé par le modèle n'est pas un
    // compte : on laisse l'amont la rejeter avec son propre message.
    if (!n) continue;
    if (!allowedSet.has(n) && !bad.includes(id)) bad.push(id);
  }
  return bad;
}

/** True when the call names at least one account (whatever its scope). */
export function namesAnAccount(args, { keys, norm }) {
  return collectAccountIds(args, keys).some((id) => norm(id));
}

// ── Amont (SSE) ──────────────────────────────────────────────────────────────

const upstream = new Client(
  { name: `impulsemotion-scoped-${SERVER_NAME}`, version: "1.0.0" },
  { capabilities: {} },
);

async function connectUpstream() {
  const transport = new SSEClientTransport(new URL(UPSTREAM_URL));
  await upstream.connect(transport);
}

// ── Aval (stdio, vu par le CLI Claude) ───────────────────────────────────────

const server = new Server(
  { name: SERVER_NAME, version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Dernière liste d'outils lue en amont : dit sous quelle forme un outil attend
// ses arguments (voir `prepare`).
let upstreamTools = null;
async function readUpstreamTools() {
  const { tools } = await upstream.listTools();
  upstreamTools = tools || [];
  return upstreamTools;
}

/** Outil n8n d'ancienne génération : un seul paramètre `input`, objet JSON en chaîne. */
async function takesSerialisedInput(name) {
  let tool;
  try { tool = (upstreamTools ?? await readUpstreamTools()).find((t) => t.name === name); } catch { return true; }
  const props = tool?.inputSchema?.properties;
  return !props || (Object.keys(props).length === 1 && "input" in props);
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await readUpstreamTools();
  return {
    tools: tools
      .filter((t) => !isDenied(t.name))
      .map((t) => (profile.describe ? { ...t, description: profile.describe(t.name, t.description) } : t)),
  };
});

const refusal = (text) => ({ isError: true, content: [{ type: "text", text }] });
const isWrite = (name) => (profile.denyPattern ? profile.denyPattern.test(name) : false);
const isClosed = (name) => (onlyTools ? !onlyTools.has(name) : false);
const isDenied = (name) => profile.deny.has(name) || isWrite(name) || isClosed(name);

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: given } = request.params;

  if (isWrite(name)) {
    return refusal(`Outil "${name}" indisponible : les outils qui créent ou modifient ${profile.label} ne sont pas ouverts dans cette conversation.`);
  }
  if (profile.deny.has(name)) {
    return refusal(
      `Outil "${name}" indisponible : l'énumération des comptes ${profile.label} n'est pas autorisée. ` +
        `Les comptes sur lesquels tu peux travailler te sont donnés dans tes instructions.`,
    );
  }
  if (isClosed(name)) {
    return refusal(`Outil "${name}" indisponible : il n'est pas ouvert dans cette conversation.`);
  }

  // Le contrôle porte sur ce qui part réellement en amont.
  const args = profile.prepare ? profile.prepare(name, given, { legacy: await takesSerialisedInput(name) }) : given;

  if (!UNRESTRICTED && profile.requireId && !namesAnAccount(args, profile)) {
    return refusal(
      `Appel refusé : "${name}" doit nommer le compte ${profile.label} interrogé. ` +
        `Tu ne peux interroger que : ${[...allowed].join(", ")}.`,
    );
  }

  const bad = UNRESTRICTED ? [] : outOfScope(args, profile, allowed);
  if (bad.length > 0) {
    console.error(`[mcp-scoped-ads] refus ${SERVER_NAME}.${name} hors périmètre: ${bad.join(", ")}`);
    return refusal(
      `Accès refusé : le compte ${profile.label} ${bad.join(", ")} n'est pas dans ton périmètre. ` +
        `Tu ne peux interroger que : ${[...allowed].join(", ")}.`,
    );
  }

  let raw = await upstream.callTool({ name, arguments: args ?? {} });
  // Meta coupe une série quotidienne à 25 lignes par page : on va chercher la
  // suite sur le même compte (arguments déjà contrôlés) et on recolle.
  if (SERVER_NAME === "meta-ads-impulse") {
    const followed = await followDailyPages(raw, args ?? {}, (next) => upstream.callTool({ name, arguments: next }));
    if (followed.pages > 0) console.error(`[mcp-scoped-ads] ${SERVER_NAME}.${name} série poursuivie sur ${followed.pages} page(s)`);
    raw = followed.result;
  }
  // Compaction déterministe (server/mcp-compact.mjs) : même lecture pour
  // l'analyste, 75-95 % de tokens en moins sur les JSON n8n.
  const { result, stats } = compactToolResult(raw, { server: SERVER_NAME, tool: name });
  if (stats) console.error(`[mcp-scoped-ads] ${SERVER_NAME}.${name} ${stats.raw} → ${stats.out} chars`);
  return result;
});

// ── Démarrage ────────────────────────────────────────────────────────────────

// Importé par les tests pour n'exercer que les fonctions pures.
if (process.env.SCOPED_ADS_NO_LISTEN !== "1") {
  try {
    await connectUpstream();
  } catch (err) {
    die(`connexion amont impossible: ${err?.message ?? err}`);
  }
  await server.connect(new StdioServerTransport());
  console.error(`[mcp-scoped-ads] ${SERVER_NAME} — périmètre: ${[...allowed].join(", ")}`);

  const shutdown = async () => {
    try { await upstream.close(); } catch { /* déjà fermé */ }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
