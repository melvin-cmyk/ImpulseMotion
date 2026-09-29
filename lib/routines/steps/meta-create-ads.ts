/**
 * Routines — step meta.create_ads: one ad per input row, always PAUSED, in the
 * ad set named by the definition. The only step that writes on a platform.
 *
 * Rules (plan, section 2 B):
 *   - the account is the routine's (ctx.routine.metaAccountId); the campaign,
 *     ad set and Page ids are literals of the definition, never templates: a
 *     cell can change a text, a link or an image, never where the ad goes;
 *   - the ad set is re-read and compared with the account and the campaign
 *     before anything is sent, here once and again by createPausedAd;
 *   - dry run (ctx.write null): reads only, `planned` lists the ads that would
 *     really be created. ctx.claimItem is asked for each row: in a dry run the
 *     engine answers from the database without reserving anything, so a row
 *     already created, or whose outcome is unknown, is not announced again;
 *   - live: claimItem before Meta, settleItem after. `already_done` and
 *     `uncertain` create nothing. An ad of the same name already in the ad set
 *     is attached instead of created again;
 *   - a creation whose outcome is unknown (timeout, network) is NOT settled: the
 *     item stays reserved and the engine turns it `uncertain`. The step stops
 *     there, nothing is sent again;
 *   - ceiling (maxItemsPerRun) and deadline: the rows left wait for the next run;
 *   - the rows that come out are those this run dealt with, each with its
 *     outcome (meta_statut, meta_ad_id, meta_erreur);
 *   - the status written back in the Sheet is a reflection: its failure is a
 *     warning, never a failure of the step.
 *
 * A row the step refuses (empty or duplicate key, link that is not public
 * https…) is a warning and creates nothing; a creation refused by Meta fails
 * the step. First version: image only (see lib/meta-write.ts).
 */

import {
  CALL_TO_ACTIONS, MAX_AD_NAME_CHARS, checkAdIdentity, cleanMetaMessage, createPausedAd, findAdByName, isCallToAction,
  isMetaId, isMetaWriteError, pausedAdInputError, verifyAdsetInAccount, verifyCampaignInAccount,
  type PausedAdInput,
} from "@/lib/meta-write";
import { readSheet, sheetRefError, updateCells, type CellUpdate } from "@/lib/relay-sheets";
import { wasDeferred } from "@/lib/routines/store";
import { renderTemplateDetailed, scopeFromContext, templateError } from "@/lib/routines/template";
import {
  MAX_ITEMS_PER_RUN_CAP,
  type Cell, type ErrorClass, type MetaCreateAdsStep, type PlannedWrite, type PreflightIssue, type Row, type RowSet,
  type StepContext, type StepHandler, type StepRunOutcome,
} from "@/lib/routines/types";

const STEP_KEYS = ["id", "type", "label", "input", "campaignId", "adsetId", "pageId", "instagramActorId", "keyColumn", "mapping", "writeBack"];
const MAPPING_KEYS = ["adName", "primaryText", "headline", "description", "linkUrl", "callToAction", "mediaType", "mediaUrl"];
const WRITE_BACK_KEYS = ["sheet", "statusColumn", "adIdColumn", "errorColumn"];
const SHEET_KEYS = ["spreadsheetId", "tab"];
const STEP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_COLUMN_CHARS = 120;
const MAX_KEY_CHARS = 200;

/** Time one ad may take (four reads, two POST): an ad is not started with less left. */
export const ITEM_BUDGET_MS = 60_000;
/** Time kept for the status written back in the Sheet. */
const WRITE_BACK_BUDGET_MS = 20_000;

/** Columns added to the rows that come out of the step. */
export const OUT_STATUS = "meta_statut";
export const OUT_AD_ID = "meta_ad_id";
export const OUT_ERROR = "meta_erreur";

const UNCERTAIN = "résultat d'une exécution précédente inconnu : à vérifier dans le gestionnaire de publicités, aucune création";

type ItemState = "créée" | "déjà présente" | "déjà traitée" | "à vérifier" | "échec" | "refusée" | "en attente" | "prévue";

