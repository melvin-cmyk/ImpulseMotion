"use client"

import { useEffect, useState } from "react"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useSession } from "next-auth/react"
import {
  Settings,
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
  PenTool, PanelLeftClose, PanelLeftOpen, ChevronDown, AudioLines, Images,
} from "lucide-react"
import { LogoMark } from "@/components/brand/logo-mark"
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
        href: "/analyse",
        icon: Sparkles,
        label: "Analyse Ads",
        match: (p) => ANALYSE_ROUTES.some((r) => p === r || p.startsWith(r + "/")),
      },
      // Créas par client: generation (ex Studio créa, /studio redirects here), generated visuals, swipe file of templates, brand assets.
      { href: "/creas", icon: Images, label: "Créas", match: (p) => p === "/creas" || p.startsWith("/creas/") || p === "/studio" },
      // Design files (FigCraft editor + AI copilot), staff only: proxy.ts keeps /design out of the client prefixes.
      { href: "/design", icon: PenTool, label: "Design", match: (p) => p === "/design" || p.startsWith("/design/") },
      { href: "/ai", icon: Bot, label: "AI Assistant", match: (p) => p.startsWith("/ai") },
      // Mo: voice assistant on a full-screen board of cards (staff only, app/mo/layout.tsx).
      { href: "/mo", icon: AudioLines, label: "Mo", match: (p) => p === "/mo" || p.startsWith("/mo/") },
    ],
  },
  {
    label: "Espace clients",
    hint: "Ce que voient vos clients",
    items: [
      {
        href: "/d",
        icon: Layers,
        label: "Dashboards client",
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
  const [userCollapsed, toggleCollapsed] = useSidebarCollapsed()
  // Analyse Ads reproduces Motion's layout: the app navigation is an icon rail there.
  const collapsed = userCollapsed || pathname.startsWith("/analyse")
  // Each section is a dropdown: folded sections are remembered per browser.
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => { if (!active) return; try { setFolded(JSON.parse(localStorage.getItem("im:sidebar-folded") || "{}")) } catch { /* fine */ } })
    return () => { active = false }
  }, [])
  const toggleSection = (label: string) => setFolded((prev) => {
    const next = { ...prev, [label]: !prev[label] }
    try { localStorage.setItem("im:sidebar-folded", JSON.stringify(next)) } catch { /* fine */ }
    return next
  })
  const runningFor = (href: string) => running.filter((j) => (href === "/ai" ? j.surface === "console" : href === "/bot" ? j.surface === "bot" : href === "/design" ? j.surface === "design" : href === "/mo" ? j.surface === "mo" : false)).length

  return (
    <div className={cn("bg-ui-sunken border-r border-ui-line flex flex-col pb-4 gap-1 shrink-0 overflow-y-auto overflow-x-hidden no-scrollbar transition-[width] duration-150", collapsed ? "w-14 px-2" : "w-60 px-3")}>
      <div className={cn("h-14 flex items-center gap-2 mb-2 shrink-0", collapsed ? "justify-center px-0" : "px-2")} title="ImpulseMotion">
        <LogoMark size={24} />
        {!collapsed && <span className="text-[15px] font-medium text-ui-fg flex-1 truncate">ImpulseMotion</span>}
        {!collapsed && (
          <button type="button" onClick={toggleCollapsed} title="Replier le menu" className="p-1 rounded-md text-ui-muted hover:text-ui-fg hover:bg-ui-raised">
            <PanelLeftClose className="w-4 h-4" />
          </button>
        )}
      </div>
      {collapsed && !pathname.startsWith("/analyse") && (
        <button type="button" onClick={toggleCollapsed} title="Déployer le menu" className="mx-auto mb-2 w-9 h-8 flex items-center justify-center rounded-lg text-ui-muted hover:text-ui-fg hover:bg-ui-raised">
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      )}

      {NAV_SECTIONS.map((section) => {
        const items = section.items.filter((it) => (!it.adminOnly || isAdmin) && (!it.realAdminOnly || baseRole === "admin") && (!it.routinesOnly || session?.routinesAccess === true))
        if (items.length === 0) return null
        return (
          <div key={section.label} className="mt-4 first:mt-0">
            {collapsed ? (
              <div className="mx-2 mb-2 border-t border-ui-line" title={section.label} />
            ) : (
              <button
                type="button"
                onClick={() => toggleSection(section.label)}
                aria-expanded={!folded[section.label]}
                title={folded[section.label] ? "Déplier" : "Replier"}
                className="w-full px-2 mb-2 flex items-center gap-1 text-left group"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-xs text-ui-muted group-hover:text-ui-fg2">
                    {section.label}
                  </span>
                  {section.hint && !folded[section.label] && (
                    <span className="block text-xs text-ui-muted/80">{section.hint}</span>
                  )}
                </span>
                <ChevronDown className={cn("w-3.5 h-3.5 text-ui-muted group-hover:text-ui-fg2 transition-transform", folded[section.label] ? "-rotate-90" : "")} />
              </button>
            )}
            <div className={cn("flex flex-col gap-0.5", !collapsed && folded[section.label] ? "hidden" : "")}>
              {items.map(({ href, icon: Icon, label, match }) => {
                const active = match ? match(pathname) : pathname === href
                return (
                  <Link
                    key={href}
                    href={href}
                    title={collapsed ? label : undefined}
                    className={cn(
                      "relative flex items-center gap-2.5 h-8 rounded-lg text-sm transition-colors duration-150",
                      collapsed ? "justify-center px-0" : "px-2",
                      active
                        ? "bg-ui-raised text-ui-fg"
                        : "text-ui-fg2 hover:text-ui-fg hover:bg-ui-raised/60"
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon className={cn("w-4 h-4 shrink-0", active ? "text-ui-accent-ink" : "text-ui-muted")} strokeWidth={1.5} />
                    {!collapsed && <span className="truncate">{label}</span>}
                    {collapsed && runningFor(href) > 0 && (
                      <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-ui-accent" title={`${runningFor(href)} réponse(s) en cours`} />
                    )}
                    {!collapsed && runningFor(href) > 0 && (
                      <span
                        title={`${runningFor(href)} réponse${runningFor(href) > 1 ? "s" : ""} en cours`}
                        className="ml-auto inline-flex items-center gap-1 font-mono text-xs tabular-nums text-ui-accent-ink"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-ui-accent" />
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
        <div className="flex items-center gap-2" title={collapsed ? `${session?.user?.name ?? session?.user?.email ?? ""} · ${ROLE_LABELS[baseRole] ?? baseRole}` : undefined}>
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium text-ui-fg2 shrink-0 bg-ui-raised">
            {(session?.user?.name ?? "IM").slice(0, 2).toUpperCase()}
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="text-xs text-ui-fg2 truncate">{session?.user?.name ?? session?.user?.email ?? "Impulse Media"}</div>
              <div className="text-xs text-ui-muted">{ROLE_LABELS[baseRole] ?? baseRole}</div>
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

/** The legacy Analyse Ads sub-nav is gone: /analyse carries its own report sidebar. */
export function SecondaryNav() {
  return null
}
