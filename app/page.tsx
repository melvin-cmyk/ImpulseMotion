import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Nav */}
      <nav className="border-b border-gray-800/60 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-white fill-current">
                <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm13 0a5 5 0 110 10 5 5 0 010-10z" />
              </svg>
            </div>
            <span className="text-lg font-bold text-white tracking-tight">ImpulseMotion</span>
          </div>
          <Link
            href="/login"
            className="text-sm text-gray-400 hover:text-white transition-colors font-medium"
          >
            Se connecter →
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-20 text-center">
        <div className="inline-flex items-center gap-2 bg-violet-950/60 border border-violet-800/50 rounded-full px-4 py-1.5 mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 inline-block" />
          <span className="text-violet-300 text-xs font-medium tracking-wide uppercase">
            Meta Ads &amp; TikTok Ads Analytics
          </span>
        </div>

        <h1 className="text-5xl sm:text-6xl font-extrabold text-white leading-tight tracking-tight mb-6 max-w-3xl mx-auto">
          Pourquoi cette publicité{" "}
          <span className="text-violet-400">fonctionne-t-elle</span> ou non&nbsp;?
        </h1>

        <p className="text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
          Analysez vos créatives Meta &amp; TikTok comme les meilleurs media buyers.
          Visuellement.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2.5 bg-[#1877F2] hover:bg-[#166ee0] text-white font-semibold px-6 py-3.5 rounded-xl transition-colors shadow-lg shadow-blue-900/30"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current flex-shrink-0">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
            </svg>
            Connecter Meta Ads
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2.5 bg-gray-900 hover:bg-gray-800 text-white font-semibold px-6 py-3.5 rounded-xl transition-colors border border-gray-700"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current flex-shrink-0">
              <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.35 6.35 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.17 8.17 0 004.78 1.52V6.75a4.85 4.85 0 01-1.01-.06z" />
            </svg>
            Connecter TikTok Ads
          </Link>
        </div>
      </section>

      {/* Stats bar */}
      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="grid grid-cols-3 divide-x divide-gray-800 border border-gray-800 rounded-2xl bg-gray-900/50">
          {[
            { label: "Hook Rate", desc: "Rétention dans les 3 premières secondes" },
            { label: "Thumbstop Ratio", desc: "Taux d'arrêt sur votre créative" },
            { label: "ROAS Visuel", desc: "Retour sur investissement par créative" },
          ].map((stat) => (
            <div key={stat.label} className="px-8 py-6 text-center">
              <p className="text-base font-semibold text-gray-200 mb-1">{stat.label}</p>
              <p className="text-xs text-gray-500">{stat.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-bold text-white mb-3">Tout ce dont vous avez besoin</h2>
          <p className="text-gray-400">Un dashboard pensé pour les media buyers exigeants.</p>
        </div>

        <div className="grid sm:grid-cols-3 gap-5">
          {[
            {
              emoji: "🎯",
              title: "Analyse Créative Visuelle",
              desc: "Voyez vos performances directement sur les visuels. Fini les tableurs Excel.",
            },
            {
              emoji: "📊",
              title: "Décomposition du Funnel",
              desc: "CPM → CTR → Taux de conversion. Identifiez exactement où ça coince.",
            },
            {
              emoji: "🔄",
              title: "Rapports Partageables",
              desc: "Envoyez un lien à votre monteur vidéo avec les perfs affichées sur chaque créative.",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="bg-gray-900 border border-gray-800 rounded-2xl p-7 hover:border-gray-700 transition-colors"
            >
              <div className="text-3xl mb-4">{f.emoji}</div>
              <h3 className="text-white font-semibold text-lg mb-2">{f.title}</h3>
              <p className="text-gray-400 text-sm leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Metrics */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-bold text-white mb-3">Les métriques qui comptent</h2>
          <p className="text-gray-400">Chaque KPI expliqué simplement pour optimiser vos créatives.</p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            {
              metric: "Hook Rate",
              question: "Les 3 premières secondes accrochent-elles ?",
              color: "from-violet-600/20 to-transparent",
              accent: "text-violet-400",
            },
            {
              metric: "Hold Rate",
              question: "Regardent-ils jusqu'au bout ?",
              color: "from-blue-600/20 to-transparent",
              accent: "text-blue-400",
            },
            {
              metric: "Thumbstop Ratio",
              question: "S'arrêtent-ils sur votre pub ?",
              color: "from-emerald-600/20 to-transparent",
              accent: "text-emerald-400",
            },
            {
              metric: "CTR",
              question: "Cliquent-ils pour en savoir plus ?",
              color: "from-orange-600/20 to-transparent",
              accent: "text-orange-400",
            },
          ].map((k) => (
            <div
              key={k.metric}
              className={`bg-gradient-to-b ${k.color} bg-gray-900 border border-gray-800 rounded-2xl p-6 hover:border-gray-700 transition-colors`}
            >
              <p className={`text-xl font-bold mb-2 ${k.accent}`}>{k.metric}</p>
              <p className="text-gray-400 text-sm leading-relaxed">{k.question}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer CTA */}
      <section className="border-t border-gray-800/60">
        <div className="max-w-6xl mx-auto px-6 py-20 text-center">
          <h2 className="text-4xl font-extrabold text-white mb-4">
            Prêt à scaler vos créatives&nbsp;?
          </h2>
          <p className="text-gray-400 mb-8 text-lg">
            Connectez votre compte publicitaire en quelques secondes.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 bg-violet-600 hover:bg-violet-500 text-white font-semibold px-8 py-4 rounded-xl transition-colors shadow-lg shadow-violet-900/40 text-lg mb-5"
          >
            Connecter votre compte pub
            <svg viewBox="0 0 20 20" className="w-5 h-5 fill-current">
              <path
                fillRule="evenodd"
                d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </Link>
          <p className="text-gray-600 text-sm">
            Accès en lecture seule. Nous ne publions jamais à votre place.
          </p>
        </div>
      </section>
    </div>
  );
}
