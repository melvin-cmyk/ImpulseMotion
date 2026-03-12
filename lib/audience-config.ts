/**
 * Audience tagging system — localStorage helpers
 * Stores audience labels keyed by creative ID.
 */

export const AUDIENCE_STORAGE_KEY = "impulsemotion_audience_tags";

export type AudienceTags = Record<string, string>; // creativeId → audience label

export function getAudienceTags(): AudienceTags {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(AUDIENCE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function setAudienceTag(creativeId: string, audience: string): void {
  if (typeof window === "undefined") return;
  const tags = getAudienceTags();
  tags[creativeId] = audience.trim();
  localStorage.setItem(AUDIENCE_STORAGE_KEY, JSON.stringify(tags));
}

export function removeAudienceTag(creativeId: string): void {
  if (typeof window === "undefined") return;
  const tags = getAudienceTags();
  delete tags[creativeId];
  localStorage.setItem(AUDIENCE_STORAGE_KEY, JSON.stringify(tags));
}
