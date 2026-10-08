/**
 * Personas of a client (staff only) — the HQ artefact
 * projects/{hqSlug}/brain/recherche/personas.md and the draft the AI wrote.
 *
 * GET    → { hq: the file in HQ | null, draft: PersonaDraft | null, slug, canWrite }
 * POST   → generate a draft from the consultant's reviews + HQ folder + Meta ads
 *          (body: { reviews?, reviewsSource?, notes? }); replaces the draft.
 * PUT    → write the draft (or an edited body) to HQ
 *          (body: { markdown, statut: "a_confirmer" | "confirme", etag }).
 *          `confirme` carries the consultant's name — HQ's rule: only a human confirms.
 * DELETE → drop the draft.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { HQ_PROJECT_RE } from "@/lib/hq-journal";
import {
  collectPersonaInputs, generatePersonaDraft, readHqPersona, writeHqPersona,
  serializePersonaFile, summarizeInputs, todayIso, PERSONA_REFRESH_DAYS, type PersonaFrontmatter,
} from "@/lib/hq-persona";

export const maxDuration = 300;

async function guardDashboard(id: string) {
  const guard = await requireStaff();
  if ("error" in guard) return { error: guard.error } as const;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return { error: denied } as const;
  const dashboard = await prisma.dashboard.findUnique({
    where: { id },
    select: { id: true, name: true, metaAccountId: true, hqSlug: true, hqContextMd: true, personaDraft: true },
  });
  if (!dashboard) return { error: NextResponse.json({ error: "not found" }, { status: 404 }) } as const;
  return { session: guard.session, dashboard } as const;
}

function draftView(d: { id: string; markdown: string; inputsJson: string; kind: string; createdById: string | null; createdAt: Date; updatedAt: Date } | null) {
  if (!d) return null;
  let inputs: unknown = {};
  try { inputs = JSON.parse(d.inputsJson); } catch { /* keep {} */ }
  return { id: d.id, markdown: d.markdown, kind: d.kind, inputs, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString() };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guardDashboard(id);
  if ("error" in g) return g.error;
  const slug = g.dashboard.hqSlug && HQ_PROJECT_RE.test(g.dashboard.hqSlug) ? g.dashboard.hqSlug : null;
  let hq = null;
  let warning: string | null = null;
  if (slug) {
    try { hq = await readHqPersona(slug); } catch (e) { warning = e instanceof Error ? e.message : String(e); }
  }
  return NextResponse.json({ slug, hq, draft: draftView(g.dashboard.personaDraft), warning, refreshDays: PERSONA_REFRESH_DAYS });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guardDashboard(id);
  if ("error" in g) return g.error;
  const body = await req.json().catch(() => ({}));
  const reviews = typeof body.reviews === "string" ? body.reviews : "";
  const reviewsSource = typeof body.reviewsSource === "string" ? body.reviewsSource : "";
  const notes = typeof body.notes === "string" ? body.notes : "";

  const inputs = await collectPersonaInputs({ dashboard: g.dashboard, reviews, reviewsSource, notes });
  try {
    const { markdown, kind } = await generatePersonaDraft(inputs, {
      maxMs: 280_000,
      usage: { dashboardId: id, user: { id: g.session.userId, email: g.session.user?.email, role: g.session.role } },
    });
    const summary = summarizeInputs(inputs);
    const draft = await prisma.personaDraft.upsert({
      where: { dashboardId: id },
      create: { dashboardId: id, markdown, kind, inputsJson: JSON.stringify(summary), createdById: g.session.userId },
      update: { markdown, kind, inputsJson: JSON.stringify(summary), createdById: g.session.userId },
    });
    return NextResponse.json({ draft: draftView(draft), adsWarning: inputs.adsWarning });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg.slice(0, 300) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guardDashboard(id);
  if ("error" in g) return g.error;
  const slug = g.dashboard.hqSlug && HQ_PROJECT_RE.test(g.dashboard.hqSlug) ? g.dashboard.hqSlug : null;
  if (!slug) return NextResponse.json({ error: "Ce client n'a pas de dossier HQ rattaché (réglages du dashboard → dossier HQ)." }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const markdown = typeof body.markdown === "string" ? body.markdown.trim() : "";
  const statut = body.statut === "confirme" ? "confirme" : "a_confirmer";
  const etag = typeof body.etag === "string" && body.etag ? body.etag : null;
  if (markdown.length < 200) return NextResponse.json({ error: "Le contenu est trop court pour être écrit dans HQ." }, { status: 400 });

  const who = ((g.session.user?.name ?? "").trim() || g.session.user?.email || "").slice(0, 120);
  if (statut === "confirme" && !who) return NextResponse.json({ error: "Impossible d'identifier qui confirme." }, { status: 400 });

  // Re-read right before writing: the ETag the page holds may be stale.
  let current = null;
  try { current = await readHqPersona(slug); } catch (e) {
    return NextResponse.json({ error: `HQ inaccessible (${e instanceof Error ? e.message : String(e)})` }, { status: 502 });
  }
  if (current && current.etag && current.etag !== etag) {
    return NextResponse.json({ error: "Le fichier a changé dans HQ depuis votre lecture. Rechargez la page, puis réessayez.", conflict: true, hq: current }, { status: 409 });
  }

  const draftKind = g.dashboard.personaDraft?.kind ?? "persona";
  const source: string = current?.frontmatter.source && current.frontmatter.source !== "recherche" ? "mixte" : "recherche";
  const fm: PersonaFrontmatter = {
    statut,
    source: draftKind === "hypothese" && statut === "confirme" ? "mixte" : source,
    maj: todayIso(),
    confirme_par: statut === "confirme" ? who : "",
    rafraichir_tous_les: current?.frontmatter.rafraichir_tous_les || `${PERSONA_REFRESH_DAYS}j`,
  };
  const content = serializePersonaFile(fm, markdown);
  const out = await writeHqPersona(slug, content, current?.etag ?? null);
  if (!out.ok) return NextResponse.json({ error: out.error, conflict: out.conflict === true }, { status: out.conflict ? 409 : 502 });

  // The draft served its purpose once it is in HQ.
  await prisma.personaDraft.deleteMany({ where: { dashboardId: id } }).catch(() => {});
  const hq = await readHqPersona(slug).catch(() => null);
  return NextResponse.json({ ok: true, created: out.created, hq: hq ?? { slug, path: `projects/${slug}/brain/recherche/personas.md`, frontmatter: fm, body: markdown, etag: out.etag, lastModified: null, stale: false } });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guardDashboard(id);
  if ("error" in g) return g.error;
  await prisma.personaDraft.deleteMany({ where: { dashboardId: id } });
  return NextResponse.json({ ok: true });
}
