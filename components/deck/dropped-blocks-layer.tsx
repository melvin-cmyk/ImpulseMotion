"use client";

import { GripVertical, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DroppedBlock } from "@/lib/deck-page-types";
import { useDeckTheme } from "./slide-style-context";

export type BlockStyle = {
  headerColor: string;
  rowColor: string;
  fontSize: number;
  fontFamily: string;
  textColor: string;
  borderColor: string;
  borderWidth: number;
};

function makeDefaultBlockStyle(headerColor: string): BlockStyle {
  return {
    headerColor,
    rowColor: "#F3F3F3",
    fontSize: 10,
    fontFamily: "Inter",
    textColor: "#1a1a1a",
    borderColor: "#e5e7eb",
    borderWidth: 1,
  };
}

interface Props {
  blocks: DroppedBlock[];
  selectedBlockId: string | null;
  setSelectedBlockId: (id: string | null) => void;
  blockStyles: Record<string, BlockStyle>;
  setBlockStyles: React.Dispatch<React.SetStateAction<Record<string, BlockStyle>>>;
  draggingBlock: { id: string } | null;
  handleBlockMouseDown: (e: React.MouseEvent, blockId: string) => void;
  removeBlock: (blockId: string) => void;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  setDroppedBlocks: React.Dispatch<React.SetStateAction<DroppedBlock[]>>;
}

