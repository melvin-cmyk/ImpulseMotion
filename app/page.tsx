"use client";

import { useCreativesContext } from "@/lib/creatives-context";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { TrendingUp, DollarSign, MousePointerClick, Zap } from "lucide-react";
import { useMemo } from "react";
import { DateRangePicker } from "@/components/date-range-picker";
import { WowBanner } from "@/components/wow-indicator";

// ─── KPI card ────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  gradient: string;
  accentText: string;
}

function KpiCard({ label, value, sub, icon: Icon, gradient, accentText }: KpiCardProps) {
  return (
    <div
      className={`bg-gradient-to-br ${gradient} border border-gray-800 rounded-2xl p-5 flex flex-col gap-4`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
          {label}
        </span>
        <div className="w-8 h-8 rounded-xl bg-gray-800/70 flex items-center justify-center">
          <Icon className={`w-4 h-4 ${accentText}`} />
        </div>
      </div>
      <div>
        <p className={`text-3xl font-extrabold ${accentText}`}>{value}</p>
        {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Dashboard home (logged in) ───────────────────────────────────────────────

function DashboardHome() {
  const { creatives, isLoading, dateRange, wowData, isWowLoading } = useCreativesContext();

  const kpis = useMemo(() => {
    if (creatives.length === 0) {
      return { totalSpend: 0, avgCtr: 0, avgHookRate: 0, avgRoas: 0 };
    }
    const totalSpend = creatives.reduce((s, c) => s + c.spend, 0);
    const avgCtr =
      creatives.reduce((s, c) => s + c.ctr, 0) / creatives.length;
    const videoCreatives = creatives.filter((c) => c.hookRate > 0);
    const avgHookRate =
      videoCreatives.length > 0
        ? videoCreatives.reduce((s, c) => s + c.hookRate, 0) / videoCreatives.length
        : 0;
    const avgRoas =
      creatives.reduce((s, c) => s + c.roas, 0) / creatives.length;
    return { totalSpend, avgCtr, avgHookRate, avgRoas };
  }, [creatives]);

  const fmtSpend = (n: number) =>
    n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            This week at a glance
          </p>
        </div>
        <DateRangePicker />
      </div>

      {/* Date badge */}
      <p className="text-xs text-gray-600 -mt-2">
        {dateRange.since} — {dateRange.until}
      </p>

      {/* KPI cards */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-32 bg-gray-900 border border-gray-800 rounded-2xl animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <KpiCard
            label="Total Spend"
            value={fmtSpend(kpis.totalSpend)}
            sub={`Across ${creatives.length} active creatives`}
            icon={DollarSign}
            gradient="from-violet-950/60 to-transparent"
            accentText="text-violet-400"
          />
          <KpiCard
            label="Avg CTR"
            value={`${kpis.avgCtr.toFixed(2)}%`}
            sub="Click-through rate"
            icon={MousePointerClick}
            gradient="from-blue-950/60 to-transparent"
            accentText="text-blue-400"
          />
          <KpiCard
            label="Avg Hook Rate"
            value={kpis.avgHookRate > 0 ? `${kpis.avgHookRate.toFixed(1)}%` : "—"}
            sub="3-second video retention"
            icon={Zap}
            gradient="from-emerald-950/60 to-transparent"
            accentText="text-emerald-400"
          />
          <KpiCard
            label="Avg ROAS"
            value={`${kpis.avgRoas.toFixed(2)}x`}
            sub="Return on ad spend"
            icon={TrendingUp}
            gradient="from-orange-950/60 to-transparent"
            accentText="text-orange-400"
          />
        </div>
      )}

      {/* Week over Week Banner */}
      {!isLoading && !isWowLoading && wowData && (
        <WowBanner
          wow={wowData.aggregateWow}
          currentPeriod={wowData.currentPeriod}
          prevPeriod={wowData.prevPeriod}
        />
      )}
      {!isLoading && isWowLoading && (
        <div className="h-28 bg-gray-900 border border-gray-800 rounded-2xl animate-pulse" />
      )}

      {/* Quick links */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-2">
        {[
          {
            href: "/creatives",
            label: "Creative Feed",
            desc: "Browse all creatives with metrics",
            color: "hover:border-violet-700/60",
          },
          {
            href: "/compare",
            label: "A/B Compare",
            desc: "Compare two creatives head-to-head",
            color: "hover:border-blue-700/60",
          },
          {
            href: "/fatigue",
            label: "Fatigue Detection",
            desc: "Creatives showing declining performance",
            color: "hover:border-orange-700/60",
          },
          {
            href: "/top-charts",
            label: "Top Charts",
            desc: "Ranked by ROAS, Spend, CTR",
            color: "hover:border-emerald-700/60",
          },
          {
            href: "/comparatif",
            label: "Comparatif",
            desc: "Performance by format: Image, Video, Carousel",
            color: "hover:border-pink-700/60",
          },
        ].map(({ href, label, desc, color }) => (
          <Link
            key={href}
            href={href}
            className={`block bg-gray-900 border border-gray-800 ${color} rounded-2xl p-5 transition-colors group`}
          >
            <p className="text-white font-semibold text-sm group-hover:text-violet-300 transition-colors">
              {label}
            </p>
            <p className="text-gray-500 text-xs mt-1 leading-relaxed">{desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ─── Landing page (logged out) ────────────────────────────────────────────────

function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-gray-100">
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

// ─── Root export ──────────────────────────────────────────────────────────────

export default function RootPage() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
        Loading…
      </div>
    );
  }

  if (session) {
    return <DashboardHome />;
  }

  return <LandingPage />;
}
