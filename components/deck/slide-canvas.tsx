"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import {
  MousePointer2, Type, Square, Circle, ArrowRight, Trash2,
  Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  type Slide, type SlideElement, type TableStyle,
  DEFAULT_TABLE_STYLE,
} from "@/lib/deck-store"

// ── Types ─────────────────────────────────────────────────────────────────────
export type EditorTool = "select" | "text" | "rect" | "circle" | "arrow"

const FONT_OPTIONS = [
  { label: "Inter", value: "Inter, sans-serif" },
  { label: "Raleway", value: "Raleway, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Playfair", value: "'Playfair Display', serif" },
  { label: "Mono", value: "monospace" },
]

function createDefaultElement(
  type: SlideElement["type"],
  xPct: number,
  yPct: number
): SlideElement {
  const base = { id: crypto.randomUUID(), type, strokeWidth: 2, opacity: 1 }
  switch (type) {
    case "text":
      return {
        ...base, x: xPct, y: yPct, w: 24, h: 10,
        fillColor: "transparent", strokeColor: "transparent",
        text: "Texte", fontSize: 14,
        fontFamily: "Inter, sans-serif", fontWeight: "normal",
        fontStyle: "normal", textDecoration: "none",
        textColor: "#FFFFFF", textAlign: "left",
      }
    case "rect":
      return { ...base, x: xPct, y: yPct, w: 20, h: 14, fillColor: "#1e3a5f", strokeColor: "#3b82f6" }
    case "circle":
      return { ...base, x: xPct, y: yPct, w: 14, h: 18, fillColor: "#1e3a5f", strokeColor: "#3b82f6" }
    case "arrow":
      return { ...base, x: xPct, y: yPct, w: 24, h: 5, fillColor: "transparent", strokeColor: "#3b82f6" }
    default:
      return { ...base, x: xPct, y: yPct, w: 20, h: 14, fillColor: "#1e3a5f", strokeColor: "#3b82f6" }
  }
}

// ── Rendered element on canvas ─────────────────────────────────────────────────
interface ElementItemProps {
  el: SlideElement
  isSelected: boolean
  isEditing: boolean
  canvasW: number
  canvasH: number
  onMouseDown: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onTextChange: (text: string) => void
  onBlur: () => void
  onResizeMouseDown: (e: React.MouseEvent, handle: string) => void
}

