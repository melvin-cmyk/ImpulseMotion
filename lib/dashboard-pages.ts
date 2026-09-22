/**
 * Dashboard pages (tabs) — server helpers.
 *
 * A page groups widgets inside one dashboard (« Meta », « Google », « Créas »…).
 * Widgets with `pageId = null` belong to the FIRST page, so dashboards created
 * before pages existed keep their single implicit page and the client view is
 * unchanged. The AI page creator turns a one-line brief into a full page:
 * one relay call (no tools), strict JSON, every widget validated by the same
 * rules as the manual form before anything is written.
 */

import { prisma } from "@/lib/prisma";
import { relayComplete, parseLooseJson } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import {
  CONVERSION_WIDGET_TYPES,
  WIDGET_TYPES,
  WIDGET_TYPE_INFO,
  validateWidgetConfig,
  validateWidgetWidth,
  type WidgetType,
} from "@/lib/dashboard-types";

export const MAX_PAGES = 12;
export const MAX_WIDGETS_PER_PAGE = 24;
export const MAX_PAGE_NAME = 40;

export interface PageWidgetSpec {
  type: string;
  title: string | null;
  width: string;
  config: Record<string, unknown>;
}

export interface PageSpec {
  name: string;
  widgets: PageWidgetSpec[];
}

export function cleanPageName(raw: unknown, fallback = "Page"): string {
  const s = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  return (s || fallback).slice(0, MAX_PAGE_NAME);
}

/** Validates a list of widget specs (AI output or API body) with the form rules. */
export function validatePageWidgets(input: unknown): PageWidgetSpec[] {
  if (!Array.isArray(input)) throw new Error("widgets doit être une liste");
  if (input.length > MAX_WIDGETS_PER_PAGE) throw new Error(`${MAX_WIDGETS_PER_PAGE} widgets max par page`);
  return input.map((raw, i) => {
    const w = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const type = String(w.type ?? "");
    if (!(WIDGET_TYPES as readonly string[]).includes(type)) throw new Error(`widget ${i + 1} : type inconnu « ${type} »`);
    const config = validateWidgetConfig(type, w.config ?? {});
    const width = validateWidgetWidth(w.width ?? "half");
    const title = typeof w.title === "string" && w.title.trim() ? w.title.trim().slice(0, 120) : null;
    return { type, title, width, config };
  });
}

// ── AI page creator ──────────────────────────────────────────────────────────

export function buildPageCreatorSystemPrompt(dashboard: { name: string; metaAccountId: string | null; googleCustomerId: string | null; hasHubspot?: boolean }): string {
  const catalogue = WIDGET_TYPES
    .map((t: WidgetType) => `- ${t} (${WIDGET_TYPE_INFO[t].label}) : config ${WIDGET_TYPE_INFO[t].configDoc}`)
    .join("\n");
  const sources = [
    dashboard.metaAccountId ? "Meta Ads (source \"meta\")" : null,
    dashboard.googleCustomerId ? "Google Ads (source \"google\")" : null,
    dashboard.hasHubspot ? "HubSpot CRM" : null,
  ].filter(Boolean).join(", ") || "aucune source liée";
  return `Tu composes une PAGE de dashboard de pilotage publicitaire pour le client « ${dashboard.name} », à partir du brief du consultant.
Sources disponibles sur ce dashboard : ${sources}. N'utilise jamais une source absente (pas de widget Google si Google Ads n'est pas lié, et inversement). Si le brief demande une source absente, compose avec ce qui existe et dis-le dans "note".

CATALOGUE DES WIDGETS (types et config exacts) :
${catalogue}
Largeurs : third (1/3 de ligne), half (1/2), full (pleine largeur). Compose des lignes complètes (ex. 3 × third, 2 × half, 1 × full).
Option commune aux widgets ${CONVERSION_WIDGET_TYPES.join(", ")} : conversionEvent?: purchase|lead|complete_registration|custom:<action_type Meta>.

RÈGLES DE COMPOSITION
- 4 à 12 widgets, du général au détail : un texte d'intro court (type text) si utile, une rangée de KPI (third), puis courbes (half/full), puis tableaux (full).
- Un titre court et parlant par widget, en français.
- Reste strictement dans le catalogue : un type, une métrique ou une source hors catalogue seront rejetés.

RÉPONDS UNIQUEMENT par un bloc \`\`\`json :
{"name": "Nom de page court (≤ 40 caractères)", "note": "1 phrase optionnelle", "widgets": [{"type": "kpi", "title": "…", "width": "third", "config": {…}}, …]}`;
}

export function parsePageSpec(raw: string): { spec: PageSpec; note: string | null } {
  const parsed = parseLooseJson<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("Réponse IA illisible (JSON attendu)");
  const widgets = validatePageWidgets(parsed.widgets);
  if (widgets.length === 0) throw new Error("L'IA n'a proposé aucun widget");
  return {
    spec: { name: cleanPageName(parsed.name, "Nouvelle page"), widgets },
    note: typeof parsed.note === "string" && parsed.note.trim() ? parsed.note.trim().slice(0, 300) : null,
  };
}

export async function generatePageSpec(
  dashboard: { id: string; name: string; metaAccountId: string | null; googleCustomerId: string | null; hasHubspot?: boolean },
  brief: string,
  user?: { id: string; email?: string | null; role: string },
): Promise<{ spec: PageSpec; note: string | null }> {
  const raw = await relayComplete(
    {
      messages: [{ role: "user", content: `BRIEF DU CONSULTANT :\n${brief.trim().slice(0, 1500)}\n\nCompose la page.` }],
      systemPrompt: buildPageCreatorSystemPrompt(dashboard),
      allowedServers: [],
      accountScope: {},
    },
    {
      maxMs: 90_000,
      onUsage: (usage) => void recordAiUsage(usage, { feature: "copilot", dashboardId: dashboard.id, clientName: dashboard.name, user }),
    },
  );
  return parsePageSpec(raw);
}

// ── Persistence ──────────────────────────────────────────────────────────────

/** Creates a page (and its widgets) atomically at the end of the tab list. */
export async function createPageWithWidgets(dashboardId: string, input: { name: string; intent?: string | null; widgets: PageWidgetSpec[] }) {
  const count = await prisma.dashboardPage.count({ where: { dashboardId } });
  if (count >= MAX_PAGES) throw new Error(`${MAX_PAGES} pages max par dashboard`);
  const max = await prisma.dashboardPage.aggregate({ where: { dashboardId }, _max: { position: true } });
  const position = (max._max.position ?? -1) + 1;
  return prisma.dashboardPage.create({
    data: {
      dashboardId,
      name: cleanPageName(input.name),
      position,
      intent: input.intent?.trim() ? input.intent.trim().slice(0, 1500) : null,
      widgets: {
        create: input.widgets.map((w, i) => ({
          dashboardId,
          type: w.type,
          title: w.title,
          width: w.width,
          position: i,
          config: JSON.stringify(w.config),
        })),
      },
    },
    include: { _count: { select: { widgets: true } } },
  });
}
