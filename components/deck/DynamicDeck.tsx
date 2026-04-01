"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, Download, Presentation } from "lucide-react";
import { DynamicSlide } from "./DynamicSlide";
import type { SlideData } from "@/types/deck";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface DynamicDeckProps {
  slides: SlideData[];
  title?: string;
  /** Called when user clicks the export button. Implement your own PPTX logic. */
  onExport?: () => void;
  /** Show all slides stacked (scroll mode) instead of one-at-a-time navigation */
  scrollMode?: boolean;
}

// ── Navigation controls ───────────────────────────────────────────────────────

interface NavControlsProps {
  current: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onExport?: () => void;
  title?: string;
}

function NavControls({
  current,
  total,
  onPrev,
  onNext,
  onExport,
  title,
}: NavControlsProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-white border border-gray-200 rounded-lg shadow-sm mb-3">
      {/* Left: deck title */}
      <div className="flex items-center gap-2 min-w-0">
        <Presentation className="w-4 h-4 text-[#2CA6F9] flex-shrink-0" />
        {title && (
          <span className="text-sm font-semibold text-[#0944A1] truncate">
            {title}
          </span>
        )}
      </div>

      {/* Centre: prev / counter / next */}
      <div className="flex items-center gap-2">
        <button
          onClick={onPrev}
          disabled={current === 0}
          aria-label="Previous slide"
          className="w-8 h-8 flex items-center justify-center rounded-md transition-colors
            text-gray-600 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <span className="text-sm font-medium tabular-nums text-gray-700 min-w-[5ch] text-center">
          {current + 1} / {total}
        </span>

        <button
          onClick={onNext}
          disabled={current === total - 1}
          aria-label="Next slide"
          className="w-8 h-8 flex items-center justify-center rounded-md transition-colors
            text-gray-600 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Right: export */}
      <button
        onClick={onExport}
        disabled={!onExport}
        aria-label="Export deck"
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors
          bg-[#0944A1] text-white hover:bg-[#07338a] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Download className="w-3.5 h-3.5" />
        Export
      </button>
    </div>
  );
}

// ── Slide thumbnail strip ─────────────────────────────────────────────────────

interface ThumbnailStripProps {
  slides: SlideData[];
  current: number;
  onSelect: (i: number) => void;
}

function ThumbnailStrip({ slides, current, onSelect }: ThumbnailStripProps) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2 mt-3 scrollbar-thin">
      {slides.map((slide, i) => (
        <button
          key={slide.id}
          onClick={() => onSelect(i)}
          className={`flex-shrink-0 rounded-md border-2 transition-all overflow-hidden
            ${
              i === current
                ? "border-[#2CA6F9] shadow-md"
                : "border-gray-200 hover:border-gray-400 opacity-60 hover:opacity-80"
            }`}
          style={{ width: 120, height: 68 }}
          aria-label={`Go to slide ${i + 1}: ${slide.title}`}
        >
          <div className="w-full h-full flex flex-col items-start justify-start p-1.5 bg-white overflow-hidden">
            {/* Accent bar */}
            <div
              className="w-1 self-stretch rounded-sm mr-1 flex-shrink-0 absolute left-0 top-0 bottom-0"
              style={{ background: "#2CA6F9" }}
            />
            <p
              className="text-[8px] font-bold leading-tight text-[#0944A1] line-clamp-2 pl-2"
              style={{ fontFamily: "'Raleway', sans-serif" }}
            >
              {slide.title}
            </p>
            <p
              className="text-[7px] text-gray-400 mt-auto pl-2 capitalize"
            >
              {slide.type}
            </p>
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyDeck() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center text-gray-400">
      <Presentation className="w-12 h-12 mb-4 opacity-30" />
      <p className="text-sm font-medium">No slides to display</p>
      <p className="text-xs mt-1 opacity-70">
        Generate a deck using the AI panel to get started.
      </p>
    </div>
  );
}

// ── DynamicDeck ───────────────────────────────────────────────────────────────

export function DynamicDeck({
  slides,
  title = "Performance Deck",
  onExport,
  scrollMode = false,
}: DynamicDeckProps) {
  const [current, setCurrent] = useState(0);

  if (!slides || slides.length === 0) return <EmptyDeck />;

  const safeIndex = Math.min(current, slides.length - 1);

  const prev = () => setCurrent((i) => Math.max(0, i - 1));
  const next = () => setCurrent((i) => Math.min(slides.length - 1, i + 1));

  if (scrollMode) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          {title && (
            <h2 className="text-base font-bold text-[#0944A1] flex items-center gap-2">
              <Presentation className="w-4 h-4 text-[#2CA6F9]" />
              {title}
            </h2>
          )}
          {onExport && (
            <button
              onClick={onExport}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md
                bg-[#0944A1] text-white hover:bg-[#07338a] transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Export
            </button>
          )}
        </div>
        {slides.map((slide, i) => (
          <DynamicSlide key={slide.id} slide={slide} slideNumber={i + 1} />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <NavControls
        current={safeIndex}
        total={slides.length}
        onPrev={prev}
        onNext={next}
        onExport={onExport}
        title={title}
      />

      {/* Active slide */}
      <div className="w-full">
        <DynamicSlide
          slide={slides[safeIndex]}
          slideNumber={safeIndex + 1}
        />
      </div>

      {/* Thumbnail strip */}
      {slides.length > 1 && (
        <ThumbnailStrip
          slides={slides}
          current={safeIndex}
          onSelect={setCurrent}
        />
      )}
    </div>
  );
}
