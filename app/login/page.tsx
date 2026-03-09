"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export default function LoginPage() {
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [loadingTikTok, setLoadingTikTok] = useState(false);

  const handleMeta = async () => {
    setLoadingMeta(true);
    await signIn("facebook", { callbackUrl: "/" });
  };

  const handleTikTok = async () => {
    setLoadingTikTok(true);
    await signIn("tiktok", { callbackUrl: "/" });
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="w-9 h-9 rounded-lg bg-violet-600 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-5 h-5 text-white fill-current">
                <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm13 0a5 5 0 110 10 5 5 0 010-10z" />
              </svg>
            </div>
            <span className="text-2xl font-bold text-white tracking-tight">
              ImpulseMotion
            </span>
          </div>
          <p className="text-gray-400 text-sm">
            Analyse de créatives publicitaires
          </p>
        </div>

        {/* Card */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 shadow-2xl">
          <h1 className="text-xl font-semibold text-white mb-2">
            Connecte ton compte pub
          </h1>
          <p className="text-gray-400 text-sm mb-8">
            Choisis la plateforme depuis laquelle tu veux analyser tes créatives.
          </p>

          {/* Meta button */}
          <button
            onClick={handleMeta}
            disabled={loadingMeta || loadingTikTok}
            className="w-full flex items-center gap-3 bg-[#1877F2] hover:bg-[#166ee0] disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold px-5 py-3.5 rounded-xl transition-colors mb-3"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current flex-shrink-0">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
            </svg>
            <span className="flex-1 text-left">
              {loadingMeta ? "Connexion..." : "Continuer avec Meta Ads"}
            </span>
            {loadingMeta && (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
          </button>

          {/* TikTok button */}
          <button
            onClick={handleTikTok}
            disabled={loadingMeta || loadingTikTok}
            className="w-full flex items-center gap-3 bg-gray-800 hover:bg-gray-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold px-5 py-3.5 rounded-xl transition-colors border border-gray-700"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current flex-shrink-0">
              <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.35 6.35 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.17 8.17 0 004.78 1.52V6.75a4.85 4.85 0 01-1.01-.06z" />
            </svg>
            <span className="flex-1 text-left">
              {loadingTikTok ? "Connexion..." : "Continuer avec TikTok Ads"}
            </span>
            {loadingTikTok && (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
          </button>

          {/* Trust line */}
          <p className="text-gray-600 text-xs text-center mt-6">
            Accès en lecture seule. Nous ne publions jamais à ta place.
          </p>
        </div>
      </div>
    </div>
  );
}
