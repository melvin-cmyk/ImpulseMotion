import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MANUAL_SCHEDULE_LABEL, NO_SCHEDULE_LABEL, hourLabel, parseSchedule, scheduleLabel, scheduleTitle } from "@/components/routines/schedule-label";
import {
  ROUTINE_EXAMPLES, ROUTINE_STATUS, RUN_STATUS, RUN_TRIGGER, STEP_FAMILY,
  actionBlocked, canApplyProposal, dateTimeLabel, describeStep, durationLabel, exampleByKey, hasDefinition,
  plannedWrites, readSteps, shiftProposalKeys, stepTexts, toRoutineView, toRunView,
  type ProposalState, type RoutineView,
} from "@/components/routines/routine-model";
import { ROUTINE_STATUSES, RUN_STATUSES, RUN_TRIGGERS, STEP_TYPES, type RoutineStep } from "@/lib/routines/types";

describe("routines — libellés de planning", () => {
  it("dit les plannings en français", () => {
    const cases: Array<[unknown, string]> = [
      [{ kind: "weekly", time: "09:00", weekdays: [1] }, "tous les lundis à 9 h"],
      [{ kind: "daily", time: "09:00" }, "tous les jours à 9 h"],
      [{ kind: "daily", time: "07:30" }, "tous les jours à 7 h 30"],
      [{ kind: "daily", time: "00:15" }, "tous les jours à 0 h 15"],
      [{ kind: "daily", time: "18:45" }, "tous les jours à 18 h 45"],
      [{ kind: "weekly", time: "08:15", weekdays: [1, 4] }, "tous les lundis et jeudis à 8 h 15"],
      [{ kind: "weekly", time: "10:00", weekdays: [5, 1, 3] }, "tous les lundis, mercredis et vendredis à 10 h"],
      [{ kind: "weekly", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, "du lundi au vendredi à 9 h"],
      [{ kind: "weekly", time: "09:00", weekdays: [6, 7] }, "tous les samedis et dimanches à 9 h"],
      [{ kind: "weekly", time: "09:00", weekdays: [7] }, "tous les dimanches à 9 h"],
      [{ kind: "weekly", time: "09:00", weekdays: [1, 2, 3, 4, 5, 6, 7] }, "tous les jours à 9 h"],
      [{ kind: "monthly", time: "09:00", dayOfMonth: 1 }, "le 1er de chaque mois à 9 h"],
      [{ kind: "monthly", time: "08:30", dayOfMonth: 15 }, "le 15 de chaque mois à 8 h 30"],
      [{ kind: "manual" }, MANUAL_SCHEDULE_LABEL],
    ];
    for (const [schedule, label] of cases) expect(scheduleLabel(schedule), JSON.stringify(schedule)).toBe(label);
  });

  it("lit aussi le JSON enregistré", () => {
    expect(scheduleLabel('{"kind":"weekly","time":"09:00","weekdays":[1]}')).toBe("tous les lundis à 9 h");
    expect(scheduleTitle({ kind: "daily", time: "09:00" })).toBe("Tous les jours à 9 h");
  });

  it("nomme le fuseau seulement s'il n'est pas celui de l'agence", () => {
    expect(scheduleLabel({ kind: "daily", time: "09:00" }, "Europe/Paris")).toBe("tous les jours à 9 h");
    expect(scheduleLabel({ kind: "daily", time: "09:00" }, "America/Montreal")).toBe("tous les jours à 9 h (heure de America/Montreal)");
  });

  it("ne lève jamais sur un planning illisible", () => {
    for (const bad of [
      null, undefined, "", "pas du json", 42, [], {}, { kind: "hourly", time: "09:00" }, { kind: "daily" }, { kind: "daily", time: "9h" },
      { kind: "daily", time: "24:00" }, { kind: "weekly", time: "09:00" }, { kind: "weekly", time: "09:00", weekdays: [] },
      { kind: "weekly", time: "09:00", weekdays: [0] }, { kind: "weekly", time: "09:00", weekdays: [1, 8] },
      { kind: "monthly", time: "09:00" }, { kind: "monthly", time: "09:00", dayOfMonth: 31 }, { kind: "cron", expr: "* * * * *" },
    ]) {
      expect(parseSchedule(bad), JSON.stringify(bad)).toBeNull();
      expect(scheduleLabel(bad)).toBe(NO_SCHEDULE_LABEL);
    }
    expect(hourLabel("09:05")).toBe("9 h 05");
  });
});

// As the store's routineView sends it: parsed JSON, dates in epoch ms, dryRunValid.
const stored = {
  id: "cku1routine0001", name: "Créas LPEV", description: "", status: "ready", clientName: "LPEV", dashboardId: "d1",
  metaAccountId: "act_123", googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20, writesPlatform: false,
  definition: { version: 1, steps: [{ id: "lire", type: "sheet.read", sheet: { spreadsheetId: "abc", tab: "Créas" }, requiredColumns: ["id"] }] },
  definitionHash: "h1", schedule: { kind: "daily", time: "08:00" },
  nextRunAt: null, lastRunAt: Date.UTC(2026, 9, 5, 7, 0), lastRunStatus: "success", consecutiveFailures: 0,
  running: false, dryRunAt: null, dryRunValid: false,
};
const view = (over: Record<string, unknown> = {}): RoutineView => toRoutineView({ ...stored, ...over })!;

describe("routines — lecture d'une routine", () => {
  it("lit la forme envoyée par l'API", () => {
    const r = view();
    expect(r).toMatchObject({ id: "cku1routine0001", name: "Créas LPEV", status: "ready", description: null, dryRunValid: false, running: false });
    expect(r.steps).toHaveLength(1);
    expect(r.schedule).toEqual({ kind: "daily", time: "08:00" });
    expect(r.lastRunAt).toBe("2026-10-05T07:00:00.000Z");
    expect(r.nextRunAt).toBeNull();
  });

  it("lit aussi les colonnes brutes de la base", () => {
    const r = toRoutineView({
      id: "r2", name: "B", status: "active", definitionJson: JSON.stringify(stored.definition), scheduleJson: '{"kind":"manual"}',
      definitionHash: "h1", dryRunHash: "h1", nextRunAt: "2026-10-05T07:00:00.000Z",
    })!;
    expect(r.steps).toHaveLength(1);
    expect(r.schedule).toEqual({ kind: "manual" });
    expect(r.dryRunValid).toBe(true);
    expect(r.nextRunAt).toBe("2026-10-05T07:00:00.000Z");
    expect(toRoutineView({ id: "r3", definitionHash: "h2", dryRunHash: "h1" })!.dryRunValid).toBe(false);
  });

  it("ne lève pas sur une réponse illisible", () => {
    for (const bad of [null, undefined, "x", 3, [], {}, { name: "sans id" }]) expect(toRoutineView(bad)).toBeNull();
    const r = toRoutineView({ id: "r4", definition: "pas du json", schedule: 12, nextRunAt: "demain", maxItemsPerRun: "20" })!;
    expect(r).toMatchObject({ steps: [], schedule: null, nextRunAt: null, maxItemsPerRun: 0, name: "Routine sans nom", status: "draft" });
    expect(readSteps({ steps: [{ id: "x", type: "meta.update_budget" }, { type: "sheet.read" }, null, { id: "ok", type: "rows.limit", count: 3 }] })).toHaveLength(1);
  });

  it("garde le bandeau des publicités dès que la définition en crée, quoi que dise le champ", () => {
    const ads = { version: 1, steps: [{ id: "pubs", type: "meta.create_ads" }] };
    expect(view({ definition: ads, writesPlatform: false }).writesPlatform).toBe(true);
    expect(view({ writesPlatform: true }).writesPlatform).toBe(true);
    expect(view().writesPlatform).toBe(false);
  });
});

describe("routines — boutons", () => {
  it("grise « Activer » tant qu'aucun essai à blanc réussi ne couvre la définition, et dit pourquoi", () => {
    expect(actionBlocked("activate", view())).toContain("Lancez d'abord un essai à blanc");
    expect(actionBlocked("activate", view({ dryRunAt: Date.UTC(2026, 9, 1), dryRunValid: false }))).toContain("a changé depuis le dernier essai");
    expect(actionBlocked("activate", view({ dryRunAt: Date.UTC(2026, 9, 1), dryRunValid: true }))).toBeNull();
    expect(actionBlocked("activate", view({ status: "error", dryRunValid: true }))).toBeNull();
    // Without a definition hash, a dry run said valid is not believed.
    expect(actionBlocked("activate", view({ definitionHash: "", dryRunValid: true }))).toContain("Aucune définition");
  });

  it("n'active ni un brouillon, ni une routine active, en pause ou archivée", () => {
    expect(actionBlocked("activate", view({ status: "draft", definition: {}, definitionHash: "" }))).toContain("Aucune définition");
    expect(actionBlocked("activate", view({ status: "active", dryRunValid: true }))).toContain("déjà active");
    expect(actionBlocked("activate", view({ status: "paused", dryRunValid: true }))).toContain("Reprendre");
    expect(actionBlocked("activate", view({ status: "archived", dryRunValid: true }))).toContain("archivée");
  });

  it("ouvre chaque action dans le seul état qui la permet", () => {
    const active = view({ status: "active", dryRunValid: true });
    const paused = view({ status: "paused", dryRunValid: true });
    expect(actionBlocked("pause", active)).toBeNull();
    expect(actionBlocked("pause", paused)).not.toBeNull();
    expect(actionBlocked("resume", paused)).toBeNull();
    expect(actionBlocked("resume", view({ status: "paused", dryRunValid: false }))).toContain("essai à blanc");
    expect(actionBlocked("resume", active)).not.toBeNull();
    expect(actionBlocked("run", active)).toBeNull();
    expect(actionBlocked("run", view({ status: "active", dryRunValid: true, running: true }))).toContain("déjà en cours");
    expect(actionBlocked("run", view({ dryRunValid: true }))).toContain("Activez la routine");
    expect(actionBlocked("dry_run", view())).toBeNull();
    expect(actionBlocked("dry_run", view({ definition: {}, definitionHash: "" }))).toContain("Aucune définition");
    expect(actionBlocked("archive", active)).toBeNull();
    for (const action of ["dry_run", "activate", "pause", "resume", "run", "archive"] as const) {
      expect(actionBlocked(action, view({ status: "archived" })), action).toContain("archivée");
    }
    expect(hasDefinition(view())).toBe(true);
  });
});

describe("routines — bouton « Appliquer »", () => {
  const proposal = { name: "x" };
  const states: ProposalState[] = ["checking", "unverified", "invalid", "pending", "applying", "applied", "refused", "failed"];

  it("n'existe jamais pour une proposition invalide, non vérifiée ou en cours de vérification", () => {
    for (const state of ["invalid", "unverified", "checking"] as const) {
      expect(canApplyProposal(state, proposal), state).toBe(false);
      expect(canApplyProposal(state, null), state).toBe(false);
    }
  });

  it("exige une proposition validée par le serveur", () => {
    for (const state of states) expect(canApplyProposal(state, null), state).toBe(false);
    for (const state of states) expect(canApplyProposal(state, undefined), state).toBe(false);
    expect(states.filter((s) => canApplyProposal(s, proposal))).toEqual(["pending", "failed"]);
  });

  it("est rendu par la carte sous cette seule condition", () => {
    const card = fs.readFileSync(path.resolve(__dirname, "../../components/routines/proposal-card.tsx"), "utf8");
    expect(card.match(/onClick=\{onApply\}/g)).toHaveLength(1);
    const guard = card.indexOf("{canApplyProposal(state, proposal) && (");
    const button = card.indexOf("onClick={onApply}");
    expect(guard).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(guard);
    expect(card.slice(guard, button)).not.toContain(")}");

    // The conversation gives the card a proposal only when the server's check says ok.
    const chat = fs.readFileSync(path.resolve(__dirname, "../../components/routines/routine-chat.tsx"), "utf8");
    expect(chat).toContain('const proposal = check?.ok && local.kind === "candidate" ? check.proposal : null;');
    expect(chat).toContain('else if (!check.ok) { state = "invalid"; errors = check.errors; }');
    expect(chat).toContain('if (local.kind === "malformed") { state = "invalid"; errors = local.errors; }');
    expect(chat).toContain("`/api/routines/${routineId}/definition`");
    expect(chat).not.toContain("validateProposal");
  });
});

describe("routines — exécutions", () => {
  const stepResult = {
    stepId: "pubs", type: "meta.create_ads", status: "ok", durationMs: 1200, rowsIn: 3, rowsOut: 3,
    output: { rows: { columns: ["id"], rows: [{ id: "a1" }, { id: { objet: 1 } }], truncated: true } },
    planned: [{ target: "meta", summary: "Publicité « A1 »", itemKey: "pubs:a1", preview: { nom: "A1", lien: "https://x.fr", objet: { a: 1 } } }],
    written: [], warnings: ["attention", 3],
  };

  it("lit une ligne d'historique et la réponse d'un essai à blanc", () => {
    const row = toRunView({
      id: "run1", trigger: "schedule", status: "partial", definitionHash: "h1", startedAt: Date.UTC(2026, 9, 5, 7, 0), durationMs: 4200,
      totals: { planned: 3, created: 2, skipped: 0, failed: 1 }, steps: [stepResult], error: null,
    })!;
    expect(row).toMatchObject({ id: "run1", trigger: "schedule", status: "partial", totals: { planned: 3, created: 2, skipped: 0, failed: 1 } });
    expect(row.steps[0].warnings).toEqual(["attention"]);
    expect(row.steps[0].planned[0].preview).toEqual({ nom: "A1", lien: "https://x.fr" });
    expect(row.steps[0].output.rows).toEqual({ columns: ["id"], rows: [{ id: "a1" }, { id: null }], truncated: true });

    const result = toRunView({ runId: "run2", mode: "dry_run", status: "success", steps: [stepResult], totals: { planned: 1, created: 0, skipped: 0, failed: 0 }, timedOut: false })!;
    expect(result).toMatchObject({ id: "run2", trigger: "dry_run", status: "success" });

    const raw = toRunView({ id: "run3", trigger: "manual", status: "failed", itemsPlanned: 2, itemsFailed: 2, stepsJson: JSON.stringify([stepResult]), error: "boum" })!;
    expect(raw.totals).toEqual({ planned: 2, created: 0, skipped: 0, failed: 2 });
    expect(raw.steps).toHaveLength(1);
    expect(raw.error).toBe("boum");
  });

  it("liste ce qui serait écrit, élément par élément", () => {
    const run = toRunView({ id: "r", steps: [stepResult, { ...stepResult, stepId: "envoi", type: "slack.message", planned: [{ target: "slack", summary: "Message dans #client", preview: {} }] }] })!;
    expect(plannedWrites(run).map((p) => [p.stepId, p.target, p.summary])).toEqual([
      ["pubs", "meta", "Publicité « A1 »"],
      ["envoi", "slack", "Message dans #client"],
    ]);
  });

  it("ne lève pas sur une exécution illisible", () => {
    for (const bad of [null, "x", [], {}, { status: "success" }]) expect(toRunView(bad)).toBeNull();
    expect(toRunView({ id: "r", steps: "pas du json" })!.steps).toEqual([]);
    expect(toRunView({ id: "r", steps: [{ error: { message: "x", class: "autre" } }] })!.steps[0]).toMatchObject({ stepId: "?", status: "ok", error: { class: "functional", message: "x" } });
  });
});

describe("routines — libellés", () => {
  it("a un libellé pour chaque état, chaque déclencheur et chaque type d'étape", () => {
    for (const s of ROUTINE_STATUSES) expect(ROUTINE_STATUS[s]?.label, s).toBeTruthy();
    for (const s of RUN_STATUSES) expect(RUN_STATUS[s]?.label, s).toBeTruthy();
    for (const t of RUN_TRIGGERS) expect(RUN_TRIGGER[t], t).toBeTruthy();
    for (const t of STEP_TYPES) expect(STEP_FAMILY[t]?.label, t).toBeTruthy();
  });

  it("dit chaque étape en une phrase", () => {
    const sheet = { spreadsheetId: "abc", tab: "Créas" };
    const steps: RoutineStep[] = [
      { id: "a", type: "sheet.read", sheet, requiredColumns: ["id", "titre"], maxRows: 200 },
      { id: "b", type: "meta.insights", level: "campaign", window: "7d", metrics: ["spend", "roas"], nameContains: "Promo" },
      { id: "c", type: "google.insights", level: "account", window: "month_to_date", metrics: ["clicks"] },
      { id: "d", type: "rows.filter", where: [{ column: "statut", op: "empty" }, { column: "depense", op: "gt", value: 100 }] },
      { id: "e", type: "rows.sort", by: "depense", dir: "desc" },
      { id: "f", type: "rows.limit", count: 5 },
      { id: "g", type: "rows.select", columns: [{ from: "nom" }, { from: "spend", as: "depense" }] },
      { id: "h", type: "ai.summary", instruction: "Résume.", maxChars: 600, onFailure: "continue_without" },
      { id: "i", type: "sheet.write", sheet, mode: "upsert", keyColumn: "id", columns: [{ column: "statut", value: "fait" }] },
      { id: "j", type: "slack.message", channel: "#client", text: "Point du {{run.date}}", includeTable: true },
      { id: "k", type: "email.send", to: ["a@b.fr"], subject: "Point", body: "{{steps.h.text}}" },
      {
        id: "l", type: "meta.create_ads", campaignId: "111", adsetId: "222", pageId: "333", keyColumn: "id",
        mapping: { adName: "{{row.nom}}", primaryText: "{{row.texte}}", linkUrl: "{{row.lien}}", mediaType: "video", mediaUrl: "{{row.url}}" },
        writeBack: { sheet, statusColumn: "statut" },
      },
    ];
    expect(steps.map((s) => s.type)).toEqual([...STEP_TYPES]);
    for (const s of steps) {
      const text = describeStep(s);
      expect(text.length, s.type).toBeGreaterThan(15);
      expect(text, s.type).not.toMatch(/undefined|\[object/);
    }
    expect(describeStep(steps[1])).toContain("par campagne, 7 derniers jours : dépense, ROAS");
    expect(describeStep(steps[3])).toContain("« statut » est vide et « depense » > « 100 »");
    expect(describeStep(steps[11])).toContain("EN PAUSE");
    expect(describeStep(steps[11])).toContain("vidéo");
    expect(stepTexts(steps[9])).toEqual([{ label: "Message", text: "Point du {{run.date}}" }]);
    expect(stepTexts(steps[11]).map((t) => t.label)).toEqual(["Nom de la publicité", "Texte principal", "Lien", "Média"]);
    expect(stepTexts(steps[0])).toEqual([]);
  });

  it("ne lève pas sur une étape incomplète", () => {
    for (const type of STEP_TYPES) expect(() => describeStep({ id: "x", type } as unknown as RoutineStep), type).not.toThrow();
    for (const type of STEP_TYPES) expect(() => stepTexts({ id: "x", type } as unknown as RoutineStep), type).not.toThrow();
  });

  it("dit les dates dans le fuseau de la routine, et les durées", () => {
    expect(dateTimeLabel("2026-10-05T07:00:00.000Z", "Europe/Paris")).toMatch(/lun\.? 5 oct\.? à 09:00/);
    expect(dateTimeLabel("2026-10-05T07:00:00.000Z", null)).toMatch(/09:00/);
    expect(dateTimeLabel(null)).toBe("—");
    expect(dateTimeLabel("pas une date")).toBe("—");
    expect(dateTimeLabel("2026-10-05T07:00:00.000Z", "Fuseau/Inconnu")).toBe("2026-10-05 07:00");
    expect(durationLabel(850)).toBe("850 ms");
    expect(durationLabel(12_400)).toBe("12 s");
    expect(durationLabel(125_000)).toBe("2 min 05");
  });
});

describe("routines — conversation", () => {
  it("fait suivre les statuts quand la conversation est raccourcie par le haut", () => {
    expect(shiftProposalKeys({ m1: "applied", m5: "pending", m7: "invalid" }, 2)).toEqual({ m3: "pending", m5: "invalid" });
    expect(shiftProposalKeys({ m1: "applied" }, 0)).toEqual({ m1: "applied" });
    expect(shiftProposalKeys({ autre: "x", m2: "y" }, 1)).toEqual({ m1: "y" });
  });

  it("propose trois exemples, dont pousser des créas sur Meta depuis un Google Sheet", () => {
    expect(ROUTINE_EXAMPLES).toHaveLength(3);
    expect(new Set(ROUTINE_EXAMPLES.map((e) => e.key)).size).toBe(3);
    for (const e of ROUTINE_EXAMPLES) {
      expect(e.prompt.length, e.key).toBeGreaterThan(60);
      expect(e.name.length, e.key).toBeLessThanOrEqual(120);
    }
    expect(exampleByKey("creas")?.prompt).toMatch(/Google Sheet.*publicités Meta.*en pause/);
    expect(exampleByKey("inconnu")).toBeNull();
    expect(exampleByKey(null)).toBeNull();
  });
});

describe("routines — navigation et accès", () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8");

  it("place « Routines » dans l'espace interne, après « Rapports IA »", () => {
    const sidebar = read("components/sidebar.tsx");
    const internal = sidebar.slice(sidebar.indexOf('label: "Espace interne"'), sidebar.indexOf('label: "Espace clients"'));
    const labels = [...internal.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels.slice(labels.indexOf("Rapports IA"), labels.indexOf("Rapports IA") + 2)).toEqual(["Rapports IA", "Routines"]);
    expect(internal).toContain('href: "/routines"');
  });

  it("laisse les clients hors de /routines : le proxy n'ouvre aucun de ces chemins", () => {
    const proxy = read("proxy.ts");
    const allowed = /const CLIENT_ALLOWED_PREFIXES = \[([\s\S]*?)\];/.exec(proxy)?.[1] ?? "";
    const prefixes = [...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(prefixes.length).toBeGreaterThan(5);
    for (const p of ["/routines", "/routines/new", "/routines/abc", "/api/routines", "/api/routines/abc/assistant"]) {
      expect(prefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`)), p).toBe(false);
    }
    const publicPaths = /const publicPaths = \[([^\]]*)\]/.exec(proxy)?.[1] ?? "";
    expect(publicPaths).not.toContain("routines");
  });
});
