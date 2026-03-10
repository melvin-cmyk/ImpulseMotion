/**
 * Reports localStorage store
 * Persists Report objects under the key "impulse_reports"
 */

export interface Report {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  dateRange: { from: string; to: string };
  creativeIds: string[];
}

const STORAGE_KEY = "impulse_reports";

export function getReports(): Report[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Report[];
  } catch {
    return [];
  }
}

export function getReport(id: string): Report | null {
  return getReports().find((r) => r.id === id) ?? null;
}

export function saveReport(report: Report): void {
  const reports = getReports();
  const idx = reports.findIndex((r) => r.id === report.id);
  if (idx >= 0) {
    reports[idx] = report;
  } else {
    reports.unshift(report);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
}

export function deleteReport(id: string): void {
  const reports = getReports().filter((r) => r.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
}

export function createReport(
  data: Omit<Report, "id" | "createdAt">
): Report {
  const report: Report = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  saveReport(report);
  return report;
}
