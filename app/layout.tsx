import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar, SecondaryNav } from "@/components/sidebar";
import { SessionProvider } from "next-auth/react";
import { AclWatcher } from "@/components/acl-watcher";
import { AiJobsWatcher } from "@/components/ai-jobs-watcher";
import { GuideBot } from "@/components/guide-bot";
import { MoDock } from "@/components/mo/mo-dock";
import { auth } from "@/auth";
import { UserNav } from "@/components/user-nav";
import { CommandPalette } from "@/components/command-palette";
import { CreativesProvider } from "@/lib/creatives-context";
import { ClientNavLink } from "@/components/bot/client-nav-link";
import { LogoMark } from "@/components/brand/logo-mark";
import { countEnabledBotAccess, countVisibleClientDashboards } from "@/lib/bot-access";
import { cookies } from "next/headers";
import { ThemeToggle } from "@/components/theme-toggle";
import { THEME_COOKIE, parseTheme, type UiTheme } from "@/lib/ui-theme";
import { ClientUserNav } from "@/components/client-user-nav";

const geist = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});
// Figures and periods (tabular): the client space's signature.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "ImpulseMotion", template: "%s · ImpulseMotion" },
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
  // "Dashboards" hides when every dashboard of theirs is hidden (client
  // attached for the private bot only, DashboardMember.dashboardHidden).
  let hasBot = false;
  let hasDashboard = true;
  if (isClient && session?.userId) {
    try {
      hasBot = (await countEnabledBotAccess(session.userId)) > 0;
      hasDashboard = !hasBot || (await countVisibleClientDashboards(session.userId)) > 0;
    } catch {
      // DB hiccup: hide the link rather than break the layout
    }
  }

  // Day / night: the client's choice (cookie). Staff surfaces are drawn for
  // the night only, so the staff app always stays dark.
  let theme: UiTheme = "dark";
  if (!showApp || isClient) {
    try {
      theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
    } catch { /* default */ }
  }

  return (
    <html lang="fr" data-theme={theme}>
      <body className={`${geist.variable} ${geistMono.variable} antialiased`}>
        <SessionProvider session={session} refetchInterval={30} refetchOnWindowFocus>
          <AclWatcher />
          {/* Detached AI turns of the viewer: counts in the nav, a notice when a reply is ready. */}
          <AiJobsWatcher enabled={showApp}>
          <CreativesProvider>
            {showApp && isClient ? (
              // Client chrome: just their dashboard — no internal nav.
              <div className="flex flex-col h-screen bg-ui-bg text-ui-fg">
                <header className="h-14 border-b border-ui-line bg-ui-sunken flex items-center justify-between gap-4 px-4 sm:px-6 flex-shrink-0">
                  <div className="flex items-center gap-6 min-w-0">
                    <span className="flex items-center gap-2"><LogoMark size={24} /><span className="font-medium text-[15px] text-ui-fg">ImpulseMotion</span></span>
                    <nav className="flex items-center gap-1" aria-label="Espace client">
                      {hasDashboard && <ClientNavLink href="/d" label="Dashboards" />}
                      {hasBot && <ClientNavLink href="/bot" label="Assistant IA" />}
                    </nav>
                  </div>
                  {/* No account picker for clients: the dashboard defines the
                      account; switching brands happens on /d. */}
                  <div className="flex items-center gap-4">
                    <ThemeToggle initial={theme} />
                    {session ? <ClientUserNav session={session} /> : null}
                  </div>
                </header>
                <main className="flex-1 overflow-auto min-h-0">{children}</main>
              </div>
            ) : showApp ? (
              <div className="flex h-screen bg-gray-950 text-gray-100">
                {/* Staff only: clients get their own chrome above, without the guide. */}
                <GuideBot />
                {/* Mo on every staff page: hold the orb, speak, Mo answers and opens the page asked for (components/mo/mo-dock.tsx). */}
                <MoDock />
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
                  {/* pb-16: the Mo orb floats over the bottom of the page (components/mo/mo-dock.tsx). */}
                  <main className="flex-1 overflow-auto min-h-0 pb-16">
                    {children}
                  </main>
                </div>
              </div>
            ) : (
              <div className="min-h-screen bg-ui-bg text-ui-fg">
                {children}
              </div>
            )}
          </CreativesProvider>
          </AiJobsWatcher>
        </SessionProvider>
      </body>
    </html>
  );
}
