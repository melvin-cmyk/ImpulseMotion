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
      aria-current={active ? "page" : undefined}
      className={`h-8 inline-flex items-center gap-2 px-3 rounded-lg text-sm transition-colors duration-150 ${active ? "bg-ui-raised text-ui-fg" : "text-ui-fg2 hover:text-ui-fg hover:bg-ui-raised/60"}`}
    >
      {label}
      {count > 0 && (
        <span title={`${count} réponse${count > 1 ? "s" : ""} en cours`} className="inline-flex items-center gap-1 font-mono text-xs tabular-nums text-ui-accent-ink">
          <span className="w-1.5 h-1.5 rounded-full bg-ui-accent" />
          {count}
        </span>
      )}
    </Link>
  );
}
