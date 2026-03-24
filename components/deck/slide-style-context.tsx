"use client";
import { createContext, useContext } from "react";

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  color?: string;
  scale?: "sm" | "md" | "lg"; // relative to slide's base size
}

interface SlideStyleContextType {
  getStyle: (slideIndex: number, field: string) => TextStyle;
  setStyle: (slideIndex: number, field: string, style: Partial<TextStyle>) => void;
}

export const SlideStyleContext = createContext<SlideStyleContextType | null>(null);

export function useSlideStyle() {
  return useContext(SlideStyleContext);
}
