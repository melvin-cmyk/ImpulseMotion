"use client";

import { cn } from "@/lib/utils";

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
}

export function SlideShell({
  children,
  dark = false,
  accent,
  className,
  slideNumber,
  source,
}: SlideShellProps) {
  const accentColor = accent === "violet" ? "#7F5AFD" : "#2CA6F9";

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
          className="absolute left-0 top-0 bottom-0 w-[7px]"
          style={{ backgroundColor: accentColor }}
        />
      )}

      {/* Content area */}
      <div className={cn("relative h-full flex flex-col", accent ? "pl-[20px] pr-[14px]" : "px-[14px]")}>
        <div className="flex-1 pt-[6%]">
          {children}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pb-[2%] text-[6px]">
          <span style={{ color: "#2CA6F9", fontWeight: 700 }}>
            Impulse Analytics.
          </span>
          <span style={{ color: "#CCCCCC", fontStyle: "italic" }}>
            {source || `Source : Meta Ads & Google Ads — ${new Date().toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}`}
            {slideNumber != null && ` · Slide ${slideNumber}`}
          </span>
        </div>
      </div>
    </div>
  );
}
