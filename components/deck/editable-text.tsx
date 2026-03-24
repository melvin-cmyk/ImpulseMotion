"use client";

import { ReactNode } from "react";

interface EditableTextProps {
  children: ReactNode;
  field: string;
  slideIndex: number;
  currentValue: string;
  onClick: (event: { field: string; slideIndex: number; currentValue: string }) => void;
}

/**
 * Wrapper pour rendre un texte éditable via le chat IA.
 * Ajoute un hover outline bleu et un curseur pointer.
 */
export function EditableText({
  children,
  field,
  slideIndex,
  currentValue,
  onClick,
}: EditableTextProps) {
  const handleClick = () => {
    onClick({ field, slideIndex, currentValue });
  };

  return (
    <span
      onClick={handleClick}
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
