/**
 * Dashboard access — the silo.
 *
 * A dashboard is created by an ADMIN, who attaches the people allowed in it by
 * email: consultants (staff working on the client) and clients (read access,
 * and their private bot). Nobody else gets in: there is no automatic
 * provisioning, and a consultant only sees the dashboards they were attached to.
 *
 * Membership is what the admin manages; it materialises the UserAdAccount rows
 * every data route already enforces (lib/acl, lib/scope, resolveBinding), and
 * removes them again when the last membership covering an account goes away.
 */

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { generateTempPassword } from "@/lib/temp-password";
import { grantDashboardAccess } from "@/lib/dashboard-widgets";
import { normMeta, normGoogle } from "@/lib/portfolio";

export type MemberRole = "consultant" | "client";

export class MemberError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MemberError";
  }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLE_LABEL: Record<string, string> = { admin: "admin", consultant: "consultant", client: "client" };

export const memberSelect = {
  id: true,
  userId: true,
  user: { select: { id: true, email: true, name: true, role: true } },
} as const;

export type AddedMember = {
  member: { id: string; userId: string; user: { id: string; email: string | null; name: string | null; role: string } };
  /** true when the login did not exist and was created with a temp password. */
  created: boolean;
  /** Shown ONCE to the admin, never stored in clear. */
  tempPassword?: string;
};

/**
 * Attaches a person to a dashboard by email. Unknown email → the login is
 * created with the requested role and a temporary password.
 */
export async function addDashboardMember(input: {
  dashboardId: string;
  email: string;
  role: MemberRole;
  name?: string | null;
}): Promise<AddedMember> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new MemberError(`email invalide : ${input.email}`, 400);

  const dashboard = await prisma.dashboard.findUnique({
    where: { id: input.dashboardId },
    select: { id: true, name: true, metaAccountId: true, googleCustomerId: true },
  });
  if (!dashboard) throw new MemberError("dashboard introuvable", 404);

  let user = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
  let tempPassword: string | undefined;
  if (user && user.role === "admin") {
    throw new MemberError(`${email} est admin : il voit déjà tous les dashboards`, 409);
  }
  if (user && user.role !== input.role) {
    throw new MemberError(`${email} existe déjà comme ${ROLE_LABEL[user.role] ?? user.role}, pas comme ${input.role}`, 409);
  }
  if (!user) {
    tempPassword = generateTempPassword();
    user = await prisma.user.create({
      data: {
        email,
        name: input.name?.trim().slice(0, 120) || null,
        role: input.role,
        passwordHash: await bcrypt.hash(tempPassword, 12),
      },
      select: { id: true, role: true },
    });
  }

  const member = await prisma.dashboardMember.upsert({
    where: { dashboardId_userId: { dashboardId: dashboard.id, userId: user.id } },
    update: {},
    create: { dashboardId: dashboard.id, userId: user.id },
    select: memberSelect,
  });
  await grantDashboardAccess(user.id, dashboard);
  return { member, created: !!tempPassword, ...(tempPassword ? { tempPassword } : {}) };
}

/**
 * Detaches a person: membership, their access to the dashboard's bot, and the
 * ACL rows no other dashboard of theirs still justifies.
 */
export async function removeDashboardMember(dashboardId: string, userId: string): Promise<void> {
  const dashboard = await prisma.dashboard.findUnique({
    where: { id: dashboardId },
    select: { id: true, metaAccountId: true, googleCustomerId: true, bot: { select: { id: true } } },
  });
  if (!dashboard) throw new MemberError("dashboard introuvable", 404);

  await prisma.dashboardMember.deleteMany({ where: { dashboardId, userId } });
  if (dashboard.bot) {
    await prisma.clientBotAccess.deleteMany({ where: { botId: dashboard.bot.id, userId } });
  }
  await revokeUncoveredAccess(userId, dashboard);
}

/** Drops the user's ACL rows on the given accounts unless another dashboard
 *  they own or belong to is bound to the same account. */
export async function revokeUncoveredAccess(
  userId: string,
  accounts: { metaAccountId: string | null; googleCustomerId: string | null },
): Promise<void> {
  const remaining = await prisma.dashboard.findMany({
    where: { OR: [{ userId }, { members: { some: { userId } } }] },
    select: { metaAccountId: true, googleCustomerId: true },
  });
  const stillMeta = new Set(remaining.flatMap((d) => (d.metaAccountId ? [normMeta(d.metaAccountId)] : [])));
  const stillGoogle = new Set(remaining.flatMap((d) => (d.googleCustomerId ? [normGoogle(d.googleCustomerId)] : [])));

  if (accounts.metaAccountId && !stillMeta.has(normMeta(accounts.metaAccountId))) {
    const id = normMeta(accounts.metaAccountId);
    await prisma.userAdAccount.deleteMany({ where: { userId, platform: "meta", accountId: { in: [id, `act_${id}`] } } });
  }
  if (accounts.googleCustomerId && !stillGoogle.has(normGoogle(accounts.googleCustomerId))) {
    const id = normGoogle(accounts.googleCustomerId);
    const rows = await prisma.userAdAccount.findMany({ where: { userId, platform: "google" }, select: { id: true, accountId: true } });
    const ids = rows.filter((r) => normGoogle(r.accountId) === id).map((r) => r.id);
    if (ids.length) await prisma.userAdAccount.deleteMany({ where: { id: { in: ids } } });
  }
}

/** Splits "a@x.fr, b@y.fr" / arrays into a clean, de-duplicated email list. */
export function parseEmails(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.map(String) : typeof input === "string" ? input.split(/[\s,;]+/) : [];
  return [...new Set(raw.map((e) => e.trim().toLowerCase()).filter(Boolean))];
}
