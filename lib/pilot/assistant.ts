/**
 * Pilotage — the AI a consultant talks to about one client, to change its
 * campaigns on Meta and Google Ads.
 *
 * The AI sees every account of the client the consultant may change (Meta and
 * Google Ads side by side, as everywhere else in ImpulseMotion): campaigns and
 * ad sets / ad groups with their status, budget, last 7 days' results. It has
 * no tool. It answers, and when a change is wanted it proposes it in a fenced
 * ```pilot block, one block per account:
 *
 *   {"platform":"meta","accountId":"123","why":"…","requests":[
 *     {"kind":"set_daily_budget","objectType":"adset","objectId":"456","value":50,"label":"…"}]}
 *
 * Nothing is sent from there. The block is read here (extractPilotProposals),
 * checked against the accounts of the client (validatePilotProposal), shown as
 * a card, and only the consultant's click prepares the usual preview
 * (POST /api/pilot/actions) — read again on the platform, with the second
 * confirmation, the reason, the HQ entry and the undo of a manual change.
 *
 * Pure (no network, no database): shared by the route and the page.
 */

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@/lib/ai-tool-guidance";
import { PILOT_ASSISTANT_PROFILE } from "@/lib/ai-profiles";
import type { RelayChatBody, RelayMessage } from "@/lib/relay-chat";
import {
  PILOT_KINDS, PILOT_MAX_OPERATIONS, PLATFORM_FR, isPilotPlatform, money, objectLabel, readRequest,
  type PilotPlatform, type PilotRequest,
} from "@/lib/pilot/ops";

export const PILOT_FENCE = "pilot";
export const PILOT_ASSISTANT_BUDGET_MS = 150_000;
export const PILOT_CHAT_MAX_MESSAGES = 40;
export const PILOT_CHAT_MAX_MESSAGE_CHARS = 20_000;
/** Room for the accounts in a user message, under the relay's own cap (20 000). */
export const PILOT_CONTEXT_MAX_CHARS = 16_000;
/** Accounts read for one conversation: beyond, the consultant picks the account first. */
export const PILOT_MAX_ACCOUNTS = 6;

export type PilotRelayBody = RelayChatBody & { turnContext: string };

export interface ContextMetrics { spend: number; conversions: number; cpa: number; roas: number; roasAvailable: boolean }

export interface ContextObject {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  /** Minor units of the currency. */
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  bidAmount: number | null;
  bidStrategy: string | null;
  /** Cost per result aimed at (minor units) and ROAS aimed at (ratio), when the strategy has one. */
  targetCpa?: number | null;
  targetRoas?: number | null;
  spendCap?: number | null;
  startTime?: string | null;
  endTime?: string | null;
  budgetLock: string | null;
  parentId: string | null;
  spend7d: number;
  /** Last 7 full days and the 7 before (campaigns only); null when not read. */
  last7: ContextMetrics | null;
  prev7: ContextMetrics | null;
}

export interface ContextAccount {
  platform: PilotPlatform;
  accountId: string;
  name: string;
  currency: string | null;
  /** Set when the account could not be read: the AI is told, and proposes nothing on it. */
  error: string | null;
  writesOpen: boolean;
  campaigns: ContextObject[];
  adsets: ContextObject[];
}

export function pilotSessionKey(clientId: string, userId: string, thread: string): string {
  return `pilot:${clientId}:${userId}:${thread}`;
}

// ── Prompt ───────────────────────────────────────────────────────────────

const KIND_DOCS: Record<(typeof PILOT_KINDS)[number], string> = {
  set_status: `"value" : "ACTIVE" (activer), "PAUSED" (mettre en pause) ou "DELETED" (supprimer — définitif, à ne proposer que sur demande explicite)`,
  set_daily_budget: `"value" : le nouveau budget JOURNALIER en unités de la devise du compte (50 = 50 €/jour). Seulement sur l'objet qui porte un budget journalier dans le contexte (campagne ou ensemble), jamais sur un budget marqué « partagé »`,
  set_lifetime_budget: `"value" : le nouveau budget TOTAL en unités de la devise. Seulement sur un objet qui a déjà un budget total`,
  set_end_time: `"value" : date de fin ISO 8601 avec fuseau (2026-10-31T23:59:00+01:00), plus d'une heure dans le futur. Meta : campagne ou ensemble ; Google Ads : campagne seulement (le jour compte)`,
  set_start_time: `"value" : date de début ISO 8601 avec fuseau, dans le futur. Meta : campagne ou ensemble ; Google Ads : campagne pas encore commencée`,
  set_bid_amount: `"value" : la nouvelle enchère en unités de la devise. Seulement sur un ensemble / groupe d'annonces qui a déjà une enchère manuelle dans le contexte`,
  set_target_cpa: `"value" : le coût par résultat visé en unités de la devise. Meta : sur l'objet qui porte la stratégie d'enchère (bidStrategy non nul), passe en « cost cap » ; Google Ads : campagne en Maximiser les conversions ou CPA cible (targetCpa ou bidStrategy dans le contexte)`,
  set_target_roas: `"value" : le ROAS visé en multiplicateur (3 = 300 %). Meta : ROAS minimum sur l'objet qui porte la stratégie ; Google Ads : campagne en Maximiser la valeur de conversion ou ROAS cible`,
  set_bid_strategy: `"value" : "AUTO" seulement — retour à l'enchère automatique (coût le plus bas, sans plafond). Meta seulement, sur l'objet qui porte la stratégie`,
  set_spend_cap: `"value" : le plafond de dépense total de la campagne en unités de la devise (100 au moins). Meta, campagne seulement`,
  rename: `"value" : le nouveau nom`,
  create_ad: `NE LE PROPOSE JAMAIS dans un bloc : une nouvelle publicité se crée depuis le formulaire « Nouvelle publicité » d'un ensemble (image du Studio créa, textes, Page). Si le consultant le demande, propose-lui des textes (texte principal, titre, bouton) qu'il collera dans ce formulaire`,
  duplicate: `"value" : {"name":"<nom de la copie>"} — copie en pause d'une campagne (avec ses ensembles et annonces), d'un ensemble ou d'une annonce. Meta seulement`,
};