function ElementItem({
  el, isSelected, isEditing, canvasW, canvasH,
  onMouseDown, onDoubleClick, onTextChange, onBlur,
  onResizeMouseDown,
}: ElementItemProps) {
  const px = (el.x / 100) * canvasW
  const py = (el.y / 100) * canvasH
  const pw = (el.w / 100) * canvasW
  const ph = (el.h / 100) * canvasH

  const HANDLES = [
    { id: "nw", x: -4, y: -4 }, { id: "n", x: pw / 2 - 4, y: -4 }, { id: "ne", x: pw - 4, y: -4 },
    { id: "w", x: -4, y: ph / 2 - 4 },                              { id: "e", x: pw - 4, y: ph / 2 - 4 },
    { id: "sw", x: -4, y: ph - 4 }, { id: "s", x: pw / 2 - 4, y: ph - 4 }, { id: "se", x: pw - 4, y: ph - 4 },
  ]

  const style: React.CSSProperties = {
    position: "absolute",
    left: px,
    top: py,
    width: pw,
    height: ph,
    opacity: el.opacity,
    cursor: "move",
    userSelect: "none",
  }

  let inner: React.ReactNode = null

  if (el.type === "arrow") {
    inner = (
      <svg width={pw} height={ph} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <defs>
          <marker id={`arrow-${el.id}`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L6,3 z" fill={el.strokeColor} />
          </marker>
        </defs>
        <line
          x1={0} y1={ph / 2} x2={pw - 8} y2={ph / 2}
          stroke={el.strokeColor} strokeWidth={el.strokeWidth}
          markerEnd={`url(#arrow-${el.id})`}
        />
      </svg>
    )
  } else if (el.type === "circle") {
    inner = (
      <svg width={pw} height={ph} style={{ position: "absolute", inset: 0 }}>
        <ellipse
          cx={pw / 2} cy={ph / 2} rx={pw / 2 - el.strokeWidth / 2} ry={ph / 2 - el.strokeWidth / 2}
          fill={el.fillColor === "transparent" ? "none" : el.fillColor}
          stroke={el.strokeColor} strokeWidth={el.strokeWidth}
        />
      </svg>
    )
  } else if (el.type === "rect") {
    inner = (
      <div style={{
        width: "100%", height: "100%",
        background: el.fillColor === "transparent" ? "transparent" : el.fillColor,
        border: `${el.strokeWidth}px solid ${el.strokeColor}`,
        boxSizing: "border-box",
      }} />
    )
  } else if (el.type === "text") {
    if (isEditing) {
      inner = (
        <textarea
          autoFocus
          value={el.text ?? ""}
          onChange={(e) => onTextChange(e.target.value)}
          onBlur={onBlur}
          style={{
            width: "100%", height: "100%", background: "transparent",
            border: "1px dashed #3b82f6", outline: "none", resize: "none",
            color: el.textColor ?? "#FFFFFF",
            fontSize: (el.fontSize ?? 14),
            fontFamily: el.fontFamily ?? "Inter, sans-serif",
            fontWeight: el.fontWeight === "bold" ? "bold" : "normal",
            fontStyle: el.fontStyle === "italic" ? "italic" : "normal",
            textDecoration: el.textDecoration === "underline" ? "underline" : "none",
            textAlign: (el.textAlign ?? "left") as React.CSSProperties["textAlign"],
            padding: "2px 4px",
          }}
        />
      )
    } else {
      inner = (
        <div style={{
          width: "100%", height: "100%",
          color: el.textColor ?? "#FFFFFF",
          fontSize: (el.fontSize ?? 14),
          fontFamily: el.fontFamily ?? "Inter, sans-serif",
          fontWeight: el.fontWeight === "bold" ? "bold" : "normal",
          fontStyle: el.fontStyle === "italic" ? "italic" : "normal",
          textDecoration: el.textDecoration === "underline" ? "underline" : "none",
          textAlign: (el.textAlign ?? "left") as React.CSSProperties["textAlign"],
          padding: "2px 4px",
          overflow: "hidden",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}>
          {el.text ?? ""}
        </div>
      )
    }
  }

  return (
    <div style={style} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      {inner}
      {isSelected && !isEditing && HANDLES.map((h) => (
        <div
          key={h.id}
          onMouseDown={(e) => { e.stopPropagation(); onResizeMouseDown(e, h.id) }}
          style={{
            position: "absolute", left: h.x, top: h.y,
            width: 8, height: 8,
            background: "#2CA6F9", border: "1.5px solid white",
            borderRadius: 2, cursor: `${h.id}-resize`, zIndex: 40,
          }}
        />
      ))}
      {isSelected && (
        <div style={{
          position: "absolute", inset: -1,
          border: "1.5px solid #2CA6F9",
          pointerEvents: "none",
        }} />
      )}
    </div>
  )
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
interface ToolbarProps {
  tool: EditorTool
  onToolChange: (t: EditorTool) => void
  selected: SlideElement | null
  onUpdate: (patch: Partial<SlideElement>) => void
  onDelete: () => void
}

function EditorToolbar({ tool, onToolChange, selected, onUpdate, onDelete }: ToolbarProps) {
  const TOOLS: { t: EditorTool; icon: React.ReactNode; label: string }[] = [
    { t: "select", icon: <MousePointer2 className="w-3.5 h-3.5" />, label: "Sélectionner" },
    { t: "text", icon: <Type className="w-3.5 h-3.5" />, label: "Texte" },
    { t: "rect", icon: <Square className="w-3.5 h-3.5" />, label: "Rectangle" },
    { t: "circle", icon: <Circle className="w-3.5 h-3.5" />, label: "Cercle" },
    { t: "arrow", icon: <ArrowRight className="w-3.5 h-3.5" />, label: "Flèche" },
  ]

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 bg-white border border-gray-200 rounded-lg shadow-sm flex-wrap mb-2">
      {TOOLS.map(({ t, icon, label }) => (
        <button
          key={t}
          onClick={() => onToolChange(t)}
          title={label}
          className={`flex items-center justify-center w-7 h-7 rounded transition-colors ${
            tool === t ? "bg-[#0944A1] text-white" : "text-gray-600 hover:bg-gray-100"
          }`}
        >
          {icon}
        </button>
      ))}

      <div className="h-5 w-px bg-gray-200 mx-1" />

      <button
        onClick={onDelete}
        disabled={!selected}
        title="Supprimer"
        className="flex items-center justify-center w-7 h-7 rounded text-red-500 hover:bg-red-50 disabled:opacity-30 transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>

      {selected && (
        <>
          <div className="h-5 w-px bg-gray-200 mx-1" />
          <div className="flex items-center gap-1.5 flex-wrap">
            {selected.type !== "arrow" && selected.type !== "text" && (
              <label className="flex items-center gap-1 text-[10px] text-gray-500">
                Fond
                <input type="color"
                  value={selected.fillColor === "transparent" ? "#000000" : selected.fillColor}
                  onChange={(e) => onUpdate({ fillColor: e.target.value })}
                  className="w-6 h-6 rounded cursor-pointer border border-gray-300 p-0"
                />
              </label>
            )}
            <label className="flex items-center gap-1 text-[10px] text-gray-500">
              Bord
              <input type="color"
                value={selected.strokeColor === "transparent" ? "#000000" : selected.strokeColor}
                onChange={(e) => onUpdate({ strokeColor: e.target.value })}
                className="w-6 h-6 rounded cursor-pointer border border-gray-300 p-0"
              />
            </label>
            <label className="flex items-center gap-1 text-[10px] text-gray-500">
              ép.
              <input type="number" value={selected.strokeWidth}
                onChange={(e) => onUpdate({ strokeWidth: Math.max(0, Math.min(10, Number(e.target.value))) })}
                min={0} max={10}
                className="w-9 h-5 text-[10px] border border-gray-300 rounded px-1 text-center"
              />
            </label>
            <label className="flex items-center gap-1 text-[10px] text-gray-500">
              opacité
              <input type="number" value={Math.round(selected.opacity * 100)}
                onChange={(e) => onUpdate({ opacity: Math.max(0, Math.min(100, Number(e.target.value))) / 100 })}
                min={0} max={100}
                className="w-11 h-5 text-[10px] border border-gray-300 rounded px-1 text-center"
              />%
            </label>

            {selected.type === "text" && (
              <>
                <div className="h-5 w-px bg-gray-200 mx-0.5" />
                <label className="flex items-center gap-1 text-[10px] text-gray-500">
                  <input type="color"
                    value={selected.textColor ?? "#FFFFFF"}
                    onChange={(e) => onUpdate({ textColor: e.target.value })}
                    className="w-6 h-6 rounded cursor-pointer border border-gray-300 p-0"
                    title="Couleur texte"
                  />
                </label>
                <select
                  value={selected.fontFamily ?? "Inter, sans-serif"}
                  onChange={(e) => onUpdate({ fontFamily: e.target.value })}
                  className="text-[10px] border border-gray-300 rounded px-1 h-5 bg-white"
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
                <input type="number"
                  value={selected.fontSize ?? 14}
                  onChange={(e) => onUpdate({ fontSize: Math.max(6, Math.min(96, Number(e.target.value))) })}
                  min={6} max={96}
                  className="w-12 h-5 text-[10px] border border-gray-300 rounded px-1 text-center"
                  title="Taille police"
                />
                <button
                  onClick={() => onUpdate({ fontWeight: selected.fontWeight === "bold" ? "normal" : "bold" })}
                  className={`w-6 h-5 rounded flex items-center justify-center ${selected.fontWeight === "bold" ? "bg-gray-200" : "hover:bg-gray-100"}`}
                  title="Gras"
                >
                  <Bold className="w-3 h-3" />
                </button>
                <button
                  onClick={() => onUpdate({ fontStyle: selected.fontStyle === "italic" ? "normal" : "italic" })}
                  className={`w-6 h-5 rounded flex items-center justify-center ${selected.fontStyle === "italic" ? "bg-gray-200" : "hover:bg-gray-100"}`}
                  title="Italique"
                >
                  <Italic className="w-3 h-3" />
                </button>
                <button
                  onClick={() => onUpdate({ textDecoration: selected.textDecoration === "underline" ? "none" : "underline" })}
                  className={`w-6 h-5 rounded flex items-center justify-center ${selected.textDecoration === "underline" ? "bg-gray-200" : "hover:bg-gray-100"}`}
                  title="Souligné"
                >
                  <Underline className="w-3 h-3" />
                </button>
                {(["left", "center", "right"] as const).map((align) => {
                  const icons = { left: <AlignLeft className="w-3 h-3" />, center: <AlignCenter className="w-3 h-3" />, right: <AlignRight className="w-3 h-3" /> }
                  return (
                    <button key={align}
                      onClick={() => onUpdate({ textAlign: align })}
                      className={`w-6 h-5 rounded flex items-center justify-center ${selected.textAlign === align ? "bg-gray-200" : "hover:bg-gray-100"}`}
                    >
                      {icons[align]}
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Table renderer with style ─────────────────────────────────────────────────
function StyledTable({ headers, rows, style, selected, onMouseDown }: {
  headers: string[]
  rows: string[][]
  style: TableStyle
  selected: boolean
  onMouseDown: (e: React.MouseEvent) => void
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        cursor: "move",
        width: "100%", height: "100%",
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        overflow: "auto",
        position: "relative",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{
                background: style.headerBg, color: style.headerText,
                padding: "4px 8px", textAlign: "left",
                border: `1px solid ${style.borderColor}`, fontWeight: 600,
              }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} style={{
                  background: i % 2 === 0 ? style.rowBg : style.altRowBg,
                  color: style.rowText,
                  padding: "3px 8px",
                  border: `1px solid ${style.borderColor}`,
                }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <div style={{
          position: "absolute", inset: -1,
          border: "1.5px solid #2CA6F9",
          pointerEvents: "none",
        }} />
      )}
    </div>
  )
}

// ── Table style panel ─────────────────────────────────────────────────────────
function TableStylePanel({ style, onChange }: {
  style: TableStyle
  onChange: (patch: Partial<TableStyle>) => void
}) {
  const fields: { key: keyof TableStyle; label: string; type: "color" | "number" | "select" }[] = [
    { key: "headerBg", label: "Fond header", type: "color" },
    { key: "headerText", label: "Texte header", type: "color" },
    { key: "rowBg", label: "Fond lignes", type: "color" },
    { key: "altRowBg", label: "Fond alt", type: "color" },
    { key: "rowText", label: "Texte lignes", type: "color" },
    { key: "borderColor", label: "Bordures", type: "color" },
    { key: "fontSize", label: "Taille", type: "number" },
    { key: "fontFamily", label: "Font", type: "select" },
  ]

  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2 bg-gray-900 border-t border-gray-800 rounded-b-lg">
      <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Style tableau</span>
      {fields.map(({ key, label, type }) => (
        <label key={key} className="flex items-center gap-1 text-[10px] text-gray-400">
          {label}
          {type === "color" && (
            <input type="color"
              value={style[key] as string}
              onChange={(e) => onChange({ [key]: e.target.value })}
              className="w-5 h-5 rounded cursor-pointer border-0 p-0 bg-transparent"
            />
          )}
          {type === "number" && (
            <input type="number"
              value={style[key] as number}
              onChange={(e) => onChange({ [key]: Number(e.target.value) })}
              min={8} max={16}
              className="w-10 h-5 text-[10px] border border-gray-700 rounded px-1 text-center bg-gray-800 text-white"
            />
          )}
          {type === "select" && (
            <select
              value={style[key] as string}
              onChange={(e) => onChange({ [key]: e.target.value })}
              className="text-[10px] border border-gray-700 rounded px-1 h-5 bg-gray-800 text-white"
            >
              {FONT_OPTIONS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          )}
        </label>
      ))}
    </div>
  )
}

// ── Main SlideCanvas component ─────────────────────────────────────────────────
interface SlideCanvasProps {
  slide: Slide
  onUpdateSlide: (updates: Partial<Slide>) => void
  readOnly?: boolean
}

export function SlideCanvas({ slide, onUpdateSlide, readOnly = false }: SlideCanvasProps) {
  const [tool, setTool] = useState<EditorTool>("select")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [tableSelected, setTableSelected] = useState(false)

  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ elId: string; startX: number; startY: number; origX: number; origY: number } | null>(null)
  const resizeRef = useRef<{ elId: string; handle: string; startX: number; startY: number; origEl: SlideElement } | null>(null)
  const tableResizeRef = useRef<{ startX: number; startY: number; origPos: { x: number; y: number; w: number; h: number } } | null>(null)

  const elements = slide.elements ?? []
  const tableStyle = slide.tableStyle ?? DEFAULT_TABLE_STYLE
  const tablePos = slide.tablePosition ?? { x: 5, y: 5, w: 90, h: 85 }

  const selectedEl = elements.find((e) => e.id === selectedId) ?? null

  // Canvas dimensions
  const getCanvas = () => canvasRef.current!
  const getDims = () => {
    const r = getCanvas().getBoundingClientRect()
    return { w: r.width, h: r.height }
  }

  // Update elements helper
  const setElements = useCallback((fn: (prev: SlideElement[]) => SlideElement[]) => {
    onUpdateSlide({ elements: fn(slide.elements ?? []) })
  }, [slide.elements, onUpdateSlide])

  // Keyboard shortcuts
  useEffect(() => {
    if (readOnly) return
    const handler = (e: KeyboardEvent) => {
      if (editingId) return
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId) {
          e.preventDefault()
          setElements((prev) => prev.filter((el) => el.id !== selectedId))
          setSelectedId(null)
        } else if (tableSelected) {
          e.preventDefault()
          onUpdateSlide({ tableData: undefined, type: "markdown", content: "" })
          setTableSelected(false)
        }
      }
      if (e.key === "Escape") {
        if (tableSelected) {
          // Delete table on Escape (user request)
          onUpdateSlide({ tableData: undefined, type: "markdown", content: "" })
          setTableSelected(false)
        } else {
          setSelectedId(null)
          setEditingId(null)
          setTableSelected(false)
        }
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [selectedId, editingId, setElements, readOnly])

  // Global mouse up
  useEffect(() => {
    const onUp = () => { dragRef.current = null; resizeRef.current = null; tableResizeRef.current = null }
    const onMove = (e: MouseEvent) => {
      if (!canvasRef.current) return
      const { w, h } = getDims()

      if (dragRef.current) {
        const { elId, startX, startY, origX, origY } = dragRef.current
        const dx = ((e.clientX - startX) / w) * 100
        const dy = ((e.clientY - startY) / h) * 100
        setElements((prev) => prev.map((el) => el.id === elId
          ? { ...el, x: Math.max(0, Math.min(90, origX + dx)), y: Math.max(0, Math.min(90, origY + dy)) }
          : el
        ))
      }

      if (resizeRef.current) {
        const { elId, handle, startX, startY, origEl } = resizeRef.current
        const dx = ((e.clientX - startX) / w) * 100
        const dy = ((e.clientY - startY) / h) * 100
        setElements((prev) => prev.map((el) => {
          if (el.id !== elId) return el
          let { x, y, width: ww, height: hh } = { x: origEl.x, y: origEl.y, width: origEl.w, height: origEl.h }
          if (handle.includes("e")) ww = Math.max(5, origEl.w + dx)
          if (handle.includes("w")) { x = origEl.x + dx; ww = Math.max(5, origEl.w - dx) }
          if (handle.includes("s")) hh = Math.max(3, origEl.h + dy)
          if (handle.includes("n")) { y = origEl.y + dy; hh = Math.max(3, origEl.h - dy) }
          return { ...el, x, y, w: ww, h: hh }
        }))
      }

      if (tableResizeRef.current) {
        const { startX, startY, origPos } = tableResizeRef.current
        const dx = ((e.clientX - startX) / w) * 100
        const dy = ((e.clientY - startY) / h) * 100
        onUpdateSlide({
          tablePosition: {
            x: origPos.x,
            y: origPos.y,
            w: Math.max(20, origPos.w + dx),
            h: Math.max(10, origPos.h + dy),
          }
        })
      }
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp) }
  }, [setElements, onUpdateSlide])

  // Canvas click → create element or deselect
  const handleCanvasClick = (e: React.MouseEvent) => {
    if (readOnly) return
    if (e.target !== canvasRef.current && !(e.target as HTMLElement).closest("[data-canvas-bg]")) return
    if (tool === "select") {
      setSelectedId(null)
      setEditingId(null)
      setTableSelected(false)
      return
    }
    const rect = getCanvas().getBoundingClientRect()
    const xPct = ((e.clientX - rect.left) / rect.width) * 100
    const yPct = ((e.clientY - rect.top) / rect.height) * 100
    const newEl = createDefaultElement(tool as SlideElement["type"], xPct, yPct)
    setElements((prev) => [...prev, newEl])
    setSelectedId(newEl.id)
    setTool("select")
    if (newEl.type === "text") setEditingId(newEl.id)
  }

  const handleElMouseDown = (e: React.MouseEvent, el: SlideElement) => {
    if (readOnly) return
    e.stopPropagation()
    if (tool !== "select") return
    setSelectedId(el.id)
    setTableSelected(false)
    const { w, h } = getDims()
    dragRef.current = { elId: el.id, startX: e.clientX, startY: e.clientY, origX: el.x, origY: el.y }
    // suppress unused
    void w; void h
  }

  const handleResizeMouseDown = (e: React.MouseEvent, el: SlideElement, handle: string) => {
    if (readOnly) return
    e.stopPropagation()
    resizeRef.current = { elId: el.id, handle, startX: e.clientX, startY: e.clientY, origEl: { ...el } }
  }

  const handleTableMouseDown = (e: React.MouseEvent) => {
    if (readOnly) return
    e.stopPropagation()
    setSelectedId(null)
    setTableSelected(true)
  }

  const handleTableResizeMouseDown = (e: React.MouseEvent) => {
    if (readOnly) return
    e.stopPropagation()
    tableResizeRef.current = {
      startX: e.clientX, startY: e.clientY,
      origPos: { ...tablePos },
    }
  }

  // ── Render base slide content (background layer) ──────────────────────────
  const renderBaseContent = () => {
    if (slide.type === "table" && slide.tableData) {
      const { w: cw, h: ch } = canvasRef.current
        ? { w: canvasRef.current.offsetWidth, h: canvasRef.current.offsetHeight }
        : { w: 800, h: 450 }
      const px = (tablePos.x / 100) * cw
      const py = (tablePos.y / 100) * ch
      const pw = (tablePos.w / 100) * cw
      const ph = (tablePos.h / 100) * ch

      const TABLE_HANDLES = [
        { id: "se", cursor: "se-resize", bottom: -4, right: -4 },
        { id: "s", cursor: "s-resize", bottom: -4, left: pw / 2 - 4 },
        { id: "e", cursor: "e-resize", top: ph / 2 - 4, right: -4 },
      ]

      return (
        <div
          style={{ position: "absolute", left: px, top: py, width: pw, height: ph }}
        >
          <StyledTable
            headers={slide.tableData.headers}
            rows={slide.tableData.rows}
            style={tableStyle}
            selected={tableSelected}
            onMouseDown={handleTableMouseDown}
          />
          {tableSelected && TABLE_HANDLES.map((h) => (
            <div
              key={h.id}
              onMouseDown={handleTableResizeMouseDown}
              style={{
                position: "absolute",
                bottom: h.bottom, right: h.right, top: h.top, left: h.left,
                width: 8, height: 8,
                background: "#2CA6F9", border: "1.5px solid white",
                borderRadius: 2, cursor: h.cursor, zIndex: 40,
              }}
            />
          ))}
        </div>
      )
    }

    if (slide.type === "title") {
      return (
        <div data-canvas-bg className="flex flex-col items-center justify-center h-full text-center px-6 pointer-events-none">
          <h2 className="text-3xl font-bold text-white mb-3">{slide.title}</h2>
          {slide.subtitle && <p className="text-lg text-gray-400">{slide.subtitle}</p>}
        </div>
      )
    }

    if (slide.type === "image" || slide.type === "creative") {
      return (
        <div data-canvas-bg className="flex flex-col items-center justify-center h-full gap-2 pointer-events-none">
          {slide.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={slide.imageUrl} alt="" className="max-h-[80%] max-w-full object-contain rounded" />
          ) : (
            <div className="w-16 h-16 bg-gray-800 rounded flex items-center justify-center text-gray-600">IMG</div>
          )}
          {slide.creativeName && <p className="text-xs text-gray-400">{slide.creativeName}</p>}
        </div>
      )
    }

    // markdown
    return (
      <div data-canvas-bg className="p-5 h-full overflow-auto prose prose-sm prose-invert max-w-none pointer-events-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{slide.content}</ReactMarkdown>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      {!readOnly && (
        <EditorToolbar
          tool={tool}
          onToolChange={setTool}
          selected={selectedEl}
          onUpdate={(patch) => {
            setElements((prev) => prev.map((el) => el.id === selectedId ? { ...el, ...patch } : el))
          }}
          onDelete={() => {
            if (selectedId) {
              setElements((prev) => prev.filter((el) => el.id !== selectedId))
              setSelectedId(null)
            }
          }}
        />
      )}

      {/* Canvas */}
      <div
        className="relative flex-1 bg-[#0F0F17] rounded-lg border border-gray-700/50 overflow-hidden"
        style={{ cursor: tool !== "select" ? "crosshair" : "default" }}
        onClick={handleCanvasClick}
      >
        <div ref={canvasRef} className="w-full h-full" style={{ position: "relative" }}>
          {/* Base slide content */}
          {renderBaseContent()}

          {/* Overlay elements */}
          {elements.map((el) => (
            <ElementItem
              key={el.id}
              el={el}
              isSelected={!readOnly && selectedId === el.id}
              isEditing={!readOnly && editingId === el.id}
              canvasW={canvasRef.current?.offsetWidth ?? 800}
              canvasH={canvasRef.current?.offsetHeight ?? 450}
              onMouseDown={(e) => handleElMouseDown(e, el)}
              onDoubleClick={() => {
                if (!readOnly && el.type === "text") setEditingId(el.id)
              }}
              onTextChange={(text) => {
                setElements((prev) => prev.map((e) => e.id === el.id ? { ...e, text } : e))
              }}
              onBlur={() => setEditingId(null)}
              onResizeMouseDown={(e, handle) => handleResizeMouseDown(e, el, handle)}
            />
          ))}
        </div>
      </div>

      {/* Table style panel */}
      {!readOnly && slide.type === "table" && (
        <TableStylePanel
          style={tableStyle}
          onChange={(patch) => onUpdateSlide({ tableStyle: { ...tableStyle, ...patch } })}
        />
      )}
    </div>
  )
}
