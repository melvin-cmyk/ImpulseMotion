#!/usr/bin/env node
/**
 * Génère lib/staff-dashboards/templates/generated.ts depuis les modèles de
 * dashboards du staff (lib/staff-dashboards/templates/<key>.html + <key>.datasets.json
 * + <key>.params.json facultatif). Un module TS importé statiquement : aucune
 * lecture de fichier à l'exécution (le bundle Vercel n'embarque pas les .html).
 *
 *   node scripts/build-dashboard-templates.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "staff-dashboards", "templates");
const keys = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, "")).sort();
const entries = keys.map((key) => {
  const html = fs.readFileSync(path.join(dir, `${key}.html`), "utf8");
  const datasets = JSON.parse(fs.readFileSync(path.join(dir, `${key}.datasets.json`), "utf8"));
  const paramsPath = path.join(dir, `${key}.params.json`);
  const params = fs.existsSync(paramsPath) ? JSON.parse(fs.readFileSync(paramsPath, "utf8")) : {};
  return `  ${JSON.stringify(key)}: { html: ${JSON.stringify(html)}, datasets: ${JSON.stringify(datasets)}, params: ${JSON.stringify(params)} },`;
});
const out = `// GÉNÉRÉ par scripts/build-dashboard-templates.mjs — ne pas modifier à la main.
// Source : lib/staff-dashboards/templates/<key>.html + <key>.datasets.json (+ <key>.params.json).
export const GENERATED_TEMPLATES: Record<string, { html: string; datasets: unknown; params: unknown }> = {
${entries.join("\n")}
};
`;
fs.writeFileSync(path.join(dir, "generated.ts"), out);
console.log(`[dashboard-templates] ${keys.length} modèle(s) : ${keys.join(", ")}`);
