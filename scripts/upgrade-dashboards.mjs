#!/usr/bin/env node
// Met à niveau les dashboards existants vers la nouvelle composition par défaut
// (widgets funnel / demographics / geo_device / alerts) en préservant les
// widgets personnalisés (ceux dont (type,titre) ne matche aucun défaut connu).
//
// Par défaut : DRY-RUN (aucune écriture). Passer --apply pour écrire.
//   node scripts/upgrade-dashboards.mjs           # simulation
//   node scripts/upgrade-dashboards.mjs --apply   # écrit (transaction)

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ── .env.local ───────────────────────────────────────────────────────────────
for (const file of [".env.local", ".env"]) {
  try {
    const txt = readFileSync(resolve(root, file), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch { /* fichier absent : ignoré */ }
}

const require = createRequire(resolve(root, "package.json"));
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");

// ── Composition par défaut (dupliquée depuis lib/dashboard-widgets.ts —
//    script one-shot, garder synchrone avec defaultWidgets()) ────────────────
function defaultWidgets(hasMeta, hasGoogle, accountName) {
  const source = hasMeta && hasGoogle ? "combined" : hasGoogle && !hasMeta ? "google" : "meta";
  const platforms = hasMeta && hasGoogle ? "Meta Ads + Google Ads" : hasMeta ? "Meta Ads" : "Google Ads";
  const intro = [
    `**Vue d'ensemble ${platforms}.**`,
    "Les chiffres couvrent la période sélectionnée en haut de page, avec comparaison automatique vs la période précédente.",
    "KPIs clés, suivi du budget, courbes quotidiennes puis détail par campagne : tout se lit de haut en bas.",
  ].join(" ");

  const w = [
    { type: "text", title: (accountName ?? "").trim() || "Votre dashboard", width: "full", config: { markdown: intro } },
    { type: "kpi", title: "Dépenses", width: "third", config: { metric: "spend", source } },
    { type: "kpi", title: "ROAS", width: "third", config: { metric: "roas", source } },
    { type: "kpi", title: "Conversions", width: "third", config: { metric: "purchases", source } },
    { type: "kpi", title: "CPA", width: "third", config: { metric: "cpa", source } },
    { type: "kpi", title: "CPC", width: "third", config: { metric: "cpc", source } },
    { type: "kpi", title: "Taux de conversion", width: "third", config: { metric: "cr", source } },
    { type: "funnel", title: "Entonnoir de conversion", width: "half", config: { source } },
    { type: "alerts", title: "Dernières alertes", width: "half", config: { limit: 5 } },
  ];

  if (hasMeta) w.push({ type: "pacing", title: "Suivi du budget mensuel", width: "full", config: {} });
  w.push({ type: "platform_table", title: "Vue par plateforme", width: "full", config: {} });

  if (hasMeta && hasGoogle) {
    w.push({ type: "timeseries", title: "Dépenses quotidiennes — Meta", width: "half", config: { metric: "spend", source: "meta" } });
    w.push({ type: "timeseries", title: "Dépenses quotidiennes — Google", width: "half", config: { metric: "spend", source: "google" } });
    w.push({ type: "timeseries", title: "ROAS quotidien — Meta", width: "half", config: { metric: "roas", source: "meta" } });
    w.push({ type: "timeseries", title: "Conversions quotidiennes — Google", width: "half", config: { metric: "purchases", source: "google" } });
  } else if (hasMeta) {
    w.push({ type: "timeseries", title: "Dépenses quotidiennes", width: "half", config: { metric: "spend", source: "meta" } });
    w.push({ type: "timeseries", title: "ROAS quotidien", width: "half", config: { metric: "roas", source: "meta" } });
  } else {
    w.push({ type: "timeseries", title: "Dépenses quotidiennes", width: "half", config: { metric: "spend", source: "google" } });
    w.push({ type: "timeseries", title: "Conversions quotidiennes", width: "half", config: { metric: "purchases", source: "google" } });
  }

  if (hasMeta) {
    w.push({ type: "demographics", title: "Démographie Meta", width: "half", config: { metric: "spend" } });
    w.push({ type: "geo_device", title: "Répartition par appareil", width: "half", config: { source: "meta", dimension: "device" } });
  }

  if (hasMeta) {
    w.push({ type: "top_creatives", title: "Top créas Meta", width: "half", config: { limit: 6 } });
    w.push({ type: "table", title: "Campagnes Meta", width: "half", config: { kind: "campaigns", source: "meta", limit: 10 } });
  }
  if (hasGoogle && hasMeta) {
    w.push({ type: "table", title: "Campagnes Google Ads", width: "full", config: { kind: "campaigns", source: "google", limit: 10 } });
    w.push({ type: "table", title: "Top mots-clés", width: "half", config: { kind: "keywords", source: "google", limit: 10 } });
    w.push({ type: "table", title: "Termes de recherche", width: "half", config: { kind: "search_terms", source: "google", limit: 10 } });
  } else if (hasGoogle) {
    w.push({ type: "table", title: "Campagnes Google Ads", width: "full", config: { kind: "campaigns", source: "google", limit: 10 } });
    w.push({ type: "geo_device", title: "Répartition par appareil", width: "half", config: { source: "google", dimension: "device" } });
    w.push({ type: "table", title: "Top mots-clés", width: "half", config: { kind: "keywords", source: "google", limit: 10 } });
    w.push({ type: "table", title: "Termes de recherche", width: "full", config: { kind: "search_terms", source: "google", limit: 10 } });
  }

  return w.map((widget, position) => ({ ...widget, position }));
}

// ── Vérification grille 6 colonnes (third=2, half=3, full=6) ─────────────────
const SPANS = { third: 2, half: 3, full: 6 };
function checkGrid(widgets) {
  let cols = 0;
  const problems = [];
  for (const w of widgets) {
    const span = SPANS[w.width] ?? 6;
    if (cols + span > 6) {
      if (cols !== 0) problems.push(`rangée incomplète (${cols}/6 cols) avant « ${w.title} »`);
      cols = span;
    } else {
      cols += span;
    }
    if (cols === 6) cols = 0;
  }
  if (cols !== 0) problems.push(`dernière rangée incomplète (${cols}/6 cols)`);
  return problems;
}

// ── Défauts historiques : (type,titre) des anciennes compositions ────────────
const LEGACY_DEFAULTS = [
  ["kpi", "Dépenses"], ["kpi", "ROAS"], ["kpi", "Conversions"], ["kpi", "CPA"],
  ["kpi", "Clics"], ["kpi", "CTR"], ["kpi", "CPC"], ["kpi", "Taux de conversion"],
  ["platform_table", "Vue par plateforme"],
  ["pacing", "Suivi du budget mensuel"],
  ["timeseries", "Dépenses quotidiennes — Meta"], ["timeseries", "Dépenses quotidiennes — Google"],
  ["timeseries", "ROAS quotidien — Meta"], ["timeseries", "Conversions quotidiennes — Google"],
  ["timeseries", "Dépenses quotidiennes"], ["timeseries", "ROAS quotidien"], ["timeseries", "Conversions quotidiennes"],
  ["top_creatives", "Top créas Meta"],
  ["table", "Campagnes Meta"], ["table", "Campagnes Google Ads"],
  ["table", "Top mots-clés"], ["table", "Termes de recherche"],
  ["text", "Votre dashboard"],
];

const key = (type, title) => `${type}::${(title ?? "").trim()}`;

async function main() {
  console.log(APPLY ? "Mode : APPLY (écriture en base)\n" : "Mode : DRY-RUN (aucune écriture — passer --apply pour écrire)\n");

  // Sanity check grille sur les 3 combinaisons de sources
  for (const [label, m, g] of [["Meta+Google", true, true], ["Meta seul", true, false], ["Google seul", false, true]]) {
    const problems = checkGrid(defaultWidgets(m, g, "Test"));
    console.log(`Grille ${label} : ${problems.length ? "PROBLÈMES → " + problems.join(" ; ") : "OK (rangées complètes)"}`);
  }
  console.log("");

  const dashboards = await prisma.dashboard.findMany({
    include: { widgets: { orderBy: { position: "asc" } } },
    orderBy: { createdAt: "asc" },
  });
  console.log(`${dashboards.length} dashboard(s) trouvé(s).\n`);

  for (const d of dashboards) {
    const hasMeta = !!d.metaAccountId;
    const hasGoogle = !!d.googleCustomerId;
    const defaults = defaultWidgets(hasMeta, hasGoogle, d.name);

    // (type,titre) connus = nouvelle composition (avec le titre du dashboard
    // pour le widget texte) + défauts historiques.
    const known = new Set([
      ...defaults.map((w) => key(w.type, w.title)),
      ...LEGACY_DEFAULTS.map(([t, ti]) => key(t, ti)),
    ]);

    const preserved = d.widgets.filter((w) => !known.has(key(w.type, w.title)));
    const removed = d.widgets.filter((w) => known.has(key(w.type, w.title)));

    // Composition finale : défauts + personnalisés à la suite (positions recalculées)
    const finalWidgets = [
      ...defaults.map((w) => ({ type: w.type, title: w.title, width: w.width, config: JSON.stringify(w.config) })),
      ...preserved.map((w) => ({ type: w.type, title: w.title, width: w.width, config: w.config })),
    ].map((w, position) => ({ ...w, position }));

    const gridProblems = checkGrid(finalWidgets.map((w) => ({ ...w, title: w.title ?? "" })));

    console.log(`── Dashboard « ${d.name} » (${d.id})`);
    console.log(`   Binding : meta=${d.metaAccountId ?? "—"} google=${d.googleCustomerId ?? "—"}`);
    console.log(`   Widgets actuels : ${d.widgets.length} — supprimés/remplacés : ${removed.length} — préservés : ${preserved.length}`);
    for (const w of removed) console.log(`     - remplacé  [${w.type}] « ${w.title ?? ""} » (${w.width})`);
    for (const w of defaults) console.log(`     + ajouté    [${w.type}] « ${w.title} » (${w.width})`);
    for (const w of preserved) console.log(`     = préservé  [${w.type}] « ${w.title ?? ""} » (${w.width}) — replacé en fin (position recalculée)`);
    console.log(`   Total après mise à niveau : ${finalWidgets.length} widgets`);
    if (gridProblems.length) console.log(`   ⚠ Grille : ${gridProblems.join(" ; ")} (widgets préservés inclus)`);

    if (APPLY) {
      await prisma.$transaction([
        prisma.dashboardWidget.deleteMany({ where: { dashboardId: d.id } }),
        prisma.dashboardWidget.createMany({
          data: finalWidgets.map((w) => ({
            dashboardId: d.id, type: w.type, title: w.title, width: w.width,
            position: w.position, config: w.config,
          })),
        }),
      ]);
      console.log("   ✔ Appliqué.");
    }
    console.log("");
  }

  if (!APPLY) console.log("DRY-RUN terminé — aucune écriture effectuée.");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