interface Item {
  row: Row;
  key: string;
  state: ItemState;
  adId?: string;
  error?: string;
  input?: PausedAdInput;
  /** The state was found in the database, left there by an earlier run. */
  earlier?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cap = (n: number) => Math.max(1, Math.min(MAX_ITEMS_PER_RUN_CAP, Math.floor(Number.isFinite(n) ? n : 1)));
const messageOf = (err: unknown) => cleanMetaMessage(err instanceof Error ? err.message : String(err));

function unknownKey(value: Record<string, unknown>, allowed: string[]): string | null {
  return Object.keys(value).find((k) => !allowed.includes(k)) ?? null;
}

function columnError(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "nom de colonne vide";
  if (value.length > MAX_COLUMN_CHARS || /[{}\n\r]/.test(value)) return "nom de colonne invalide";
  return null;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** Renders one row into the ad it describes, or says why the row is refused. */
function buildInput(step: MetaCreateAdsStep, accountId: string, ctx: Pick<StepContext, "now" | "routine" | "outputs">, row: Row): { input: PausedAdInput } | { error: string } {
  const scope = scopeFromContext(ctx, row);
  const render = (template: string | undefined, label: string, required: boolean): { text?: string; error?: string } => {
    if (template === undefined) return {};
    const { text, missing } = renderTemplateDetailed(template, scope);
    if (missing.length) return { error: `${label} : ${missing[0]} introuvable` };
    if (required && !text.trim()) return { error: `${label} vide` };
    return { text };
  };
  const m = step.mapping;
  const parts = {
    name: render(m.adName, "nom de la publicité", true),
    primaryText: render(m.primaryText, "texte principal", true),
    headline: render(m.headline, "titre", false),
    description: render(m.description, "description", false),
    linkUrl: render(m.linkUrl, "lien", true),
    imageUrl: render(m.mediaUrl, "image", true),
  };
  for (const part of Object.values(parts)) if (part.error) return { error: part.error };
  // Ids come from the routine and from the definition only; the row gave texts and URLs.
  const input: PausedAdInput = {
    accountId,
    campaignId: step.campaignId,
    adsetId: step.adsetId,
    pageId: step.pageId,
    ...(step.instagramActorId ? { instagramUserId: step.instagramActorId } : {}),
    name: (parts.name.text ?? "").trim(),
    primaryText: parts.primaryText.text ?? "",
    ...(parts.headline.text?.trim() ? { headline: parts.headline.text } : {}),
    ...(parts.description.text?.trim() ? { description: parts.description.text } : {}),
    linkUrl: (parts.linkUrl.text ?? "").trim(),
    ...(m.callToAction ? { callToAction: m.callToAction } : {}),
    imageUrl: (parts.imageUrl.text ?? "").trim(),
  };
  const invalid = pausedAdInputError(input);
  return invalid ? { error: invalid } : { input };
}

/** One item per row: keyed and rendered, or refused with the reason. */
function readRows(step: MetaCreateAdsStep, accountId: string, ctx: StepContext, rows: Row[]): Item[] {
  const keyOf = (row: Row) => {
    const v = Object.prototype.hasOwnProperty.call(row, step.keyColumn) ? row[step.keyColumn] : null;
    return v === null || v === undefined ? "" : String(v).trim();
  };
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const names = new Map<string, number>();
  const items = rows.map((row): Item => {
    const key = keyOf(row);
    if (!key) return { row, key, state: "refusée", error: `clé vide (colonne « ${step.keyColumn} »)` };
    if (key.length > MAX_KEY_CHARS) return { row, key: key.slice(0, MAX_KEY_CHARS), state: "refusée", error: `clé trop longue (${MAX_KEY_CHARS} caractères au plus)` };
    if ((counts.get(key) ?? 0) > 1) return { row, key, state: "refusée", error: `clé « ${key} » présente ${counts.get(key)} fois dans le tableau : aucune de ces lignes n'est traitée` };
    const built = buildInput(step, accountId, ctx, row);
    if ("error" in built) return { row, key, state: "refusée", error: built.error };
    names.set(built.input.name, (names.get(built.input.name) ?? 0) + 1);
    return { row, key, state: "en attente", input: built.input };
  });
  for (const item of items) {
    if (item.input && (names.get(item.input.name) ?? 0) > 1) {
      item.state = "refusée";
      item.error = `nom de publicité « ${item.input.name.slice(0, 80)} » donné à plusieurs lignes : aucune n'est traitée`;
      item.input = undefined;
    }
  }
  return items;
}

function previewOf(input: PausedAdInput, key: string): Record<string, Cell> {
  return {
    cle: key,
    nom: input.name,
    texte: input.primaryText,
    titre: input.headline ?? null,
    description: input.description ?? null,
    lien: input.linkUrl,
    bouton: input.callToAction ?? null,
    media: input.imageUrl,
    type_media: "image",
    statut: "PAUSED",
    compte: input.accountId,
    campagne: input.campaignId,
    ensemble: input.adsetId,
    page: input.pageId,
  };
}

/**
 * Rows that come out of the step: those this run dealt with (created,
 * attached, planned, failed, refused, outcome unknown). A row done by an
 * earlier run, or left for the next one, is not news: a message placed after
 * the step must not announce it, and is not sent when nothing is left to say.
 */
const dealtWith = (item: Item) => item.state !== "en attente" && item.state !== "déjà traitée" && !item.earlier;

function outputRows(input: RowSet, all: Item[]): RowSet {
  const items = all.filter(dealtWith);
  const added = [OUT_STATUS, OUT_AD_ID, OUT_ERROR].filter((c) => !input.columns.includes(c));
  return {
    columns: [...input.columns, ...added],
    rows: items.map((i) => ({ ...i.row, [OUT_STATUS]: i.state, [OUT_AD_ID]: i.adId ?? null, [OUT_ERROR]: i.error ?? null })),
    truncated: input.truncated,
  };
}

// ── Status written back in the Sheet ─────────────────────────────────────────

const REPORTED: ItemState[] = ["créée", "déjà présente", "à vérifier", "échec", "refusée", "prévue"];

/** Cells to rewrite, found by key in the sheet as it is now. Read only. */
async function writeBackUpdates(step: MetaCreateAdsStep, items: Item[], warnings: string[]): Promise<CellUpdate[]> {
  const back = step.writeBack;
  const reported = items.filter((i) => i.key && REPORTED.includes(i.state));
  if (!back || reported.length === 0) return [];
  const sheet = await readSheet(back.sheet, { maxRows: 5000 });
  if (!sheet.columns.includes(step.keyColumn)) {
    warnings.push(`Retour dans le Sheet impossible : colonne « ${step.keyColumn} » absente de l'onglet « ${back.sheet.tab} ».`);
    return [];
  }
  const columns = [back.statusColumn, back.adIdColumn, back.errorColumn].filter((c): c is string => !!c);
  const absent = columns.find((c) => !sheet.columns.includes(c));
  if (absent) {
    warnings.push(`Retour dans le Sheet impossible : colonne « ${absent} » absente de l'onglet « ${back.sheet.tab} ».`);
    return [];
  }
  const rowsOf = new Map<string, number[]>();
  sheet.rows.forEach((row, i) => {
    const key = String(row[step.keyColumn] ?? "").trim();
    const n = sheet.rowNumbers[i];
    if (key && Number.isInteger(n)) rowsOf.set(key, [...(rowsOf.get(key) ?? []), n]);
  });
  const updates: CellUpdate[] = [];
  let lost = 0;
  for (const item of reported) {
    const found = rowsOf.get(item.key) ?? [];
    // A key on several rows is one of the refusals reported: every such row gets the message.
    if (found.length === 0 || (found.length > 1 && item.state !== "refusée")) { lost++; continue; }
    for (const row of found) {
      updates.push({ row, column: back.statusColumn, value: item.state === "créée" || item.state === "déjà présente" ? `${item.state} (en pause)` : item.state });
      if (back.adIdColumn && item.adId) updates.push({ row, column: back.adIdColumn, value: item.adId });
      if (back.errorColumn) updates.push({ row, column: back.errorColumn, value: item.error ?? "" });
    }
  }
  if (lost) warnings.push(`Retour dans le Sheet : ${lost} ligne(s) introuvable(s) par leur clé, non mises à jour.`);
  const seen = new Set<string>();
  return updates.filter((u) => {
    const cell = `${u.row}:${u.column}`;
    if (seen.has(cell)) return false;
    seen.add(cell);
    return true;
  }).slice(0, 500);
}

// ── Handler ──────────────────────────────────────────────────────────────────

function failure(rowsIn: number, message: string, errorClass: ErrorClass, warnings: string[] = []): StepRunOutcome {
  return {
    status: "failed", rowsIn, rowsOut: 0, output: {}, planned: [], written: [], warnings,
    error: { class: errorClass, message: cleanMetaMessage(message) },
  };
}

const classOfWrite = (err: unknown): ErrorClass => (isMetaWriteError(err) && err.kind === "refused" ? "functional" : "infra");

export const metaCreateAdsHandler: StepHandler<MetaCreateAdsStep> = {
  type: "meta.create_ads",
  writes: "platform",

  validate(step) {
    const no = (error: string) => ({ ok: false as const, error: `meta.create_ads : ${error}` });
    if (!isRecord(step)) return no("étape invalide");
    // Every key is named: a status, a budget or a bid slipped in is refused, not ignored.
    const extra = unknownKey(step, STEP_KEYS);
    if (extra) return no(`champ « ${extra.slice(0, 40)} » refusé : une publicité est toujours créée en pause, sans statut, budget ni enchère à régler`);
    if (step.type !== "meta.create_ads") return no("type inattendu");
    if (typeof step.id !== "string" || !STEP_ID_RE.test(step.id)) return no("identifiant d'étape invalide");
    for (const [key, label] of [["campaignId", "de campagne"], ["adsetId", "d'ensemble de publicités"], ["pageId", "de page"]] as const) {
      if (!isMetaId(step[key])) return no(`identifiant ${label} invalide : des chiffres seulement, aucun gabarit`);
    }
    if (step.instagramActorId !== undefined && !isMetaId(step.instagramActorId)) return no("identifiant de compte Instagram invalide : des chiffres seulement, aucun gabarit");
    const keyColumn = columnError(step.keyColumn);
    if (keyColumn) return no(`colonne clé : ${keyColumn}`);

    if (!isRecord(step.mapping)) return no("« mapping » manquant");
    const extraMapping = unknownKey(step.mapping, MAPPING_KEYS);
    if (extraMapping) return no(`champ « mapping.${extraMapping.slice(0, 40)} » refusé`);
    const m = step.mapping;
    const mapping: Partial<MetaCreateAdsStep["mapping"]> = {};
    for (const key of ["adName", "primaryText", "linkUrl", "mediaUrl"] as const) {
      if (typeof m[key] !== "string" || !(m[key] as string).trim()) return no(`« mapping.${key} » manquant`);
    }
    for (const key of ["adName", "primaryText", "headline", "description", "linkUrl", "mediaUrl"] as const) {
      const v = m[key];
      if (v === undefined) continue;
      const bad = templateError(v);
      if (bad) return no(`« mapping.${key} » : ${bad}`);
      mapping[key] = v as string;
    }
    if ((m.adName as string).length > MAX_AD_NAME_CHARS) return no("« mapping.adName » trop long");
    if (m.mediaType === "video") return no("vidéo non prise en charge dans cette version : seules les images (adresse https) sont acceptées");
    if (m.mediaType !== "image") return no("« mapping.mediaType » doit valoir « image »");
    mapping.mediaType = "image";
    if (m.callToAction !== undefined) {
      if (!isCallToAction(m.callToAction)) return no(`bouton d'action inconnu (${CALL_TO_ACTIONS.join(", ")})`);
      mapping.callToAction = m.callToAction;
    }

    const out: MetaCreateAdsStep = {
      id: step.id, type: "meta.create_ads",
      campaignId: step.campaignId as string, adsetId: step.adsetId as string, pageId: step.pageId as string,
      keyColumn: (step.keyColumn as string).trim(),
      mapping: mapping as MetaCreateAdsStep["mapping"],
    };
    if (step.instagramActorId !== undefined) out.instagramActorId = step.instagramActorId as string;
    for (const key of ["label", "input"] as const) {
      const v = step[key];
      if (v === undefined) continue;
      if (typeof v !== "string" || v.length > 120) return no(`« ${key} » invalide`);
      out[key] = v;
    }

    if (step.writeBack !== undefined) {
      const back = step.writeBack;
      if (!isRecord(back)) return no("« writeBack » invalide");
      const extraBack = unknownKey(back, WRITE_BACK_KEYS);
      if (extraBack) return no(`champ « writeBack.${extraBack.slice(0, 40)} » refusé`);
      if (!isRecord(back.sheet) || unknownKey(back.sheet, SHEET_KEYS)) return no("« writeBack.sheet » invalide");
      const ref = sheetRefError(back.sheet);
      if (ref) return no(`« writeBack.sheet » : ${ref}`);
      const columns: string[] = [];
      for (const key of ["statusColumn", "adIdColumn", "errorColumn"] as const) {
        if (back[key] === undefined && key !== "statusColumn") continue;
        const bad = columnError(back[key]);
        if (bad) return no(`« writeBack.${key} » : ${bad}`);
        columns.push((back[key] as string).trim());
      }
      if (new Set(columns).size !== columns.length) return no("« writeBack » : une colonne est citée deux fois");
      if (columns.includes(out.keyColumn)) return no("« writeBack » : la colonne clé ne peut pas être réécrite");
      out.writeBack = {
        sheet: { spreadsheetId: back.sheet.spreadsheetId as string, tab: (back.sheet.tab as string).trim() },
        statusColumn: (back.statusColumn as string).trim(),
        ...(back.adIdColumn !== undefined ? { adIdColumn: (back.adIdColumn as string).trim() } : {}),
        ...(back.errorColumn !== undefined ? { errorColumn: (back.errorColumn as string).trim() } : {}),
      };
    }
    return { ok: true, step: out };
  },

  async preflight(step, routine) {
    const issues: PreflightIssue[] = [];
    const add = (severity: PreflightIssue["severity"], message: string) => issues.push({ stepId: step.id, severity, message: cleanMetaMessage(message) });
    const accountId = routine.metaAccountId;
    if (!accountId) {
      add("error", "Aucun compte Meta n'est rattaché à la routine : création de publicités impossible.");
      return issues;
    }
    // Meta said no = error; Meta could not be reached = warning, the run will check again.
    const report = (err: unknown) => add(classOfWrite(err) === "functional" ? "error" : "warning", messageOf(err));
    try {
      const campaign = await verifyCampaignInAccount(accountId, step.campaignId);
      if (campaign.status !== "ACTIVE") add("warning", `La campagne « ${campaign.name} » est au statut ${campaign.status}.`);
    } catch (err) { report(err); }
    try {
      await verifyAdsetInAccount(accountId, step.campaignId, step.adsetId);
    } catch (err) { report(err); }

    const identity = await checkAdIdentity(accountId, step.pageId, step.instagramActorId);
    if (identity.pageReadable === false) add("error", identity.notes[0] ?? `Page ${step.pageId} inaccessible.`);
    else for (const note of identity.notes) add("warning", note);

    if (step.writeBack) {
      try {
        const sheet = await readSheet(step.writeBack.sheet, { maxRows: 1 });
        const wanted = [step.keyColumn, step.writeBack.statusColumn, step.writeBack.adIdColumn, step.writeBack.errorColumn].filter((c): c is string => !!c);
        for (const c of wanted) {
          if (!sheet.columns.includes(c)) add("error", `Retour dans le Sheet : colonne « ${c} » absente de l'onglet « ${step.writeBack.sheet.tab} ».`);
        }
      } catch (err) {
        add("warning", `Retour dans le Sheet non vérifié : ${messageOf(err)}`);
      }
    }
    return issues;
  },

  async run(step, ctx) {
    const rowsIn = ctx.input?.rows.length ?? 0;
    const accountId = ctx.routine.metaAccountId;
    if (!accountId) return failure(rowsIn, "Aucun compte Meta n'est rattaché à la routine.", "functional");
    if (!ctx.input) return failure(rowsIn, "Aucune ligne en entrée : l'étape attend les lignes d'une étape précédente.", "functional");
    if (!ctx.input.columns.includes(step.keyColumn) && rowsIn > 0) {
      return failure(rowsIn, `Colonne clé « ${step.keyColumn} » absente des lignes reçues.`, "functional");
    }
    const live = ctx.write !== null && ctx.mode === "live";
    if (ctx.write !== null && ctx.mode !== "live") return failure(rowsIn, "Autorisation d'écriture reçue hors exécution réelle : étape arrêtée.", "functional");

    const warnings: string[] = [];
    const planned: PlannedWrite[] = [];
    const written: StepRunOutcome["written"] = [];
    const items = readRows(step, accountId, ctx, ctx.input.rows);
    for (const item of items) {
      if (item.state === "refusée") warnings.push(`Ligne ${item.key ? `« ${item.key} » ` : "sans clé "}refusée : ${item.error}`);
    }
    const ready = items.filter((i) => i.input);
    const done = (): StepRunOutcome => ({
      status: "ok", rowsIn, rowsOut: items.filter(dealtWith).length,
      output: { rows: outputRows(ctx.input!, items) }, planned, written, warnings,
    });
    if (ready.length === 0) return done();

    // Where the ads go: read again at every run, before the first item is reserved.
    try {
      await verifyAdsetInAccount(accountId, step.campaignId, step.adsetId);
    } catch (err) {
      return failure(rowsIn, messageOf(err), classOfWrite(err), warnings);
    }

    const ceiling = cap(ctx.routine.maxItemsPerRun);
    const timeLeft = () => ctx.deadlineAt - Date.now();
    let started = 0;
    let failed = 0;
    let stopped: { message: string; class: ErrorClass } | null = null;

    for (const item of ready) {
      const input = item.input!;
      if (stopped) break;
      if (started >= ceiling) {
        warnings.push(`Plafond de ${ceiling} publicités par exécution atteint : les lignes restantes attendent l'exécution suivante.`);
        break;
      }
      if (timeLeft() < ITEM_BUDGET_MS) {
        warnings.push("Temps de l'exécution presque écoulé : les lignes restantes attendent l'exécution suivante.");
        break;
      }

      if (!live) {
        // Same question as a live run, answered by the engine without reserving anything.
        let seen: Awaited<ReturnType<StepContext["claimItem"]>>;
        try {
          seen = await ctx.claimItem(step.id, item.key, input.name);
        } catch (err) {
          stopped = { message: `État de « ${item.key} » illisible en base : ${messageOf(err)}`, class: "infra" };
          break;
        }
        if (seen === "already_done") {
          if (!wasDeferred(ctx.runId, item.key)) item.state = "déjà traitée";
          continue;
        }
        if (seen === "uncertain") {
          item.state = "à vérifier";
          item.earlier = true;
          item.error = UNCERTAIN;
          warnings.push(`Ligne « ${item.key} » : ${item.error}.`);
          continue;
        }
        started++;
        let existing: Awaited<ReturnType<typeof findAdByName>> = null;
        try {
          existing = await findAdByName(step.adsetId, input.name);
        } catch (err) {
          warnings.push(`Ligne « ${item.key} » : présence d'une publicité du même nom non vérifiée (${messageOf(err)}).`);
        }
        if (existing) {
          item.state = "déjà présente";
          item.adId = existing.id;
          warnings.push(`Ligne « ${item.key} » : une publicité nommée « ${input.name} » existe déjà (${existing.id}), elle ne serait pas recréée.`);
          continue;
        }
        item.state = "prévue";
        planned.push({ target: "meta", summary: `Créer en pause la publicité « ${input.name} »`, itemKey: item.key, preview: previewOf(input, item.key) });
        continue;
      }

      let claim: Awaited<ReturnType<StepContext["claimItem"]>>;
      try {
        claim = await ctx.claimItem(step.id, item.key, input.name);
      } catch (err) {
        stopped = { message: `Réservation impossible pour « ${item.key} » : ${messageOf(err)}`, class: "infra" };
        break;
      }
      // Put off by the engine (ceiling, time): the row waits, it is not done.
      if (claim === "already_done") { if (!wasDeferred(ctx.runId, item.key)) item.state = "déjà traitée"; continue; }
      if (claim === "uncertain") {
        item.state = "à vérifier";
        item.earlier = true;
        item.error = UNCERTAIN;
        warnings.push(`Ligne « ${item.key} » : ${item.error}.`);
        continue;
      }
      started++;

      const settle = async (r: Parameters<StepContext["settleItem"]>[2]) => {
        try {
          await ctx.settleItem(step.id, item.key, r);
        } catch (err) {
          stopped = { message: `Résultat de « ${item.key} » non enregistré : ${messageOf(err)}`, class: "infra" };
        }
      };

      try {
        const existing = await findAdByName(step.adsetId, input.name);
        if (existing) {
          item.state = "déjà présente";
          item.adId = existing.id;
          warnings.push(`Ligne « ${item.key} » : une publicité nommée « ${input.name} » existait déjà (${existing.id}, statut ${existing.status}) ; rattachée, rien n'a été créé.`);
          await settle({ status: "created", externalId: existing.id });
          written.push({ itemKey: item.key, externalId: existing.id, summary: `Publicité « ${input.name} » déjà présente, rattachée` });
          continue;
        }
        const ad = await createPausedAd(ctx.write!, input);
        item.state = "créée";
        item.adId = ad.adId;
        await settle({ status: "created", externalId: ad.adId });
        written.push({ itemKey: item.key, externalId: ad.adId, summary: `Publicité « ${input.name} » créée en pause` });
      } catch (err) {
        const message = messageOf(err);
        item.error = message;
        if (isMetaWriteError(err) && err.kind === "uncertain") {
          // Not settled on purpose: the reservation stays and becomes `uncertain`.
          item.state = "à vérifier";
          stopped = { message: `Ligne « ${item.key} » : ${message}`, class: "infra" };
          break;
        }
        item.state = "échec";
        failed++;
        const adId = isMetaWriteError(err) ? err.adId : undefined;
        if (adId) item.adId = adId;
        await settle({ status: "failed", ...(adId ? { externalId: adId } : {}), error: message });
        warnings.push(`Ligne « ${item.key} » : ${message}`);
        // Quota or token: the next rows would fail the same way.
        if (classOfWrite(err) === "infra" && !(isMetaWriteError(err) && err.kind === "not_paused")) {
          stopped = { message: `Ligne « ${item.key} » : ${message}`, class: "infra" };
        }
      }
    }

    if (step.writeBack) {
      if (timeLeft() < WRITE_BACK_BUDGET_MS) warnings.push("Retour dans le Sheet abandonné : temps de l'exécution écoulé.");
      else {
        try {
          const updates = await writeBackUpdates(step, items, warnings);
          if (updates.length && live) await updateCells(ctx.write!, step.writeBack.sheet, updates);
          else if (updates.length) {
            planned.push({
              target: "sheet",
              summary: `Écrire le statut de ${new Set(updates.map((u) => u.row)).size} ligne(s) dans l'onglet « ${step.writeBack.sheet.tab} »`,
              preview: { cellules: updates.length, colonne_statut: step.writeBack.statusColumn },
            });
          }
        } catch (err) {
          warnings.push(`Retour dans le Sheet non effectué : ${messageOf(err)}`);
        }
      }
    }

    const outcome = done();
    if (stopped || failed > 0) {
      const stop: { message: string; class: ErrorClass } | null = stopped;
      outcome.status = "failed";
      outcome.error = stop
        ? { class: stop.class, message: cleanMetaMessage(`Étape arrêtée, aucune autre création tentée. ${stop.message}`) }
        : { class: "functional", message: `${failed} publicité(s) en échec sur ${started} tentée(s) ; ${written.length} créée(s) ou rattachée(s).` };
    }
    return outcome;
  },
};
