"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Small header link of the client chrome (app/layout.tsx), active on prefix. */
export function ClientNavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname() ?? "";
  const active = pathname === href || pathname.startsWith(href + "/");
  return (
    <Link
      href={href}
      className={`px-2.5 py-1 rounded-md transition-colors ${active ? "bg-gray-800 text-white" : "text-gray-400 hover:text-white hover:bg-gray-900"}`}
    >
      {label}
    </Link>
  );
}
