"use client";

/**
 * React binding for manual audience tags (localStorage-backed, see
 * lib/audience-config.ts). useSyncExternalStore avoids setState-in-effect and
 * keeps every consumer in sync after a save.
 */

import { useSyncExternalStore } from "react";
import {
  AUDIENCE_STORAGE_KEY,
  getAudienceTags,
  setAudienceTag,
  removeAudienceTag,
  type AudienceTags,
} from "./audience-config";

const EMPTY: AudienceTags = {};
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedTags: AudienceTags = EMPTY;

function readRaw(): string | null {
  try {
    return localStorage.getItem(AUDIENCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getSnapshot(): AudienceTags {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedTags = getAudienceTags();
  }
  return cachedTags;
}

function getServerSnapshot(): AudienceTags {
  return EMPTY;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === AUDIENCE_STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

/** Replace the whole tag map (empty values remove the tag) and notify consumers. */
export function replaceAudienceTags(next: AudienceTags): void {
  const previous = getAudienceTags();
  for (const id of Object.keys(previous)) {
    if (!next[id]?.trim()) removeAudienceTag(id);
  }
  for (const [id, value] of Object.entries(next)) {
    if (value.trim()) setAudienceTag(id, value);
  }
  for (const cb of listeners) cb();
}

export function useAudienceTags(): AudienceTags {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
