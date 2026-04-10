"use client";

import { cn } from "@/lib/utils";
import { usePeriodLabel } from "./slide-style-context";

/**
 * SlideShell — wrapper that renders a 16:9 slide preview card
 * following the Impulse Analytics design system.
 */

interface SlideShellProps {
  children: React.ReactNode;
  /** Dark background slide (cover, section dividers) */
  dark?: boolean;
  /** Accent bar color on the left */
  accent?: "blue" | "violet";
  /** Optional className override */
  className?: string;
  /** Slide number (shown in footer) */
  slideNumber?: number;
  /** Source label in footer */
  source?: string;
  /** Period label shown in footer (e.g. "Mars 2026") — replaces current date */
  periodLabel?: string;
}

export function SlideShell({
  children,
  dark = false,
  accent,
  className,
  slideNumber,
  source,
  periodLabel: periodLabelProp,
}: SlideShellProps) {
  const accentColor = accent === "violet" ? "#7F5AFD" : "#2CA6F9";
  const contextPeriodLabel = usePeriodLabel();
  const periodLabel = periodLabelProp ?? contextPeriodLabel;

  return (
    <div
      className={cn(
        "relative w-full aspect-[16/9] rounded-lg overflow-hidden shadow-lg border",
        dark
          ? "text-white border-transparent"
          : "bg-white text-black border-gray-200",
        className
      )}
      style={{
        fontFamily: "'Open Sans', Calibri, sans-serif",
        ...(dark ? { background: "linear-gradient(135deg, #0944A1 0%, #1a6dd4 30%, #2CA6F9 55%, #7F5AFD 100%)" } : {}),
      }}
    >
      {/* Left accent bar — gradient style matching Impulse Analytics MBR */}
      {accent && (
        <div
          className="absolute left-0 top-0 bottom-0 w-[6px]"
          style={{ background: accent === "violet" ? `linear-gradient(180deg, #7F5AFD, #2CA6F9)` : `linear-gradient(180deg, #2CA6F9, #0944A1)` }}
        />
      )}

      {/* Content area */}
      <div className={cn("relative h-full flex flex-col", accent ? "pl-[24px] pr-[16px]" : "px-[16px]")}>
        <div className="flex-1 pt-[3%] pb-[1%] overflow-hidden">
          {children}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pb-[1.5%] min-h-[2%]" style={{ fontSize: "max(0.9%, 10px)" }}>
          <span style={{ color: "#2CA6F9", fontWeight: 700 }}>
            Impulse Analytics.
          </span>
          <span style={{ color: "#CCCCCC", fontStyle: "italic" }}>
            {source || `Source : Meta Ads & Google Ads — ${periodLabel ?? new Date().toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}`}
            {slideNumber != null && ` · Slide ${slideNumber}`}
          </span>
        </div>
      </div>
    </div>
  );
}
