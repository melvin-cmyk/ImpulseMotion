"use client";

import { LogoMark } from "@/components/brand/logo-mark";

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

  const field = "h-10 px-3 rounded-lg text-sm bg-ui-card text-ui-fg border border-ui-line-strong outline-none focus:border-ui-accent transition-colors duration-150";
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-ui-bg text-ui-fg">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-12">
          <LogoMark size={24} />
          <span className="font-medium text-[15px]">ImpulseMotion</span>
        </div>

        <h1 className="text-3xl font-normal leading-tight">Connexion</h1>
        <p className="text-[15px] text-ui-fg2 mt-2 mb-8">Votre espace Impulse Analytics : vos campagnes, vos créas et votre assistant</p>

        {google && (
          <>
            <button
              type="button"
              onClick={handleGoogle}
              disabled={googleLoading || loading}
              className="w-full h-11 flex items-center justify-center gap-2.5 rounded-lg text-sm font-medium bg-ui-card text-ui-fg border border-ui-line-strong hover:bg-ui-raised active:scale-[0.98] transition-[background-color,transform] duration-150 ease-ui disabled:opacity-50"
            >
              <GoogleMark />
              {googleLoading ? "Redirection vers Google" : "Continuer avec Google"}
            </button>
            <div className="flex items-center gap-3 my-6 text-xs text-ui-muted">
              <div className="h-px flex-1 bg-ui-line" />
              ou avec votre mot de passe
              <div className="h-px flex-1 bg-ui-line" />
            </div>
          </>
        )}

        <form onSubmit={handleCredentials} className="flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-sm text-ui-fg2">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={field}
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm text-ui-fg2">Mot de passe</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
            />
          </label>

          {error && (
            <div role="alert" className="text-sm px-3 py-2 rounded-lg bg-ui-neg/10 text-ui-neg">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-2 h-11 rounded-lg text-sm font-medium bg-ui-accent text-ui-on-accent hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150 ease-ui disabled:opacity-50"
          >
            {loading ? "Connexion" : "Se connecter"}
          </button>
        </form>

        <p className="mt-8 text-xs text-ui-muted">Identifiants fournis par votre interlocuteur chez Impulse Analytics</p>
      </div>
    </div>
  );
}
