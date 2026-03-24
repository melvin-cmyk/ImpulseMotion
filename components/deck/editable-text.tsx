"use client";

import { useState, useRef, useEffect, ReactNode } from "react";

interface EditableTextProps {
  children: ReactNode;
  field: string;
  slideIndex: number;
  currentValue: string;
  onEdit: (field: string, slideIndex: number, newValue: string) => void;
}

/**
 * Inline-editable text. Hover shows blue outline, click opens textarea,
 * Enter or blur confirms, Escape cancels.
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

  if (isEditing) {
    return (
      <textarea
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleConfirm}
        onKeyDown={handleKeyDown}
        className="w-full bg-transparent border-none resize-none"
        style={{
          font: "inherit",
          color: "inherit",
          fontSize: "inherit",
          fontWeight: "inherit",
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
    );
  }

  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        setIsEditing(true);
      }}
      className="editable-text-inline cursor-pointer transition-all"
      style={{
        outline: "0px solid #2CA6F9",
        outlineOffset: "2px",
        borderRadius: "2px",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.outline = "2px solid #2CA6F9";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.outline = "0px solid #2CA6F9";
      }}
    >
      {children}
    </span>
  );
}
