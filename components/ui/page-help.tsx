"use client";

import { useState, useEffect } from "react";
import { HelpCircle, X, ChevronDown } from "lucide-react";

interface PageHelpProps {
  title: string;
  description: string;
  steps: string[];
  tip?: string;
}

export function PageHelp({ title, description, steps, tip }: PageHelpProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Sur desktop (>= 1024px), ouvert par défaut ; fermé sur mobile
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    setIsOpen(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsOpen(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return (
    <div className="bg-blue-950/30 border border-blue-800/30 rounded-2xl overflow-hidden mb-6">
      {/* Header — toujours visible */}
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-blue-900/20 transition-colors"
        aria-expanded={isOpen}
      >
        <div className="w-7 h-7 rounded-lg bg-blue-600/20 flex items-center justify-center shrink-0">
          <HelpCircle className="w-4 h-4 text-blue-400" />
        </div>
        <div className="flex-1 text-left">
          <span className="text-sm font-semibold text-blue-200">{title}</span>
          {!isOpen && (
            <span className="text-xs text-blue-400/70 ml-2 hidden sm:inline">
              — cliquer pour en savoir plus
            </span>
          )}
        </div>
        <ChevronDown
          className={`w-4 h-4 text-blue-400 transition-transform shrink-0 ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {/* Corps collapsible */}
      {isOpen && (
        <div className="px-5 pb-5 pt-1 space-y-4 border-t border-blue-800/20">
          {/* Description */}
          <p className="text-sm text-blue-100/80 leading-relaxed">{description}</p>

          {/* Steps */}
          <div className="space-y-2">
            <p className="text-[10px] font-semibold text-blue-400/60 uppercase tracking-widest">
              Comment l&apos;utiliser
            </p>
            <ol className="space-y-1.5">
              {steps.map((step, i) => (
                <li key={i} className="flex items-start gap-2.5 text-sm text-blue-100/70">
                  <span className="w-5 h-5 rounded-full bg-blue-800/50 text-blue-300 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          {/* Conseil optionnel */}
          {tip && (
            <div className="flex items-start gap-2 bg-blue-900/20 border border-blue-700/20 rounded-xl px-4 py-3">
              <span className="text-base shrink-0">💡</span>
              <p className="text-xs text-blue-200/70 leading-relaxed">
                <span className="font-semibold text-blue-200/90">Conseil : </span>
                {tip}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
