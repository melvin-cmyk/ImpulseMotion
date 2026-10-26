"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useSession } from "next-auth/react"
import {
  Settings,
  Zap,
  Sparkles,
  FileText,
  Bot,
  Activity,
  Layers,
  LayoutDashboard,
  Briefcase,
  ShieldCheck,
  BellRing,
  MessageSquare,
  Repeat,
  SlidersHorizontal,
  Wand2, PenTool, PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { cn } from "@/lib/utils"
import { ANALYSE_ROUTES } from "@/lib/nav-routes"
import { useAiJobs } from "@/components/ai-jobs-watcher"
import { useSidebarCollapsed } from "@/lib/sidebar-state"

// The rail is split into labeled sections so the boundary is obvious:
// "Espace interne" = admin & consultants only; "Espace clients" = the exact
// surface clients see when they log in (their dashboards, nothing else).
// Clients never see this sidebar at all (they get the minimal client chrome).
type NavItem = {
  href: string
  icon: React.ElementType
  label: string
  match?: (path: string) => boolean
  adminOnly?: boolean
  /** People management: only for the persons who really are admins (lib/roles.ts). */
  realAdminOnly?: boolean
  /** Shown to who may enter the routines: `session.routinesAccess`, decided on the server (ROUTINES_ACCESS). */
  routinesOnly?: boolean
}
type NavSection = { label: string; hint?: string; items: NavItem[] }


const REPORT_ROUTES = ["/reports"]

const NAV_SECTIONS: NavSection[] = [
  {
    label: "Espace interne",
    items: [
      {
        href: "/cockpit",
        icon: Activity,
        label: "Cockpit",
        match: (p) => p === "/" || p === "/cockpit" || p.startsWith("/me/") || p === "/dashboard",
      },
      {
        // Staff only: the section is hidden from clients (app/layout.tsx) and proxy.ts keeps /dashboards out of their prefixes.
        href: "/dashboards",
        icon: LayoutDashboard,
        label: "Mes dashboards",
        match: (p) => p === "/dashboards" || p.startsWith("/dashboards/"),
      },
      {
        href: "/portfolio",
        icon: Briefcase,
        label: "Clients",
        match: (p) => p === "/portfolio" || p.startsWith("/portfolio/"),
      },
      {
        href: "/reports",
        icon: FileText,
        label: "Rapports IA",
        match: (p) => REPORT_ROUTES.some((r) => p === r || p.startsWith(r + "/")),
      },
      {
        href: "/routines",
        icon: Repeat,
        label: "Routines",
        routinesOnly: true,
        match: (p) => p === "/routines" || p.startsWith("/routines/"),
      },
      {
        href: "/pilotage",
        icon: SlidersHorizontal,
        label: "Pilotage",
        match: (p) => p === "/pilotage" || p.startsWith("/pilotage/"),
      },
      {
        href: "/creatives",
        icon: Sparkles,
        label: "Analyse Ads",
        match: (p) => ANALYSE_ROUTES.some((r) => p === r || p.startsWith(r + "/")),
      },
      { href: "/studio", icon: Wand2, label: "Studio créa", match: (p) => p === "/studio" || p.startsWith("/studio/") },
      // Design files (FigCraft editor + AI copilot), staff only: proxy.ts keeps /design out of the client prefixes.
      { href: "/design", icon: PenTool, label: "Design", match: (p) => p === "/design" || p.startsWith("/design/") },
      { href: "/ai", icon: Bot, label: "AI Assistant", match: (p) => p.startsWith("/ai") },
    ],
  },
  {
    label: "Espace clients",
    hint: "Ce que voient vos clients",
    items: [
      {
        href: "/d",
        icon: Layers,
        label: "Dashboards consultant",
        match: (p) => p === "/d" || p.startsWith("/d/") || p === "/client" || p.startsWith("/client/"),
      },
      {
        href: "/bot",
        icon: MessageSquare,
        label: "Assistant IA",
        match: (p) => p === "/bot" || p.startsWith("/bot/"),
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        href: "/admin",
        icon: ShieldCheck,
        label: "Utilisateurs & accès",
        match: (p) => p === "/admin" || p.startsWith("/admin/users"),
        realAdminOnly: true,
      },
      {
        href: "/admin/bots",
        icon: Bot,
        label: "Bots clients",
        match: (p) => p.startsWith("/admin/bots"),
        realAdminOnly: true,
      },
      {
        href: "/admin/alerts/assistant",
        icon: BellRing,
        label: "Alertes",
        match: (p) => p.startsWith("/admin/alerts"),
      },
      { href: "/settings", icon: Settings, label: "Réglages", match: (p) => p.startsWith("/settings") },
    ],
  },
]

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  consultant: "Consultant",
  client: "Client",
}

