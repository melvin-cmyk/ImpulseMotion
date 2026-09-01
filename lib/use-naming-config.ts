"use client";

/**
 * React binding for the shared naming convention (localStorage-backed).
 * Uses useSyncExternalStore so pages read the config without a setState-in-effect
 * and re-render when it is saved from the Naming page or another tab.
 */

import { useSyncExternalStore } from "react";
import {
  DEFAULT_NAMING_CONFIG,
  NAMING_STORAGE_KEY,
  loadNamingConfig,
  saveNamingConfig as persistNamingConfig,
  type NamingConfig,
} from "./naming-config";

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedConfig: NamingConfig = DEFAULT_NAMING_CONFIG;

function readRaw(): string | null {
  try {
    return localStorage.getItem(NAMING_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getSnapshot(): NamingConfig {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedConfig = loadNamingConfig();
  }
  return cachedConfig;
}

function getServerSnapshot(): NamingConfig {
  return DEFAULT_NAMING_CONFIG;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === NAMING_STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

/** Persist the config and notify every mounted `useNamingConfig()`. */
export function updateNamingConfig(config: NamingConfig): void {
  persistNamingConfig(config);
  cachedRaw = readRaw();
  cachedConfig = config;
  for (const cb of listeners) cb();
}

export function useNamingConfig(): NamingConfig {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
