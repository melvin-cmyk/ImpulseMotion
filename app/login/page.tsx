"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export default function LoginPage() {
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [loadingTikTok, setLoadingTikTok] = useState(false);

  const handleMeta = async () => {
    setLoadingMeta(true);
    await signIn("facebook", { callbackUrl: "/creatives" });
  };

  const handleTikTok = async () => {
    setLoadingTikTok(true);
    await signIn("tiktok", { callbackUrl: "/creatives" });
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#0a0a0f", color: "#ffffff" }}>

      {/* ───── NAV ───── */}
      <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4"
        style={{ background: "rgba(10,10,15,0.7)", backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(139,92,246,0.12)" }}>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>
            <svg viewBox="0 0 24 24" className="w-4 h-4 fill-white">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <span className="font-bold text-white text-lg tracking-tight">ImpulseMotion</span>
        </div>
        <a
          href="#cta"
          className="text-sm font-semibold px-4 py-2 rounded-lg transition-all duration-200 hover:opacity-90"
          style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)", color: "#fff" }}
        >
          Commencer gratuitement
        </a>
      </nav>

      {/* ───── HERO ───── */}
      <section className="relative flex flex-col items-center justify-center text-center px-6 pt-40 pb-32 overflow-hidden">
        {/* Background glow */}
        <div className="absolute inset-0 pointer-events-none" aria-hidden>
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] rounded-full opacity-20"
            style={{ background: "radial-gradient(ellipse at center, #7c3aed 0%, transparent 70%)" }} />
        </div>

        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full mb-8 text-xs font-medium tracking-wide"
          style={{ border: "1px solid rgba(139,92,246,0.4)", background: "rgba(124,58,237,0.1)", color: "#c4b5fd" }}>
          <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: "#a855f7" }} />
          Analyse créative propulsée par l'IA
        </div>

        {/* Headline */}
        <h1 className="text-5xl sm:text-6xl md:text-7xl font-black tracking-tight leading-[1.05] mb-6 relative z-10">
          <span className="text-white">ImpulseMotion</span>
        </h1>
        <p className="text-2xl sm:text-3xl font-semibold mb-6 relative z-10"
          style={{ background: "linear-gradient(90deg,#a78bfa,#f0abfc)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          Comprenez pourquoi vos pubs fonctionnent.
        </p>
        <p className="max-w-xl text-base sm:text-lg leading-relaxed relative z-10" style={{ color: "#9ca3af" }}>
          Connectez vos comptes Meta Ads et TikTok Ads pour analyser en profondeur
          vos créatives publicitaires et booster votre ROAS.
        </p>

        {/* Scroll arrow */}
        <div className="mt-16 flex flex-col items-center gap-2 animate-bounce relative z-10">
          <span className="text-xs" style={{ color: "#6b7280" }}>Découvrir</span>
          <svg viewBox="0 0 24 24" className="w-5 h-5" style={{ color: "#6b7280" }} fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </section>

      {/* ───── FEATURES ───── */}
      <section className="px-6 pb-32 max-w-6xl mx-auto">
        <div className="text-center mb-14">
          <p className="text-xs font-semibold tracking-widest uppercase mb-3" style={{ color: "#7c3aed" }}>Métriques clés</p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white">Tout ce dont vous avez besoin</h2>
          <p className="mt-3 text-base" style={{ color: "#6b7280" }}>Trois indicateurs pour comprendre la performance de chaque creative.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

          {/* Card 1 — Hook Rate */}
          <div className="group rounded-2xl p-px transition-all duration-300 hover:shadow-2xl"
            style={{ background: "linear-gradient(135deg,rgba(124,58,237,0.5),rgba(168,85,247,0.1),rgba(10,10,15,0))" }}>
            <div className="rounded-2xl p-7 h-full flex flex-col gap-5 transition-all duration-300 group-hover:-translate-y-1"
              style={{ background: "rgba(15,15,22,0.95)" }}>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                style={{ background: "rgba(124,58,237,0.2)", border: "1px solid rgba(124,58,237,0.4)" }}>
                <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="#a855f7" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </div>
              <div>
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-3xl font-black" style={{ color: "#a855f7" }}>Hook Rate</span>
                </div>
                <p style={{ color: "#9ca3af" }} className="text-sm leading-relaxed">
                  Mesure le pourcentage de spectateurs qui restent au-delà des 3 premières secondes.
                  Un bon hook, c'est tout.
                </p>
              </div>
              <div className="mt-auto pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs" style={{ color: "#6b7280" }}>Référence</span>
                  <span className="text-xs font-semibold" style={{ color: "#c4b5fd" }}>&gt; 30 % = excellent</span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
                  <div className="h-full rounded-full transition-all duration-700 group-hover:w-4/5 w-3/5"
                    style={{ background: "linear-gradient(90deg,#7c3aed,#a855f7)" }} />
                </div>
              </div>
            </div>
          </div>

          {/* Card 2 — Thumbstop Ratio */}
          <div className="group rounded-2xl p-px transition-all duration-300 hover:shadow-2xl"
            style={{ background: "linear-gradient(135deg,rgba(168,85,247,0.5),rgba(236,72,153,0.15),rgba(10,10,15,0))" }}>
            <div className="rounded-2xl p-7 h-full flex flex-col gap-5 transition-all duration-300 group-hover:-translate-y-1"
              style={{ background: "rgba(15,15,22,0.95)" }}>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                style={{ background: "rgba(168,85,247,0.2)", border: "1px solid rgba(168,85,247,0.4)" }}>
                <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="#c084fc" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0V11" />
                </svg>
              </div>
              <div>
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-3xl font-black" style={{ color: "#c084fc" }}>Thumbstop</span>
                </div>
                <p style={{ color: "#9ca3af" }} className="text-sm leading-relaxed">
                  Ratio d'impressions qui stoppent le scroll. L'indicateur le plus puissant
                  de l'accroche visuelle de votre créative.
                </p>
              </div>
              <div className="mt-auto pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs" style={{ color: "#6b7280" }}>Référence</span>
                  <span className="text-xs font-semibold" style={{ color: "#e9d5ff" }}>&gt; 25 % = top performer</span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
                  <div className="h-full rounded-full transition-all duration-700 group-hover:w-3/4 w-1/2"
                    style={{ background: "linear-gradient(90deg,#a855f7,#ec4899)" }} />
                </div>
              </div>
            </div>
          </div>

          {/* Card 3 — ROAS Visuel */}
          <div className="group rounded-2xl p-px transition-all duration-300 hover:shadow-2xl"
            style={{ background: "linear-gradient(135deg,rgba(79,70,229,0.5),rgba(124,58,237,0.2),rgba(10,10,15,0))" }}>
            <div className="rounded-2xl p-7 h-full flex flex-col gap-5 transition-all duration-300 group-hover:-translate-y-1"
              style={{ background: "rgba(15,15,22,0.95)" }}>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                style={{ background: "rgba(79,70,229,0.2)", border: "1px solid rgba(79,70,229,0.4)" }}>
                <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="#818cf8" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              </div>
              <div>
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-3xl font-black" style={{ color: "#818cf8" }}>ROAS Visuel</span>
                </div>
                <p style={{ color: "#9ca3af" }} className="text-sm leading-relaxed">
                  Visualisez le retour sur dépense publicitaire de chaque creative en un coup d'œil.
                  Identifiez vos winners instantanément.
                </p>
              </div>
              <div className="mt-auto pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs" style={{ color: "#6b7280" }}>Référence</span>
                  <span className="text-xs font-semibold" style={{ color: "#c7d2fe" }}>&gt; 3× = rentable</span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
                  <div className="h-full rounded-full transition-all duration-700 group-hover:w-5/6 w-2/3"
                    style={{ background: "linear-gradient(90deg,#4f46e5,#7c3aed)" }} />
                </div>
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* ───── SOCIAL PROOF STRIP ───── */}
      <div className="py-10 px-6" style={{ borderTop: "1px solid rgba(255,255,255,0.05)", borderBottom: "1px solid rgba(255,255,255,0.05)", background: "rgba(255,255,255,0.02)" }}>
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-center gap-10 text-center">
          {[
            { value: "2.4×", label: "ROAS moyen amélioré" },
            { value: "+38%", label: "Hook Rate médian" },
            { value: "500+", label: "Créatives analysées" },
            { value: "< 5s", label: "Temps d'analyse" },
          ].map((stat) => (
            <div key={stat.label} className="flex flex-col items-center gap-1">
              <span className="text-3xl font-black" style={{ background: "linear-gradient(90deg,#a78bfa,#f0abfc)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                {stat.value}
              </span>
              <span className="text-xs" style={{ color: "#6b7280" }}>{stat.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ───── CTA / LOGIN ───── */}
      <section id="cta" className="px-6 py-32 flex flex-col items-center text-center">
        {/* Glow */}
        <div className="absolute pointer-events-none" aria-hidden
          style={{ width: 600, height: 400, background: "radial-gradient(ellipse at center,rgba(124,58,237,0.18) 0%,transparent 70%)", transform: "translateX(-50%)", left: "50%" }} />

        <p className="text-xs font-semibold tracking-widest uppercase mb-4" style={{ color: "#7c3aed" }}>Accès immédiat</p>
        <h2 className="text-4xl sm:text-5xl font-black text-white mb-4 leading-tight">
          Prêt à comprendre<br />
          <span style={{ background: "linear-gradient(90deg,#a78bfa,#f0abfc)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            vos meilleures pubs ?
          </span>
        </h2>
        <p className="text-base mb-12 max-w-md" style={{ color: "#6b7280" }}>
          Connectez votre compte publicitaire en quelques secondes.
          Accès en lecture seule — aucune publication en votre nom.
        </p>

        {/* Login card */}
        <div className="w-full max-w-sm rounded-2xl p-px"
          style={{ background: "linear-gradient(135deg,rgba(124,58,237,0.6),rgba(168,85,247,0.2),rgba(255,255,255,0.05))" }}>
          <div className="rounded-2xl p-8" style={{ background: "#0e0e18" }}>

            {/* Meta button */}
            <button
              onClick={handleMeta}
              disabled={loadingMeta || loadingTikTok}
              className="w-full flex items-center gap-3 font-semibold px-5 py-4 rounded-xl mb-3 transition-all duration-200 hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
              style={{ background: "#1877F2", color: "#fff", boxShadow: "0 0 24px rgba(24,119,242,0.3)" }}
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white flex-shrink-0">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
              </svg>
              <span className="flex-1 text-left">
                {loadingMeta ? "Connexion en cours..." : "Connecter Meta Ads"}
              </span>
              {loadingMeta && (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin flex-shrink-0" />
              )}
            </button>

            {/* TikTok button */}
            <button
              onClick={handleTikTok}
              disabled={loadingMeta || loadingTikTok}
              className="w-full flex items-center gap-3 font-semibold px-5 py-4 rounded-xl transition-all duration-200 hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#fff",
              }}
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white flex-shrink-0">
                <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.35 6.35 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.17 8.17 0 004.78 1.52V6.75a4.85 4.85 0 01-1.01-.06z" />
              </svg>
              <span className="flex-1 text-left">
                {loadingTikTok ? "Connexion en cours..." : "Connecter TikTok Ads"}
              </span>
              {loadingTikTok && (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin flex-shrink-0" />
              )}
            </button>

            <div className="mt-6 pt-5" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              <p className="text-xs text-center" style={{ color: "#4b5563" }}>
                Accès en lecture seule &middot; Aucune publication en votre nom &middot; Données chiffrées
              </p>
            </div>
          </div>
        </div>

        <p className="mt-8 text-xs" style={{ color: "#374151" }}>
          En vous connectant, vous acceptez nos{" "}
          <a href="#" className="underline transition-colors hover:text-violet-400" style={{ color: "#6b7280" }}>
            conditions d&apos;utilisation
          </a>
          .
        </p>
      </section>

      {/* ───── FOOTER ───── */}
      <footer className="px-6 py-8 text-center" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="flex items-center justify-center gap-2 mb-3">
          <div className="w-5 h-5 rounded flex items-center justify-center"
            style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>
            <svg viewBox="0 0 24 24" className="w-3 h-3 fill-white">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-white">ImpulseMotion</span>
        </div>
        <p className="text-xs" style={{ color: "#374151" }}>
          &copy; {new Date().getFullYear()} ImpulseMotion. Tous droits réservés.
        </p>
      </footer>

    </div>
  );
}
