/**
 * Routines — the counters of a run, said in French, one per nature of write.
 * The same words in the history, in the journal of the dry runs and in the
 * notice that follows « Exécuter maintenant ». Pure and client-safe.
 */

import type { WriteCounts } from "@/lib/routines/types";

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export interface CounterText { key: keyof WriteCounts; text: string; tone: "done" | "plain" | "bad" | "wait" }

/**
 * A nature at zero is not shown, except the ads of a routine that creates
 * some (`ads`).
 */
export function counterTexts(c: WriteCounts, mode: "dry_run" | "live", ads = false): CounterText[] {
  const dry = mode === "dry_run";
  const out: CounterText[] = [];
  if (ads || c.adsCreated) out.push({ key: "adsCreated", tone: "done", text: dry ? plural(c.adsCreated, "publicité à créer", "publicités à créer") : plural(c.adsCreated, "publicité créée", "publicités créées") });
  if (c.adsAttached) out.push({ key: "adsAttached", tone: "done", text: dry ? plural(c.adsAttached, "publicité à rattacher", "publicités à rattacher") : plural(c.adsAttached, "publicité rattachée", "publicités rattachées") });
  if (c.sheetRows) out.push({ key: "sheetRows", tone: "done", text: dry ? plural(c.sheetRows, "ligne de Sheet à écrire", "lignes de Sheet à écrire") : plural(c.sheetRows, "ligne écrite dans un Sheet", "lignes écrites dans un Sheet") });
  if (c.messages) out.push({ key: "messages", tone: "done", text: dry ? plural(c.messages, "message à envoyer", "messages à envoyer") : plural(c.messages, "message envoyé", "messages envoyés") });
  if (!out.length) out.push({ key: "adsCreated", tone: "plain", text: dry ? "aucune écriture prévue" : "aucune écriture" });
  if (c.skipped) out.push({ key: "skipped", tone: "plain", text: plural(c.skipped, "ignorée", "ignorées") });
  if (c.failed) out.push({ key: "failed", tone: "bad", text: `${c.failed} en échec` });
  if (c.deferred) out.push({ key: "deferred", tone: "wait", text: plural(c.deferred, "reportée", "reportées") });
  return out;
}

export function countsText(c: WriteCounts, mode: "dry_run" | "live", ads = false): string {
  return counterTexts(c, mode, ads).map((t) => t.text).join(", ");
}
