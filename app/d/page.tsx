import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { provisionDashboardsForUser } from "@/lib/dashboard-widgets";

/**
 * /d — dashboard entry point.
 *
 * "Client" here means an AD ACCOUNT (brand), not a login: provisioning creates
 * one dashboard per ACL account. A client user with one brand goes straight to
 * it; with several brands they pick from their list. Staff see every dashboard,
 * named by brand.
 */
export default async function DashboardsIndex() {
  const session = await auth();
  if (!session?.userId) redirect("/login?callbackUrl=/d");

  if (session.role === "client") {
    const dashboards = await provisionDashboardsForUser(session.userId);
    if (dashboards.length === 1) redirect(`/d/${dashboards[0].id}`);
    return (
      <div className="max-w-2xl mx-auto px-6 py-10 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Vos dashboards</h1>
          <p className="text-sm text-gray-500 mt-1">Un dashboard de pilotage par compte publicitaire.</p>
        </div>
        <div className="grid gap-3">
          {dashboards.map((d) => (
            <Link
              key={d.id}
              href={`/d/${d.id}`}
              className="flex items-center justify-between bg-gray-900 border border-gray-800 hover:border-violet-700 rounded-xl px-5 py-4 transition-colors"
            >
              <span className="text-sm font-semibold text-white">{d.name}</span>
              <span className="text-gray-600 text-sm">→</span>
            </Link>
          ))}
          {dashboards.length === 0 && (
            <div className="text-sm text-gray-500 bg-gray-900 border border-gray-800 rounded-xl px-5 py-6">
              Aucun compte publicitaire ne vous est encore attribué — contactez votre consultant.
            </div>
          )}
        </div>
      </div>
    );
  }

  const [dashboards, clients] = await Promise.all([
    prisma.dashboard.findMany({
      include: {
        user: { select: { id: true, email: true, name: true } },
        _count: { select: { widgets: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.user.findMany({
      where: { role: "client" },
      select: {
        id: true, email: true, name: true,
        dashboards: { select: { id: true }, take: 1 },
        adAccounts: { select: { id: true }, take: 1 },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const withoutDashboard = clients.filter((c) => c.dashboards.length === 0 && c.adAccounts.length > 0);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboards clients</h1>
        <p className="text-sm text-gray-500 mt-1">
          Un dashboard par compte publicitaire — c&apos;est ce que voit le client en se connectant.
        </p>
      </div>

      <div className="grid gap-3">
        {dashboards.map((d) => (
          <Link
            key={d.id}
            href={`/d/${d.id}`}
            className="flex items-center justify-between bg-gray-900 border border-gray-800 hover:border-violet-700 rounded-xl px-5 py-4 transition-colors"
          >
            <div>
              <div className="text-sm font-semibold text-white">{d.name}</div>
              <div className="text-xs text-gray-500 mt-0.5">
                Accès : {d.user.name ?? d.user.email} · {d._count.widgets} widgets
                {d.metaAccountId ? ` · Meta ${d.metaAccountId}` : ""}
                {d.googleCustomerId ? ` · Google ${d.googleCustomerId}` : ""}
              </div>
            </div>
            <span className="text-gray-600 text-sm">→</span>
          </Link>
        ))}
        {dashboards.length === 0 && (
          <div className="text-sm text-gray-500 bg-gray-900 border border-gray-800 rounded-xl px-5 py-6">
            Aucun dashboard pour l&apos;instant — ils sont créés automatiquement à la première
            connexion d&apos;un client, ou via les boutons ci-dessous.
          </div>
        )}
      </div>

      {withoutDashboard.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Accès clients sans dashboard</h2>
          <div className="grid gap-2">
            {withoutDashboard.map((c) => (
              <form
                key={c.id}
                action={async () => {
                  "use server";
                  const s = await auth();
                  if (!s?.userId || (s.role !== "admin" && s.role !== "consultant")) return;
                  await provisionDashboardsForUser(c.id);
                  redirect("/d");
                }}
                className="flex items-center justify-between bg-gray-900/60 border border-gray-800 rounded-xl px-5 py-3"
              >
                <span className="text-sm text-gray-300">{c.name ?? c.email}</span>
                <button
                  type="submit"
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition-colors"
                >
                  Créer les dashboards
                </button>
              </form>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
