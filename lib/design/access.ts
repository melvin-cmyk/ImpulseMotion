/**
 * Who sees and manages a design: every staff member sees every design (the
 * agency's design files), the owner and the admins rename or delete it.
 */

import { prisma } from "@/lib/prisma";
import { editorUrlFor, type DesignDetail, type DesignListItem, type DesignMessage } from "@/lib/design/model";

export const DESIGN_SELECT = {
  id: true, ownerId: true, name: true, clientDashboardId: true, fileId: true, editLink: true, viewLink: true, messagesJson: true, createdAt: true, updatedAt: true,
  owner: { select: { email: true, name: true } },
  clientDashboard: { select: { name: true } },
} as const;

export type DesignRow = {
  id: string; ownerId: string; name: string; clientDashboardId: string | null; fileId: string; editLink: string; viewLink: string; messagesJson: string;
  createdAt: Date; updatedAt: Date; owner: { email: string | null; name: string | null }; clientDashboard: { name: string } | null;
};

export interface StaffSessionLike { userId: string; role?: string | null }

export function canManageDesign(row: Pick<DesignRow, "ownerId">, session: StaffSessionLike): boolean {
  return row.ownerId === session.userId || session.role === "admin";
}

export function toDesignListItem(row: DesignRow, session: StaffSessionLike): DesignListItem {
  return {
    id: row.id,
    name: row.name,
    clientDashboardId: row.clientDashboardId,
    clientName: row.clientDashboard?.name ?? null,
    ownerId: row.ownerId,
    ownerEmail: row.owner.email,
    ownerName: row.owner.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canManage: canManageDesign(row, session),
  };
}

export function toDesignDetail(row: DesignRow, session: StaffSessionLike, messages: DesignMessage[], jobId: string | null): DesignDetail {
  return {
    ...toDesignListItem(row, session),
    editorUrl: editorUrlFor(process.env.NEXT_PUBLIC_FIGCRAFT_URL, row.editLink),
    messages,
    jobId,
  };
}

export async function loadDesign(id: string): Promise<DesignRow | null> {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  return prisma.designFile.findUnique({ where: { id }, select: DESIGN_SELECT });
}
