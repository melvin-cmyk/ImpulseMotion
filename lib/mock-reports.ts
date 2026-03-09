export type ReportMetric = "roas" | "cpa" | "ctr" | "hookRate" | "holdRate" | "spend";

export interface Report {
  id: string;
  name: string;
  createdAt: string;
  period: { from: string; to: string };
  creativeIds: string[];
  metrics: ReportMetric[];
  views: number;
}

export const mockReports: Report[] = [
  {
    id: "rpt-001",
    name: "Top Winners Q1 2025",
    createdAt: "2025-03-01",
    period: { from: "2025-01-01", to: "2025-03-31" },
    creativeIds: ["c1", "c2", "c3", "c15", "c20"],
    metrics: ["roas", "cpa", "ctr", "hookRate", "spend"],
    views: 14,
  },
  {
    id: "rpt-002",
    name: "Video vs Image Analysis",
    createdAt: "2025-02-15",
    period: { from: "2025-02-01", to: "2025-02-28" },
    creativeIds: ["c1", "c3", "c6", "c7", "c8"],
    metrics: ["roas", "cpa", "ctr", "hookRate", "holdRate"],
    views: 7,
  },
  {
    id: "rpt-003",
    name: "Fatigued Creatives Review",
    createdAt: "2025-03-05",
    period: { from: "2025-02-20", to: "2025-03-05" },
    creativeIds: ["c8", "c9", "c10", "c17"],
    metrics: ["roas", "cpa", "ctr", "spend"],
    views: 3,
  },
];

export const METRIC_LABELS: Record<ReportMetric, string> = {
  roas: "ROAS",
  cpa: "CPA",
  ctr: "CTR",
  hookRate: "Hook Rate",
  holdRate: "Hold Rate",
  spend: "Spend",
};
