import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

// Test login route — creates a direct DB session bypassing OAuth
// Protected by TEST_LOGIN_SECRET env var
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");
  const email = searchParams.get("email") ?? "marinaboural262@gmail.com";

  const testSecret = process.env.TEST_LOGIN_SECRET;
  if (!testSecret || secret !== testSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find or create user
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name: "Test User",
        emailVerified: new Date(),
      },
    });
  }

  // Create session (30 days)
  const sessionToken = randomUUID();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires,
    },
  });

  // Set cookie and redirect to /deck
  // NextAuth v5 uses __Secure- prefix on HTTPS (Vercel prod)
  const isSecure = request.url.startsWith("https://");
  const cookieName = isSecure
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";

  const response = NextResponse.redirect(new URL("/deck", request.url));
  response.cookies.set(cookieName, sessionToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    expires,
    path: "/",
  });

  return response;
}
