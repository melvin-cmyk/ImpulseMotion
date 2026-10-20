"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAiJobs } from "@/components/ai-jobs-watcher";

/** Small header link of the client chrome (app/layout.tsx), active on prefix.
 *  The assistant link carries the number of replies still being produced. */
export function ClientNavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname() ?? "";
  const active = pathname === href || pathname.startsWith(href + "/");
  const { running } = useAiJobs();
  const count = href === "/bot" ? running.filter((j) => j.surface === "bot").length : 0;
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors ${active ? "bg-gray-800 text-white" : "text-gray-400 hover:text-white hover:bg-gray-900"}`}
    >
      {label}
      {count > 0 && (
        <span title={`${count} réponse${count > 1 ? "s" : ""} en cours`} className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-600/20 text-violet-300">
          <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
          {count}
        </span>
      )}
    </Link>
  );
}
