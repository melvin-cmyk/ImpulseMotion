/**
 * Dry run of the persona generation on a real client: reads HQ + Meta ads,
 * asks the relay for a draft, prints it. Writes NOTHING (no DB row, no HQ file).
 *   npx tsx --env-file=.env.local scripts/persona-dry-run.ts <hqSlug> [reviews.txt]
 */
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { collectPersonaInputs, generatePersonaDraft, hasEnoughReviews, summarizeInputs } from "@/lib/hq-persona";

async function main() {
  const slug = process.argv[2];
  if (!slug) throw new Error("slug HQ attendu");
  const reviewsFile = process.argv.slice(3).find((a) => !a.startsWith("--"));
  const reviews = reviewsFile ? readFileSync(reviewsFile, "utf8") : "";
  const d = await prisma.dashboard.findFirst({ where: { hqSlug: slug }, select: { id: true, name: true, metaAccountId: true, hqSlug: true, hqContextMd: true }, orderBy: { createdAt: "asc" } });
  if (!d) throw new Error(`aucun dashboard avec hqSlug=${slug}`);
  console.log(`Dashboard ${d.id} « ${d.name} » meta=${d.metaAccountId} brief HQ=${d.hqContextMd ? d.hqContextMd.length + " car." : "aucun"}`);
  const t0 = Date.now();
  const inputs = await collectPersonaInputs({ dashboard: d, reviews, reviewsSource: reviewsFile ? "fichier local" : "" });
  console.log("Entrées :", JSON.stringify(summarizeInputs(inputs)), `existant=${inputs.existing?.frontmatter.statut ?? "aucun"}`, `assez d'avis=${hasEnoughReviews(inputs)}`, `adsWarning=${inputs.adsWarning}`, `(${Date.now() - t0} ms)`);
  if (process.argv.includes("--inputs-only")) return;
  const t1 = Date.now();
  const out = await generatePersonaDraft(inputs, { usage: { dashboardId: d.id } });
  console.log(`\n=== mode ${out.kind}, ${out.markdown.length} car., ${Math.round((Date.now() - t1) / 1000)} s ===\n`);
  console.log(out.markdown);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ECHEC", e); process.exit(1); });
