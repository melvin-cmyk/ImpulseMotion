import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { Zap } from "lucide-react";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.userId) redirect("/login?callbackUrl=/admin");
  if (session.role !== "admin" && session.role !== "consultant") redirect("/");
  const isAdmin = session.role === "admin";

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="sticky top-0 z-40 flex items-center justify-between px-6 py-3 bg-gray-950/80 backdrop-blur-xl border-b border-gray-800">
        <div className="flex items-center gap-6">
          <Link href="/admin" className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-gradient-to-br from-violet-500 to-purple-700 rounded-lg flex items-center justify-center">
              <Zap className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-bold text-sm tracking-tight">Admin · ImpulseMotion</span>
          </Link>
          <div className="flex items-center gap-1 text-sm">
            {isAdmin && <AdminNavLink href="/admin">Utilisateurs</AdminNavLink>}
            <AdminNavLink href="/reports">Rapports IA</AdminNavLink>
            <AdminNavLink href="/admin/alerts">Alertes</AdminNavLink>
            <AdminNavLink href="/portfolio">Portfolio</AdminNavLink>
            <span className="mx-2 h-4 w-px bg-gray-800" />
            <AdminNavLink href="/cockpit" muted>Retour à l&apos;app</AdminNavLink>
          </div>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button
            type="submit"
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-800 border border-gray-800 text-gray-400 transition-colors"
          >
            Déconnexion
          </button>
        </form>
      </nav>
      <main className="px-6 py-8 max-w-6xl mx-auto">{children}</main>
    </div>
  );
}

function AdminNavLink({ href, muted, children }: { href: string; muted?: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
        muted ? "text-gray-500 hover:text-gray-300" : "text-gray-300 hover:bg-gray-800 hover:text-white"
      }`}
    >
      {children}
    </Link>
  );
}
