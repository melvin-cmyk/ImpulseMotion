/**
 * Routines — step meta.create_ads: one ad per input row, always PAUSED, in the
 * ad set named by the definition. The only step that writes on a platform.
 *
 * Rules (plan, section 2 B):
 *   - the account is the routine's (ctx.routine.metaAccountId); the campaign,
 *     ad set and Page ids are literals of the definition, never templates: a
 *     cell can change a text, a link or an image, never where the ad goes;
 *   - the name of an ad depends on its row only: {{run.date}} and
 *     {{steps.<id>.text}} are refused in `adName`, so the name by which an ad
 *     is looked for does not change from one run to the next;
 *   - the ad set is re-read and compared with the account and the campaign
 *     before anything is sent, here once and again by createPausedAd;
 *   - the Page is one the account of the routine can promote, and the one
 *     chosen when the routine was created if one was: read again before the
 *     first creation of every run, a blocking error otherwise. Same rule for
 *     the Instagram account when the token can list those of the account;
 *     when it cannot, a warning, said in the preview of the dry run;
 *   - an item is known in the database under a key that names the ad set and
 *     the row (itemKeyOf), not the step: a step renamed by the AI keeps its
 *     rows done. The same row sent to another ad set is another item; the
 *     dry run then says that the rows will be created again;
 *   - dry run (ctx.write null): reads only, `planned` lists the ads that would
 *     really be created. ctx.claimItem is asked for each row: in a dry run the
 *     engine answers from the database without reserving anything, so a row
 *     already created, or whose outcome is unknown, is not announced again;
 *   - live: claimItem before Meta, settleItem after. Only `claimed` creates;
 *   - an ad that exists is looked for by the id kept in the database first,
 *     by its name after. An item that carries an ad id is NEVER played again
 *     as a creation: that ad is read by its id. Paused, the item is closed as
 *     created; otherwise the row is « à vérifier » and nothing is created.
 *     An item whose outcome is unknown and that carries no id is looked for by
 *     its name: found paused it is attached, found otherwise or not found it
 *     stays to be checked. It is never created again by the routine;
 *   - an ad of the same name already in the ad set is attached only when it
 *     is PAUSED. At any other status the row is « à vérifier », with the
 *     status read: nothing is created, nothing is modified, and the Sheet
 *     never says « en pause » of an ad that is not;
 *   - a creation whose outcome is unknown (timeout, network) is NOT settled: the
 *     item stays reserved and the engine turns it `uncertain`. The step stops
 *     there, nothing is sent again;
 *   - a row refused by Meta fails alone: the other rows are dealt with. It is
 *     tried again by the next runs, MAX_ITEM_ATTEMPTS attempts in all, then
 *     given up (« abandonnée après 3 tentatives », with its last error);
 *   - ceiling (maxItemsPerRun) and deadline: the rows left wait for the next
 *     run, are counted (`counts.deferred`) and the outcome says when time ran
 *     out (`timedOut`);
 *   - before every write the step looks at ctx.signal: given up by the
 *     engine, it writes nothing more;
 *   - the rows that come out are those this run dealt with, each with its
 *     outcome (meta_statut, meta_ad_id, meta_erreur);
 *   - the status written back in the Sheet is a reflection: its failure is a
 *     warning, never a failure of the step. It is put right at every run: a
 *     row the database knows (created, to be checked, given up) whose cells
 *     are empty or say otherwise is written again, and nothing is created.
 *
 * STATUSES written in the status column, a closed list (the prompt of the AI
 * that writes the routines documents it, SHEET_STATUSES):
 *   créée (en pause) · déjà présente (en pause) · créée · échec ·
 *   abandonnée après 3 tentatives · refusée · à vérifier · à vérifier : <quoi>
 *
 * A row the step refuses (empty or duplicate key, link that is not public
 * https…) is a warning and creates nothing. First version: image only (see
 * lib/meta-write.ts).
 */

