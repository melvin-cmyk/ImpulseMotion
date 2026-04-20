/**
 * Pure helpers for snap-to-grid and alignment guides on the deck canvas.
 * Coordinates are expressed in % of canvas width/height.
 */

/** Default grid granularity in % of canvas width/height. */
export const SNAP_GRID_STEP = 5;

/** Tolerance in % for snapping to another block's edge (alignment guides). */
export const SNAP_EDGE_TOLERANCE = 1.5;

/** Snap a single coordinate to the nearest grid line. */
export function snapToGrid(value: number, enabled: boolean, step = SNAP_GRID_STEP): number {
  if (!enabled) return value;
  return Math.round(value / step) * step;
}

export interface SnapRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapResult {
  x: number;
  y: number;
  /** Guide lines to render on the canvas (null if no snap engaged). */
  guideX: number | null;
  guideY: number | null;
}

/**
 * Snap a dragged rect's position to either:
 *   1. another rect's edge (left, right, center-x / top, bottom, center-y)
 *      within SNAP_EDGE_TOLERANCE — strongest attraction, returns a guide; or
 *   2. the grid otherwise.
 *
 * Passing `enabled=false` disables all snapping and returns the raw coords.
 */
export function snapRect(
  draggedX: number,
  draggedY: number,
  w: number,
  h: number,
  others: SnapRect[],
  enabled: boolean,
  gridStep = SNAP_GRID_STEP,
  tolerance = SNAP_EDGE_TOLERANCE,
): SnapResult {
  if (!enabled) {
    return { x: draggedX, y: draggedY, guideX: null, guideY: null };
  }

  const draggedCandidatesX = [
    { key: "left", value: draggedX },
    { key: "center", value: draggedX + w / 2 },
    { key: "right", value: draggedX + w },
  ];
  const draggedCandidatesY = [
    { key: "top", value: draggedY },
    { key: "center", value: draggedY + h / 2 },
    { key: "bottom", value: draggedY + h },
  ];

  const othersCandidatesX: number[] = [];
  const othersCandidatesY: number[] = [];
  for (const o of others) {
    othersCandidatesX.push(o.x, o.x + o.w / 2, o.x + o.w);
    othersCandidatesY.push(o.y, o.y + o.h / 2, o.y + o.h);
  }

  let snappedX = draggedX;
  let snappedY = draggedY;
  let guideX: number | null = null;
  let guideY: number | null = null;

  let bestDX = tolerance;
  for (const d of draggedCandidatesX) {
    for (const ov of othersCandidatesX) {
      const diff = Math.abs(d.value - ov);
      if (diff < bestDX) {
        bestDX = diff;
        snappedX = draggedX + (ov - d.value);
        guideX = ov;
      }
    }
  }

  let bestDY = tolerance;
  for (const d of draggedCandidatesY) {
    for (const ov of othersCandidatesY) {
      const diff = Math.abs(d.value - ov);
      if (diff < bestDY) {
        bestDY = diff;
        snappedY = draggedY + (ov - d.value);
        guideY = ov;
      }
    }
  }

  if (guideX === null) snappedX = snapToGrid(snappedX, true, gridStep);
  if (guideY === null) snappedY = snapToGrid(snappedY, true, gridStep);

  return { x: snappedX, y: snappedY, guideX, guideY };
}
