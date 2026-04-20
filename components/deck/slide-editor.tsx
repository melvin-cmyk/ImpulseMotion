"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import {
  MousePointer2,
  Type,
  Square,
  Circle,
  ArrowRight,
  Trash2,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Bold,
  Italic,
  Underline,
  Triangle,
  Minus,
  Image as ImageIcon,
  Undo2,
  Redo2,
  RotateCw,
  Copy,
  BringToFront,
  SendToBack,
  Link,
  Replace,
  AlignHorizontalJustifyStart,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Group,
  Ungroup,
  Sparkles,
  Table as TableIcon,
  BarChart3,
  Plus,
} from "lucide-react";
import { snapRect, SNAP_GRID_STEP } from "@/lib/deck-snap";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TableCellData {
  headers: string[];
  rows: string[][];
}

export interface TableStyleData {
  headerBg: string;
  headerText: string;
  rowBg: string;
  altRowBg: string;
  rowText: string;
  borderColor: string;
  fontSize: number;
}

export interface ChartDataSource {
  /** Dot-path into DeckData, resolved at render time, e.g. "highlights" or "metaCampaigns". */
  field: string;
  /** Column names in `rows` that hold the label and the numeric value. */
  labelKey: string;
  valueKey: string;
  /** Series to plot for multi-series charts. */
  seriesKeys?: string[];
}

export interface SlideElement {
  id: string;
  type: "text" | "rect" | "circle" | "arrow" | "triangle" | "line" | "image" | "table" | "chart";
  x: number; // % of canvas width
  y: number; // % of canvas height
  w: number; // % of canvas width
  h: number; // % of canvas height
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  opacity: number; // 0-1
  rotation?: number; // degrees
  borderRadius?: number; // px, for rect only
  // Text-specific
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: "normal" | "bold";
  fontStyle?: "normal" | "italic";
  textDecoration?: "none" | "underline";
  textColor?: string;
  textAlign?: "left" | "center" | "right";
  lineHeight?: number; // multiplier e.g. 1.4
  letterSpacing?: number; // px
  // Image-specific
  imageUrl?: string;
  // Table-specific
  tableData?: TableCellData;
  tableStyle?: Partial<TableStyleData>;
  // Chart-specific
  chartType?: "bar" | "line" | "pie";
  chartTitle?: string;
  chartData?: { label: string; value: number }[];
  chartSource?: ChartDataSource;
  chartColors?: string[];
  // Grouping: elements sharing a groupId move together and select as one.
  groupId?: string;
}

export type EditorTool = "select" | "text" | "rect" | "circle" | "arrow" | "triangle" | "line" | "image" | "table" | "chart";

export const DEFAULT_TABLE_STYLE: TableStyleData = {
  headerBg: "#0944A1",
  headerText: "#ffffff",
  rowBg: "#ffffff",
  altRowBg: "#F3F6FB",
  rowText: "#1a1a1a",
  borderColor: "#e5e7eb",
  fontSize: 11,
};

export const DEFAULT_CHART_COLORS = ["#0944A1", "#2CA6F9", "#60A5FA", "#93C5FD", "#A78BFA", "#F472B6"];

export type AlignAxis = "left" | "center-h" | "right" | "top" | "center-v" | "bottom";
export type DistributeAxis = "h" | "v";

const FONT_OPTIONS = [
  { label: "Inter", value: "Inter, sans-serif" },
  { label: "Raleway", value: "Raleway, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Playfair", value: "'Playfair Display', serif" },
  { label: "Mono", value: "monospace" },
];

export function createDefaultElement(type: SlideElement["type"], x: number, y: number): SlideElement {
  const base = { id: crypto.randomUUID(), type, x, y, strokeWidth: 2, opacity: 1 };
  switch (type) {
    case "text":
      return {
        ...base,
        w: 24,
        h: 10,
        fillColor: "transparent",
        strokeColor: "#2CA6F9",
        text: "Texte",
        fontSize: 14,
        fontFamily: "Inter, sans-serif",
        fontWeight: "normal",
        fontStyle: "normal",
        textDecoration: "none",
        textColor: "#1a1a1a",
        textAlign: "left",
      };
    case "rect":
      return { ...base, w: 18, h: 14, fillColor: "#E8F0FE", strokeColor: "#0944A1" };
    case "circle":
      return { ...base, w: 14, h: 18, fillColor: "#E8F0FE", strokeColor: "#0944A1" };
    case "arrow":
      return { ...base, w: 22, h: 5, fillColor: "transparent", strokeColor: "#0944A1" };
    case "triangle":
      return { ...base, w: 16, h: 16, fillColor: "#E8F0FE", strokeColor: "#0944A1" };
    case "line":
      return { ...base, w: 22, h: 2, fillColor: "transparent", strokeColor: "#0944A1" };
    case "image":
      return { ...base, w: 24, h: 18, fillColor: "transparent", strokeColor: "transparent", imageUrl: "" };
    case "table":
      return {
        ...base,
        w: 50, h: 24,
        fillColor: "transparent", strokeColor: "transparent",
        tableData: {
          headers: ["Colonne A", "Colonne B", "Colonne C"],
          rows: [["—", "—", "—"], ["—", "—", "—"]],
        },
        tableStyle: DEFAULT_TABLE_STYLE,
      };
    case "chart":
      return {
        ...base,
        w: 40, h: 28,
        fillColor: "#ffffff", strokeColor: "#e5e7eb", strokeWidth: 1,
        chartType: "bar",
        chartTitle: "Titre du graphique",
        chartData: [
          { label: "Jan", value: 12 },
          { label: "Fév", value: 19 },
          { label: "Mar", value: 15 },
          { label: "Avr", value: 22 },
        ],
        chartColors: DEFAULT_CHART_COLORS,
      };
  }
}

// ── SlideEditorToolbar ────────────────────────────────────────────────────────

interface ToolbarProps {
  activeTool: EditorTool;
  onToolChange: (t: EditorTool) => void;
  selectedElement: SlideElement | null;
  onUpdateElement: (patch: Partial<SlideElement>) => void;
  onDeleteElement: () => void;
  onDuplicateElement?: () => void;
  onBringToFront?: () => void;
  onSendToBack?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onImageUpload?: (file: File) => void;
  // Multi-selection & alignment
  selectionCount?: number;
  onAlign?: (axis: AlignAxis) => void;
  onDistribute?: (axis: DistributeAxis) => void;
  onGroup?: () => void;
  onUngroup?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onAskAi?: () => void;
}