export function DroppedBlocksLayer({
  blocks, selectedBlockId, setSelectedBlockId,
  blockStyles, setBlockStyles,
  draggingBlock, handleBlockMouseDown, removeBlock,
  canvasRef, setDroppedBlocks,
}: Props) {
  const theme = useDeckTheme();
  const defaults = makeDefaultBlockStyle(theme.tableHeaderColor);
  return (
    <>
      {blocks.map((block) => {
        const isSelected = selectedBlockId === block.id;
        const bStyle: BlockStyle = blockStyles[block.id] ?? {
          ...defaults,
          fontSize: block.fontSize ?? defaults.fontSize,
          fontFamily: block.fontFamily ?? defaults.fontFamily,
          textColor: block.textColor ?? defaults.textColor,
        };
        const isTable = block.content.includes("|");
        const fontFamilyCss = bStyle.fontFamily === "Mono"
          ? "monospace"
          : bStyle.fontFamily === "Georgia"
          ? "Georgia, serif"
          : bStyle.fontFamily + ", sans-serif";

        return (
          <div
            key={block.id}
            data-block-id={block.id}
            onClick={(e) => { e.stopPropagation(); setSelectedBlockId(block.id); }}
            onMouseDown={(e) => { e.stopPropagation(); if (!isSelected) handleBlockMouseDown(e, block.id); }}
            style={{
              position: "absolute",
              left: `${block.x}%`,
              top: `${block.y}%`,
              width: `${block.w}%`,
              ...(block.h !== undefined ? { height: `${block.h}%` } : {}),
              cursor: draggingBlock?.id === block.id ? "grabbing" : "default",
              zIndex: isSelected ? 20 : 10,
              overflow: "visible",
            }}
            className={`rounded-lg shadow-lg bg-white border-2 transition-all ${
              isSelected ? "border-[#2CA6F9]" : "border-transparent hover:border-[#2CA6F9]/40"
            }`}
          >
            {isSelected && (
              <div className="absolute -top-8 left-0 flex items-center gap-1 bg-[#0944A1] rounded-lg px-2 py-1 shadow-md z-30">
                <GripVertical
                  className="w-3.5 h-3.5 text-white/70 cursor-grab"
                  onMouseDown={(e) => handleBlockMouseDown(e, block.id)}
                />
                <span className="text-[10px] text-white/70 font-medium select-none">Bloc données</span>
                <button
                  onClick={(e) => { e.stopPropagation(); removeBlock(block.id); }}
                  className="ml-1 p-0.5 rounded hover:bg-white/20 text-white/80 hover:text-white transition-colors"
                  title="Supprimer"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}
            {/* Top drag bar — 8px strip so content below stays interactive */}
            <div
              className="absolute top-0 left-0 right-0 h-2 z-10"
              onMouseDown={(e) => handleBlockMouseDown(e, block.id)}
              style={{ cursor: draggingBlock?.id === block.id ? "grabbing" : "grab" }}
            />

            <style>{`
              .block-md-${block.id} th { background-color: ${bStyle.headerColor} !important; color: white; padding: 3px 8px; border: ${bStyle.borderWidth}px solid ${bStyle.borderColor}; }
              .block-md-${block.id} td { padding: 3px 8px; color: ${bStyle.textColor}; border: ${bStyle.borderWidth}px solid ${bStyle.borderColor}; }
              .block-md-${block.id} tr:nth-child(even) td { background-color: ${bStyle.rowColor}; }
              .block-md-${block.id} table { font-size: ${bStyle.fontSize}px; font-family: ${fontFamilyCss}; border-collapse: collapse; width: 100%; }
            `}</style>
            <div
              className={`relative z-20 p-3 text-xs text-gray-700 prose prose-sm max-w-none block-md-${block.id}`}
              style={block.h !== undefined ? { height: "100%", overflow: "auto" } : {}}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.content}</ReactMarkdown>
            </div>

            {isSelected && isTable && (
              <div
                className="absolute left-0 z-40 bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 flex items-center gap-3 flex-wrap"
                style={{ top: "calc(100% + 4px)", minWidth: 420, pointerEvents: "all" }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <label className="flex items-center gap-1.5 text-[10px] text-gray-600 font-medium">
                  En-tête
                  <input type="color" value={bStyle.headerColor}
                    onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, headerColor: e.target.value } }))}
                    className="w-6 h-6 rounded cursor-pointer border border-gray-200" />
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-gray-600 font-medium">
                  Lignes paires
                  <input type="color" value={bStyle.rowColor}
                    onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, rowColor: e.target.value } }))}
                    className="w-6 h-6 rounded cursor-pointer border border-gray-200" />
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-gray-600 font-medium">
                  Texte
                  <input type="color" value={bStyle.textColor}
                    onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, textColor: e.target.value } }))}
                    className="w-6 h-6 rounded cursor-pointer border border-gray-200" />
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-gray-600 font-medium">
                  Bordure
                  <input type="color" value={bStyle.borderColor}
                    onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, borderColor: e.target.value } }))}
                    className="w-6 h-6 rounded cursor-pointer border border-gray-200" />
                  <input type="number" min={0} max={4} value={bStyle.borderWidth}
                    onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, borderWidth: Number(e.target.value) } }))}
                    className="w-10 text-[10px] border border-gray-200 rounded px-1 py-0.5" />
                  px
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-gray-600 font-medium">
                  Taille
                  <input type="number" min={7} max={18} value={bStyle.fontSize}
                    onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, fontSize: Number(e.target.value) } }))}
                    className="w-12 text-[10px] border border-gray-200 rounded px-1 py-0.5" />
                  px
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-gray-600 font-medium">
                  Police
                  <select value={bStyle.fontFamily}
                    onChange={(e) => setBlockStyles(prev => ({ ...prev, [block.id]: { ...bStyle, fontFamily: e.target.value } }))}
                    className="text-[10px] border border-gray-200 rounded px-1 py-0.5">
                    <option value="Inter">Inter</option>
                    <option value="Raleway">Raleway</option>
                    <option value="Georgia">Georgia</option>
                    <option value="Playfair">Playfair</option>
                    <option value="Mono">Mono</option>
                  </select>
                </label>
              </div>
            )}

            {/* Resize handle (bottom-right) — width + height */}
            {isSelected && (
              <div
                className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize z-30 flex items-end justify-end"
                style={{ background: "linear-gradient(135deg, transparent 50%, #2CA6F9 50%)", borderBottomRightRadius: 6 }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const canvas = canvasRef.current;
                  if (!canvas) return;
                  const startX = e.clientX;
                  const startY = e.clientY;
                  const origW = block.w;
                  const rect = canvas.getBoundingClientRect();
                  const currentBlockEl = canvas.querySelector(`[data-block-id="${block.id}"]`) as HTMLElement | null;
                  const currentHpx = currentBlockEl?.offsetHeight ?? rect.height * 0.3;
                  const startHpct = block.h ?? (currentHpx / rect.height) * 100;
                  const onMove = (ev: MouseEvent) => {
                    const dw = ((ev.clientX - startX) / rect.width) * 100;
                    const dh = ((ev.clientY - startY) / rect.height) * 100;
                    setDroppedBlocks(prev => prev.map(b => b.id === block.id
                      ? { ...b, w: Math.max(5, Math.min(95, origW + dw)), h: Math.max(5, Math.min(90, startHpct + dh)) }
                      : b
                    ));
                  };
                  const onUp = (ev: MouseEvent) => {
                    ev.stopPropagation();
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                  };
                  window.addEventListener("mousemove", onMove);
                  window.addEventListener("mouseup", onUp);
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
