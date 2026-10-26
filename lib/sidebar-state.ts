"use client";

/**
 * Whether the left rail is folded to its icons. Remembered per browser and
 * shared by every component that reads it (the rail itself, the pages that
 * offer a « masquer le menu » button) through a window event.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "im:sidebar-collapsed";
const EVENT = "impulse:sidebar-collapsed";

function read(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    // Browser-only state, read after hydration.
    let active = true;
    void Promise.resolve().then(() => { if (active) setCollapsed(read()); });
    const onChange = () => setCollapsed(read());
    window.addEventListener(EVENT, onChange);
    return () => { active = false; window.removeEventListener(EVENT, onChange); };
  }, []);
  const toggle = useCallback(() => {
    const next = !read();
    try { localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* fine */ }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [collapsed, toggle];
}
