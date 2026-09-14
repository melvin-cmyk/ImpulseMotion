/** Routes of the "Analyse Ads" section (route group app/(analyse)). Shared by
 *  the sidebar, the command palette and the account picker so "am I in the
 *  section where the selected account applies?" has a single answer. */
export const ANALYSE_ROUTES = [
  "/creatives", "/launch", "/top-charts", "/compare", "/comparaisons",
  "/patterns", "/angles", "/audience", "/top-copy",
  "/top-landing-page", "/fatigue", "/naming", "/creative-team",
];

export function isAnalysePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return ANALYSE_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"));
}
