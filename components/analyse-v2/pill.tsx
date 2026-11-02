"use client";

/**
 * Motion's control vocabulary: 32 px pills (radius 10, 1 px border, 14 px
 * medium text) that open a popover below them, and filled filter chips
 * « champ opérateur valeur × ».
 */

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export const PILL = "h-8 inline-flex items-center gap-1.5 rounded-[10px] border border-gray-800 bg-gray-900 px-2.5 text-sm font-medium text-gray-100 hover:border-gray-700 disabled:opacity-40 disabled:hover:border-gray-800";

export function Popover({ trigger, children, width = 260, align = "left", open: controlled, onOpenChange }: {
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  width?: number;
  align?: "left" | "right";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const set = (v: boolean) => { if (onOpenChange) onOpenChange(v); else setOwn(v); };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) set(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") set(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  });
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => set(!open) })}
      {open && (
        <div className={`absolute top-full mt-1 z-40 rounded-xl border border-gray-800 bg-gray-950 p-1 shadow-2xl ${align === "right" ? "right-0" : "left-0"}`} style={{ width }}>
          {typeof children === "function" ? children(() => set(false)) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, active, hint, disabled }: { children: React.ReactNode; onClick?: () => void; active?: boolean; hint?: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={hint} className={`w-full h-8 flex items-center gap-2 rounded-lg px-2.5 text-left text-sm disabled:opacity-40 ${active ? "bg-gray-800 text-white" : "text-gray-200 hover:bg-gray-800/70"}`}>
      {children}
    </button>
  );
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">{children}</div>;
}

export function FilterChip({ label, onClear }: { label: React.ReactNode; onClear: () => void }) {
  return (
    <span className="h-8 inline-flex items-center gap-1.5 rounded-[10px] bg-gray-800 pl-2.5 pr-1.5 text-sm text-gray-100">
      <span className="max-w-[260px] truncate">{label}</span>
      <button type="button" onClick={onClear} className="p-0.5 rounded text-gray-400 hover:text-white" aria-label="Retirer le filtre"><X className="w-3.5 h-3.5" /></button>
    </span>
  );
}
