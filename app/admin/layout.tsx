import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.userId) redirect("/login?callbackUrl=/admin");
  if (session.role !== "admin") redirect("/");

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#0a0a0f", color: "#ffffff" }}>
      <nav
        className="sticky top-0 z-40 flex items-center justify-between px-6 py-4"
        style={{
          background: "rgba(10,10,15,0.8)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid rgba(139,92,246,0.15)",
        }}
      >
        <div className="flex items-center gap-6">
          <Link href="/admin" className="flex items-center gap-2.5">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}
            >
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-white">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <span className="font-bold text-sm tracking-tight">Admin · ImpulseMotion</span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/admin" className="hover:text-violet-400 transition-colors">
              Utilisateurs
            </Link>
            <Link href="/deck" className="hover:text-violet-400 transition-colors" style={{ color: "#9ca3af" }}>
              Retour à l&apos;app
            </Link>
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
            className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.08)",
              color: "#9ca3af",
            }}
          >
            Déconnexion
          </button>
        </form>
      </nav>
      <main className="px-6 py-8 max-w-5xl mx-auto">{children}</main>
    </div>
  );
}
