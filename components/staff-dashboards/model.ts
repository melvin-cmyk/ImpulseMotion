/**
 * « Mes dashboards » — côté navigateur : formes des réponses de l'API et petits helpers.
 * Les types du modèle viennent de lib/staff-dashboards/model (types seulement : ce fichier reste sans Node).
 */

import type { Dataset, ParamValue } from "@/lib/staff-dashboards/model";
import type { StaffSource } from "@/lib/staff-dashboards/sources";

export type { Dataset, ParamValue, StaffSource };

export interface DashboardListItem {
  id: string;
  title: string;
  description: string | null;
  shared: boolean;
  mine: boolean;
  ownerEmail: string;
  ownerName: string | null;
  datasetCount: number;
  updatedAt: string;
}

export interface TemplateInfo { key: string; title: string; description: string }

export interface DashboardDetail {
  id: string;
  title: string;
  description: string | null;
  datasets: Record<string, Dataset>;
  params: Record<string, ParamValue>;
  html: string;
  shared: boolean;
  /** Sources cochées par le consultant (plateformes + comptes), données au copilote. */
  sources: StaffSource[];
  /** Dossier Drive « Dashboards » du client déduit des sources (null → dossier partagé général). */
  driveFolderUrl?: string | null;
  driveClientName?: string | null;
  mine: boolean;
  canEdit: boolean;
  ownerEmail: string;
  ownerName: string | null;
  updatedAt: string;
}

/** Une source telle que le runtime du cadre la décrit (message dash:sources). */
export interface FrameSource {
  id: string;
  kind: "source" | "calc";
  status: "ok" | "loading" | "error" | "declined" | string;
  message: string | null;
  title: string | null;
  description: string | null;
  rows: number | null;
  at: string | null;
}

/** Réponse de POST /api/staff-dashboards/[id]/data. */
export interface DataResponse {
  results: Record<string, { status: string; answer?: unknown; args?: unknown; at?: string; message?: string; cached?: boolean }>;
  params: Record<string, ParamValue>;
}

export function ownerLabel(d: { ownerName: string | null; ownerEmail: string }): string {
  return d.ownerName?.trim() || d.ownerEmail;
}

export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

/** Message d'erreur lisible d'une réponse { error, errors[] } de l'API. */
export function apiErrorText(body: unknown, status: number): string {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; errors?: unknown };
  const errors = Array.isArray(b.errors) ? b.errors.filter((x): x is string => typeof x === "string") : [];
  if (errors.length > 1) return errors.join(" · ");
  if (typeof b.error === "string" && b.error) return b.error;
  return `Erreur ${status}`;
}

/** JSON.parse avec un message d'erreur en français ; `{}` pour une zone vide. */
export function parseJsonField(label: string, text: string): { value: unknown; error: null } | { value: null; error: string } {
  const t = text.trim();
  if (!t) return { value: {}, error: null };
  try {
    const value: unknown = JSON.parse(t);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { value: null, error: `${label} : un objet JSON { … } est attendu` };
    return { value, error: null };
  } catch (e) {
    return { value: null, error: `${label} : JSON illisible (${e instanceof Error ? e.message : String(e)})` };
  }
}

export const FIELD = "w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500 disabled:opacity-60";
export const MONO_FIELD = `${FIELD} font-mono text-xs leading-relaxed`;
export const PRIMARY_BUTTON = "inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed";
export const SECONDARY_BUTTON = "inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm font-semibold border border-gray-700";
export const SMALL_BUTTON = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed";
