import { prisma } from "@/lib/prisma";

export type Platform = "meta" | "google" | "tiktok";

export async function getAllowedAccountIds(userId: string, platform: Platform): Promise<string[]> {
  const rows = await prisma.userAdAccount.findMany({
    where: { userId, platform },
    select: { accountId: true },
  });
  return rows.map((r) => r.accountId);
}

export async function assertAccountAllowed(
  userId: string,
  platform: Platform,
  accountId: string,
): Promise<boolean> {
  const normalized = accountId.replace(/^act_/, "");
  const count = await prisma.userAdAccount.count({
    where: {
      userId,
      platform,
      OR: [{ accountId }, { accountId: normalized }, { accountId: `act_${normalized}` }],
    },
  });
  return count > 0;
}

export async function getAllowedMcpServers(userId: string): Promise<string[]> {
  const rows = await prisma.userMcpPermission.findMany({
    where: { userId },
    select: { mcpServer: true },
  });
  return rows.map((r) => r.mcpServer);
}
