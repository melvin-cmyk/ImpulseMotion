/**
 * Deck Store — State management for the MBR slide builder.
 * Uses useSyncExternalStore with localStorage persistence.
 */

import { useSyncExternalStore } from "react"
import type { SectionId } from "./impulse-theme"

export interface TableData {
  headers: string[]
  rows: string[][]
}

export interface TableStyle {
  headerBg: string
  headerText: string
  rowBg: string
  altRowBg: string
  rowText: string
  borderColor: string
  fontSize: number
  fontFamily: string
}

export const DEFAULT_TABLE_STYLE: TableStyle = {
  headerBg: "#0070C0",
  headerText: "#ffffff",
  rowBg: "#ffffff",
  altRowBg: "#F3F3F3",
  rowText: "#1a1a1a",
  borderColor: "#e5e7eb",
  fontSize: 10,
  fontFamily: "Inter",
}

export interface SlideElement {
  id: string
  type: "text" | "rect" | "circle" | "arrow" | "triangle" | "line" | "image"
  x: number
  y: number
  w: number
  h: number
  fillColor: string
  strokeColor: string
  strokeWidth: number
  opacity: number
  text?: string
  fontSize?: number
  fontFamily?: string
  fontWeight?: "normal" | "bold"
  fontStyle?: "normal" | "italic"
  textDecoration?: "none" | "underline"
  textColor?: string
  textAlign?: "left" | "center" | "right"
  imageUrl?: string
}

export interface HighlightItem {
  label: string
  value: string
  delta?: string
  deltaPositive?: boolean
}

export type SlideType =
  | "markdown" | "image" | "title" | "table" | "creative"
  | "cover" | "agenda" | "section-divider" | "highlights"
  | "kpi-table" | "learnings" | "next-steps" | "budget"

export interface Slide {
  id: string
  type: SlideType
  content: string
  imageUrl?: string
  title?: string
  subtitle?: string
  notes?: string
  tableData?: TableData
  // Creative-specific fields
  creativeName?: string
  creativeMetrics?: Record<string, string>
  // MBR fields
  section?: SectionId
  highlights?: HighlightItem[]
  items?: string[]
  budgetData?: { platform: string; amount: string; percentage: string }[]
  isDark?: boolean
  // Canvas editor
  elements?: SlideElement[]
  tableStyle?: TableStyle
  tablePosition?: { x: number; y: number; w: number; h: number }
}

export interface Deck {
  id: string
  name: string
  slides: Slide[]
  createdAt: string
  updatedAt: string
  clientName?: string
  period?: string
  periodPrev?: string
}

type Listener = () => void

const STORAGE_KEY = "impulse_deck"
const listeners = new Set<Listener>()

function createEmptyDeck(): Deck {
  return {
    id: "deck-" + Date.now(),
    name: "Monthly Report",
    slides: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

let currentDeck: Deck = createEmptyDeck()

// Load from localStorage on init (client-side only)
if (typeof window !== "undefined") {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) currentDeck = JSON.parse(raw)
  } catch {}
}

function persist() {
  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentDeck))
  }
  listeners.forEach((l) => l())
}

function subscribe(cb: Listener) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function getSnapshot() {
  return currentDeck
}

function getServerSnapshot() {
  return createEmptyDeck()
}

export function useDeck() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

// Convenience wrapper matching the import in ai/page.tsx
export function useDeckStore<T>(selector: (deck: Deck) => T): T {
  const deck = useDeck()
  return selector(deck)
}

export function addSlide(slide: Omit<Slide, "id">) {
  const newSlide: Slide = { id: crypto.randomUUID(), ...slide }
  currentDeck = {
    ...currentDeck,
    slides: [...currentDeck.slides, newSlide],
    updatedAt: new Date().toISOString(),
  }
  persist()
  return newSlide
}

export function removeSlide(id: string) {
  currentDeck = {
    ...currentDeck,
    slides: currentDeck.slides.filter((s) => s.id !== id),
    updatedAt: new Date().toISOString(),
  }
  persist()
}

export function updateSlide(id: string, updates: Partial<Slide>) {
  currentDeck = {
    ...currentDeck,
    slides: currentDeck.slides.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    updatedAt: new Date().toISOString(),
  }
  persist()
}

export function reorderSlides(slides: Slide[]) {
  currentDeck = { ...currentDeck, slides, updatedAt: new Date().toISOString() }
  persist()
}

export function setDeckName(name: string) {
  currentDeck = { ...currentDeck, name, updatedAt: new Date().toISOString() }
  persist()
}

export function setDeckMeta(meta: Partial<Pick<Deck, "clientName" | "period" | "periodPrev">>) {
  currentDeck = { ...currentDeck, ...meta, updatedAt: new Date().toISOString() }
  persist()
}

export function setSlides(slides: Slide[]) {
  currentDeck = { ...currentDeck, slides, updatedAt: new Date().toISOString() }
  persist()
}

export function clearDeck() {
  currentDeck = createEmptyDeck()
  persist()
}
