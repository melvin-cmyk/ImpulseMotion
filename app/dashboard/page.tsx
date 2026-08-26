import { redirect } from "next/navigation";

/**
 * Legacy overview page — superseded by /cockpit (staff) and /d (clients).
 * Kept only so old bookmarks land somewhere sensible.
 */
export default function LegacyDashboardPage() {
  redirect("/cockpit");
}
