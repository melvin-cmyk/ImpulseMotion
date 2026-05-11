import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Sidebar, SecondaryNav } from "@/components/sidebar";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/auth";
import { UserNav } from "@/components/user-nav";
import { AccountPicker } from "@/components/account-picker";
import { CreativesProvider } from "@/lib/creatives-context";

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
  const hasSharedToken = !!process.env.META_SHARED_TOKEN;
  const showApp = !!(session || hasSharedToken);

  return (
    <html lang="en">
      <body className={`${geist.variable} antialiased`}>
        <SessionProvider session={session}>
          <CreativesProvider>
            {showApp ? (
              <div className="flex h-screen bg-gray-950 text-gray-100">
                <Sidebar />
                <div className="flex-1 flex flex-col overflow-hidden">
                  <header className="h-12 border-b border-gray-800 flex items-center justify-between px-4 flex-shrink-0">
                    <AccountPicker userId={session?.userId ?? null} />
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