export function buildPilotSystemPrompt(clientName: string, author: string | null): string {
  const kinds = PILOT_KINDS.map((k) => `- "${k}" — ${KIND_DOCS[k]}`).join("\n");
  return `Tu es l'assistant de pilotage d'ImpulseMotion, l'outil de l'agence Impulse Analytics. Tu aides un consultant à analyser et à MODIFIER les campagnes publicitaires d'un client, sur Meta et sur Google Ads.

Tu n'as aucun outil et tu n'envoies rien toi-même. Les comptes du client, leurs campagnes, leurs ensembles de publicités (Meta) ou groupes d'annonces (Google Ads), leurs budgets et leurs résultats des 7 derniers jours te sont donnés avec chaque message, lus à l'instant. Ne cite que des chiffres et des identifiants qui y figurent ; si une donnée manque, dis-le.

Quand le consultant veut un changement (ou l'accepte après ta recommandation), propose-le dans un bloc :

\`\`\`${PILOT_FENCE}
{"platform":"meta","accountId":"<identifiant du compte recopié du contexte>","why":"<pourquoi, en une ou deux phrases : c'est ce qui sera écrit dans le dossier HQ du client>","requests":[{"kind":"set_daily_budget","objectType":"adset","objectId":"<identifiant recopié du contexte>","value":50,"label":"<ce que fait ce changement, en clair>"}]}
\`\`\`

Règles du bloc :
- un bloc par compte ; ${PILOT_MAX_OPERATIONS} changements au plus par bloc ; JSON strict, sans commentaire ;
- "platform" : "meta" ou "google" ; "objectType" : "campaign", "adset" (ensemble Meta ou groupe d'annonces Google Ads) ou "ad" (annonce, Meta seulement) ;
- "objectId" et "accountId" sont recopiés tels quels du contexte, jamais inventés ;
- un seul changement par réglage d'un même objet ;
- "kind" et "value" :
${kinds}

Le consultant verra ta proposition sous forme de carte ; un clic prépare un aperçu relu sur la plateforme (valeur actuelle → nouvelle valeur), puis il confirme lui-même. Une hausse de budget de plus de 50 % ou de plus de 300 €/jour, l'arrêt d'une campagne entière et toute suppression demandent une seconde confirmation : signale-le. Ne propose pas un changement qui ne ferait rien (déjà à cette valeur), ni sur un compte marqué « illisible ». Si l'envoi vers une plateforme n'est pas encore ouvert, la proposition reste utile pour l'aperçu : dis-le simplement.

Analyse avant de proposer : regarde la dépense, les conversions, le CPA et le ROAS sur 7 jours comparés aux 7 jours d'avant, et les deux plateformes ensemble quand le client a les deux. Sois bref, concret, en français, sans jargon inutile. Si la demande est ambiguë (quel objet, quel montant), pose une question au lieu de deviner.

${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}

Client : ${clientName}${author ? `\nConsultant : ${author}` : ""}`;
}

// ── Context ──────────────────────────────────────────────────────────────

