import { redirect } from "next/navigation";

/**
 * The hardcoded client overview was replaced by configurable steering
 * dashboards (/d). This route only survives for old bookmarks.
 */
export default function LegacyClientPage() {
  redirect("/d");
}
