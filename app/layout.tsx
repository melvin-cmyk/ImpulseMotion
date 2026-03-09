import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/auth";
import { UserNav } from "@/components/user-nav";

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
  const session = await auth();
  const isLoginPage = false; // middleware handles redirects

  return (
    <html lang="en">
      <body className={`${geist.variable} antialiased`}>
        <SessionProvider session={session}>
          {session ? (
            <div className="flex h-screen bg-gray-950 text-gray-100">
              <Sidebar />
              <div className="flex-1 flex flex-col overflow-hidden">
                <header className="h-12 border-b border-gray-800 flex items-center justify-end px-4 flex-shrink-0">
                  <UserNav session={session} />
                </header>
                <main className="flex-1 overflow-auto">
                  {children}
                </main>
              </div>
            </div>
          ) : (
            <div className="min-h-screen bg-gray-950 text-gray-100">
              <header className="h-12 border-b border-gray-800 flex items-center justify-end px-4">
                <a
                  href="/login"
                  className="text-sm text-gray-300 hover:text-white transition-colors"
                >
                  Se connecter
                </a>
              </header>
              {children}
            </div>
          )}
        </SessionProvider>
      </body>
    </html>
  );
}