export function Sidebar() {
  const pathname = usePathname()
  const { data: session } = useSession()
  const role = session?.role ?? "client"
  const isAdmin = role === "admin"
  const baseRole = session?.baseRole ?? role
  // Detached AI turns still running, per surface: a count next to the assistants.
  const { running } = useAiJobs()
  // Folded rail: icons only, labels as tooltips (remembered per browser).
  const [collapsed, toggleCollapsed] = useSidebarCollapsed()
  const runningFor = (href: string) => running.filter((j) => (href === "/ai" ? j.surface === "console" : href === "/bot" ? j.surface === "bot" : href === "/design" ? j.surface === "design" : false)).length

  return (
    <div className={cn("bg-gray-950 border-r border-gray-800 flex flex-col py-4 gap-1 shrink-0 overflow-y-auto overflow-x-hidden transition-[width] duration-150", collapsed ? "w-14 px-2" : "w-52 px-3")}>
      <div className={cn("flex items-center gap-2.5 mb-4", collapsed ? "justify-center px-0" : "px-2")}>
        <div className="w-9 h-9 bg-gradient-to-br from-violet-500 to-purple-700 rounded-xl flex items-center justify-center shrink-0" title="ImpulseMotion">
          <Zap className="w-5 h-5 text-white" />
        </div>
        {!collapsed && <span className="text-sm font-semibold text-white tracking-tight">ImpulseMotion</span>}
      </div>

      {NAV_SECTIONS.map((section) => {
        const items = section.items.filter((it) => (!it.adminOnly || isAdmin) && (!it.realAdminOnly || baseRole === "admin") && (!it.routinesOnly || session?.routinesAccess === true))
        if (items.length === 0) return null
        return (
          <div key={section.label} className="mb-3">
            {collapsed ? (
              <div className="mx-2 mb-2 border-t border-gray-800" title={section.label} />
            ) : (
              <div className="px-2 mb-1">
                <span className="text-[10px] uppercase tracking-wider text-gray-600 font-semibold">
                  {section.label}
                </span>
                {section.hint && (
                  <span className="block text-[10px] text-gray-700">{section.hint}</span>
                )}
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              {items.map(({ href, icon: Icon, label, match }) => {
                const active = match ? match(pathname) : pathname === href
                return (
                  <Link
                    key={href}
                    href={href}
                    title={collapsed ? label : undefined}
                    className={cn(
                      "relative flex items-center gap-3 h-9 rounded-xl text-sm font-medium transition-all duration-150",
                      collapsed ? "justify-center px-0" : "px-3",
                      active
                        ? "bg-violet-600 text-white"
                        : "text-gray-400 hover:text-gray-100 hover:bg-gray-800/70"
                    )}
                  >
                    <Icon className="w-5 h-5 shrink-0" />
                    {!collapsed && <span className="truncate">{label}</span>}
                    {collapsed && runningFor(href) > 0 && (
                      <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-violet-300 animate-pulse" title={`${runningFor(href)} réponse(s) en cours`} />
                    )}
                    {!collapsed && runningFor(href) > 0 && (
                      <span
                        title={`${runningFor(href)} réponse${runningFor(href) > 1 ? "s" : ""} en cours`}
                        className={cn("ml-auto inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full", active ? "bg-white/20 text-white" : "bg-violet-600/20 text-violet-300")}
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                        {runningFor(href)}
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        )
      })}

      <div className={cn("mt-auto flex flex-col gap-2 pt-3", collapsed ? "items-center" : "px-2")}>
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? "Déployer le menu" : "Replier le menu"}
          className={cn("flex items-center gap-2 h-8 rounded-lg text-xs text-gray-500 hover:text-gray-200 hover:bg-gray-800/70 transition-colors", collapsed ? "w-9 justify-center" : "px-2 w-full")}
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          {!collapsed && <span>Replier le menu</span>}
        </button>
        <div className="flex items-center gap-2" title={collapsed ? `${session?.user?.name ?? session?.user?.email ?? ""} · ${ROLE_LABELS[baseRole] ?? baseRole}` : undefined}>
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-600 to-gray-700 flex items-center justify-center text-xs font-semibold text-white shrink-0">
            {(session?.user?.name ?? "IM").slice(0, 2).toUpperCase()}
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="text-xs text-gray-400 truncate">{session?.user?.name ?? session?.user?.email ?? "Impulse Media"}</div>
              <div className="text-[10px] text-violet-400 font-semibold uppercase tracking-wide">{ROLE_LABELS[baseRole] ?? baseRole}</div>
            </div>
          )}
        </div>
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
      { href: "/creative-team", label: "Funnel" },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/angles", label: "Angles" },
      { href: "/patterns", label: "Patterns" },
      { href: "/top-copy", label: "Top Copy" },
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
