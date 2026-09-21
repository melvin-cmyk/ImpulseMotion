import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getAccountScope, dashboardWhere } from "@/lib/scope";
import { groupDashboardsByAccount } from "@/lib/portfolio";
import { CreateDashboardForm } from "@/components/dashboard/create-form";
import { DashboardMembersManager } from "@/components/dashboard/members-manager";

/**
 * /d — dashboard entry point.
 *
 * A dashboard is a silo: an admin creates it on an ad account (brand) and
 * attaches the consultants and clients allowed in it, by email. Nothing is
 * provisioned automatically. A client sees only the dashboards they were
 * attached to (one → straight to it); a consultant only theirs; admins all.
 */
export default async function DashboardsIndex() {
  const session = await auth();
  if (!session?.userId) redirect("/login?callbackUrl=/d");

  if (session.role === "client") {
    const dashboards = await prisma.dashboard.findMany({
      where: { OR: [{ members: { some: { userId: session.userId } } }, { userId: session.userId }] },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    if (dashboards.length === 1) redirect(`/d/${dashboards[0].id}`);
    return (
      <div className="max-w-2xl mx-auto px-6 py-10 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Vos dashboards</h1>
          <p className="text-sm text-gray-500 mt-1">
            Espace privé : seuls vous, votre consultant et l&apos;équipe Impulse y avez accès.
          </p>
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
              Aucun dashboard ne vous a encore été ouvert — contactez votre consultant.
            </div>
          )}
        </div>
      </div>
    );
  }

  const scope = await getAccountScope(session);
  const isAdmin = session.role === "admin";
  const rows = await prisma.dashboard.findMany({
    where: dashboardWhere(scope),
    include: {
      user: { select: { id: true, email: true, name: true } },
      _count: { select: { widgets: true } },
      members: {
        select: { id: true, userId: true, user: { select: { id: true, email: true, name: true, role: true } } },
        orderBy: { createdAt: "asc" },
      },
      bot: { select: { enabled: true, name: true, accesses: { select: { userId: true } } } },
    },
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
  });

  // Same grouping as the portfolio and the report picker: dashboards sharing an
  // ad account are ONE client. Listing raw rows showed every duplicate left by
  // the old provisioning race (24 of them on a single staff login).
  const { groups, unlinked } = groupDashboardsByAccount(rows);
  const dashboards = [
    ...groups.map((g) => ({ ...g.primary, duplicates: g.duplicates })),
    ...unlinked.map((d) => ({ ...d, duplicates: 0 })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboards clients</h1>
          <p className="text-sm text-gray-500 mt-1">
            Un espace cloisonné par client : seuls les consultants et clients rattachés par un admin y accèdent.
          </p>
        </div>
        {isAdmin && <CreateDashboardForm />}
      </div>

      <div className="grid gap-3">
        {dashboards.map((d) => (
          <div
            key={d.id}
            className="bg-gray-900 border border-gray-800 hover:border-violet-700 rounded-xl px-5 py-4 transition-colors"
          >
            <Link href={`/d/${d.id}`} className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-white">{d.name}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Créé par {d.user.name ?? d.user.email} · {d._count.widgets} widgets
                  {d.metaAccountId ? ` · Meta ${d.metaAccountId}` : ""}
                  {d.googleCustomerId ? ` · Google ${d.googleCustomerId}` : ""}
                  {d.duplicates > 0 ? ` · ${d.duplicates} doublon${d.duplicates > 1 ? "s" : ""} masqué${d.duplicates > 1 ? "s" : ""}` : ""}
                </div>
              </div>
              <span className="text-gray-600 text-sm">→</span>
            </Link>
            <DashboardMembersManager
              dashboardId={d.id}
              initialMembers={d.members.map((m) => ({ id: m.id, userId: m.userId, user: m.user }))}
              bot={d.bot ? { enabled: d.bot.enabled, name: d.bot.name, accessUserIds: d.bot.accesses.map((a) => a.userId) } : null}
            />
          </div>
        ))}
        {dashboards.length === 0 && (
          <div className="text-sm text-gray-500 bg-gray-900 border border-gray-800 rounded-xl px-5 py-6">
            {isAdmin
              ? "Aucun dashboard pour l'instant — créez-en un et rattachez-y consultants et clients."
              : "Aucun dashboard ne vous a été attribué — demandez à un admin de vous y rattacher."}
          </div>
        )}
      </div>
    </div>
  );
}
