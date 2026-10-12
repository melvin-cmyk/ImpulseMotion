/**
 * Document du cadre isolé (<iframe sandbox="allow-scripts" srcdoc>) qui rend
 * la page d'un dashboard du staff : thème sombre d'ImpulseMotion exposé par
 * les variables CSS du type « Dashboard » de Claude (--cds-*, --color-*),
 * d3 v7 servi localement, runtime public/dash-runtime.js, puis la page dans
 * #dash-root, puis le démarrage (liste des jeux + paramètres).
 */

import type { ParamValue } from "./model";

export const FRAME_THEME_CSS = `
:root {
  --font-anthropic-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-anthropic-serif: ui-serif, Georgia, "Times New Roman", serif;
  --cds-gap-xs: .25rem; --cds-gap-sm: .5rem; --cds-gap-md: 1rem; --cds-gap-lg: 1.5rem; --cds-gap-xl: 2rem;
  --cds-pad-xs: .25rem; --cds-pad-sm: .5rem; --cds-pad-md: .75rem; --cds-pad-lg: 1rem; --cds-pad-xl: 1.5rem;
  --cds-font-size-caption: .75rem; --cds-font-size-body: .875rem; --cds-font-size-heading: 1rem; --cds-font-size-title: 1.5rem; --cds-font-size-display: 2rem;
  --cds-font-weight-medium: 600; --cds-font-weight-regular: 400;
  --cds-radius: .625rem; --cds-radius-sm: .375rem;
  --cds-dur-fast: .12s; --cds-dur-slow: .3s;
  --color-bg: #030712; --color-panel: #0f1117; --color-panel-raised: #171a23;
  --color-border-line: #262a36; --cds-border: #2d3240;
  --color-fg: #f3f4f6; --color-fg-muted: #9ca3af; --cds-text-secondary: #9ca3af; --cds-text-primary: #f3f4f6;
  --color-ok: #22c55e; --color-warn: #f59e0b; --color-bad: #ef4444; --color-accent: #8b5cf6;
  --cds-chart-grid: #1f2430; --cds-chart-axis: #3a4050; --cds-chart-muted: #6b7280; --cds-chart-reference: #e5e7eb;
  --cds-chart-status-critical: #ef4444; --cds-chart-status-warning: #f59e0b; --cds-chart-status-ok: #22c55e;
  --cds-chart-1: #8b5cf6; --cds-chart-2: #22c55e; --cds-chart-3: #f59e0b; --cds-chart-4: #3b82f6; --cds-chart-5: #ec4899;
  --cds-surface-popover: #171a23; --cds-shadow-popover: 0 8px 24px rgba(0,0,0,.45);
  color-scheme: dark;
}
html, body { margin: 0; padding: 0; background: transparent; color: var(--color-fg); font-family: var(--font-anthropic-sans); font-size: var(--cds-font-size-body); line-height: 1.45; }
#dash-root { padding: 0 2px 8px; }
a { color: var(--color-accent); }
table { border-color: var(--color-border-line); }
.dash-skeleton { position: relative; color: transparent !important; background: linear-gradient(90deg, #1f2430 25%, #2a3040 37%, #1f2430 63%); background-size: 400% 100%; animation: dash-shimmer 1.4s ease infinite; border-radius: .35rem; min-height: 1em; }
.dash-skeleton * { visibility: hidden; }
@keyframes dash-shimmer { 0% { background-position: 100% 0 } 100% { background-position: 0 0 } }
[data-dash-source-state=empty] { color: transparent; }
[data-dash-source-state=refreshing] { opacity: .5; transition: opacity var(--cds-dur-slow); }
`;

function escapeScriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Le document complet du cadre. `html` est la page du dashboard telle qu'enregistrée (style + markup + scripts). */
export function buildFrameDocument(html: string, datasetIds: string[], params: Record<string, ParamValue>, origin = ""): string {
  const base = origin.replace(/\/$/, "");
  return [
    "<!doctype html>",
    '<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${FRAME_THEME_CSS}</style>`,
    `<script src="${base}/vendor/d3.v7.min.js"></script>`,
    `<script src="${base}/dash-runtime.js"></script>`,
    "</head><body>",
    `<div id="dash-root">${html}</div>`,
    `<script>dash.__boot(${escapeScriptJson(datasetIds)}, ${escapeScriptJson(params)});</script>`,
    "</body></html>",
  ].join("\n");
}
