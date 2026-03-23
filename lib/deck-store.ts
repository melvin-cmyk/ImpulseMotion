/**
 * Deck Store — State management for the slide builder.
 * Uses useSyncExternalStore with localStorage persistence.
 */

import { useSyncExternalStore } from "react"

export interface TableData {
  headers: string[]
  rows: string[][]
}

export interface Slide {
  id: string
  type: "markdown" | "image" | "title" | "table" | "creative"
  content: string
  imageUrl?: string
  title?: string
  subtitle?: string
  notes?: string
  tableData?: TableData
  // Creative-specific fields
  creativeName?: string
  creativeMetrics?: Record<string, string>
}

export interface Deck {
  id: string
  name: string
  slides: Slide[]
  createdAt: string
  updatedAt: string
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

export function clearDeck() {
  currentDeck = createEmptyDeck()
  persist()
}
