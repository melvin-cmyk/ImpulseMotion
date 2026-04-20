"use client";

import { GripVertical, Plus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { SlideConfig } from "@/lib/deck-page-types";
import { SECTION_LABELS, SECTION_COLORS } from "@/lib/deck-page-types";
import type { SlideData } from "@/types/deck";
import { HighlightLabel } from "./highlight-label";

export type CustomSlide = {
  id: string;
  label: string;
  content: string;
  fontFamily?: string;
};

interface FilmstripProps {
  // Slides
  slides: SlideConfig[];
  customSlides: CustomSlide[];
  aiDynamicSlides: SlideData[];
  sectionSlides: Record<number, { idx: number; slide: SlideConfig }[]>;

  // Navigation / state
  currentSlide: number;
  totalSlideCount: number;
  goToSlide: (idx: number) => void;
  activeFilmstripItemRef: React.RefObject<HTMLButtonElement | null>;

  // Notes
  slideNotes: Record<string, string>;
  slidesWithNotesCount: number;
  showOnlyWithNotes: boolean;
  setShowOnlyWithNotes: React.Dispatch<React.SetStateAction<boolean>>;

  // Search
  filmstripSearch: string;
  setFilmstripSearch: (v: string) => void;
  filmstripSearchRef: React.RefObject<HTMLInputElement | null>;
  filmstripResultCount: number;

  // Drag-to-reorder custom slides
  filmstripDragging: number | null;
  filmstripDropTarget: number | null;
  setFilmstripDropTarget: React.Dispatch<React.SetStateAction<number | null>>;
  handleFilmstripDragStart: (e: React.DragEvent, customIdx: number) => void;
  handleFilmstripDragOver: (e: React.DragEvent, customIdx: number) => void;
  handleFilmstripDrop: (e: React.DragEvent, targetIdx: number) => void;
  handleFilmstripDragEnd: () => void;

  // Misc
  aiSlidesMode: boolean;

  // Add-slide menu
  addCustomSlide: () => void;
  showAddSlideMenu: boolean;
  setShowAddSlideMenu: React.Dispatch<React.SetStateAction<boolean>>;
  handleAddCustomSlide: (label: string, content: string, fontFamily?: string) => void;
}

const ADD_SLIDE_TEMPLATES = [
  { label: "📊 Tableau KPIs", content: "# Tableau KPIs\n\n| KPI | Valeur | Variation |\n|---|---|---|\n| CPM | — | — |\n| CTR | — | — |\n| CPA | — | — |" },
  { label: "💡 Learnings", content: "# Points Clés\n\n1. **Point 1** — description de l'insight\n2. **Point 2** — description de l'insight\n3. **Point 3** — description de l'insight" },
  { label: "✅ Next Steps", content: "# Next Steps\n\n1. ✅ **Action 1** — impact attendu (Owner)\n2. ✅ **Action 2** — impact attendu (Owner)\n3. ✅ **Action 3** — impact attendu (Owner)" },
  { label: "📄 Slide vierge", content: "# Nouveau slide\n\nAjoutez votre contenu ici." },
];

export function Filmstrip({
  slides, customSlides, aiDynamicSlides, sectionSlides,
  currentSlide, totalSlideCount, goToSlide, activeFilmstripItemRef,
  slideNotes, slidesWithNotesCount, showOnlyWithNotes, setShowOnlyWithNotes,
  filmstripSearch, setFilmstripSearch, filmstripSearchRef, filmstripResultCount,
  filmstripDragging, filmstripDropTarget, setFilmstripDropTarget,
  handleFilmstripDragStart, handleFilmstripDragOver, handleFilmstripDrop, handleFilmstripDragEnd,
  aiSlidesMode,
  addCustomSlide, showAddSlideMenu, setShowAddSlideMenu, handleAddCustomSlide,
}: FilmstripProps) {
  return (
    <div className="w-48 flex-shrink-0 bg-white border-r border-gray-200 overflow-y-auto flex flex-col">
      {/* Filmstrip progress indicator */}
      {totalSlideCount > 0 && (
        <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider">Progression</span>
            <span className="text-[10px] font-bold text-gray-600">
              {currentSlide + 1} / {totalSlideCount}
            </span>
          </div>
          <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${((currentSlide + 1) / totalSlideCount) * 100}%`,
                backgroundColor: "#7F5AFD",
              }}
            />
          </div>
        </div>
      )}
      {/* Search filmstrip by slide name */}
      <div className="mx-3 mb-1 mt-1">
        <input
          ref={filmstripSearchRef}
          type="text"
          value={filmstripSearch}
          onChange={(e) => setFilmstripSearch(e.target.value)}
          placeholder="Rechercher… (/)"
          title="Raccourci clavier : / pour focus"
          className="w-full text-[10px] px-2 py-1 rounded-md border border-gray-200 bg-gray-50 text-gray-600 placeholder-gray-300 focus:outline-none focus:border-blue-300 focus:bg-white transition-colors"
        />
        {filmstripSearch.trim() && (
          <div className={`mt-0.5 text-[9px] px-1 ${filmstripResultCount === 0 ? "text-red-400" : "text-gray-400"}`}>
            {filmstripResultCount === 0 ? "Aucun résultat" : `${filmstripResultCount} résultat${filmstripResultCount !== 1 ? "s" : ""}`}
          </div>
        )}
      </div>
      {/* Filter: show only slides with notes */}
      <button
        onClick={() => setShowOnlyWithNotes((prev) => !prev)}
        className={`mx-3 mb-2 mt-1 flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-md border transition-colors ${
          showOnlyWithNotes
            ? "bg-blue-50 border-blue-300 text-blue-700 font-semibold"
            : "bg-gray-50 border-gray-200 text-gray-400 hover:text-gray-600"
        }`}
        title="Afficher uniquement les slides avec notes (F)"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0 inline-block" />
        {showOnlyWithNotes
          ? `${slidesWithNotesCount} slide${slidesWithNotesCount !== 1 ? "s" : ""} avec notes`
          : `Toutes les slides (${totalSlideCount})`}
      </button>
      <div key={String(showOnlyWithNotes)} className="flex-1 animate-in fade-in duration-150">
      <TooltipProvider delayDuration={300}>
      {Object.entries(sectionSlides).map(([secStr, items]) => {
        const sec = Number(secStr);
        const secColor = SECTION_COLORS[sec] ?? "#2CA6F9";
        const searchLower = filmstripSearch.trim().toLowerCase();
        const visibleItems = items.filter(({ slide }) => {
          if (showOnlyWithNotes && !slideNotes[slide.id]) return false;
          if (searchLower && !slide.label.toLowerCase().includes(searchLower)) return false;
          return true;
        });
        if (visibleItems.length === 0) return null;
        return (
          <div key={sec}>
            <div
              className={`px-2 pt-3 pb-1 text-[9px] font-bold uppercase tracking-wider rounded-sm transition-colors ${
                showOnlyWithNotes ? "bg-blue-50 border-l-2 border-blue-300 mx-1" : ""
              }`}
              style={{ color: showOnlyWithNotes ? "#3b82f6" : secColor }}
            >
              {SECTION_LABELS[sec]}
            </div>
            {visibleItems.map(({ idx, slide }) => {
              const isActive = currentSlide === idx;
              const bg = slide.dark ? "#0944A1" : "#f1f5f9";
              const textColor = slide.dark ? "rgba(255,255,255,0.5)" : "#94a3b8";
              return (
                <Tooltip key={slide.id}>
                  <TooltipTrigger asChild>
                    <button
                      ref={isActive ? activeFilmstripItemRef : undefined}
                      onClick={() => goToSlide(idx)}
                      className={`w-full text-left px-2 py-1.5 transition-all ${isActive ? "bg-blue-50" : "hover:bg-gray-50"}`}
                      style={isActive ? { borderLeft: `3px solid ${secColor}`, paddingLeft: "5px" } : undefined}
                    >
                      <div
                        className="w-full aspect-[16/9] rounded overflow-hidden relative mb-1"
                        style={{ background: bg, boxShadow: isActive ? `0 0 0 1.5px ${secColor}` : "0 0 0 1px rgba(0,0,0,0.08)" }}
                      >
                        <span className="absolute top-0.5 left-1 text-[7px] font-bold" style={{ color: textColor }}>
                          {idx + 1}
                        </span>
                        <div className="absolute bottom-0 left-0 right-0 h-[2px]" style={{ background: secColor, opacity: 0.7 }} />
                        {!slide.dark && (
                          <>
                            <div className="absolute top-[28%] left-[10%] right-[10%] h-[8%] rounded-sm" style={{ background: secColor, opacity: 0.15 }} />
                            <div className="absolute top-[45%] left-[10%] right-[30%] h-[5%] rounded-sm bg-gray-300 opacity-40" />
                            <div className="absolute top-[55%] left-[10%] right-[20%] h-[5%] rounded-sm bg-gray-300 opacity-30" />
                          </>
                        )}
                        {slide.dark && (
                          <>
                            <div className="absolute top-[30%] left-[10%] right-[15%] h-[10%] rounded-sm bg-white opacity-15" />
                            <div className="absolute top-[50%] left-[10%] right-[25%] h-[6%] rounded-sm bg-white opacity-10" />
                          </>
                        )}
                        {slideNotes[slide.id] && (
                          <span className="absolute top-0.5 right-1 w-1.5 h-1.5 rounded-full bg-blue-400" />
                        )}
                      </div>
                      <span className={`block text-[10px] leading-tight truncate ${isActive ? "text-blue-700 font-semibold" : "text-gray-500"}`}>
                        <HighlightLabel label={slide.label} search={filmstripSearch} />
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-[160px]">
                    <p className="font-semibold">{slide.label}</p>
                    <p className="text-gray-300 text-[10px]">{SECTION_LABELS[sec]}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        );
      })}
      </TooltipProvider>

      {/* Custom slides */}
      {customSlides.length > 0 && (!showOnlyWithNotes || customSlides.some(cs => !!slideNotes[cs.id])) && (
        <div>
          <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">
            {aiSlidesMode ? "Slides IA" : "Personnalisés"}
          </div>
          <TooltipProvider delayDuration={300}>
          {customSlides.filter(cs => {
            if (showOnlyWithNotes && !slideNotes[cs.id]) return false;
            const sl = filmstripSearch.trim().toLowerCase();
            if (sl && !cs.label.toLowerCase().includes(sl)) return false;
            return true;
          }).map((cs) => {
            const i = customSlides.indexOf(cs);
            const idx = slides.length + i;
            const isDragging = filmstripDragging === i;
            const isDropTarget = filmstripDropTarget === i && filmstripDragging !== null && filmstripDragging !== i;
            return (
              <div key={cs.id}>
                {isDropTarget && (
                  <div className="mx-3 h-0.5 rounded-full bg-violet-500 transition-all" />
                )}
                <div
                  draggable
                  onDragStart={(e) => handleFilmstripDragStart(e, i)}
                  onDragOver={(e) => handleFilmstripDragOver(e, i)}
                  onDrop={(e) => handleFilmstripDrop(e, i)}
                  onDragEnd={handleFilmstripDragEnd}
                  className={`flex items-center gap-1 w-full text-left px-2 py-1.5 text-xs transition-all group ${
                    isDragging ? "opacity-40" :
                    currentSlide === idx ? "bg-blue-50 text-blue-700 font-semibold" : "text-gray-600 hover:bg-gray-50"
                  }`}
                  style={currentSlide === idx && !isDragging ? { borderLeft: "3px solid #7F5AFD", paddingLeft: "5px" } : undefined}
                >
                  <GripVertical className="w-3 h-3 flex-shrink-0 text-gray-300 group-hover:text-gray-400 cursor-grab active:cursor-grabbing transition-colors" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => goToSlide(idx)}
                        className="flex-1 text-left truncate flex items-center gap-1"
                      >
                        <span className="text-gray-400 mr-1">{idx + 1}.</span>
                        <span className="flex-1 truncate"><HighlightLabel label={cs.label} search={filmstripSearch} /></span>
                        {slideNotes[cs.id] && (
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0 inline-block" title="Note" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[160px]">
                      <p className="font-semibold">{cs.label}</p>
                      <p className="text-gray-300 text-[10px]">Slide personnalisée</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            );
          })}
          </TooltipProvider>
          {filmstripDragging !== null && filmstripDropTarget === null && (
            <div
              className="mx-3 h-0.5 rounded-full bg-violet-300"
              onDragOver={(e) => { e.preventDefault(); setFilmstripDropTarget(customSlides.length); }}
              onDrop={(e) => handleFilmstripDrop(e, customSlides.length)}
            />
          )}
        </div>
      )}

      {/* AI Generated slides */}
      {aiDynamicSlides.length > 0 && (
        <div>
          <div className="px-2 pt-3 pb-1 text-[9px] font-bold uppercase tracking-wider" style={{ color: "#7F5AFD" }}>
            Slides IA ({aiDynamicSlides.length})
          </div>
          {aiDynamicSlides.map((aiSlide, i) => {
            const aiAbsIdx = slides.length + customSlides.length + i;
            const isActive = currentSlide === aiAbsIdx;
            const searchLower = filmstripSearch.trim().toLowerCase();
            if (searchLower && !aiSlide.title.toLowerCase().includes(searchLower)) return null;
            return (
              <button
                key={aiSlide.id ?? `ai-${i}`}
                onClick={() => goToSlide(aiAbsIdx)}
                className={`w-full text-left px-2 py-1.5 transition-all ${isActive ? "bg-violet-50" : "hover:bg-gray-50"}`}
                style={isActive ? { borderLeft: "3px solid #7F5AFD", paddingLeft: "5px" } : undefined}
              >
                <div
                  className="w-full aspect-[16/9] rounded overflow-hidden relative mb-1"
                  style={{ background: "#f1f5f9", boxShadow: isActive ? "0 0 0 1.5px #7F5AFD" : "0 0 0 1px rgba(0,0,0,0.08)" }}
                >
                  <span className="absolute top-0.5 left-1 text-[7px] font-bold" style={{ color: "#94a3b8" }}>
                    {aiAbsIdx + 1}
                  </span>
                  <div className="absolute bottom-0 left-0 right-0 h-[2px]" style={{ background: "#7F5AFD", opacity: 0.7 }} />
                  <div className="absolute top-[28%] left-[10%] right-[10%] h-[8%] rounded-sm" style={{ background: "#7F5AFD", opacity: 0.15 }} />
                  <div className="absolute top-[45%] left-[10%] right-[30%] h-[5%] rounded-sm bg-gray-300 opacity-40" />
                  <div className="absolute top-[55%] left-[10%] right-[20%] h-[5%] rounded-sm bg-gray-300 opacity-30" />
                </div>
                <span className={`block text-[10px] leading-tight truncate ${isActive ? "text-violet-700 font-semibold" : "text-gray-500"}`}>
                  {aiSlide.title}
                </span>
              </button>
            );
          })}
        </div>
      )}
      </div>

      {/* Add slide button */}
      <div className="relative border-t border-gray-200">
        <div className="flex">
          <button
            onClick={addCustomSlide}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-gray-500 hover:text-[#0944A1] hover:bg-blue-50 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Ajouter une slide
          </button>
          <button
            onClick={() => setShowAddSlideMenu(v => !v)}
            className="px-2.5 text-xs text-gray-400 hover:text-[#0944A1] hover:bg-blue-50 border-l border-gray-200 transition-colors font-semibold"
            title="Choisir un type de slide"
          >
            ▾
          </button>
        </div>
        {showAddSlideMenu && (
          <div className="absolute bottom-full left-0 right-0 bg-white border border-gray-200 rounded-t-lg shadow-lg z-20 py-1">
            {ADD_SLIDE_TEMPLATES.map(item => (
              <button
                key={item.label}
                onClick={() => { handleAddCustomSlide(item.label.replace(/^[^\w]+/, "").trim(), item.content); setShowAddSlideMenu(false); }}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-blue-50 hover:text-[#0944A1] transition-colors"
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
