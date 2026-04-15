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
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SlideElement {
  id: string;
  type: "text" | "rect" | "circle" | "arrow" | "triangle" | "line" | "image";
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
}

export type EditorTool = "select" | "text" | "rect" | "circle" | "arrow" | "triangle" | "line" | "image";

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
}: ToolbarProps) {
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

// ── SlideElementItem ──────────────────────────────────────────────────────────

type ResizeHandleId = "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r";

interface SlideElementItemProps {
  el: SlideElement;
  isSelected: boolean;
  isEditing: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onTextChange: (text: string) => void;
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

export function useSlideEditor(
  canvasRef: React.RefObject<HTMLDivElement | null>,
  elements: SlideElement[],
  onChange: (els: SlideElement[]) => void
) {
  const [activeTool, setActiveTool] = useState<EditorTool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

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
  const dragRef = useRef<{
    type: "move" | "resize";
    id: string;
    handle?: ResizeHandle;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
    moved: boolean;
  } | null>(null);

  const [activeGuides, setActiveGuides] = useState<{ vertical: number[]; horizontal: number[] }>({
    vertical: [],
    horizontal: [],
  });

  const selectedElement = elements.find((e) => e.id === selectedId) ?? null;

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

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    changeWithHistory(elements.filter((e) => e.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, elements, changeWithHistory]);

  const duplicateSelected = useCallback(() => {
    if (!selectedId) return;
    const el = elements.find((e) => e.id === selectedId);
    if (!el) return;
    const copy = { ...el, id: crypto.randomUUID(), x: el.x + 3, y: el.y + 3 };
    const newEls = [...elements, copy];
    changeWithHistory(newEls);
    setSelectedId(copy.id);
  }, [selectedId, elements, changeWithHistory]);

  const bringToFront = useCallback(() => {
    if (!selectedId) return;
    const el = elements.find((e) => e.id === selectedId);
    if (!el) return;
    const newEls = [...elements.filter((e) => e.id !== selectedId), el];
    changeWithHistory(newEls);
  }, [selectedId, elements, changeWithHistory]);

  const sendToBack = useCallback(() => {
    if (!selectedId) return;
    const el = elements.find((e) => e.id === selectedId);
    if (!el) return;
    const newEls = [el, ...elements.filter((e) => e.id !== selectedId)];
    changeWithHistory(newEls);
  }, [selectedId, elements, changeWithHistory]);

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
  }, [elements, changeWithHistory]);

  // Keyboard delete + undo/redo
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
      } else if ((e.ctrlKey || e.metaKey) && e.key === "d" && !inInput) {
        e.preventDefault();
        duplicateSelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey && !inInput) {
        e.preventDefault();
        undo();
      } else if (((e.ctrlKey || e.metaKey) && e.key === "y") || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "z")) {
        if (!inInput) { e.preventDefault(); redo(); }
      } else if (
        !inInput &&
        selectedId &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : 0.5;
        const el = elements.find((x) => x.id === selectedId);
        if (!el) return;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        updateElWithHistory(selectedId, {
          x: Math.max(0, Math.min(100 - el.w, el.x + dx)),
          y: Math.max(0, Math.min(100 - el.h, el.y + dy)),
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, duplicateSelected, selectedId, undo, redo, elements, updateElWithHistory]);

  // Global mouse move/up for drag
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
      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) drag.moved = true;

      if (drag.type === "move") {
        let nx = Math.max(0, Math.min(100 - drag.origW, drag.origX + dx));
        let ny = Math.max(0, Math.min(100 - drag.origH, drag.origY + dy));
        const snap = computeSnap(nx, ny, drag.origW, drag.origH, drag.id);
        nx = Math.max(0, Math.min(100 - drag.origW, snap.x));
        ny = Math.max(0, Math.min(100 - drag.origH, snap.y));
        setActiveGuides({ vertical: snap.vGuides, horizontal: snap.hGuides });
        updateEl(drag.id, { x: nx, y: ny });
      } else {
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
      }
    };

    const onUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      setActiveGuides({ vertical: [], horizontal: [] });
      if (drag && drag.moved) {
        // Commit current elements state to history (drag mutated via updateEl without history)
        pushHistory(elements);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [updateEl, canvasRef, elements, pushHistory]);

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
    [activeTool, canvasRef, elements, changeWithHistory]
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
        moved: false,
      };
    },
    [activeTool]
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
      if (el.type === "text") {
        setSelectedId(el.id);
        setEditingId(el.id);
        textEditSnapshotRef.current = el.text ?? "";
      }
    },
    []
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
  }, [elements, changeWithHistory]);

  return {
    activeTool,
    setActiveTool,
    selectedId,
    setSelectedId,
    editingId,
    setEditingId,
    selectedElement,
    updateEl,
    updateElWithHistory,
    deleteSelected,
    duplicateSelected,
    bringToFront,
    sendToBack,
    handleCanvasClick,
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
