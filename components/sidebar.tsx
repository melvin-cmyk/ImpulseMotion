"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  Settings,
  Zap,
  Sparkles,
  Presentation,
} from "lucide-react"
import { cn } from "@/lib/utils"

// Top-level navigation — intentionally minimal. Sub-features live in a
// contextual secondary nav (see SecondaryNav) so the rail stays uncluttered.
type NavItem = { href: string; icon: React.ElementType; label: string; match?: (path: string) => boolean }

const ANALYSE_ROUTES = [
  "/creatives", "/launch", "/top-charts", "/compare", "/comparaisons",
  "/patterns", "/angles", "/audience", "/top-copy", "/visual-format",
  "/top-landing-page", "/fatigue", "/naming",
]

const DECK_ROUTES = ["/deck", "/create/weekly", "/create/monthly", "/reports", "/ai"]

const navItems: NavItem[] = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard", match: (p) => p === "/" },
  {
    href: "/creatives",
    icon: Sparkles,
    label: "Analyse Ads",
    match: (p) => ANALYSE_ROUTES.some((r) => p === r || p.startsWith(r + "/")),
  },
  {
    href: "/deck",
    icon: Presentation,
    label: "Deck Builder",
    match: (p) => DECK_ROUTES.some((r) => p === r || p.startsWith(r + "/")),
  },
  { href: "/settings", icon: Settings, label: "Réglages", match: (p) => p.startsWith("/settings") },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <div className="w-16 bg-gray-950 border-r border-gray-800 flex flex-col items-center py-4 gap-1 shrink-0">
      <div className="w-9 h-9 bg-gradient-to-br from-violet-500 to-purple-700 rounded-xl flex items-center justify-center mb-5">
        <Zap className="w-5 h-5 text-white" />
      </div>

      <div className="flex flex-col items-center gap-2 w-full">
        {navItems.map(({ href, icon: Icon, label, match }) => {
          const active = match ? match(pathname) : pathname === href
          return (
            <Link
              key={href}
              href={href}
              title={label}
              className={cn(
                "w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150",
                active
                  ? "bg-violet-600 text-white"
                  : "text-gray-500 hover:text-gray-200 hover:bg-gray-800"
              )}
            >
              <Icon className="w-5 h-5" />
            </Link>
          )
        })}
      </div>

      <div className="mt-auto">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-600 to-gray-700 flex items-center justify-center text-xs font-semibold text-white">
          IM
        </div>
      </div>
    </div>
  )
}

// Contextual secondary nav shown under the main header when the user is
// inside the Analyse Ads section. Lives here to keep the route list in sync.
const ANALYSE_SUB_NAV: { href: string; label: string }[] = [
  { href: "/creatives", label: "Creatives" },
  { href: "/launch", label: "Launch" },
  { href: "/top-charts", label: "Top Charts" },
  { href: "/compare", label: "A/B Compare" },
  { href: "/comparaisons", label: "Comparaisons" },
  { href: "/patterns", label: "Patterns" },
  { href: "/angles", label: "Angles" },
  { href: "/audience", label: "Audience" },
  { href: "/top-copy", label: "Top Copy" },
  { href: "/visual-format", label: "Visual Format" },
  { href: "/top-landing-page", label: "Landing Pages" },
  { href: "/fatigue", label: "Fatigue" },
  { href: "/naming", label: "Naming" },
]

export function SecondaryNav() {
  const pathname = usePathname()
  const inAnalyse = ANALYSE_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"))
  if (!inAnalyse) return null

  return (
    <nav className="h-10 border-b border-gray-800 bg-gray-950 flex items-center gap-1 px-4 overflow-x-auto flex-shrink-0">
      {ANALYSE_SUB_NAV.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(href + "/")
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors",
              active
                ? "bg-violet-600 text-white"
                : "text-gray-400 hover:text-gray-100 hover:bg-gray-800"
            )}
          >
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
