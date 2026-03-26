"use client";

import { useState, useRef, useEffect, ReactNode } from "react";
import { useSlideStyle } from "./slide-style-context";

interface EditableTextProps {
  children: ReactNode;
  field: string;
  slideIndex: number;
  currentValue: string;
  onEdit: (field: string, slideIndex: number, newValue: string) => void;
}

const COLOR_SWATCHES = [
  { color: "#000000", label: "Noir" },
  { color: "#0944A1", label: "Bleu foncé" },
  { color: "#2CA6F9", label: "Bleu" },
  { color: "#7F5AFD", label: "Violet" },
  { color: "#0B8043", label: "Vert" },
  { color: "#C53929", label: "Rouge" },
  { color: "#CCCCCC", label: "Gris" },
  { color: "#FFFFFF", label: "Blanc" },
];

/**
 * Inline-editable text with formatting toolbar.
 * - Hover: blue outline
 * - Click: textarea + format toolbar (bold, italic, color, size)
 * - Enter or blur confirms, Escape cancels
 */
export function EditableText({
  children,
  field,
  slideIndex,
  currentValue,
  onEdit,
}: EditableTextProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(currentValue);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLSpanElement>(null);

  const styleCtx = useSlideStyle();
  const style = styleCtx?.getStyle(slideIndex, field) ?? {};

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    setEditValue(currentValue);
  }, [currentValue]);

  const handleConfirm = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== currentValue) {
      onEdit(field, slideIndex, trimmed);
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditValue(currentValue);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
    e.stopPropagation();
  };

  // Build inline style from style overrides
  const computedStyle: React.CSSProperties = {
    fontWeight: style.bold ? "bold" : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    color: style.color ?? undefined,
    fontSize: style.scale === "sm" ? "0.8em" : style.scale === "lg" ? "1.3em" : undefined,
  };

  if (isEditing) {
    return (
      <span ref={containerRef} className="relative inline-block" style={{ position: "relative" }}>
        {/* Format toolbar */}
        {styleCtx && (
          <span
            className="absolute flex items-center gap-1 bg-white border border-gray-200 rounded-lg shadow-xl px-1.5 py-1 z-50 flex-wrap"
            style={{ bottom: "100%", left: 0, marginBottom: 4, minWidth: 200, whiteSpace: "nowrap" }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {/* Bold */}
            <button
              onMouseDown={(e) => { e.preventDefault(); styleCtx.setStyle(slideIndex, field, { bold: !style.bold }); }}
              className={`w-6 h-6 rounded text-xs font-bold transition-colors ${style.bold ? "bg-[#0944A1] text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
              title="Gras"
            >B</button>
            {/* Italic */}
            <button
              onMouseDown={(e) => { e.preventDefault(); styleCtx.setStyle(slideIndex, field, { italic: !style.italic }); }}
              className={`w-6 h-6 rounded text-xs italic transition-colors ${style.italic ? "bg-[#0944A1] text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
              title="Italique"
            >I</button>
            <span className="w-px h-4 bg-gray-200 mx-0.5 inline-block" />
            {/* Size */}
            <button
              onMouseDown={(e) => { e.preventDefault(); styleCtx.setStyle(slideIndex, field, { scale: style.scale === "sm" ? "md" : "sm" }); }}
              className={`w-6 h-6 rounded text-[10px] transition-colors ${style.scale === "sm" ? "bg-[#0944A1] text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
              title="Petit"
            >S</button>
            <button
              onMouseDown={(e) => { e.preventDefault(); styleCtx.setStyle(slideIndex, field, { scale: undefined }); }}
              className={`w-6 h-6 rounded text-[10px] transition-colors ${!style.scale || style.scale === "md" ? "bg-[#0944A1] text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
              title="Normal"
            >M</button>
            <button
              onMouseDown={(e) => { e.preventDefault(); styleCtx.setStyle(slideIndex, field, { scale: style.scale === "lg" ? "md" : "lg" }); }}
              className={`w-6 h-6 rounded text-[10px] transition-colors ${style.scale === "lg" ? "bg-[#0944A1] text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
              title="Grand"
            >L</button>
            <span className="w-px h-4 bg-gray-200 mx-0.5 inline-block" />
            {/* Color swatches */}
            {COLOR_SWATCHES.map(({ color, label }) => (
              <button
                key={color}
                onMouseDown={(e) => { e.preventDefault(); styleCtx.setStyle(slideIndex, field, { color }); }}
                title={label}
                className="rounded-full transition-all"
                style={{
                  width: 14,
                  height: 14,
                  backgroundColor: color,
                  border: style.color === color ? "2px solid #2CA6F9" : "1px solid #ccc",
                  transform: style.color === color ? "scale(1.2)" : undefined,
                }}
              />
            ))}
            {/* Reset color */}
            <button
              onMouseDown={(e) => { e.preventDefault(); styleCtx.setStyle(slideIndex, field, { color: undefined }); }}
              className="w-5 h-5 rounded text-[9px] bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
              title="Couleur par défaut"
            >✕</button>
          </span>
        )}
        <textarea
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleConfirm}
          onKeyDown={handleKeyDown}
          className="w-full bg-transparent border-none resize-none"
          style={{
            font: "inherit",
            color: computedStyle.color ?? "inherit",
            fontSize: computedStyle.fontSize ?? "inherit",
            fontWeight: computedStyle.fontWeight ?? "inherit",
            fontStyle: computedStyle.fontStyle ?? "inherit",
            lineHeight: "inherit",
            letterSpacing: "inherit",
            padding: "2px 4px",
            margin: "-2px -4px",
            outline: "2px solid #2CA6F9",
            outlineOffset: "0px",
            borderRadius: "2px",
            minHeight: "1.5em",
          }}
          rows={currentValue.length > 80 ? 3 : 1}
        />
      </span>
    );
  }

  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        setIsEditing(true);
      }}
      title="Cliquer pour modifier"
      className="cursor-text transition-all"
      style={{
        outline: "0px solid #2CA6F9",
        outlineOffset: "3px",
        borderRadius: "2px",
        ...computedStyle,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.outline = "2px solid #2CA6F9";
        (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(44,166,249,0.08)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.outline = "0px solid #2CA6F9";
        (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
      }}
    >
      {children}
    </span>
  );
}
