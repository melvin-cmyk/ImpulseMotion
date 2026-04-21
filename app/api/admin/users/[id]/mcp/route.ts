import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { MCP_SERVER_WHITELIST } from "@/lib/mcp-whitelist";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Ctx) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const { id: userId } = await params;
  const body = await req.json().catch(() => ({}));
  const incoming: string[] = Array.isArray(body.servers) ? body.servers.map(String) : [];
  const valid = incoming.filter((s) => (MCP_SERVER_WHITELIST as readonly string[]).includes(s));

  await prisma.$transaction([
    prisma.userMcpPermission.deleteMany({ where: { userId } }),
    ...(valid.length
      ? [prisma.userMcpPermission.createMany({ data: valid.map((mcpServer) => ({ userId, mcpServer })) })]
      : []),
  ]);

  return NextResponse.json({ servers: valid });
}
