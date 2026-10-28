/**
 * Smoke test of the Créas libraries on real data, without HTTP auth:
 *   1. a warehouse ad with a picture (biggest Meta spender of the last 30 days),
 *   2. its picture fetched and read by the AI (lib/creas/analysis),
 *   3. the copy brief (buildCopyPrompt) and ONE generation through Agnes (free) with the template as reference.
 * Usage: npx -y tsx@4 --env-file=.env.local scripts/creas-smoke.ts [--no-generate] [--url=https://… (no database needed)]
 */
import { prisma } from "../lib/prisma";
import { fetchImageBytes, dataUriToRelayImage, toDataUri } from "../lib/creas/media";
import { analyseTemplate } from "../lib/creas/analysis";
import { buildCopyPrompt, buildEditorAsk } from "../lib/creas/templates";
import { relayImage, relayUpload } from "../lib/studio";
import { readQuotas, spentToday, checkGeneration } from "../lib/quotas";

async function main() {
  const generate = !process.argv.includes("--no-generate");
  const urlArg = process.argv.find((a) => a.startsWith("--url="))?.slice(6);
  const rows = urlArg ? [{ id: "url", name: "Image de test", imageUrl: urlArg, thumbnailUrl: null, title: null, body: null, accountId: "", spend: 0 }] : await prisma.$queryRawUnsafe<Array<{ id: string; name: string; imageUrl: string | null; thumbnailUrl: string | null; title: string | null; body: string | null; accountId: string; spend: number }>>(
    `SELECT c.id, c.name, c."imageUrl", c."thumbnailUrl", c.title, c.body, c."accountId", d.spend FROM "AdCatalog" c
     JOIN (SELECT platform, "adId", SUM(spend) AS spend FROM "AdDaily" WHERE date >= CURRENT_DATE - INTERVAL '30 days' GROUP BY 1, 2) d ON d.platform = c.platform AND d."adId" = c."adId"
     WHERE c.platform = 'meta' AND c.format = 'Image' AND (c."imageUrl" IS NOT NULL OR c."thumbnailUrl" IS NOT NULL) ORDER BY d.spend DESC LIMIT 1`);
  const ad = rows[0];
  if (!ad) throw new Error("no ad with picture");
  console.log("AD", ad.id, ad.name, "spend30d", Math.round(ad.spend), "img", (ad.imageUrl ?? ad.thumbnailUrl)?.slice(0, 80));
  const t0 = Date.now();
  const got = await fetchImageBytes(ad.imageUrl ?? ad.thumbnailUrl!);
  if (!got) throw new Error("image fetch failed");
  console.log("IMAGE", got.mediaType, got.buf.length, "bytes in", Date.now() - t0, "ms");
  const dataUri = toDataUri(got.buf, got.mediaType);
  const t1 = Date.now();
  const analysis = await analyseTemplate({ image: dataUriToRelayImage(dataUri, "template"), title: ad.title, body: ad.body, brand: "Client test", user: null });
  console.log("ANALYSIS in", Date.now() - t1, "ms\n", JSON.stringify(analysis, null, 1).slice(0, 1800));
  const prompt = buildCopyPrompt({ template: { name: ad.name, brand: "Marque d'origine", title: ad.title, body: ad.body }, analysis, clientName: "Naturalia", instructions: "ambiance automne, produit bio", assets: 0, textless: true });
  console.log("\nCOPY PROMPT\n", prompt);
  console.log("\nEDITOR ASK\n", buildEditorAsk({ editor: "figcraft", file: "template-abc.jpg", template: { name: ad.name, brand: "Marque d'origine" }, analysis, clientName: "Naturalia" }));
  if (!urlArg) { const q = await readQuotas(); const spent = await spentToday("smoke"); console.log("\nQUOTAS", q, "SPENT", spent, "GATE", checkGeneration(q, spent, 0, 1)); }
  if (!generate) return;
  const t2 = Date.now();
  const up = await relayUpload(dataUri);
  console.log("UPLOAD", up.file);
  const out = await relayImage({ prompt, ratio: "1:1", size: "1K", images: [dataUri] });
  console.log("AGNES COPY in", Date.now() - t2, "ms", out.model, out.url?.slice(0, 100), "file", out.file);
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAIL", e); process.exit(1); });