import {
  CALL_TO_ACTIONS, MAX_AD_NAME_CHARS, checkInstagramActor, cleanMetaMessage, createPausedAd, findAdByName, isCallToAction,
  isMetaId, isMetaWriteError, pausedAdInputError, readAdById, verifyAdsetInAccount, verifyCampaignInAccount, verifyPagePromotable,
  type PausedAdInput,
} from "@/lib/meta-write";
import { readSheet, sheetRefError, updateCells, type CellUpdate } from "@/lib/relay-sheets";
import { adsetChangeNotice } from "@/lib/routines/notices";
import { renderTemplateDetailed, rowOnlyTemplateError, scopeFromContext, templateError } from "@/lib/routines/template";
import { assertCanWrite } from "@/lib/routines/write-guard-check";
import {
  MAX_ITEMS_PER_RUN_CAP, MAX_ITEM_ATTEMPTS, META_SHEET_STATUSES, itemKeyOf,
  type Cell, type ErrorClass, type ItemClaim, type MetaCreateAdsStep, type PlannedWrite, type PreflightIssue, type Row, type RowSet,
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
/** Rows left after the ceiling or the deadline that are looked up in the database to be counted right. */
const MAX_PEEKED_ROWS = 200;

/** What the status column of the Sheet may hold once the step has written it. The variable part follows « à vérifier : ». */
export const SHEET_STATUSES = META_SHEET_STATUSES;

/** The Page of the step is not the one the routine was created with. */
export function chosenPageError(step: Pick<MetaCreateAdsStep, "pageId">, chosenPageId: string | null | undefined): string | null {
  if (!chosenPageId || step.pageId === chosenPageId) return null;
  return `La Page Facebook choisie à la création de la routine est ${chosenPageId} : les publicités sont publiées sous cette Page, pas sous ${step.pageId}. Reprenez « pageId » : "${chosenPageId}".`;
}

/** `abandonnée` = failed MAX_ITEM_ATTEMPTS times, given up. `déjà présente` = found PAUSED and attached. */
type ItemState = "créée" | "déjà présente" | "déjà traitée" | "à vérifier" | "échec" | "abandonnée" | "refusée" | "en attente" | "prévue";

interface Item {
  row: Row;
  /** Value of the key column: what the consultant reads, and what finds the row in the Sheet. */
  key: string;
  state: ItemState;
  adId?: string;
  error?: string;
  /** What is to be checked, said in the status itself (« à vérifier : … »). */
  note?: string;
  input?: PausedAdInput;
  /** The state was found in the database, left there by an earlier run. */
  earlier?: boolean;
}

export const ABANDONED_STATUS = `abandonnée après ${MAX_ITEM_ATTEMPTS} tentatives`;

/** Status of a row as the Sheet and the history show it. « en pause » is said of an ad that was read PAUSED, and of no other. */
function statusText(item: Item, forSheet: boolean): string {
  if (item.state === "abandonnée") return ABANDONED_STATUS;
  // Created by an earlier run: the database says so, nobody has read the ad again. « en pause » is not said.
  if (item.state === "déjà traitée") return "créée";
  if (item.state === "à vérifier") return item.note ? `à vérifier : ${item.note}` : "à vérifier";
  if (forSheet && (item.state === "créée" || item.state === "déjà présente")) return `${item.state} (en pause)`;
  return item.state;
}

/** Key of a row in RoutineItem: the ad set, then the value of the key column. Not the step: see itemKeyOf. */
export function metaItemKey(step: Pick<MetaCreateAdsStep, "adsetId">, rowKey: string): string {
  return itemKeyOf(step.adsetId, rowKey);
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
    rows: items.map((i) => ({ ...i.row, [OUT_STATUS]: statusText(i, false), [OUT_AD_ID]: i.adId ?? null, [OUT_ERROR]: i.error ?? null })),
    truncated: input.truncated,
  };
}

// ── Status written back in the Sheet ─────────────────────────────────────────

const REPORTED: ItemState[] = ["créée", "déjà présente", "déjà traitée", "à vérifier", "échec", "abandonnée", "refusée", "prévue"];

const cellText = (value: Cell | undefined): string => (value === null || value === undefined ? "" : String(value).trim());

