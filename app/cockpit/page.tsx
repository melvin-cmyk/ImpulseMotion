"use client";

/**
 * /cockpit — staff landing page. « Pilotage » is the Global Cockpit (weekly
 * reading of every client, budget pace); « Activité » keeps the previous
 * cockpit: open alerts, recent changes, AI reports.
 */

import { useState } from "react";
import { GlobalCockpit } from "@/components/cockpit/global-cockpit";
import { CockpitActivity } from "@/components/cockpit/activity";

type View = "pilotage" | "activite";

export default function CockpitPage() {
  const [view, setView] = useState<View>("pilotage");
  return (
    <div className="space-y-4">
      <nav className="flex gap-1 px-6 pt-4" aria-label="Vues du cockpit">
        {([["pilotage", "Pilotage"], ["activite", "Activité"]] as Array<[View, string]>).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            aria-current={view === id}
            className={`rounded-lg px-3 py-1.5 text-sm ${view === id ? "bg-violet-600 text-white" : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"}`}
          >
            {label}
          </button>
        ))}
      </nav>
      {view === "pilotage" ? <div className="px-6 pb-8"><GlobalCockpit /></div> : <CockpitActivity />}
    </div>
  );
}
