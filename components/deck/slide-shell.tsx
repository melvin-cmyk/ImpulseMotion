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
          ? "bg-[#0944A1] text-white border-[#0944A1]"
          : "bg-white text-black border-gray-200",
        className
      )}
      style={{ fontFamily: "'Open Sans', Calibri, sans-serif" }}
    >
      {/* Left accent bar */}
      {accent && (
        <div
          className="absolute left-0 top-0 bottom-0 w-[6px]"
          style={{ backgroundColor: accentColor }}
        />
      )}

      {/* Content area */}
      <div className={cn("relative h-full flex flex-col", accent ? "pl-[24px] pr-[16px]" : "px-[16px]")}>
        <div className="flex-1 pt-[5%] overflow-hidden">
          {children}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pb-[2%] text-[0.7%] min-h-[2%]" style={{ fontSize: "max(0.7%, 8px)" }}>
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
