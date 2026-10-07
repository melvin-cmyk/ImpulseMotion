/**
 * Pilotage — links that open /pilotage on a client, an account, an object,
 * with a change ready or a question for the AI. Used by the AI reports (one
 * link per next step), the dashboards (one per campaign row, per alert), the
 * Slack digests and the onglet « Historique & impact ».
 *
 *   /pilotage?client=<alertClientId>
 *   /pilotage?platform=meta|google&account=<id>          the client is found from the account
 *   &object=campaign:<id> | adset:<id> | ad:<id>          the object is shown
 *   &do=pause|activate|budget&value=<amount>              a change is put in « Modifier », not sent
 *   &prompt=<text>                                        the AI of the page gets this question
 *   &step=<reportId>:<stepId>                             the report's step is ticked once a change is sent
 *   &preview=<actionId>                                   a prepared action (an undo) is opened
 *
 * Pure.
 */

export type PilotLinkDo = "pause" | "activate" | "budget";

export interface PilotLink {
  client?: string | null;
  platform?: "meta" | "google" | null;
  account?: string | null;
  object?: { type: "campaign" | "adset" | "ad"; id: string } | null;
  do?: PilotLinkDo | null;
  value?: string | null;
  prompt?: string | null;
  step?: { reportId: string; stepId: string } | null;
  preview?: string | null;
}

const isId = (v: string) => /^[A-Za-z0-9_:-]{1,60}$/.test(v);

export function buildPilotHref(link: PilotLink, base = "/pilotage"): string {
  const q = new URLSearchParams();
  if (link.client) q.set("client", link.client);
  if (link.platform) q.set("platform", link.platform);
  if (link.account) q.set("account", link.account);
  if (link.object) q.set("object", `${link.object.type}:${link.object.id}`);
  if (link.do) q.set("do", link.do);
  if (link.value !== undefined && link.value !== null && link.value !== "") q.set("value", String(link.value));
  if (link.prompt) q.set("prompt", link.prompt.slice(0, 1500));
  if (link.step) q.set("step", `${link.step.reportId}:${link.step.stepId}`);
  if (link.preview) q.set("preview", link.preview);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** The link as the page reads it; what is not readable is left out, never guessed. */
export function readPilotLink(search: string | URLSearchParams): PilotLink {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const out: PilotLink = {};
  const client = q.get("client");
  if (client && isId(client)) out.client = client;
  const platform = q.get("platform");
  if (platform === "meta" || platform === "google") out.platform = platform;
  const account = q.get("account");
  if (account && /^[A-Za-z0-9_-]{3,40}$/.test(account)) out.account = account;
  const object = q.get("object");
  const m = object ? /^(campaign|adset|ad):(\d{1,25})$/.exec(object) : null;
  if (m) out.object = { type: m[1] as "campaign" | "adset" | "ad", id: m[2] };
  const act = q.get("do");
  if (act === "pause" || act === "activate" || act === "budget") out.do = act;
  const value = q.get("value");
  if (value && value.length <= 40) out.value = value;
  const prompt = q.get("prompt");
  if (prompt && prompt.trim()) out.prompt = prompt.trim().slice(0, 1500);
  const step = q.get("step");
  const sm = step ? /^([A-Za-z0-9_-]{1,40}):([A-Za-z0-9_-]{1,40})$/.exec(step) : null;
  if (sm) out.step = { reportId: sm[1], stepId: sm[2] };
  const preview = q.get("preview");
  if (preview && isId(preview)) out.preview = preview;
  return out;
}

/** The platform an alert's account id belongs to (AlertEvent.clientId): act_… is Meta, ten digits Google Ads. */
export function platformOfAccountId(id: string): "meta" | "google" | "tiktok" | null {
  if (/^act_\d{5,25}$/.test(id)) return "meta";
  if (/^\d{3}-\d{3}-\d{4}$/.test(id) || /^\d{10}$/.test(id)) return "google";
  if (/^\d{16,20}$/.test(id)) return "tiktok";
  return null;
}

/** The question the AI of Pilotage gets for a report's next step. */
export function stepPrompt(step: { title: string; detail?: string }): string {
  return `Le rapport propose cette action : « ${step.title} ».${step.detail ? ` ${step.detail}` : ""} Prépare les modifications correspondantes sur ce compte, en expliquant ce que tu changes.`;
}