const STATUS_SHORT: Record<string, string> = { ACTIVE: "actif", PAUSED: "en pause" };
const n0 = (v: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(v);
const n2 = (v: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(v);

function metricsText(m: ContextMetrics | null, currency: string): string {
  if (!m) return "";
  const parts = [`dépense ${n0(m.spend)} ${currency}`, `${n2(m.conversions)} conv.`];
  if (m.conversions > 0) parts.push(`CPA ${n2(m.cpa)}`);
  if (m.roasAvailable) parts.push(`ROAS ${n2(m.roas)}`);
  return parts.join(", ");
}

function objectLine(platform: PilotPlatform, o: ContextObject, type: "campaign" | "adset", currency: string): string {
  const status = STATUS_SHORT[o.effectiveStatus] ?? (o.effectiveStatus || o.status).toLowerCase().replace(/_/g, " ");
  const bits = [`${objectLabel(platform, type)} « ${o.name} » [${o.id}] — ${status}${o.status !== o.effectiveStatus && STATUS_SHORT[o.status] ? ` (réglé ${STATUS_SHORT[o.status]})` : ""}`];
  if (o.dailyBudget) bits.push(`budget ${money(o.dailyBudget, currency)}/jour${o.budgetLock ? " (partagé, non modifiable ici)" : ""}`);
  else if (o.lifetimeBudget) bits.push(`budget total ${money(o.lifetimeBudget, currency)}${o.budgetLock ? " (partagé, non modifiable ici)" : ""}`);
  if (o.bidAmount) bits.push(`enchère manuelle ${money(o.bidAmount, currency)}`);
  else if (o.bidStrategy) bits.push(`enchères ${o.bidStrategy.toLowerCase().replace(/_/g, " ")}${o.targetCpa ? `, cible ${money(o.targetCpa, currency)}` : ""}${o.targetRoas ? `, ROAS cible ${o.targetRoas}×` : ""}`);
  if (o.spendCap) bits.push(`plafond ${money(o.spendCap, currency)}`);
  if (o.startTime || o.endTime) bits.push(`du ${o.startTime ? o.startTime.slice(0, 10) : "—"} au ${o.endTime ? o.endTime.slice(0, 10) : "—"}`);
  if (o.last7) bits.push(`7 j : ${metricsText(o.last7, currency)}${o.prev7 ? ` (7 j d'avant : ${metricsText(o.prev7, currency)})` : ""}`);
  else bits.push(`dépense 7 j ${n0(o.spend7d)} ${currency}`);
  return bits.join(" · ");
}

/** One account, cut to `budget` characters: the live and spending objects first. */
function accountBlock(a: ContextAccount, budget: number): string {
  const head = `## ${PLATFORM_FR[a.platform]} — « ${a.name} » (accountId ${a.accountId}${a.currency ? `, devise ${a.currency}` : ""})${a.writesOpen ? "" : " — envoi vers cette plateforme pas encore ouvert (aperçu seulement)"}`;
  if (a.error) return `${head}\nCompte illisible pour le moment : ${a.error}`;
  const currency = a.currency ?? "";
  const rank = (o: ContextObject) => (o.effectiveStatus === "ACTIVE" ? 0 : 1) * 1e12 - o.spend7d;
  const campaigns = [...a.campaigns].sort((x, y) => rank(x) - rank(y));
  const adsetsOf = new Map<string, ContextObject[]>();
  for (const s of a.adsets) adsetsOf.set(s.parentId ?? "", [...(adsetsOf.get(s.parentId ?? "") ?? []), s]);
  const lines: string[] = [head];
  let used = head.length;
  let left = 0;
  for (const c of campaigns) {
    const block = [objectLine(a.platform, c, "campaign", currency)];
    for (const s of (adsetsOf.get(c.id) ?? []).sort((x, y) => rank(x) - rank(y))) block.push(`   - ${objectLine(a.platform, s, "adset", currency)}`);
    const text = `- ${block.join("\n")}`;
    if (used + text.length + 1 > budget) {
      // Too long with its ad sets: the campaign alone, if it fits.
      const alone = `- ${block[0]}`;
      if (used + alone.length + 1 > budget) { left++; continue; }
      lines.push(alone); used += alone.length + 1;
      continue;
    }
    lines.push(text);
    used += text.length + 1;
  }
  if (!campaigns.length) lines.push("Aucune campagne.");
  if (left) lines.push(`(${left} campagne(s) en pause ou sans dépense non détaillée(s) faute de place : demande au consultant de préciser si besoin.)`);
  return lines.join("\n");
}

export function buildPilotTurnContext(clientName: string, accounts: ContextAccount[], today: string): string {
  const head = `Comptes de ${clientName} lus le ${today} (identifiants entre crochets ; montants dans la devise de chaque compte) :`;
  if (!accounts.length) return `${head}\nAucun compte Meta ou Google Ads modifiable pour ce client.`;
  const budget = Math.floor((PILOT_CONTEXT_MAX_CHARS - head.length) / accounts.length);
  return [head, ...accounts.map((a) => accountBlock(a, budget))].join("\n\n").slice(0, PILOT_CONTEXT_MAX_CHARS);
}

export function buildPilotRelayBody(input: {
  clientId: string; clientName: string; userId: string; author: string | null; thread: string;
  accounts: ContextAccount[]; today: string; messages: RelayMessage[];
}): PilotRelayBody {
  return {
    messages: input.messages,
    systemPrompt: buildPilotSystemPrompt(input.clientName, input.author),
    turnContext: buildPilotTurnContext(input.clientName, input.accounts, input.today),
    sessionKey: pilotSessionKey(input.clientId, input.userId, input.thread),
    model: PILOT_ASSISTANT_PROFILE.model,
    effort: PILOT_ASSISTANT_PROFILE.effort,
    maxTurns: PILOT_ASSISTANT_PROFILE.maxTurns,
    budgetMs: PILOT_ASSISTANT_BUDGET_MS,
    // No tool at all: the accounts are in the message, the proposals are checked by code and sent by the consultant.
    allowedServers: [],
    accountScope: {},
  };
}

// ── Proposals ────────────────────────────────────────────────────────────

export interface PilotProposal {
  platform: PilotPlatform;
  accountId: string;
  why: string;
  requests: PilotRequest[];
  /** What the AI says each change does, in the same order (shown on the card only). */
  labels: string[];
}

export type ExtractedProposal = { ok: true; proposal: PilotProposal } | { ok: false; error: string };

const FENCE_RE = new RegExp("```" + PILOT_FENCE + "\\s*\\n([\\s\\S]*?)```", "g");

/** Every ```pilot block of a message, read (not yet checked against the client's accounts). */
export function extractPilotProposals(text: string): ExtractedProposal[] {
  const out: ExtractedProposal[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    let raw: unknown;
    try { raw = JSON.parse(m[1].trim()); } catch { out.push({ ok: false, error: "Proposition illisible (JSON invalide)." }); continue; }
    out.push(readProposal(raw));
  }
  return out;
}

/** The text of a message without its blocks, as the conversation shows it. */
export function stripPilotBlocks(text: string): string {
  return text.replace(FENCE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

function readProposal(raw: unknown): ExtractedProposal {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Proposition illisible." };
  const r = raw as Record<string, unknown>;
  if (!isPilotPlatform(r.platform)) return { ok: false, error: "Plateforme inconnue dans la proposition." };
  if (typeof r.accountId !== "string" || !r.accountId.trim()) return { ok: false, error: "Compte absent de la proposition." };
  const list = Array.isArray(r.requests) ? r.requests : [];
  if (!list.length) return { ok: false, error: "Aucun changement dans la proposition." };
  if (list.length > PILOT_MAX_OPERATIONS) return { ok: false, error: `${PILOT_MAX_OPERATIONS} changements au plus par proposition.` };
  const requests: PilotRequest[] = [];
  const labels: string[] = [];
  for (const item of list) {
    const req = readRequest(item);
    if (!req) return { ok: false, error: "Un changement de la proposition est illisible." };
    if (req.kind === "create_ad") return { ok: false, error: "Une nouvelle publicité se crée depuis le formulaire « Nouvelle publicité » de l'ensemble, pas par l'IA." };
    requests.push(req);
    const label = item && typeof item === "object" && typeof (item as Record<string, unknown>).label === "string" ? String((item as Record<string, unknown>).label).trim().slice(0, 300) : "";
    labels.push(label);
  }
  const why = typeof r.why === "string" ? r.why.trim().slice(0, 2000) : "";
  return { ok: true, proposal: { platform: r.platform, accountId: r.accountId.trim(), why, requests, labels } };
}

/**
 * A proposal against the accounts of the client: the account must be one of
 * them (same platform), and each object one the context listed for it. The
 * values themselves are checked by the preview, on the platform.
 */
export function validatePilotProposal(
  proposal: PilotProposal,
  accounts: Array<{ platform: string; accountId: string; objectIds?: Set<string> | null }>,
  sameAccount: (platform: PilotPlatform, a: string, b: string) => boolean,
): { ok: true } | { ok: false; error: string } {
  const account = accounts.find((a) => a.platform === proposal.platform && sameAccount(proposal.platform, a.accountId, proposal.accountId));
  if (!account) return { ok: false, error: `Le compte ${PLATFORM_FR[proposal.platform]} ${proposal.accountId} n'est pas un compte de ce client.` };
  if (account.objectIds) {
    const unknown = proposal.requests.filter((r) => r.objectType !== "ad" && !account.objectIds!.has(r.objectId));
    if (unknown.length) return { ok: false, error: `Objet inconnu dans ce compte : ${unknown.map((r) => r.objectId).join(", ")}.` };
  }
  const seen = new Set<string>();
  for (const r of proposal.requests) {
    const key = `${r.objectId}:${r.kind === "set_status" ? "status" : r.kind}`;
    if (seen.has(key)) return { ok: false, error: "Deux changements du même réglage sur un même objet." };
    seen.add(key);
  }
  return { ok: true };
}