export function SlideEditorToolbar({
  activeTool,
  onToolChange,
  selectedElement,
  onUpdateElement,
  onDeleteElement,
  onDuplicateElement,
  onBringToFront,
  onSendToBack,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onImageUpload,
  selectionCount = 0,
  onAlign,
  onDistribute,
  onGroup,
  onUngroup,
  onCopy,
  onPaste,
  onAskAi,
}: ToolbarProps) {
  const hasMulti = selectionCount >= 2;
  const hasTri = selectionCount >= 3;
  const imageInputRef = useRef<HTMLInputElement>(null);
  const replaceImageInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center gap-1 mb-2 px-2 py-1 bg-white border border-gray-200 rounded-lg shadow-sm flex-wrap">
      {/* Undo / Redo */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        title="Annuler (Ctrl+Z)"
        className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30 transition-colors"
      >
        <Undo2 className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        title="Rétablir (Ctrl+Y)"
        className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30 transition-colors"
      >
        <Redo2 className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-gray-200 mx-1" />

      {(
        [
          { tool: "select" as EditorTool, icon: <MousePointer2 className="w-3.5 h-3.5" />, label: "Sélectionner" },
          { tool: "text" as EditorTool, icon: <Type className="w-3.5 h-3.5" />, label: "Texte" },
          { tool: "rect" as EditorTool, icon: <Square className="w-3.5 h-3.5" />, label: "Rectangle" },
          { tool: "circle" as EditorTool, icon: <Circle className="w-3.5 h-3.5" />, label: "Cercle" },
          { tool: "triangle" as EditorTool, icon: <Triangle className="w-3.5 h-3.5" />, label: "Triangle" },
          { tool: "arrow" as EditorTool, icon: <ArrowRight className="w-3.5 h-3.5" />, label: "Flèche" },
          { tool: "line" as EditorTool, icon: <Minus className="w-3.5 h-3.5" />, label: "Ligne" },
          { tool: "table" as EditorTool, icon: <TableIcon className="w-3.5 h-3.5" />, label: "Tableau" },
          { tool: "chart" as EditorTool, icon: <BarChart3 className="w-3.5 h-3.5" />, label: "Graphique" },
        ] as { tool: EditorTool; icon: React.ReactNode; label: string }[]
      ).map(({ tool, icon, label }) => (
        <button
          key={tool}
          onClick={() => onToolChange(tool)}
          title={label}
          className={`flex items-center justify-center w-7 h-7 rounded transition-colors ${
            activeTool === tool ? "bg-[#0944A1] text-white" : "text-gray-600 hover:bg-gray-100"
          }`}
        >
          {icon}
        </button>
      ))}

      {/* Image upload */}
      <button
        onClick={() => {
          if (onImageUpload) imageInputRef.current?.click();
          else onToolChange("image");
        }}
        title="Insérer une image (fichier)"
        className={`flex items-center justify-center w-7 h-7 rounded transition-colors ${
          activeTool === "image" ? "bg-[#0944A1] text-white" : "text-gray-600 hover:bg-gray-100"
        }`}
      >
        <ImageIcon className="w-3.5 h-3.5" />
      </button>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && onImageUpload) onImageUpload(file);
          e.target.value = "";
        }}
      />
      {/* Image from URL */}
      <button
        onClick={() => {
          const url = prompt("URL de l'image :");
          if (url && url.trim()) {
            onUpdateElement({ type: "image", imageUrl: url.trim() } as Partial<SlideElement>);
            // If no element is selected, this creates a new one via onImageUpload path
            if (!selectedElement && onImageUpload) {
              // Fetch the image and pass as file
              fetch(`/api/deck/proxy-image?url=${encodeURIComponent(url.trim())}`)
                .then(res => res.blob())
                .then(blob => {
                  const file = new File([blob], "image-from-url.jpg", { type: blob.type || "image/jpeg" });
                  onImageUpload(file);
                })
                .catch(() => alert("Impossible de charger l'image depuis cette URL."));
            }
          }
        }}
        title="Insérer une image depuis une URL"
        className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 transition-colors"
      >
        <Link className="w-3.5 h-3.5" />
      </button>

      <div className="h-5 w-px bg-gray-200 mx-1" />

      <button
        onClick={onDuplicateElement}
        disabled={!selectedElement}
        title="Dupliquer (Ctrl+D)"
        className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30 transition-colors"
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={onBringToFront}
        disabled={!selectedElement}
        title="Mettre au premier plan"
        className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30 transition-colors"
      >
        <BringToFront className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={onSendToBack}
        disabled={!selectedElement}
        title="Envoyer en arrière-plan"
        className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30 transition-colors"
      >
        <SendToBack className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={onDeleteElement}
        disabled={!selectedElement}
        title="Supprimer l'élément (Delete)"
        className="flex items-center justify-center w-7 h-7 rounded text-red-400 hover:bg-red-50 disabled:opacity-30 transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>

      {/* Copy/Paste (always available when clipboard has content or selection exists) */}
      <div className="h-5 w-px bg-gray-200 mx-1" />
      <button
        onClick={onCopy}
        disabled={!selectedElement}
        title="Copier (Ctrl+C)"
        className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30 transition-colors text-[10px] font-semibold"
      >
        ⎘
      </button>
      <button
        onClick={onPaste}
        title="Coller (Ctrl+V)"
        className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 transition-colors text-[10px] font-semibold"
      >
        ⎗
      </button>

      {/* Align / Distribute — active when ≥2 selected */}
      {hasMulti && (
        <>
          <div className="h-5 w-px bg-gray-200 mx-1" />
          <span className="text-[10px] text-[#0944A1] font-semibold px-1">
            {selectionCount} éléments
          </span>
          <button onClick={() => onAlign?.("left")} title="Aligner à gauche" className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 transition-colors">
            <AlignHorizontalJustifyStart className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onAlign?.("center-h")} title="Centrer horizontalement" className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 transition-colors">
            <AlignHorizontalJustifyCenter className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onAlign?.("right")} title="Aligner à droite" className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 transition-colors">
            <AlignHorizontalJustifyEnd className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onAlign?.("top")} title="Aligner en haut" className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 transition-colors">
            <AlignVerticalJustifyStart className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onAlign?.("center-v")} title="Centrer verticalement" className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 transition-colors">
            <AlignVerticalJustifyCenter className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onAlign?.("bottom")} title="Aligner en bas" className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 transition-colors">
            <AlignVerticalJustifyEnd className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDistribute?.("h")}
            disabled={!hasTri}
            title="Répartir horizontalement"
            className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30 transition-colors"
          >
            <AlignHorizontalDistributeCenter className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDistribute?.("v")}
            disabled={!hasTri}
            title="Répartir verticalement"
            className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30 transition-colors"
          >
            <AlignVerticalDistributeCenter className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onGroup}
            title="Grouper (Ctrl+G)"
            className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <Group className="w-3.5 h-3.5" />
          </button>
        </>
      )}
      {selectedElement?.groupId && (
        <button
          onClick={onUngroup}
          title="Dégrouper (Ctrl+Shift+G)"
          className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:bg-gray-100 transition-colors"
        >
          <Ungroup className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Ask AI — always available when a selection exists */}
      {selectedElement && onAskAi && (
        <>
          <div className="h-5 w-px bg-gray-200 mx-1" />
          <button
            onClick={onAskAi}
            title="Demander à l'IA d'éditer la sélection"
            className="flex items-center gap-1 px-2 h-7 rounded bg-gradient-to-r from-[#0944A1] to-[#2CA6F9] text-white hover:opacity-90 transition-opacity text-[10px] font-semibold"
          >
            <Sparkles className="w-3 h-3" />
            Ask AI
          </button>
        </>
      )}

      {selectedElement && (
        <>
          <div className="h-5 w-px bg-gray-200 mx-1" />
          <div className="flex items-center gap-1.5 flex-wrap">
            {selectedElement.type !== "arrow" && (
              <label className="flex items-center gap-1 text-[10px] text-gray-500">
                Fond
                <input
                  type="color"
                  value={selectedElement.fillColor === "transparent" ? "#ffffff" : selectedElement.fillColor}
                  onChange={(e) => onUpdateElement({ fillColor: e.target.value })}
                  className="w-6 h-6 rounded cursor-pointer border border-gray-300 p-0"
                />
              </label>
            )}

            <label className="flex items-center gap-1 text-[10px] text-gray-500">
              Bord
              <input
                type="color"
                value={selectedElement.strokeColor}
                onChange={(e) => onUpdateElement({ strokeColor: e.target.value })}
                className="w-6 h-6 rounded cursor-pointer border border-gray-300 p-0"
              />
            </label>

            <label className="flex items-center gap-1 text-[10px] text-gray-500">
              ép.
              <input
                type="number"
                value={selectedElement.strokeWidth}
                onChange={(e) => onUpdateElement({ strokeWidth: Math.max(0, Math.min(10, Number(e.target.value))) })}
                min={0}
                max={10}
                className="w-9 h-5 text-[10px] border border-gray-300 rounded px-1 text-center"
              />
            </label>

            <label className="flex items-center gap-1 text-[10px] text-gray-500">
              opacité
              <input
                type="number"
                value={Math.round(selectedElement.opacity * 100)}
                onChange={(e) => onUpdateElement({ opacity: Math.max(0, Math.min(100, Number(e.target.value))) / 100 })}
                min={0}
                max={100}
                className="w-11 h-5 text-[10px] border border-gray-300 rounded px-1 text-center"
              />
              %
            </label>

            <label className="flex items-center gap-1 text-[10px] text-gray-500">
              <RotateCw className="w-3 h-3" />
              <input
                type="number"
                value={Math.round(selectedElement.rotation ?? 0)}
                onChange={(e) => onUpdateElement({ rotation: Number(e.target.value) % 360 })}
                min={-360}
                max={360}
                className="w-12 h-5 text-[10px] border border-gray-300 rounded px-1 text-center"
                title="Rotation (degrés)"
              />
              °
            </label>

            {selectedElement.type === "rect" && (
              <label className="flex items-center gap-1 text-[10px] text-gray-500">
                radius
                <input
                  type="number"
                  value={selectedElement.borderRadius ?? 4}
                  onChange={(e) => onUpdateElement({ borderRadius: Math.max(0, Math.min(100, Number(e.target.value))) })}
                  min={0}
                  max={100}
                  className="w-10 h-5 text-[10px] border border-gray-300 rounded px-1 text-center"
                  title="Arrondi des coins (px)"
                />
                px
              </label>
            )}

            {selectedElement.type === "image" && (
              <>
                <div className="h-5 w-px bg-gray-200 mx-0.5" />
                <button
                  onClick={() => replaceImageInputRef.current?.click()}
                  title="Remplacer l'image"
                  className="flex items-center gap-1 px-1.5 h-5 rounded text-[10px] text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  <Replace className="w-3 h-3" />
                  Remplacer
                </button>
                <input
                  ref={replaceImageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onloadend = () => {
                        onUpdateElement({ imageUrl: reader.result as string });
                      };
                      reader.readAsDataURL(file);
                    }
                    e.target.value = "";
                  }}
                />
                <button
                  onClick={() => {
                    const url = prompt("Nouvelle URL de l'image :", selectedElement.imageUrl ?? "");
                    if (url && url.trim()) {
                      fetch(`/api/deck/proxy-image?url=${encodeURIComponent(url.trim())}`)
                        .then(res => res.blob())
                        .then(blob => {
                          const reader = new FileReader();
                          reader.onloadend = () => onUpdateElement({ imageUrl: reader.result as string });
                          reader.readAsDataURL(blob);
                        })
                        .catch(() => onUpdateElement({ imageUrl: url.trim() }));
                    }
                  }}
                  title="Changer l'URL de l'image"
                  className="flex items-center gap-1 px-1.5 h-5 rounded text-[10px] text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  <Link className="w-3 h-3" />
                  URL
                </button>
              </>
            )}

            {selectedElement.type === "table" && selectedElement.tableData && (
              <>
                <div className="h-5 w-px bg-gray-200 mx-0.5" />
                <button
                  onClick={() => {
                    const td = selectedElement.tableData!;
                    const newRow = Array(td.headers.length).fill("—");
                    onUpdateElement({ tableData: { ...td, rows: [...td.rows, newRow] } });
                  }}
                  title="Ajouter une ligne"
                  className="flex items-center gap-1 px-1.5 h-5 rounded text-[10px] text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  <Plus className="w-3 h-3" /> ligne
                </button>
                <button
                  onClick={() => {
                    const td = selectedElement.tableData!;
                    onUpdateElement({
                      tableData: {
                        headers: [...td.headers, "Colonne"],
                        rows: td.rows.map((r) => [...r, "—"]),
                      },
                    });
                  }}
                  title="Ajouter une colonne"
                  className="flex items-center gap-1 px-1.5 h-5 rounded text-[10px] text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  <Plus className="w-3 h-3" /> col
                </button>
                <label className="flex items-center gap-1 text-[10px] text-gray-500" title="Fond entête">
                  entête
                  <input
                    type="color"
                    value={selectedElement.tableStyle?.headerBg ?? DEFAULT_TABLE_STYLE.headerBg}
                    onChange={(e) => onUpdateElement({ tableStyle: { ...selectedElement.tableStyle, headerBg: e.target.value } })}
                    className="w-5 h-5 rounded cursor-pointer border border-gray-300 p-0"
                  />
                </label>
              </>
            )}

            {selectedElement.type === "chart" && (
              <>
                <div className="h-5 w-px bg-gray-200 mx-0.5" />
                <select
                  value={selectedElement.chartType ?? "bar"}
                  onChange={(e) => onUpdateElement({ chartType: e.target.value as "bar" | "line" | "pie" })}
                  className="text-[10px] border border-gray-300 rounded px-1 h-5 bg-white"
                  title="Type de graphique"
                >
                  <option value="bar">Barres</option>
                  <option value="line">Lignes</option>
                  <option value="pie">Camembert</option>
                </select>
                <input
                  type="text"
                  value={selectedElement.chartTitle ?? ""}
                  onChange={(e) => onUpdateElement({ chartTitle: e.target.value })}
                  placeholder="Titre"
                  className="w-24 h-5 text-[10px] border border-gray-300 rounded px-1"
                />
                <select
                  value={selectedElement.chartSource ? `${selectedElement.chartSource.field}:${selectedElement.chartSource.valueKey}` : ""}
                  onChange={(e) => {
                    if (!e.target.value) {
                      onUpdateElement({ chartSource: undefined });
                      return;
                    }
                    const [field, valueKey] = e.target.value.split(":");
                    // Pick a sensible label key per source
                    const labelKey =
                      field === "metaCampaigns" || field === "googleCampaigns" ? "name" :
                      field === "topCreatives" ? "name" :
                      field === "globalTable" ? "platform" :
                      "label";
                    onUpdateElement({ chartSource: { field, labelKey, valueKey } });
                  }}
                  title="Source de données (live)"
                  className="text-[10px] border border-gray-300 rounded px-1 h-5 bg-white"
                >
                  <option value="">Statique</option>
                  <option value="metaCampaigns:spend">Meta · Spend par campagne</option>
                  <option value="metaCampaigns:roas">Meta · ROAS par campagne</option>
                  <option value="metaCampaigns:ctr">Meta · CTR par campagne</option>
                  <option value="googleCampaigns:spend">Google · Spend par campagne</option>
                  <option value="googleCampaigns:roas">Google · ROAS par campagne</option>
                  <option value="topCreatives:spend">Top créatifs · Spend</option>
                  <option value="topCreatives:roas">Top créatifs · ROAS</option>
                  <option value="globalTable:spend">Total · Spend par plateforme</option>
                </select>
              </>
            )}

            {selectedElement.type === "text" && (
              <>
                <div className="h-5 w-px bg-gray-200 mx-0.5" />
                <label className="flex items-center gap-1 text-[10px] text-gray-500">
                  <input
                    type="color"
                    value={selectedElement.textColor ?? "#1a1a1a"}
                    onChange={(e) => onUpdateElement({ textColor: e.target.value })}
                    className="w-6 h-6 rounded cursor-pointer border border-gray-300 p-0"
                    title="Couleur du texte"
                  />
                </label>

                <select
                  value={selectedElement.fontFamily ?? "Inter, sans-serif"}
                  onChange={(e) => onUpdateElement({ fontFamily: e.target.value })}
                  className="text-[10px] border border-gray-300 rounded px-1 h-5 bg-white"
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>

                <input
                  type="number"
                  value={selectedElement.fontSize ?? 14}
                  onChange={(e) => onUpdateElement({ fontSize: Math.max(6, Math.min(96, Number(e.target.value))) })}
                  min={6}
                  max={96}
                  className="w-12 h-5 text-[10px] border border-gray-300 rounded px-1 text-center"
                  title="Taille de police"
                />

                <button
                  onClick={() => onUpdateElement({ fontWeight: selectedElement.fontWeight === "bold" ? "normal" : "bold" })}
                  className={`w-6 h-5 rounded flex items-center justify-center transition-colors ${selectedElement.fontWeight === "bold" ? "bg-gray-200" : "hover:bg-gray-100"}`}
                  title="Gras"
                >
                  <Bold className="w-3 h-3" />
                </button>
                <button
                  onClick={() => onUpdateElement({ fontStyle: selectedElement.fontStyle === "italic" ? "normal" : "italic" })}
                  className={`w-6 h-5 rounded flex items-center justify-center transition-colors ${selectedElement.fontStyle === "italic" ? "bg-gray-200" : "hover:bg-gray-100"}`}
                  title="Italique"
                >
                  <Italic className="w-3 h-3" />
                </button>
                <button
                  onClick={() => onUpdateElement({ textDecoration: selectedElement.textDecoration === "underline" ? "none" : "underline" })}
                  className={`w-6 h-5 rounded flex items-center justify-center transition-colors ${selectedElement.textDecoration === "underline" ? "bg-gray-200" : "hover:bg-gray-100"}`}
                  title="Souligné"
                >
                  <Underline className="w-3 h-3" />
                </button>

                {(["left", "center", "right"] as const).map((align) => {
                  const icons = {
                    left: <AlignLeft className="w-3 h-3" />,
                    center: <AlignCenter className="w-3 h-3" />,
                    right: <AlignRight className="w-3 h-3" />,
                  };
                  return (
                    <button
                      key={align}
                      onClick={() => onUpdateElement({ textAlign: align })}
                      className={`w-6 h-5 rounded flex items-center justify-center transition-colors ${selectedElement.textAlign === align ? "bg-gray-200" : "hover:bg-gray-100"}`}
                    >
                      {icons[align]}
                    </button>
                  );
                })}

                <div className="h-5 w-px bg-gray-200 mx-0.5" />

                <label className="flex items-center gap-1 text-[10px] text-gray-500" title="Interligne">
                  ≡
                  <input
                    type="number"
                    value={selectedElement.lineHeight ?? 1.4}
                    onChange={(e) => onUpdateElement({ lineHeight: Math.max(0.8, Math.min(4, Number(e.target.value))) })}
                    min={0.8}
                    max={4}
                    step={0.1}
                    className="w-12 h-5 text-[10px] border border-gray-300 rounded px-1 text-center"
                  />
                </label>

                <label className="flex items-center gap-1 text-[10px] text-gray-500" title="Espacement lettres">
                  AV
                  <input
                    type="number"
                    value={selectedElement.letterSpacing ?? 0}
                    onChange={(e) => onUpdateElement({ letterSpacing: Number(e.target.value) })}
                    min={-5}
                    max={20}
                    step={0.5}
                    className="w-12 h-5 text-[10px] border border-gray-300 rounded px-1 text-center"
                  />
                  px
                </label>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Table renderer ────────────────────────────────────────────────────────────
function TableElementRenderer({
  el,
  isEditing,
  onTableChange,
}: {
  el: SlideElement;
  isEditing: boolean;
  onTableChange?: (data: TableCellData) => void;
}) {
  const style = { ...DEFAULT_TABLE_STYLE, ...(el.tableStyle ?? {}) };
  const data = el.tableData ?? { headers: [], rows: [] };
  const updateCell = (isHeader: boolean, row: number, col: number, value: string) => {
    if (!onTableChange) return;
    if (isHeader) {
      const headers = [...data.headers];
      headers[col] = value;
      onTableChange({ ...data, headers });
    } else {
      const rows = data.rows.map((r, i) => (i === row ? r.map((c, j) => (j === col ? value : c)) : r));
      onTableChange({ ...data, rows });
    }
  };
  return (
    <table
      style={{
        width: "100%", height: "100%",
        borderCollapse: "collapse", tableLayout: "fixed",
        fontSize: style.fontSize, fontFamily: "Inter, sans-serif",
      }}
    >
      <thead>
        <tr>
          {data.headers.map((h, i) => (
            <th
              key={i}
              contentEditable={isEditing}
              suppressContentEditableWarning
              onBlur={(e) => updateCell(true, 0, i, (e.target as HTMLElement).textContent ?? "")}
              style={{
                background: style.headerBg, color: style.headerText,
                padding: "4px 8px", textAlign: "left",
                border: `1px solid ${style.borderColor}`, fontWeight: 600,
                outline: isEditing ? `1px dashed ${style.headerText}` : "none",
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td
                key={j}
                contentEditable={isEditing}
                suppressContentEditableWarning
                onBlur={(e) => updateCell(false, i, j, (e.target as HTMLElement).textContent ?? "")}
                style={{
                  background: i % 2 === 0 ? style.rowBg : style.altRowBg,
                  color: style.rowText,
                  padding: "3px 8px",
                  border: `1px solid ${style.borderColor}`,
                  outline: isEditing ? `1px dashed ${style.borderColor}` : "none",
                }}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Chart renderer (Recharts) ─────────────────────────────────────────────────
// Lazy-loaded to keep the editor bundle lean — Recharts is ~50KB gzipped.
const LazyChart = dynamic(() => import("./chart-element").then((m) => m.ChartElement), {
  ssr: false,
  loading: () => <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">Graphique…</div>,
});

function ChartElementRenderer({ el }: { el: SlideElement }) {
  return (
    <div style={{ width: "100%", height: "100%", padding: 6, boxSizing: "border-box" }}>
      <LazyChart el={el} />
    </div>
  );
}

// ── SlideElementItem ──────────────────────────────────────────────────────────

type ResizeHandleId = "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r";

interface SlideElementItemProps {
  el: SlideElement;
  isSelected: boolean;
  isEditing: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onTextChange: (text: string) => void;
  onTableChange?: (data: TableCellData) => void;
  onBlur: () => void;
  onResizeMouseDown: (e: React.MouseEvent, handle: ResizeHandleId) => void;
}

export function SlideElementItem({
  el,
  isSelected,
  isEditing,
  onMouseDown,
  onDoubleClick,
  onTextChange,
  onTableChange,
  onBlur,
  onResizeMouseDown,
}: SlideElementItemProps) {
  const wrapperStyle: React.CSSProperties = {
    position: "absolute",
    left: `${el.x}%`,
    top: `${el.y}%`,
    width: `${el.w}%`,
    height: `${el.h}%`,
    opacity: el.opacity,
    zIndex: isSelected ? 30 : 20,
    cursor: "grab",
    boxSizing: "border-box",
    transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
    transformOrigin: "center center",
  };

  const shapeStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
  };

  const renderShape = () => {
    switch (el.type) {
      case "rect":
        return (
          <div
            style={{
              ...shapeStyle,
              backgroundColor: el.fillColor === "transparent" ? "transparent" : el.fillColor,
              border: `${el.strokeWidth}px solid ${el.strokeColor}`,
              borderRadius: el.borderRadius ?? 4,
            }}
          />
        );
      case "circle":
        return (
          <div
            style={{
              ...shapeStyle,
              backgroundColor: el.fillColor === "transparent" ? "transparent" : el.fillColor,
              border: `${el.strokeWidth}px solid ${el.strokeColor}`,
              borderRadius: "50%",
            }}
          />
        );
      case "arrow":
        return (
          <svg width="100%" height="100%" viewBox="0 0 100 20" preserveAspectRatio="none" style={{ overflow: "visible" }}>
            <defs>
              <marker id={`arrow-${el.id}`} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                <path d="M0,0 L0,8 L8,4 z" fill={el.strokeColor} />
              </marker>
            </defs>
            <line x1="2" y1="10" x2="94" y2="10" stroke={el.strokeColor} strokeWidth={el.strokeWidth} markerEnd={`url(#arrow-${el.id})`} />
          </svg>
        );
      case "triangle":
        return (
          <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
            <polygon
              points="50,2 98,98 2,98"
              fill={el.fillColor === "transparent" ? "transparent" : el.fillColor}
              stroke={el.strokeColor}
              strokeWidth={el.strokeWidth}
            />
          </svg>
        );
      case "line":
        return (
          <svg width="100%" height="100%" viewBox="0 0 100 10" preserveAspectRatio="none">
            <line x1="0" y1="5" x2="100" y2="5" stroke={el.strokeColor} strokeWidth={el.strokeWidth * 2} />
          </svg>
        );
      case "image":
        return el.imageUrl ? (
          <img
            src={el.imageUrl}
            alt=""
            style={{ ...shapeStyle, objectFit: "contain", display: "block" }}
            draggable={false}
          />
        ) : (
          <div
            style={{
              ...shapeStyle,
              border: `2px dashed ${el.strokeColor}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#9ca3af",
              fontSize: 11,
            }}
          >
            Image
          </div>
        );
      case "table":
        return <TableElementRenderer el={el} isEditing={isEditing} onTableChange={onTableChange} />;
      case "chart":
        return <ChartElementRenderer el={el} />;
      case "text":
        if (isEditing) {
          return (
            <div
              contentEditable
              suppressContentEditableWarning
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onInput={(e) => onTextChange((e.target as HTMLDivElement).textContent ?? "")}
              onBlur={onBlur}
              style={{
                ...shapeStyle,
                outline: "none",
                color: el.textColor ?? "#1a1a1a",
                fontFamily: el.fontFamily ?? "Inter, sans-serif",
                fontSize: `${el.fontSize ?? 14}px`,
                fontWeight: el.fontWeight ?? "normal",
                fontStyle: el.fontStyle ?? "normal",
                textDecoration: el.textDecoration ?? "none",
                textAlign: el.textAlign ?? "left",
                lineHeight: el.lineHeight ?? 1.4,
                letterSpacing: el.letterSpacing ? `${el.letterSpacing}px` : undefined,
                border: `${el.strokeWidth}px dashed ${el.strokeColor}`,
                padding: "2px 4px",
                wordBreak: "break-word",
                whiteSpace: "pre-wrap",
              }}
            >
              {el.text ?? ""}
            </div>
          );
        }
        return (
          <div
            style={{
              ...shapeStyle,
              color: el.textColor ?? "#1a1a1a",
              fontFamily: el.fontFamily ?? "Inter, sans-serif",
              fontSize: `${el.fontSize ?? 14}px`,
              fontWeight: el.fontWeight ?? "normal",
              fontStyle: el.fontStyle ?? "normal",
              textDecoration: el.textDecoration ?? "none",
              textAlign: el.textAlign ?? "left",
              lineHeight: el.lineHeight ?? 1.4,
              letterSpacing: el.letterSpacing ? `${el.letterSpacing}px` : undefined,
              border: isSelected ? `${el.strokeWidth}px dashed ${el.strokeColor}` : "none",
              padding: "2px 4px",
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
            }}
          >
            {el.text ?? ""}
          </div>
        );
    }
  };

  return (
    <div style={wrapperStyle} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      {isSelected && (
        <div
          style={{
            position: "absolute",
            inset: -2,
            border: "2px dashed #2CA6F9",
            borderRadius: el.type === "circle" ? "50%" : 4,
            pointerEvents: "none",
            zIndex: 31,
          }}
        />
      )}
      {renderShape()}
      {isSelected && (() => {
        const handles: { id: ResizeHandleId; top?: string | number; left?: string | number; bottom?: string | number; right?: string | number; cursor: string }[] = [
          { id: "tl", top: -4, left: -4, cursor: "nwse-resize" },
          { id: "tr", top: -4, right: -4, cursor: "nesw-resize" },
          { id: "bl", bottom: -4, left: -4, cursor: "nesw-resize" },
          { id: "br", bottom: -4, right: -4, cursor: "nwse-resize" },
          { id: "t", top: -4, left: "calc(50% - 5px)", cursor: "ns-resize" },
          { id: "b", bottom: -4, left: "calc(50% - 5px)", cursor: "ns-resize" },
          { id: "l", left: -4, top: "calc(50% - 5px)", cursor: "ew-resize" },
          { id: "r", right: -4, top: "calc(50% - 5px)", cursor: "ew-resize" },
        ];
        return handles.map((h) => (
          <div
            key={h.id}
            onMouseDown={(e) => onResizeMouseDown(e, h.id)}
            style={{
              position: "absolute",
              top: h.top,
              left: h.left,
              right: h.right,
              bottom: h.bottom,
              width: 10,
              height: 10,
              background: "#2CA6F9",
              border: "2px solid white",
              borderRadius: 2,
              cursor: h.cursor,
              zIndex: 32,
            }}
          />
        ));
      })()}
    </div>
  );
}

// ── useSlideEditor hook ───────────────────────────────────────────────────────

// Module-level cross-slide clipboard so elements can be pasted into any slide.
const editorClipboard: { elements: SlideElement[] } = { elements: [] };

export interface Marquee {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function useSlideEditor(
  canvasRef: React.RefObject<HTMLDivElement | null>,
  elements: SlideElement[],
  onChange: (els: SlideElement[]) => void
) {
  const [activeTool, setActiveTool] = useState<EditorTool>("select");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [snapGuide, setSnapGuide] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });

  // Primary selection = last element added to the selection (drives toolbar)
  const selectedId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIds(id ? [id] : []);
  }, []);

  // Undo/redo history
  const historyRef = useRef<SlideElement[][]>([]);
  const historyIndexRef = useRef<number>(-1);
  const [historyLen, setHistoryLen] = useState(0); // trigger re-render when history changes

  // Seed history with initial state so first action has something to undo to
  useEffect(() => {
    if (historyRef.current.length === 0) {
      historyRef.current.push(elements);
      historyIndexRef.current = 0;
      setHistoryLen(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pushHistory = useCallback((newEls: SlideElement[]) => {
    // Truncate forward history
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
    historyRef.current.push(newEls);
    if (historyRef.current.length > 50) historyRef.current.shift();
    historyIndexRef.current = historyRef.current.length - 1;
    setHistoryLen(historyRef.current.length);
  }, []);

  const changeWithHistory = useCallback((newEls: SlideElement[]) => {
    pushHistory(newEls);
    onChange(newEls);
  }, [pushHistory, onChange]);

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    const prev = historyRef.current[historyIndexRef.current];
    setHistoryLen(historyRef.current.length);
    onChange(prev);
  }, [onChange]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    const next = historyRef.current[historyIndexRef.current];
    setHistoryLen(historyRef.current.length);
    onChange(next);
  }, [onChange]);

  const canUndo = historyLen > 0 && historyIndexRef.current > 0;
  const canRedo = historyLen > 0 && historyIndexRef.current < historyRef.current.length - 1;

  type ResizeHandle = "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r";
  // Drag: supports 8-handle resize AND multi-element move (primary drives snap, others follow delta).
  const dragRef = useRef<{
    type: "move" | "resize" | "marquee";
    id: string; // primary id for move/resize
    handle?: ResizeHandle;
    startX: number;
    startY: number;
    origX: number; // % origin of primary for move/resize OR marquee start x
    origY: number;
    origW: number;
    origH: number;
    // For multi-move: snapshot of original positions for each dragged element
    origPositions?: Map<string, { x: number; y: number }>;
    moved?: boolean;
  } | null>(null);

  const [activeGuides, setActiveGuides] = useState<{ vertical: number[]; horizontal: number[] }>({
    vertical: [],
    horizontal: [],
  });

  // Expand a set of ids to include every element sharing a groupId with any of them.
  const expandGroupIds = useCallback(
    (ids: string[]): string[] => {
      const out = new Set(ids);
      const groupIds = new Set<string>();
      for (const el of elements) {
        if (out.has(el.id) && el.groupId) groupIds.add(el.groupId);
      }
      for (const el of elements) {
        if (el.groupId && groupIds.has(el.groupId)) out.add(el.id);
      }
      return [...out];
    },
    [elements]
  );

  const selectedElement = elements.find((e) => e.id === selectedId) ?? null;
  const selectedElements = elements.filter((e) => selectedIds.includes(e.id));

  const updateEl = useCallback(
    (id: string, patch: Partial<SlideElement>) => {
      const newEls = elements.map((e) => (e.id === id ? { ...e, ...patch } : e));
      onChange(newEls);
    },
    [elements, onChange]
  );

  const updateElWithHistory = useCallback(
    (id: string, patch: Partial<SlideElement>) => {
      const newEls = elements.map((e) => (e.id === id ? { ...e, ...patch } : e));
      changeWithHistory(newEls);
    },
    [elements, changeWithHistory]
  );

  // Apply a patch to every currently-selected element. Useful for bulk style ops and AI tools.
  const updateSelected = useCallback(
    (patch: Partial<SlideElement>) => {
      if (selectedIds.length === 0) return;
      const sel = new Set(selectedIds);
      const newEls = elements.map((e) => (sel.has(e.id) ? { ...e, ...patch } : e));
      changeWithHistory(newEls);
    },
    [selectedIds, elements, changeWithHistory]
  );

  const deleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    const sel = new Set(selectedIds);
    changeWithHistory(elements.filter((e) => !sel.has(e.id)));
    setSelectedIds([]);
  }, [selectedIds, elements, changeWithHistory]);

  const duplicateSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    const sel = new Set(selectedIds);
    const copies = elements
      .filter((e) => sel.has(e.id))
      .map((el) => ({ ...el, id: crypto.randomUUID(), x: el.x + 3, y: el.y + 3 }));
    if (copies.length === 0) return;
    changeWithHistory([...elements, ...copies]);
    setSelectedIds(copies.map((c) => c.id));
  }, [selectedIds, elements, changeWithHistory]);

  const bringToFront = useCallback(() => {
    if (selectedIds.length === 0) return;
    const sel = new Set(selectedIds);
    const front = elements.filter((e) => sel.has(e.id));
    const rest = elements.filter((e) => !sel.has(e.id));
    changeWithHistory([...rest, ...front]);
  }, [selectedIds, elements, changeWithHistory]);

  const sendToBack = useCallback(() => {
    if (selectedIds.length === 0) return;
    const sel = new Set(selectedIds);
    const back = elements.filter((e) => sel.has(e.id));
    const rest = elements.filter((e) => !sel.has(e.id));
    changeWithHistory([...back, ...rest]);
  }, [selectedIds, elements, changeWithHistory]);

  // ── Align & distribute ──────────────────────────────────────────────────────
  const alignSelected = useCallback(
    (axis: AlignAxis) => {
      if (selectedIds.length < 2) return;
      const sel = new Set(selectedIds);
      const targets = elements.filter((e) => sel.has(e.id));
      // Anchor = bounding box of the whole selection
      const minX = Math.min(...targets.map((t) => t.x));
      const minY = Math.min(...targets.map((t) => t.y));
      const maxX = Math.max(...targets.map((t) => t.x + t.w));
      const maxY = Math.max(...targets.map((t) => t.y + t.h));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const newEls = elements.map((e) => {
        if (!sel.has(e.id)) return e;
        switch (axis) {
          case "left": return { ...e, x: minX };
          case "center-h": return { ...e, x: cx - e.w / 2 };
          case "right": return { ...e, x: maxX - e.w };
          case "top": return { ...e, y: minY };
          case "center-v": return { ...e, y: cy - e.h / 2 };
          case "bottom": return { ...e, y: maxY - e.h };
        }
      });
      changeWithHistory(newEls);
    },
    [selectedIds, elements, changeWithHistory]
  );

  const distributeSelected = useCallback(
    (axis: DistributeAxis) => {
      if (selectedIds.length < 3) return;
      const sel = new Set(selectedIds);
      const sorted = elements
        .filter((e) => sel.has(e.id))
        .sort((a, b) => (axis === "h" ? a.x - b.x : a.y - b.y));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const firstCenter = axis === "h" ? first.x + first.w / 2 : first.y + first.h / 2;
      const lastCenter = axis === "h" ? last.x + last.w / 2 : last.y + last.h / 2;
      const step = (lastCenter - firstCenter) / (sorted.length - 1);
      const targetById = new Map<string, number>();
      sorted.forEach((el, i) => {
        const center = firstCenter + step * i;
        targetById.set(el.id, axis === "h" ? center - el.w / 2 : center - el.h / 2);
      });
      const newEls = elements.map((e) => {
        if (!sel.has(e.id)) return e;
        const v = targetById.get(e.id);
        if (v === undefined) return e;
        return axis === "h" ? { ...e, x: v } : { ...e, y: v };
      });
      changeWithHistory(newEls);
    },
    [selectedIds, elements, changeWithHistory]
  );

  // ── Group / ungroup ─────────────────────────────────────────────────────────
  const groupSelected = useCallback(() => {
    if (selectedIds.length < 2) return;
    const groupId = `g-${crypto.randomUUID().slice(0, 8)}`;
    const sel = new Set(selectedIds);
    const newEls = elements.map((e) => (sel.has(e.id) ? { ...e, groupId } : e));
    changeWithHistory(newEls);
  }, [selectedIds, elements, changeWithHistory]);

  const ungroupSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    const sel = new Set(selectedIds);
    // Collect every groupId present in the selection, then strip groupId
    // from all members of those groups (not just the selected ones).
    const touchedGroups = new Set<string>();
    for (const e of elements) if (sel.has(e.id) && e.groupId) touchedGroups.add(e.groupId);
    if (touchedGroups.size === 0) return;
    const newEls = elements.map((e) => {
      if (e.groupId && touchedGroups.has(e.groupId)) {
        const { groupId: _g, ...rest } = e;
        void _g;
        return rest as SlideElement;
      }
      return e;
    });
    changeWithHistory(newEls);
  }, [selectedIds, elements, changeWithHistory]);

  // ── Clipboard ────────────────────────────────────────────────────────────────
  const copySelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    const sel = new Set(selectedIds);
    editorClipboard.elements = elements.filter((e) => sel.has(e.id)).map((e) => ({ ...e }));
  }, [selectedIds, elements]);

  const cutSelected = useCallback(() => {
    copySelected();
    deleteSelected();
  }, [copySelected, deleteSelected]);

  const pasteClipboard = useCallback(() => {
    if (editorClipboard.elements.length === 0) return;
    // Preserve group membership inside the paste, but give each pasted group a fresh id.
    const groupMap = new Map<string, string>();
    const pasted = editorClipboard.elements.map((el) => {
      let newGroup: string | undefined;
      if (el.groupId) {
        newGroup = groupMap.get(el.groupId);
        if (!newGroup) {
          newGroup = `g-${crypto.randomUUID().slice(0, 8)}`;
          groupMap.set(el.groupId, newGroup);
        }
      }
      return { ...el, id: crypto.randomUUID(), x: el.x + 2, y: el.y + 2, groupId: newGroup };
    });
    changeWithHistory([...elements, ...pasted]);
    setSelectedIds(pasted.map((p) => p.id));
  }, [elements, changeWithHistory]);

  // ── Nudge with arrow keys ────────────────────────────────────────────────────
  const nudgeSelected = useCallback(
    (dx: number, dy: number) => {
      if (selectedIds.length === 0) return;
      const sel = new Set(selectedIds);
      const newEls = elements.map((e) => (sel.has(e.id) ? { ...e, x: e.x + dx, y: e.y + dy } : e));
      onChange(newEls);
    },
    [selectedIds, elements, onChange]
  );

  const handleImageUpload = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const imageUrl = ev.target?.result as string;
      const el = createDefaultElement("image", 20, 20);
      el.imageUrl = imageUrl;
      const newEls = [...elements, el];
      changeWithHistory(newEls);
      setSelectedId(el.id);
      setActiveTool("select");
    };
    reader.readAsDataURL(file);
  }, [elements, changeWithHistory, setSelectedId]);

  // Keyboard: delete, undo/redo, copy/cut/paste, group/ungroup, select-all, nudge.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inInput =
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA" ||
        (document.activeElement as HTMLElement)?.isContentEditable;
      if (inInput) return;
      const mod = e.ctrlKey || e.metaKey;

      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.length > 0) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "Escape") {
        setSelectedIds([]);
        setEditingId(null);
      } else if (mod && e.key === "d") {
        e.preventDefault();
        duplicateSelected();
      } else if (mod && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((mod && e.key === "y") || (mod && e.shiftKey && e.key === "z")) {
        e.preventDefault();
        redo();
      } else if (mod && e.key === "c") {
        e.preventDefault();
        copySelected();
      } else if (mod && e.key === "x") {
        e.preventDefault();
        cutSelected();
      } else if (mod && e.key === "v") {
        e.preventDefault();
        pasteClipboard();
      } else if (mod && e.key === "a") {
        e.preventDefault();
        setSelectedIds(elements.map((el) => el.id));
      } else if (mod && e.key === "g" && !e.shiftKey) {
        e.preventDefault();
        groupSelected();
      } else if (mod && e.shiftKey && e.key === "g") {
        e.preventDefault();
        ungroupSelected();
      } else if (selectedIds.length > 0 && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? SNAP_GRID_STEP : 0.5;
        if (e.key === "ArrowUp") nudgeSelected(0, -step);
        if (e.key === "ArrowDown") nudgeSelected(0, step);
        if (e.key === "ArrowLeft") nudgeSelected(-step, 0);
        if (e.key === "ArrowRight") nudgeSelected(step, 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selectedIds, elements, deleteSelected, duplicateSelected, undo, redo,
    copySelected, cutSelected, pasteClipboard, groupSelected, ungroupSelected, nudgeSelected,
  ]);

  // Global mousemove/up: handle move (multi + snap), resize, marquee selection.
  useEffect(() => {
    const SNAP_TOL = 1.2; // % tolerance

    const computeSnap = (
      newX: number,
      newY: number,
      w: number,
      h: number,
      id: string
    ): { x: number; y: number; vGuides: number[]; hGuides: number[] } => {
      const others = elements.filter((e) => e.id !== id);
      const vTargets: number[] = [0, 50, 100];
      const hTargets: number[] = [0, 50, 100];
      others.forEach((e) => {
        vTargets.push(e.x, e.x + e.w / 2, e.x + e.w);
        hTargets.push(e.y, e.y + e.h / 2, e.y + e.h);
      });
      const elV = [newX, newX + w / 2, newX + w];
      const elH = [newY, newY + h / 2, newY + h];
      let bestX = { d: SNAP_TOL, delta: 0, line: 0, found: false };
      let bestY = { d: SNAP_TOL, delta: 0, line: 0, found: false };
      elV.forEach((v, i) => {
        vTargets.forEach((t) => {
          const d = Math.abs(v - t);
          if (d < bestX.d) bestX = { d, delta: t - v, line: t, found: true };
          else if (d === bestX.d && bestX.found) bestX = { ...bestX, line: t };
          void i;
        });
      });
      elH.forEach((v) => {
        hTargets.forEach((t) => {
          const d = Math.abs(v - t);
          if (d < bestY.d) bestY = { d, delta: t - v, line: t, found: true };
        });
      });
      return {
        x: bestX.found ? newX + bestX.delta : newX,
        y: bestY.found ? newY + bestY.delta : newY,
        vGuides: bestX.found ? [bestX.line] : [],
        hGuides: bestY.found ? [bestY.line] : [],
      };
    };

    const onMove = (e: MouseEvent) => {
      if (!dragRef.current || !canvasRef.current) return;
      const drag = dragRef.current;
      const rect = canvasRef.current.getBoundingClientRect();
      const dx = ((e.clientX - drag.startX) / rect.width) * 100;
      const dy = ((e.clientY - drag.startY) / rect.height) * 100;

      // ── Marquee selection ───────────────────────────────────────────────
      if (drag.type === "marquee") {
        const nx = Math.min(drag.origX, drag.origX + dx);
        const ny = Math.min(drag.origY, drag.origY + dy);
        const nw = Math.abs(dx);
        const nh = Math.abs(dy);
        setMarquee({ x: nx, y: ny, w: nw, h: nh });
        return;
      }

      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) drag.moved = true;

      // ── Move (multi-drag: primary drives snap, others follow same delta) ─
      if (drag.type === "move") {
        let nx = Math.max(0, Math.min(100 - drag.origW, drag.origX + dx));
        let ny = Math.max(0, Math.min(100 - drag.origH, drag.origY + dy));
        const snap = computeSnap(nx, ny, drag.origW, drag.origH, drag.id);
        nx = Math.max(0, Math.min(100 - drag.origW, snap.x));
        ny = Math.max(0, Math.min(100 - drag.origH, snap.y));
        setActiveGuides({ vertical: snap.vGuides, horizontal: snap.hGuides });

        const actualDX = nx - drag.origX;
        const actualDY = ny - drag.origY;
        const origs = drag.origPositions;
        if (origs && origs.size > 1) {
          // Multi-element drag: apply the same delta to every element in origPositions
          const newEls = elements.map((el) => {
            const o = origs.get(el.id);
            if (!o) return el;
            return {
              ...el,
              x: Math.max(0, Math.min(100 - el.w, o.x + actualDX)),
              y: Math.max(0, Math.min(100 - el.h, o.y + actualDY)),
            };
          });
          onChange(newEls);
        } else {
          updateEl(drag.id, { x: nx, y: ny });
        }
        return;
      }

      // ── Resize (8 handles, shift-aspect on corners) ─────────────────────
      const h = drag.handle ?? "br";
      let nx = drag.origX;
      let ny = drag.origY;
      let nw = drag.origW;
      let nh = drag.origH;
      const right = drag.origX + drag.origW;
      const bottom = drag.origY + drag.origH;
      if (h.includes("r")) nw = drag.origW + dx;
      if (h.includes("l")) { nx = drag.origX + dx; nw = right - nx; }
      if (h.includes("b")) nh = drag.origH + dy;
      if (h.includes("t")) { ny = drag.origY + dy; nh = bottom - ny; }
      if (e.shiftKey && drag.origW > 0 && drag.origH > 0) {
        const ratio = drag.origW / drag.origH;
        if (h === "tl" || h === "tr" || h === "bl" || h === "br") {
          if (Math.abs(nw / drag.origW - 1) > Math.abs(nh / drag.origH - 1)) {
            nh = nw / ratio;
            if (h.includes("t")) ny = bottom - nh;
          } else {
            nw = nh * ratio;
            if (h.includes("l")) nx = right - nw;
          }
        }
      }
      if (nw < 3) { nw = 3; if (h.includes("l")) nx = right - 3; }
      if (nh < 2) { nh = 2; if (h.includes("t")) ny = bottom - 2; }
      nx = Math.max(0, Math.min(100, nx));
      ny = Math.max(0, Math.min(100, ny));
      nw = Math.min(nw, 100 - nx);
      nh = Math.min(nh, 100 - ny);
      updateEl(drag.id, { x: nx, y: ny, w: nw, h: nh });
    };

    const onUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      setActiveGuides({ vertical: [], horizontal: [] });

      if (!drag) return;
      if (drag.type === "marquee") {
        if (marquee) {
          const m = marquee;
          const hit = elements.filter((el) => {
            const ex1 = el.x, ex2 = el.x + el.w;
            const ey1 = el.y, ey2 = el.y + el.h;
            return ex1 < m.x + m.w && ex2 > m.x && ey1 < m.y + m.h && ey2 > m.y;
          });
          if (hit.length > 0) setSelectedIds(expandGroupIds(hit.map((el) => el.id)));
        }
        setMarquee(null);
      } else if (drag.moved) {
        // Commit current elements state to history
        pushHistory(elements);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [elements, onChange, updateEl, canvasRef, marquee, pushHistory, expandGroupIds]);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (activeTool === "select" || activeTool === "image" || !canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      const el = createDefaultElement(activeTool as SlideElement["type"], x - 9, y - 5);
      const newEls = [...elements, el];
      changeWithHistory(newEls);
      setSelectedId(el.id);
      setActiveTool("select");
      if (activeTool === "text") setTimeout(() => setEditingId(el.id), 50);
    },
    [activeTool, canvasRef, elements, changeWithHistory, setSelectedId]
  );

  // Start a marquee selection on empty canvas (select tool only).
  // Elements & blocks stopPropagation in their own mouseDown, so any event reaching
  // the canvas handler means the user clicked on an empty region.
  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (activeTool !== "select" || !canvasRef.current) return;
      // Ignore right/middle clicks
      if (e.button !== 0) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      if (!e.shiftKey) setSelectedIds([]);
      dragRef.current = {
        type: "marquee",
        id: "",
        startX: e.clientX,
        startY: e.clientY,
        origX: x,
        origY: y,
        origW: 0,
        origH: 0,
      };
      setMarquee({ x, y, w: 0, h: 0 });
    },
    [activeTool, canvasRef]
  );

  const handleElementMouseDown = useCallback(
    (e: React.MouseEvent, el: SlideElement) => {
      e.stopPropagation();
      if (activeTool !== "select") return;

      // Decide the new selection set BEFORE starting the drag so "drag" moves the whole selection.
      let nextSelected: string[];
      if (e.shiftKey) {
        // Toggle this element in/out of the current selection
        nextSelected = selectedIds.includes(el.id)
          ? selectedIds.filter((id) => id !== el.id)
          : [...selectedIds, el.id];
      } else if (selectedIds.includes(el.id)) {
        // Keep the existing selection so we can drag multiple
        nextSelected = selectedIds;
      } else {
        nextSelected = [el.id];
      }
      // Expand to include other group members
      nextSelected = expandGroupIds(nextSelected);
      setSelectedIds(nextSelected);

      const origPositions = new Map<string, { x: number; y: number }>();
      for (const item of elements) {
        if (nextSelected.includes(item.id)) origPositions.set(item.id, { x: item.x, y: item.y });
      }
      dragRef.current = {
        type: "move",
        id: el.id,
        startX: e.clientX,
        startY: e.clientY,
        origX: el.x,
        origY: el.y,
        origW: el.w,
        origH: el.h,
        origPositions,
        moved: false,
      };
    },
    [activeTool, selectedIds, elements, expandGroupIds]
  );

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent, el: SlideElement, handle: ResizeHandle = "br") => {
      e.stopPropagation();
      dragRef.current = {
        type: "resize",
        id: el.id,
        handle,
        startX: e.clientX,
        startY: e.clientY,
        origX: el.x,
        origY: el.y,
        origW: el.w,
        origH: el.h,
        moved: false,
      };
    },
    []
  );

  const textEditSnapshotRef = useRef<string | null>(null);

  const handleElementDoubleClick = useCallback(
    (e: React.MouseEvent, el: SlideElement) => {
      e.stopPropagation();
      if (el.type === "text" || el.type === "table") {
        setSelectedId(el.id);
        setEditingId(el.id);
        textEditSnapshotRef.current = el.text ?? "";
      }
    },
    [setSelectedId]
  );

  const commitTextEdit = useCallback(() => {
    const id = editingId;
    setEditingId(null);
    if (id == null) return;
    const cur = elements.find((e) => e.id === id);
    if (cur && (cur.text ?? "") !== (textEditSnapshotRef.current ?? "")) {
      pushHistory(elements);
    }
    textEditSnapshotRef.current = null;
  }, [editingId, elements, pushHistory]);

  // Drag-and-drop image files onto the canvas
  const handleCanvasDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleCanvasDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    if (files.length === 0) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const dropX = rect ? ((e.clientX - rect.left) / rect.width) * 100 : 20;
    const dropY = rect ? ((e.clientY - rect.top) / rect.height) * 100 : 20;
    files.forEach((file, i) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const imageUrl = ev.target?.result as string;
        const el = createDefaultElement("image", Math.min(80, dropX + i * 5), Math.min(80, dropY + i * 5));
        el.imageUrl = imageUrl;
        const newEls = [...elements, el];
        changeWithHistory(newEls);
        setSelectedId(el.id);
        setActiveTool("select");
      };
      reader.readAsDataURL(file);
    });
  }, [elements, changeWithHistory, setSelectedId]);

  return {
    activeTool,
    setActiveTool,
    selectedId,
    setSelectedId,
    selectedIds,
    setSelectedIds,
    editingId,
    setEditingId,
    selectedElement,
    selectedElements,
    marquee,
    snapGuide,
    updateEl,
    updateElWithHistory,
    updateSelected,
    deleteSelected,
    duplicateSelected,
    bringToFront,
    sendToBack,
    alignSelected,
    distributeSelected,
    groupSelected,
    ungroupSelected,
    copySelected,
    cutSelected,
    pasteClipboard,
    handleCanvasClick,
    handleCanvasMouseDown,
    handleElementMouseDown,
    handleResizeMouseDown,
    handleElementDoubleClick,
    handleImageUpload,
    handleCanvasDragOver,
    handleCanvasDrop,
    commitTextEdit,
    activeGuides,
    undo,
    redo,
    canUndo,
    canRedo,
    canvasCursor: activeTool !== "select" ? "crosshair" : "default",
  };
}
