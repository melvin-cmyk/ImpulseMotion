import { AlertsAssistant } from "@/components/client-alerts/alerts-assistant";

export const metadata = { title: "Alertes · ImpulseMotion" };

/**
 * Alerts created by conversation with an AI: a client, a sentence, a click.
 * The layout of /admin already restricts the page to the staff; every request
 * it makes is guarded again by the API (app/api/client-alerts).
 */
export default function ClientAlertsPage() {
  return <AlertsAssistant />;
}
