/**
 * Shared naming convention config — used by Naming, Angles, Patterns pages
 */

export const NAMING_STORAGE_KEY = "impulsemotion_naming_config";

export interface SegmentDef {
  label: string;
  position: number;
}

export interface NamingConfig {
  separator: string;
  segments: SegmentDef[];
}

export const DEFAULT_NAMING_CONFIG: NamingConfig = {
  separator: "_",
  segments: [
    { label: "Product", position: 0 },
    { label: "Format", position: 1 },
    { label: "Angle", position: 2 },
  ],
};

export function loadNamingConfig(): NamingConfig {
  if (typeof window === "undefined") return DEFAULT_NAMING_CONFIG;
  try {
    const raw = localStorage.getItem(NAMING_STORAGE_KEY);
    if (!raw) return DEFAULT_NAMING_CONFIG;
    const parsed = JSON.parse(raw);
    if (!parsed.separator || !Array.isArray(parsed.segments)) return DEFAULT_NAMING_CONFIG;
    return parsed as NamingConfig;
  } catch {
    return DEFAULT_NAMING_CONFIG;
  }
}

export function parseSegmentValue(name: string, position: number, separator: string): string {
  const parts = name.split(separator).map((p) => p.trim()).filter(Boolean);
  return parts[position] || "Unknown";
}

export function parseAllSegments(name: string, config: NamingConfig): Record<string, string> {
  const result: Record<string, string> = {};
  for (const seg of config.segments) {
    result[seg.label] = parseSegmentValue(name, seg.position, config.separator);
  }
  return result;
}
