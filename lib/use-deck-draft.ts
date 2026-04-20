"use client";

import { useEffect, useRef, useState } from "react";
import type { DroppedBlock, SlideOverride } from "@/lib/deck-page-types";
import type { SlideData } from "@/types/deck";
import type { SlideElement } from "@/components/deck/slide-editor";
import type { TextStyle } from "@/components/deck/slide-style-context";
import type { CustomSlide } from "@/components/deck/filmstrip";

export interface DeckDraftState {
  droppedBlocks: DroppedBlock[];
  slideOverrides: SlideOverride[];
  customSlides: CustomSlide[];
  slideNotes: Record<string, string>;
  blockStyles: Record<string, {
    headerColor: string; rowColor: string; fontSize: number; fontFamily: string;
    textColor: string; borderColor: string; borderWidth: number;
  }>;
  slideElements: Record<number, SlideElement[]>;
  textStyles: Record<string, TextStyle>;
  aiDynamicSlides: SlideData[];
  masterElements?: SlideElement[];
  themeId?: string;
}

const DEBOUNCE_MS = 800;

/**
 * Syncs a deck's working state to /api/deck/draft, keyed by (client, period).
 *
 * On mount (or when the key changes) loads the server draft and calls
 * `applyLoaded` so the page state can hydrate. Then debounces changes to
 * PUT back to the server.
 *
 * Falls back silently on network errors so the local in-memory state keeps
 * working even when the relay / DB is down.
 */
export function useDeckDraft(
  clientId: string | null,
  periodKey: string | null,
  state: DeckDraftState,
  applyLoaded: (draft: DeckDraftState) => void,
) {
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "saved" | "error">("idle");
  const lastSavedKey = useRef<string>("");
  const loadedKey = useRef<string>("");

  // Load when (clientId, periodKey) changes
  useEffect(() => {
    if (!clientId || !periodKey) return;
    const key = `${clientId}::${periodKey}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    let cancelled = false;

    setStatus("loading");
    fetch(`/api/deck/draft?clientId=${encodeURIComponent(clientId)}&periodKey=${encodeURIComponent(periodKey)}`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : { draft: null })
      .then(({ draft }) => {
        if (cancelled) return;
        if (draft) applyLoaded(draft as DeckDraftState);
        setStatus("idle");
      })
      .catch(() => { if (!cancelled) setStatus("error"); });

    return () => { cancelled = true; };
  }, [clientId, periodKey, applyLoaded]);

  // Debounced save on state change
  useEffect(() => {
    if (!clientId || !periodKey) return;
    const key = `${clientId}::${periodKey}`;
    if (loadedKey.current !== key) return; // don't save before initial load completes

    const snapshot = JSON.stringify(state);
    if (snapshot === lastSavedKey.current) return;

    const timer = setTimeout(async () => {
      setStatus("saving");
      try {
        const res = await fetch("/api/deck/draft", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, periodKey, ...state }),
        });
        if (res.ok) {
          lastSavedKey.current = snapshot;
          setStatus("saved");
          setTimeout(() => setStatus(s => s === "saved" ? "idle" : s), 1500);
        } else {
          setStatus("error");
        }
      } catch {
        setStatus("error");
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [state, clientId, periodKey]);

  return { status };
}
