"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  Grid2X2,
  BarChart3,
  GitCompareArrows,
  AlertTriangle,
  Settings,
  Zap,
  Tag,
  Share2,
  Rocket,
  PieChart,
  Shapes,
  MessageSquare,
  Users,
  FileText,
  Layers,
} from "lucide-react"
import { cn } from "@/lib/utils"

const navItems = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/creatives", icon: Grid2X2, label: "Creatives" },
  { href: "/launch", icon: Rocket, label: "Launch Analysis" },
  { href: "/top-charts", icon: BarChart3, label: "Top Charts" },
  { href: "/compare", icon: GitCompareArrows, label: "A/B Compare" },
  { href: "/comparaisons", icon: PieChart, label: "Comparaisons" },
  { href: "/angles", icon: MessageSquare, label: "Angles" },
  { href: "/patterns", icon: Shapes, label: "Patterns" },
  { href: "/fatigue", icon: AlertTriangle, label: "Fatigue" },
  { href: "/naming", icon: Tag, label: "Naming Convention" },
  { href: "/top-copy", icon: FileText, label: "Top Copy" },
  { href: "/visual-format", icon: Layers, label: "Format Visuel" },
  { href: "/creative-team", icon: Users, label: "Équipe créa" },
  { href: "/reports", icon: Share2, label: "Reports" },
  { href: "/settings", icon: Settings, label: "Settings" },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <div className="w-16 bg-gray-950 border-r border-gray-800 flex flex-col items-center py-4 gap-1 shrink-0">
      <div className="w-9 h-9 bg-gradient-to-br from-violet-500 to-purple-700 rounded-xl flex items-center justify-center mb-5">
        <Zap className="w-5 h-5 text-white" />
      </div>

      {navItems.map(({ href, icon: Icon, label }) => (
        <Link
          key={href}
          href={href}
          title={label}
          className={cn(
            "w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150",
            pathname === href
              ? "bg-violet-600 text-white"
              : "text-gray-500 hover:text-gray-200 hover:bg-gray-800"
          )}
        >
          <Icon className="w-5 h-5" />
        </Link>
      ))}

      <div className="mt-auto">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-600 to-gray-700 flex items-center justify-center text-xs font-semibold text-white">
          IM
        </div>
      </div>
    </div>
  )
}
