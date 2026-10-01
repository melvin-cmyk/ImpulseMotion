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
import { accountsOfTikTokCall, describeTikTokTool, prepareTikTokArgs } from "./mcp-tiktok-args.mjs";

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
 *  - `prepare` / `accountsOf` / `describe` (server/mcp-tiktok-args.mjs) :
 *              l'appel est relu en JSON strict et complété, seul l'objet relu
 *              part en amont, et le compte est lu là où le serveur le lit —
 *              un appel qui n'en nomme pas est refusé, même pour un
 *              administrateur ; la description de l'outil est corrigée.
 *  - `closedTools` : le proxy ne démarre pas sans sa liste d'outils (SCOPED_TOOLS).
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
    // Le compte est lu par `accountsOf` ; ces clés sont ce que le second contrôle
    // cherche plus bas dans l'appel (un `advertiser_id` glissé dans `filtering`).
    keys: /^advertiser_ids?$/i,
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
    prepare: prepareTikTokArgs,
    accountsOf: accountsOfTikTokCall,
    describe: describeTikTokTool,
    closedTools: true,
  },
};

const profile = PROFILES[SERVER_NAME];
if (!profile) die(`SCOPED_SERVER_NAME inconnu ou manquant: "${SERVER_NAME}"`);
if (!/^https:\/\//.test(UPSTREAM_URL)) die("SCOPED_UPSTREAM_URL manquante ou non https");

if (RAW_ACCOUNTS.trim() !== "*" && !RAW_ACCOUNTS.split(",").some((s) => profile.norm(s))) die(`périmètre vide pour ${SERVER_NAME}`);

// ── Extraction des identifiants ──────────────────────────────────────────────

/**
 * Parcourt les arguments d'un appel et renvoie toute valeur qui désigne un
 * compte. Les outils n8n attendent un objet JSON *sérialisé* : une chaîne qui
 * ressemble à du JSON est donc reparcourue, sinon `{"input":"{\"ad_account_id\"
 * :\"act_999\"}"}` passerait à travers le contrôle.
 */
export function collectAccountIds(value, keys, depth = 0) {
  const found = [];
  if (value == null) return found;
  // Trop profond pour être relu : refusé, jamais transmis sans contrôle. La limite
  // est loin de tout appel réel (un filtre GA4 imbriqué dans `input` en prend une dizaine).
  if (depth > MAX_DEPTH) return typeof value === "object" || typeof value === "string" ? [UNREADABLE] : found;

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

/** Stands for a value too deep to be read: it is in no scope, so the call is refused. */
export const UNREADABLE = "[valeur illisible]";
const MAX_DEPTH = 40;

/**
 * Every scalar held under an account-ish key: v itself, the items of an array,
 * the leaves of an object. A string that is a serialised JSON array
 * (`"[\"123\"]"`, the form TikTok's advertiser_ids takes) is read as that
 * array: taken whole, it was neither a known id nor — once normalised to
 * nothing — a refused one.
 */
function scalars(v, depth = 0) {
  if (typeof v === "number") return [String(v)];
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[")) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return scalars(parsed, depth + 1);
      } catch { /* chaîne ordinaire */ }
    }
    return [v];
  }
  if (v === null || typeof v !== "object") return [];
  if (depth >= MAX_DEPTH) return [UNREADABLE];
  return Object.values(v).flatMap((x) => scalars(x, depth + 1));
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

/**
 * `input` of an old-generation n8n tool must be a strict JSON object. n8n reads
 * more than JSON (object notation, a fenced block, a bare value for a tool of
 * one parameter): what this proxy cannot read, n8n would still act on.
 * Returns the refusal, or null.
 */
export function unreadableInput(args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || args.input === undefined || args.input === null) return null;
  let value = args.input;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    try { value = JSON.parse(value); } catch { value = null; }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? null
    : "Appel refusé : `input` doit être un objet JSON strict (guillemets doubles, sans bloc de code ni commentaire).";
}

/**
 * What the proxy decides, apart from the network: which tools are open, and
 * for a call either the refusal or the arguments to send upstream.
 * @param {{ label: string, keys: RegExp, norm: (v: unknown) => string, deny: Set<string>, denyPattern?: RegExp, prepare?: Function, accountsOf?: Function }} p
 * @param {{ accounts: string, tools?: string }} scope  accounts: ids separated by commas, or "*" (no account filter)
 */
