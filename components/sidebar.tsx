"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LayoutDashboard, Calendar, CheckSquare, FolderOpen, Zap } from "lucide-react"
import { cn } from "@/lib/utils"

const navItems = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/calendar", icon: Calendar, label: "Calendar" },
  { href: "/tasks", icon: CheckSquare, label: "Tasks" },
  { href: "/projects", icon: FolderOpen, label: "Projects" },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <div className="w-16 bg-gray-900 flex flex-col items-center py-4 gap-2 shrink-0">
      {/* Logo */}
      <div className="w-9 h-9 bg-indigo-500 rounded-lg flex items-center justify-center mb-4">
        <Zap className="w-5 h-5 text-white" />
      </div>

      {navItems.map(({ href, icon: Icon, label }) => (
        <Link
          key={href}
          href={href}
          title={label}
          className={cn(
            "w-10 h-10 rounded-lg flex items-center justify-center transition-colors",
            pathname === href
              ? "bg-indigo-500 text-white"
              : "text-gray-400 hover:text-white hover:bg-gray-800"
          )}
        >
          <Icon className="w-5 h-5" />
        </Link>
      ))}
    </div>
  )
}