/** What the status cell may already say of a row created by an earlier run without being put right. */
const saysCreated = (cell: string) => cell.startsWith("créée") || cell.startsWith("déjà présente");

/**
 * Cells to rewrite, found by key in the sheet as it is now. Read only.
 *
 * Only the cells that are empty or say something else than what is known are
 * written: a status that could not be written on the day of the creation is
 * written by the next run, and a Sheet that is right is left alone.
 */
async function writeBackUpdates(step: MetaCreateAdsStep, items: Item[], warnings: string[]): Promise<CellUpdate[]> {
  const back = step.writeBack;
  // A row done by an earlier run is reported when the database knows its ad: there is something to put right.
  const reported = items.filter((i) => i.key && REPORTED.includes(i.state) && (i.state !== "déjà traitée" || !!i.adId));
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
  const cellsOf = new Map<number, Row>();
  sheet.rows.forEach((row, i) => {
    const key = String(row[step.keyColumn] ?? "").trim();
    const n = sheet.rowNumbers[i];
    if (key && Number.isInteger(n)) { rowsOf.set(key, [...(rowsOf.get(key) ?? []), n]); cellsOf.set(n, row); }
  });
  const updates: CellUpdate[] = [];
  let lost = 0;
  let repaired = 0;
  for (const item of reported) {
    const found = rowsOf.get(item.key) ?? [];
    // A key on several rows is one of the refusals reported: every such row gets the message.
    if (found.length === 0 || (found.length > 1 && item.state !== "refusée")) { lost++; continue; }
    const earlier = item.state === "déjà traitée";
    for (const row of found) {
      const now = cellsOf.get(row) ?? {};
      const wanted: Array<{ column: string; value: string }> = [{ column: back.statusColumn, value: statusText(item, true) }];
      if (back.adIdColumn && item.adId) wanted.push({ column: back.adIdColumn, value: item.adId });
      if (back.errorColumn) wanted.push({ column: back.errorColumn, value: item.error ?? "" });
      const differing = wanted.filter((w) => {
        const cell = cellText(now[w.column]);
        // « créée (en pause) », written on the day it was read paused, is not replaced by the plain « créée ».
        if (earlier && w.column === back.statusColumn) return !saysCreated(cell);
        return cell !== w.value.trim();
      });
      if (differing.length && earlier) repaired++;
      for (const w of differing) updates.push({ row, column: w.column, value: w.value });
    }
  }
  if (lost) warnings.push(`Retour dans le Sheet : ${lost} ligne(s) introuvable(s) par leur clé, non mises à jour.`);
  if (repaired) warnings.push(`Retour dans le Sheet : ${repaired} ligne(s) déjà créée(s) par une exécution précédente, dont le statut ou l'identifiant manquait, remise(s) à jour. Rien n'a été créé.`);
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
    const moving = rowOnlyTemplateError(m.adName as string);
    if (moving) return no(`« mapping.adName » : ${moving}`);
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

    // The Page: the one chosen when the routine was created, and one the account can promote. Both block.
    const chosen = chosenPageError(step, routine.pageId);
    if (chosen) add("error", chosen);
    try {
      await verifyPagePromotable(accountId, step.pageId);
    } catch (err) { report(err); }
    if (step.instagramActorId) {
      const instagram = await checkInstagramActor(accountId, step.instagramActorId);
      if (instagram.allowed === false) add("error", instagram.note ?? "Compte Instagram refusé.");
      else if (instagram.note) add("warning", instagram.note);
    }

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
    // The account is the routine's, and nothing else: neither the step nor a row can name another.
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
    const counts = { adsCreated: 0, adsAttached: 0, sheetRows: 0, messages: 0, skipped: 0, failed: 0, deferred: 0 };
    let outOfTime = false;
    const items = readRows(step, accountId, ctx, ctx.input.rows);
    for (const item of items) {
      if (item.state === "refusée") {
        counts.skipped++;
        warnings.push(`Ligne ${item.key ? `« ${item.key} » ` : "sans clé "}refusée : ${item.error}`);
      }
    }
    const ready = items.filter((i) => i.input);
    const said: string[] = [];
    const done = (): StepRunOutcome => ({
      status: "ok", rowsIn, rowsOut: items.filter(dealtWith).length,
      output: { rows: outputRows(ctx.input!, items) }, planned, written, warnings, counts,
      ...(outOfTime ? { timedOut: true } : {}),
      ...(said.length ? { notices: said } : {}),
    });
    if (ready.length === 0) return done();

    // Where the ads go, and under whose name: read again at every run, before the first item is reserved.
    const chosen = chosenPageError(step, ctx.routine.pageId);
    if (chosen) return failure(rowsIn, chosen, "functional", warnings);
    const notices: string[] = [];
    let instagramNote: string | null = null;
    try {
      await verifyAdsetInAccount(accountId, step.campaignId, step.adsetId);
      await verifyPagePromotable(accountId, step.pageId);
      if (step.instagramActorId) {
        const instagram = await checkInstagramActor(accountId, step.instagramActorId);
        if (instagram.allowed === false) return failure(rowsIn, instagram.note ?? "Compte Instagram refusé.", "functional", warnings);
        if (instagram.note) {
          instagramNote = instagram.note;
          warnings.push(instagram.note);
          if (!live) notices.push(instagram.note);
        }
      }
    } catch (err) {
      return failure(rowsIn, messageOf(err), classOfWrite(err), warnings);
    }

    const ceiling = cap(ctx.routine.maxItemsPerRun);
    const timeLeft = () => ctx.deadlineAt - Date.now();
    const given = () => ctx.signal?.aborted === true;
    let started = 0;
    let stopped: { message: string; class: ErrorClass } | null = null;
    /** Index of the first row that was not dealt with: the rows from there on wait for the next run. */
    let at = 0;

    /** What the database already says of a row: nothing is created for it. */
    const known = async (item: Item, claim: ItemClaim): Promise<void> => {
      if (claim.state === "already_done") {
        item.state = "déjà traitée";
        item.earlier = true;
        if (claim.externalId) item.adId = claim.externalId;
        counts.skipped++;
        return;
      }
      if (claim.state === "abandoned") {
        item.state = "abandonnée";
        item.earlier = true;
        item.error = claim.error ?? "erreur non conservée";
        counts.skipped++;
        warnings.push(`Ligne « ${item.key} » ${ABANDONED_STATUS} : ${item.error}`);
        return;
      }
      // uncertain. Nothing is created, whatever is found.
      item.state = "à vérifier";
      item.earlier = true;
      const adId = claim.externalId;
      if (!adId) {
        // No id was kept (the platform answered too late, or never): the ad is looked for by its name in the ad set.
        let found: Awaited<ReturnType<typeof findAdByName>> = null;
        let unread: string | null = null;
        try { found = await findAdByName(step.adsetId, item.input!.name); } catch (err) { unread = messageOf(err); }
        if (found && found.status === "PAUSED") {
          item.state = "déjà présente";
          item.earlier = false;
          item.adId = found.id;
          counts.adsAttached++;
          warnings.push(`Ligne « ${item.key} » : le résultat d'une exécution précédente était inconnu ; la publicité « ${item.input!.name} » a été retrouvée par son nom (${found.id}), en pause${live ? " : rattachée, la ligne est close" : ""}. Rien n'a été créé.`);
          if (live) {
            try { await ctx.confirmItem?.(step.id, metaItemKey(step, item.key), found.id); } catch (err) {
              warnings.push(`Ligne « ${item.key} » : état non enregistré (${messageOf(err)}).`);
            }
            written.push({ itemKey: item.key, externalId: found.id, target: "meta", attached: true, summary: `Publicité « ${item.input!.name} » retrouvée par son nom : en pause, rattachée` });
          }
          return;
        }
        if (found) {
          item.note = `une publicité du même nom existe au statut ${found.status}`;
          item.error = `${item.note} (${found.id}) : aucune autre n'est créée, rien n'est modifié`;
        } else {
          item.error = unread ? `${UNCERTAIN} (recherche par nom impossible : ${unread})` : `${UNCERTAIN} ; aucune publicité de ce nom n'a été trouvée dans l'ensemble`;
        }
        counts.skipped++;
        warnings.push(`Ligne « ${item.key} » : ${item.error}.`);
        return;
      }
      item.adId = adId;
      let ad: Awaited<ReturnType<typeof readAdById>>;
      try {
        ad = await readAdById(adId);
      } catch (err) {
        item.note = `la publicité ${adId} n'a pas pu être relue`;
        item.error = `${item.note} (${messageOf(err)}) : aucune autre n'est créée`;
        counts.skipped++;
        warnings.push(`Ligne « ${item.key} » : ${item.error}.`);
        return;
      }
      if (ad && ad.adsetId === step.adsetId && ad.status === "PAUSED") {
        item.state = "déjà présente";
        item.earlier = false;
        item.error = undefined;
        counts.adsAttached++;
        warnings.push(`Ligne « ${item.key} » : la publicité ${adId}, créée par une exécution précédente, a été relue par son identifiant : elle est en pause${live ? ", la ligne est close" : ""}. Rien n'a été créé.`);
        if (live) {
          try { await ctx.confirmItem?.(step.id, metaItemKey(step, item.key), adId); } catch (err) {
            warnings.push(`Ligne « ${item.key} » : état non enregistré (${messageOf(err)}).`);
          }
          written.push({ itemKey: item.key, externalId: adId, target: "meta", attached: true, summary: `Publicité ${adId} relue par son identifiant : en pause, rattachée` });
        }
        return;
      }
      item.note = !ad
        ? `la publicité ${adId} créée pour cette ligne est introuvable dans Meta`
        : ad.adsetId !== step.adsetId
          ? `la publicité ${adId} n'est pas dans l'ensemble ${step.adsetId}`
          : `la publicité ${adId} existe au statut ${ad.status}`;
      item.error = `${item.note} : aucune autre n'est créée, rien n'est modifié`;
      counts.skipped++;
      warnings.push(`Ligne « ${item.key} » : ${item.error}.`);
    };

    for (; at < ready.length; at++) {
      const item = ready[at];
      const input = item.input!;
      if (stopped) break;
      if (given()) {
        outOfTime = true;
        warnings.push("Exécution arrêtée par le moteur : les lignes restantes attendent l'exécution suivante.");
        break;
      }
      if (started >= ceiling) {
        warnings.push(`Plafond de ${ceiling} publicités par exécution atteint : les lignes restantes attendent l'exécution suivante.`);
        break;
      }
      if (timeLeft() < ITEM_BUDGET_MS) {
        outOfTime = true;
        warnings.push("Temps de l'exécution presque écoulé : les lignes restantes attendent l'exécution suivante.");
        break;
      }

      let claim: ItemClaim;
      try {
        claim = await ctx.claimItem(step.id, metaItemKey(step, item.key), input.name);
      } catch (err) {
        stopped = { message: `${live ? "Réservation impossible pour" : "État illisible en base de"} « ${item.key} » : ${messageOf(err)}`, class: "infra" };
        break;
      }
      // Put off by the engine (ceiling, time): the row waits, it is not done.
      if (claim.state === "deferred") { counts.deferred++; continue; }
      if (claim.state !== "claimed") { await known(item, claim); continue; }
      started++;

      if (!live) {
        let existing: Awaited<ReturnType<typeof findAdByName>> = null;
        try {
          existing = await findAdByName(step.adsetId, input.name);
        } catch (err) {
          warnings.push(`Ligne « ${item.key} » : présence d'une publicité du même nom non vérifiée (${messageOf(err)}).`);
        }
        if (existing && existing.status === "PAUSED") {
          item.state = "déjà présente";
          item.adId = existing.id;
          counts.adsAttached++;
          warnings.push(`Ligne « ${item.key} » : une publicité nommée « ${input.name} » existe déjà (${existing.id}), en pause ; elle serait rattachée, pas recréée.`);
          continue;
        }
        if (existing) {
          // Said by the dry run, which does not fail for it: the definition is sound, a row is to be looked at.
          item.state = "à vérifier";
          item.note = `une publicité du même nom existe au statut ${existing.status}`;
          item.error = `${item.note} (${existing.id}) : rien ne serait créé ni modifié`;
          counts.skipped++;
          warnings.push(`Ligne « ${item.key} » : ${item.error}.`);
          continue;
        }
        item.state = "prévue";
        counts.adsCreated++;
        planned.push({
          target: "meta", summary: `Créer en pause la publicité « ${input.name} »`, itemKey: item.key,
          preview: { ...previewOf(input, item.key), ...(step.instagramActorId ? { instagram: instagramNote ? `${step.instagramActorId} — non vérifié` : step.instagramActorId } : {}) },
        });
        continue;
      }

      const settle = async (r: Parameters<StepContext["settleItem"]>[2]) => {
        try {
          await ctx.settleItem(step.id, metaItemKey(step, item.key), r);
        } catch (err) {
          stopped = { message: `Résultat de « ${item.key} » non enregistré : ${messageOf(err)}`, class: "infra" };
        }
      };
      /** A failure of this row alone. At the last attempt the row is given up, and says so at once. */
      const failed = async (message: string, adId?: string) => {
        item.error = message;
        counts.failed++;
        if (adId) item.adId = adId;
        else if ((claim.attempts ?? 1) >= MAX_ITEM_ATTEMPTS) item.state = "abandonnée";
        await settle({ status: "failed", ...(adId ? { externalId: adId } : {}), error: message });
        warnings.push(item.state === "abandonnée" ? `Ligne « ${item.key} » ${ABANDONED_STATUS} : ${message}` : `Ligne « ${item.key} » : ${message}`);
      };

      try {
        const existing = await findAdByName(step.adsetId, input.name);
        if (existing && existing.status === "PAUSED") {
          item.state = "déjà présente";
          item.adId = existing.id;
          warnings.push(`Ligne « ${item.key} » : une publicité nommée « ${input.name} » existait déjà (${existing.id}), en pause ; rattachée, rien n'a été créé.`);
          await settle({ status: "created", externalId: existing.id });
          counts.adsAttached++;
          written.push({ itemKey: item.key, externalId: existing.id, target: "meta", attached: true, summary: `Publicité « ${input.name} » déjà présente (en pause), rattachée` });
          continue;
        }
        if (existing) {
          // Not paused: it is not attached as one of ours, and nothing is created beside it.
          item.state = "à vérifier";
          item.note = `une publicité du même nom existe au statut ${existing.status}`;
          await failed(`${item.note} (${existing.id}) : rien n'a été créé ni modifié`);
          continue;
        }
        // Last look before the write: given up by the engine, the step sends nothing.
        assertCanWrite(ctx);
        const ad = await createPausedAd(ctx.write!, input);
        item.state = "créée";
        item.adId = ad.adId;
        await settle({ status: "created", externalId: ad.adId });
        counts.adsCreated++;
        written.push({ itemKey: item.key, externalId: ad.adId, target: "meta", summary: `Publicité « ${input.name} » créée en pause` });
      } catch (err) {
        const message = messageOf(err);
        if (given() && !isMetaWriteError(err)) {
          // Nothing was sent for this row: it is tried again by the next run.
          outOfTime = true;
          item.state = "en attente";
          await settle({ status: "failed", error: "Exécution arrêtée avant la création : rien n'a été envoyé." });
          warnings.push("Exécution arrêtée par le moteur : les lignes restantes attendent l'exécution suivante.");
          break;
        }
        if (isMetaWriteError(err) && err.kind === "uncertain") {
          // Not settled on purpose: the reservation stays and becomes `uncertain`.
          item.error = message;
          item.state = "à vérifier";
          counts.failed++;
          stopped = { message: `Ligne « ${item.key} » : ${message}`, class: "infra" };
          at++;
          break;
        }
        const adId = isMetaWriteError(err) ? err.adId : undefined;
        if (adId) {
          // The ad exists. The item keeps its id: it will be read again, never created again.
          item.state = "à vérifier";
          item.note = `la publicité ${adId} a été créée mais n'est pas confirmée en pause`;
        } else {
          item.state = "échec";
        }
        await failed(message, adId);
        // Quota or token: the next rows would fail the same way.
        if (classOfWrite(err) === "infra" && !(isMetaWriteError(err) && err.kind === "not_paused")) {
          stopped = { message: `Ligne « ${item.key} » : ${message}`, class: "infra" };
        }
      }
    }

    // The same rows, done in another ad set: the change of ad set creates them again, and says so.
    const again = items.filter((i) => i.state === "prévue" || i.state === "créée");
    if (again.length && ctx.listItems) {
      try {
        const elsewhere = new Set<string>();
        const suffix = new Map(again.map((i) => [i.key, true]));
        for (const known of await ctx.listItems()) {
          const at = known.itemKey.indexOf(":");
          if (at <= 0 || known.itemKey.slice(0, at) === step.adsetId) continue;
          const rowKey = known.itemKey.slice(at + 1);
          if (suffix.has(rowKey) && (known.status === "created" || !!known.externalId)) elsewhere.add(rowKey);
        }
        const notice = adsetChangeNotice(elsewhere.size, live);
        if (notice) { warnings.push(notice); said.push(notice); }
      } catch { /* a notice, not a control: the run goes on */ }
    }
    said.push(...notices);

    // Rows that were not looked at: those the database already answers for are not waiting.
    const rest = ready.slice(at);
    if (rest.length) {
      let waiting = rest.length;
      if (ctx.peekItem && !stopped) {
        waiting = Math.max(0, rest.length - MAX_PEEKED_ROWS);
        for (const item of rest.slice(0, MAX_PEEKED_ROWS)) {
          let seen: ItemClaim;
          try { seen = await ctx.peekItem(step.id, metaItemKey(step, item.key)); } catch { seen = { state: "claimed" }; }
          if (seen.state === "already_done") { item.state = "déjà traitée"; item.earlier = true; if (seen.externalId) item.adId = seen.externalId; counts.skipped++; }
          else if (seen.state === "abandoned") { item.state = "abandonnée"; item.earlier = true; item.error = seen.error ?? "erreur non conservée"; counts.skipped++; }
          else if (seen.state === "uncertain") counts.skipped++;
          else waiting++;
        }
      }
      counts.deferred += waiting;
    }

    if (step.writeBack) {
      if (given()) warnings.push("Retour dans le Sheet abandonné : l'exécution a été arrêtée.");
      else if (timeLeft() < WRITE_BACK_BUDGET_MS) warnings.push("Retour dans le Sheet abandonné : temps de l'exécution écoulé.");
      else {
        try {
          const updates = await writeBackUpdates(step, items, warnings);
          const rows = new Set(updates.map((u) => u.row)).size;
          if (updates.length && live) {
            assertCanWrite(ctx);
            await updateCells(ctx.write!, step.writeBack.sheet, updates);
            counts.sheetRows += rows;
          } else if (updates.length) {
            counts.sheetRows += rows;
            planned.push({
              target: "sheet",
              summary: `Écrire le statut de ${rows} ligne(s) dans l'onglet « ${step.writeBack.sheet.tab} »`,
              preview: { cellules: updates.length, colonne_statut: step.writeBack.statusColumn },
            });
          }
        } catch (err) {
          warnings.push(`Retour dans le Sheet non effectué : ${messageOf(err)}`);
        }
      }
    }

    const outcome = done();
    if (stopped || counts.failed > 0) {
      const stop: { message: string; class: ErrorClass } | null = stopped;
      outcome.status = "failed";
      outcome.error = stop
        ? { class: stop.class, scope: "step", message: cleanMetaMessage(`Étape arrêtée, aucune autre création tentée. ${stop.message}`) }
        // The step did its work; rows failed, each bounded by its own attempts.
        : { class: "functional", scope: "items", message: `${counts.failed} publicité(s) en échec ou à vérifier sur ${started} tentée(s) ; ${counts.adsCreated + counts.adsAttached} créée(s) ou rattachée(s).` };
    }
    return outcome;
  },
};