export function createGate(p, { accounts, tools = "" }) {
  // "*" = périmètre illimité (admins, Business Manager entier) : aucun compte
  // n'est filtré, tout le reste s'applique.
  const unrestricted = accounts.trim() === "*";
  const allowed = new Set(unrestricted ? [] : accounts.split(",").map((s) => p.norm(s)).filter(Boolean));
  // Liste fermée d'outils, posée par le relay (bot client : moins d'outils que
  // l'équipe). Absente = tous les outils de l'amont, moins `deny` et les écritures.
  const only = tools.split(",").map((s) => s.trim()).filter(Boolean);
  if (p.closedTools && !only.length) throw new Error("liste d'outils (SCOPED_TOOLS) manquante");
  const onlyTools = only.length ? new Set(only) : null;

  const isWrite = (name) => (p.denyPattern ? p.denyPattern.test(name) : false);
  const isClosed = (name) => (onlyTools ? !onlyTools.has(name) : false);
  const isDenied = (name) => p.deny.has(name) || isWrite(name) || isClosed(name);
  const outside = (ids) => (ids.includes(UNREADABLE)
    ? "Appel refusé : arguments trop imbriqués pour être relus. Simplifie l'appel."
    : `Accès refusé : le compte ${p.label} ${ids.join(", ")} n'est pas dans ton périmètre. Tu ne peux interroger que : ${[...allowed].join(", ")}.`);

  /** @returns {{ refusal: string } | { args: unknown }} */
  function check(name, given, { legacy = true } = {}) {
    if (isWrite(name)) return { refusal: `Outil "${name}" indisponible : les outils qui créent ou modifient ${p.label} ne sont pas ouverts dans cette conversation.` };
    if (p.deny.has(name)) {
      return { refusal: `Outil "${name}" indisponible : l'énumération des comptes ${p.label} n'est pas autorisée. Les comptes sur lesquels tu peux travailler te sont donnés dans tes instructions.` };
    }
    if (isClosed(name)) return { refusal: `Outil "${name}" indisponible : il n'est pas ouvert dans cette conversation.` };

    let args = given;
    if (p.prepare) {
      // Le contrôle porte sur ce qui part réellement en amont : l'objet relu, et lui seul.
      const prepared = p.prepare(name, given, { legacy });
      if (prepared.error) return { refusal: prepared.error };
      args = prepared.args;
      const named = p.accountsOf(name, prepared.object);
      // Énumérer les comptes de l'agence : l'équipe seulement (périmètre illimité).
      if (named.enumerates && !unrestricted) {
        return { refusal: `Outil "${name}" indisponible : l'énumération des comptes ${p.label} n'est pas autorisée. Les comptes sur lesquels tu peux travailler te sont donnés dans tes instructions.` };
      }
      if (named.error) return { refusal: unrestricted ? named.error : `${named.error} Tu ne peux interroger que : ${[...allowed].join(", ")}.` };
      const bad = unrestricted ? [] : named.ids.filter((id) => !allowed.has(p.norm(id)));
      if (bad.length) return { refusal: outside(bad) };
    } else if (legacy && !unrestricted) {
      const unreadable = unreadableInput(given);
      if (unreadable) return { refusal: unreadable };
    }

    const bad = unrestricted ? [] : outOfScope(args, p, allowed);
    if (bad.length) return { refusal: outside(bad) };
    return { args };
  }

  /** The tools a conversation sees: the open ones, their description corrected where the profile knows better. */
  const listed = (tools) => tools.filter((t) => !isDenied(t.name)).map((t) => (p.describe ? { ...t, description: p.describe(t.name, t.description) } : t));

  return { unrestricted, allowed, isDenied, listed, check };
}

let gate;
try { gate = createGate(profile, { accounts: RAW_ACCOUNTS, tools: process.env.SCOPED_TOOLS || "" }); }
catch (err) { die(`${err.message} pour ${SERVER_NAME}`); }

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
  return { tools: gate.listed(await readUpstreamTools()) };
});

const refusal = (text) => ({ isError: true, content: [{ type: "text", text }] });

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: given } = request.params;
  const decided = gate.check(name, given, { legacy: await takesSerialisedInput(name) });
  if ("refusal" in decided) {
    console.error(`[mcp-scoped-ads] refus ${SERVER_NAME}.${name} : ${decided.refusal.slice(0, 160)}`);
    return refusal(decided.refusal);
  }
  const args = decided.args;

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
  console.error(`[mcp-scoped-ads] ${SERVER_NAME} — périmètre: ${gate.unrestricted ? "*" : [...gate.allowed].join(", ")}`);

  const shutdown = async () => {
    try { await upstream.close(); } catch { /* déjà fermé */ }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
