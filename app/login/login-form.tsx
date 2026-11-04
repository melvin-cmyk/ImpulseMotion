"use client";

import { signIn } from "next-auth/react";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/** Messages for /login?error=… (Auth.js redirects here when a sign-in is refused). */
const AUTH_ERRORS: Record<string, string> = {
  AccessDenied: "Aucun compte ImpulseMotion n'est ouvert pour cette adresse Google. Demandez l'accès à votre contact ImpulseMotion, ou connectez-vous avec votre mot de passe.",
  OAuthSignin: "Connexion Google impossible pour le moment. Réessayez ou utilisez votre mot de passe.",
  OAuthCallback: "Connexion Google interrompue. Réessayez ou utilisez votre mot de passe.",
  Configuration: "Connexion Google impossible pour le moment. Réessayez ou utilisez votre mot de passe.",
};

export default function LoginFormPage({ google }: { google: boolean }) {
  return (
    <Suspense fallback={null}>
      <LoginForm google={google} />
    </Suspense>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="w-4 h-4" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function LoginForm({ google }: { google: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  // "/" lets the middleware route by role: client → /client, staff → /cockpit
  // Only a path of this site: `/login?callbackUrl=https://evil.tld` must not send
  // a person elsewhere once they have typed their password.
  const rawCallback = params.get("callbackUrl") ?? "/";
  const callbackUrl = rawCallback.startsWith("/") && !rawCallback.startsWith("//") && !rawCallback.startsWith("/\\") ? rawCallback : "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const authError = params.get("error");
  const [error, setError] = useState<string | null>(authError ? AUTH_ERRORS[authError] ?? "Connexion impossible. Réessayez." : null);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  function handleGoogle() {
    setError(null);
    setGoogleLoading(true);
    void signIn("google", { redirectTo: callbackUrl });
  }

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await signIn("credentials", {
      email: email.trim().toLowerCase(),
      password,
      redirect: false,
    });
    setLoading(false);
    if (!res || res.error) {
      setError("Identifiants invalides");
      return;
    }
    router.push(callbackUrl);
    router.refresh();
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ backgroundColor: "#0a0a0f", color: "#ffffff" }}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-px"
        style={{
          background:
            "linear-gradient(135deg,rgba(124,58,237,0.6),rgba(168,85,247,0.2),rgba(255,255,255,0.05))",
        }}
      >
        <div className="rounded-2xl p-8" style={{ background: "#0e0e18" }}>
          <div className="flex items-center gap-2.5 mb-6">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-white">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <span className="font-bold text-white text-lg tracking-tight">
              ImpulseMotion
            </span>
          </div>

          <h1 className="text-xl font-semibold mb-1">Connexion</h1>
          <p className="text-sm mb-6" style={{ color: "#9ca3af" }}>
            Entrez vos identifiants fournis par l&apos;administrateur.
          </p>

          {google && (
            <>
              <button
                type="button"
                onClick={handleGoogle}
                disabled={googleLoading || loading}
                className="w-full flex items-center justify-center gap-2.5 px-5 py-3 rounded-xl font-medium text-sm transition-all hover:brightness-95 active:scale-95 disabled:opacity-50"
                style={{ background: "#ffffff", color: "#1f2937" }}
              >
                <GoogleMark />
                {googleLoading ? "Redirection vers Google..." : "Se connecter avec Google"}
              </button>
              <div className="flex items-center gap-3 my-5 text-xs" style={{ color: "#4b5563" }}>
                <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.08)" }} />
                ou avec votre mot de passe
                <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.08)" }} />
              </div>
            </>
          )}

          <form onSubmit={handleCredentials} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium" style={{ color: "#c4b5fd" }}>
                Email
              </span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="px-3 py-2.5 rounded-lg text-sm outline-none transition-colors focus:ring-2"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "#fff",
                }}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium" style={{ color: "#c4b5fd" }}>
                Mot de passe
              </span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="px-3 py-2.5 rounded-lg text-sm outline-none transition-colors focus:ring-2"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "#fff",
                }}
              />
            </label>

            {error && (
              <div
                className="text-xs px-3 py-2 rounded-lg"
                style={{
                  background: "rgba(239,68,68,0.1)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  color: "#fca5a5",
                }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="mt-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
              style={{
                background: "linear-gradient(135deg,#7c3aed,#a855f7)",
                color: "#fff",
              }}
            >
              {loading ? "Connexion..." : "Se connecter"}
            </button>
          </form>

          <p className="mt-6 text-xs text-center" style={{ color: "#4b5563" }}>
            Accès réservé aux clients ImpulseMotion
          </p>
        </div>
      </div>
    </div>
  );
}
