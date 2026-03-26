"use client";

import { useState, useRef, useCallback, useEffect } from "react";
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
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SlideElement {
  id: string;
  type: "text" | "rect" | "circle" | "arrow";
  x: number; // % of canvas width
  y: number; // % of canvas height
  w: number; // % of canvas width
  h: number; // % of canvas height
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  opacity: number; // 0-1
  // Text-specific
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: "normal" | "bold";
  fontStyle?: "normal" | "italic";
  textDecoration?: "none" | "underline";
  textColor?: string;
  textAlign?: "left" | "center" | "right";
}

export type EditorTool = "select" | "text" | "rect" | "circle" | "arrow";

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
  }
}

// ── SlideEditorToolbar ────────────────────────────────────────────────────────

interface ToolbarProps {
  activeTool: EditorTool;
  onToolChange: (t: EditorTool) => void;
  selectedElement: SlideElement | null;
  onUpdateElement: (patch: Partial<SlideElement>) => void;
  onDeleteElement: () => void;
}

export function SlideEditorToolbar({
  activeTool,
  onToolChange,
  selectedElement,
  onUpdateElement,
  onDeleteElement,
}: ToolbarProps) {
  return (
    <div className="flex items-center gap-1 mb-2 px-2 py-1 bg-white border border-gray-200 rounded-lg shadow-sm flex-wrap">
      {(
        [
          { tool: "select" as EditorTool, icon: <MousePointer2 className="w-3.5 h-3.5" />, label: "Sélectionner" },
          { tool: "text" as EditorTool, icon: <Type className="w-3.5 h-3.5" />, label: "Texte" },
          { tool: "rect" as EditorTool, icon: <Square className="w-3.5 h-3.5" />, label: "Rectangle" },
          { tool: "circle" as EditorTool, icon: <Circle className="w-3.5 h-3.5" />, label: "Cercle" },
          { tool: "arrow" as EditorTool, icon: <ArrowRight className="w-3.5 h-3.5" />, label: "Flèche" },
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

      <div className="h-5 w-px bg-gray-200 mx-1" />

      <button
        onClick={onDeleteElement}
        disabled={!selectedElement}
        title="Supprimer l'élément"
        className="flex items-center justify-center w-7 h-7 rounded text-red-400 hover:bg-red-50 disabled:opacity-30 transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>

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
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── SlideElementItem ──────────────────────────────────────────────────────────

interface SlideElementItemProps {
  el: SlideElement;
  isSelected: boolean;
  isEditing: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onTextChange: (text: string) => void;
  onBlur: () => void;
  onResizeMouseDown: (e: React.MouseEvent) => void;
}

export function SlideElementItem({
  el,
  isSelected,
  isEditing,
  onMouseDown,
  onDoubleClick,
  onTextChange,
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
              borderRadius: 4,
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
      {isSelected && (
        <div
          onMouseDown={onResizeMouseDown}
          style={{
            position: "absolute",
            bottom: -4,
            right: -4,
            width: 10,
            height: 10,
            background: "#2CA6F9",
            border: "2px solid white",
            borderRadius: 2,
            cursor: "se-resize",
            zIndex: 32,
          }}
        />
      )}
    </div>
  );
}

// ── useSlideEditor hook ───────────────────────────────────────────────────────

export function useSlideEditor(
  canvasRef: React.RefObject<HTMLDivElement | null>,
  elements: SlideElement[],
  onChange: (els: SlideElement[]) => void
) {
  const [activeTool, setActiveTool] = useState<EditorTool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const dragRef = useRef<{
    type: "move" | "resize";
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const selectedElement = elements.find((e) => e.id === selectedId) ?? null;

  const updateEl = useCallback(
    (id: string, patch: Partial<SlideElement>) => {
      onChange(elements.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    },
    [elements, onChange]
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    onChange(elements.filter((e) => e.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, elements, onChange]);

  // Keyboard delete
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inInput =
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA" ||
        (document.activeElement as HTMLElement)?.isContentEditable;
      if ((e.key === "Delete" || e.key === "Backspace") && !inInput && selectedId) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "Escape") {
        setSelectedId(null);
        setEditingId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, selectedId]);

  // Global mouse move/up for drag
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current || !canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const dx = ((e.clientX - dragRef.current.startX) / rect.width) * 100;
      const dy = ((e.clientY - dragRef.current.startY) / rect.height) * 100;
      if (dragRef.current.type === "move") {
        updateEl(dragRef.current.id, {
          x: Math.max(0, Math.min(90, dragRef.current.origX + dx)),
          y: Math.max(0, Math.min(90, dragRef.current.origY + dy)),
        });
      } else {
        updateEl(dragRef.current.id, {
          w: Math.max(5, Math.min(95, dragRef.current.origW + dx)),
          h: Math.max(3, Math.min(95, dragRef.current.origH + dy)),
        });
      }
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [updateEl, canvasRef]);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (activeTool === "select" || !canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      const el = createDefaultElement(activeTool as SlideElement["type"], x - 9, y - 5);
      onChange([...elements, el]);
      setSelectedId(el.id);
      setActiveTool("select");
      if (activeTool === "text") setTimeout(() => setEditingId(el.id), 50);
    },
    [activeTool, canvasRef, elements, onChange]
  );

  const handleElementMouseDown = useCallback(
    (e: React.MouseEvent, el: SlideElement) => {
      e.stopPropagation();
      if (activeTool !== "select") return;
      setSelectedId(el.id);
      dragRef.current = {
        type: "move",
        id: el.id,
        startX: e.clientX,
        startY: e.clientY,
        origX: el.x,
        origY: el.y,
        origW: el.w,
        origH: el.h,
      };
    },
    [activeTool]
  );

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent, el: SlideElement) => {
      e.stopPropagation();
      dragRef.current = {
        type: "resize",
        id: el.id,
        startX: e.clientX,
        startY: e.clientY,
        origX: el.x,
        origY: el.y,
        origW: el.w,
        origH: el.h,
      };
    },
    []
  );

  const handleElementDoubleClick = useCallback(
    (e: React.MouseEvent, el: SlideElement) => {
      e.stopPropagation();
      if (el.type === "text") {
        setSelectedId(el.id);
        setEditingId(el.id);
      }
    },
    []
  );

  return {
    activeTool,
    setActiveTool,
    selectedId,
    setSelectedId,
    editingId,
    setEditingId,
    selectedElement,
    updateEl,
    deleteSelected,
    handleCanvasClick,
    handleElementMouseDown,
    handleResizeMouseDown,
    handleElementDoubleClick,
    canvasCursor: activeTool !== "select" ? "crosshair" : "default",
  };
}
