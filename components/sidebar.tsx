"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Settings,
  Zap,
  Sparkles,
  Presentation,
  Bot,
  Activity,
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

const DECK_ROUTES = ["/deck", "/create/weekly", "/create/monthly", "/reports"]

const navItems: NavItem[] = [
  {
    href: "/cockpit",
    icon: Activity,
    label: "Cockpit",
    match: (p) => p === "/" || p === "/cockpit" || p.startsWith("/me/") || p === "/portfolio" || p === "/dashboard",
  },
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
  { href: "/ai", icon: Bot, label: "AI Assistant", match: (p) => p.startsWith("/ai") },
  { href: "/settings", icon: Settings, label: "Réglages", match: (p) => p.startsWith("/settings") },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <div className="w-52 bg-gray-950 border-r border-gray-800 flex flex-col py-4 px-3 gap-1 shrink-0">
      <div className="flex items-center gap-2.5 px-2 mb-6">
        <div className="w-9 h-9 bg-gradient-to-br from-violet-500 to-purple-700 rounded-xl flex items-center justify-center shrink-0">
          <Zap className="w-5 h-5 text-white" />
        </div>
        <span className="text-sm font-semibold text-white tracking-tight">ImpulseMotion</span>
      </div>

      <div className="flex flex-col gap-1">
        {navItems.map(({ href, icon: Icon, label, match }) => {
          const active = match ? match(pathname) : pathname === href
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 h-10 px-3 rounded-xl text-sm font-medium transition-all duration-150",
                active
                  ? "bg-violet-600 text-white"
                  : "text-gray-400 hover:text-gray-100 hover:bg-gray-800/70"
              )}
            >
              <Icon className="w-5 h-5 shrink-0" />
              <span className="truncate">{label}</span>
            </Link>
          )
        })}
      </div>

      <div className="mt-auto flex items-center gap-2 px-2">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-600 to-gray-700 flex items-center justify-center text-xs font-semibold text-white shrink-0">
          IM
        </div>
        <span className="text-xs text-gray-500 truncate">Impulse Media</span>
      </div>
    </div>
  )
}

// Contextual secondary nav shown under the main header when the user is
// inside the Analyse Ads section. Grouped into 3 categories so the rail stays
// scannable rather than a 13-tab horizontal scroll.
type SubNavGroup = { label: string; items: { href: string; label: string }[] }

const ANALYSE_SUB_NAV: SubNavGroup[] = [
  {
    label: "Performance",
    items: [
      { href: "/creatives", label: "Créas" },
      { href: "/launch", label: "Launch" },
      { href: "/top-charts", label: "Top Charts" },
      { href: "/fatigue", label: "Fatigue" },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/angles", label: "Angles" },
      { href: "/patterns", label: "Patterns" },
      { href: "/top-copy", label: "Top Copy" },
      { href: "/visual-format", label: "Visual" },
      { href: "/audience", label: "Audience" },
      { href: "/top-landing-page", label: "Landing" },
    ],
  },
  {
    label: "Comparer",
    items: [
      { href: "/compare", label: "A/B" },
      { href: "/comparaisons", label: "Comparaisons" },
      { href: "/naming", label: "Naming" },
    ],
  },
]

export function SecondaryNav() {
  const pathname = usePathname()
  const inAnalyse = ANALYSE_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"))
  if (!inAnalyse) return null

  return (
    <nav className="h-10 border-b border-gray-800 bg-gray-950 flex items-center gap-3 px-4 overflow-x-auto flex-shrink-0">
      {ANALYSE_SUB_NAV.map((group, groupIdx) => (
        <div key={group.label} className="flex items-center gap-1 shrink-0">
          <span className="text-[10px] uppercase tracking-wider text-gray-600 font-semibold mr-1">
            {group.label}
          </span>
          {group.items.map(({ href, label }) => {
            const active = pathname === href || pathname.startsWith(href + "/")
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors",
                  active
                    ? "bg-violet-600 text-white"
                    : "text-gray-400 hover:text-gray-100 hover:bg-gray-800"
                )}
              >
                {label}
              </Link>
            )
          })}
          {groupIdx < ANALYSE_SUB_NAV.length - 1 && (
            <span className="h-4 w-px bg-gray-800 ml-1" />
          )}
        </div>
      ))}
    </nav>
  )
}
