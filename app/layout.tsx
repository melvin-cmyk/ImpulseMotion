import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Sidebar, SecondaryNav } from "@/components/sidebar";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/auth";
import { UserNav } from "@/components/user-nav";
import { CommandPalette } from "@/components/command-palette";
import { CreativesProvider } from "@/lib/creatives-context";
import { ClientNavLink } from "@/components/bot/client-nav-link";
import { countEnabledBotAccess } from "@/lib/bot-access";

const geist = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ImpulseMotion — Ad Creative Analytics",
  description: "Analyze Facebook & TikTok ad creatives with ImpulseMotion",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let session = null;
  try {
    session = await auth();
  } catch {
    // Auth may fail if DB is unavailable — continue without session
  }
  // Chrome follows the session, nothing else. It used to also appear whenever
  // META_SHARED_TOKEN was set — a leftover of the token-only demo mode — which
  // in production wrapped the /login page in the full internal sidebar.
  const showApp = !!session;
  const isClient = session?.role === "client";

  // Client chrome: "Assistant IA" only shows when the user was granted at
  // least one enabled private bot (see lib/bot-access.ts).
  let hasBot = false;
  if (isClient && session?.userId) {
    try {
      hasBot = (await countEnabledBotAccess(session.userId)) > 0;
    } catch {
      // DB hiccup: hide the link rather than break the layout
    }
  }

  return (
    <html lang="en">
      <body className={`${geist.variable} antialiased`}>
        <SessionProvider session={session}>
          <CreativesProvider>
            {showApp && isClient ? (
              // Client chrome: just their dashboard — no internal nav.
              <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
                <header className="h-12 border-b border-gray-800 flex items-center justify-between px-4 flex-shrink-0">
                  <div className="flex items-center gap-5">
                    <span className="font-bold text-sm tracking-tight text-white">ImpulseMotion</span>
                    <nav className="flex items-center gap-1 text-sm">
                      <ClientNavLink href="/d" label="Dashboards" />
                      {hasBot && <ClientNavLink href="/bot" label="Assistant IA" />}
                    </nav>
                  </div>
                  {/* No account picker for clients: the dashboard defines the
                      account; switching brands happens on /d. */}
                  {session ? <UserNav session={session} /> : null}
                </header>
                <main className="flex-1 overflow-auto min-h-0">{children}</main>
              </div>
            ) : showApp ? (
              <div className="flex h-screen bg-gray-950 text-gray-100">
                <Sidebar />
                <div className="flex-1 flex flex-col overflow-hidden">
                  <header className="h-12 border-b border-gray-800 flex items-center justify-between px-4 flex-shrink-0">
                    {/* Global client search (⌘K): navigates to a client, never
                        filters the page. The analysed account lives in the
                        Analyse Ads context bar, the only place it applies. */}
                    <CommandPalette userId={session?.userId ?? null} />
                    {session ? <UserNav session={session} /> : null}
                  </header>
                  <SecondaryNav />
                  <main className="flex-1 overflow-auto min-h-0">
                    {children}
                  </main>
                </div>
              </div>
            ) : (
              <div className="min-h-screen bg-gray-950 text-gray-100">
                {children}
              </div>
            )}
          </CreativesProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
