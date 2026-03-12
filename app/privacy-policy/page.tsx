export const metadata = {
  title: "Politique de Confidentialité — ImpulseMotion",
  description: "Politique de confidentialité de ImpulseMotion Analytics",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: "#0a0a0f", color: "#ffffff" }}>

      {/* NAV */}
      <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4"
        style={{ background: "rgba(10,10,15,0.85)", backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(139,92,246,0.12)" }}>
        <a href="/" className="flex items-center gap-2.5 no-underline">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>
            <svg viewBox="0 0 24 24" className="w-4 h-4 fill-white">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <span className="font-semibold text-white text-sm">ImpulseMotion</span>
        </a>
      </nav>

      {/* CONTENT */}
      <div className="max-w-3xl mx-auto px-6 pt-28 pb-20">

        {/* Header */}
        <div className="mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-4"
            style={{ background: "rgba(139,92,246,0.15)", color: "#a78bfa", border: "1px solid rgba(139,92,246,0.3)" }}>
            Légal
          </div>
          <h1 className="text-4xl font-bold mb-3" style={{ color: "#ffffff" }}>
            Politique de Confidentialité
          </h1>
          <p className="text-sm" style={{ color: "#6b7280" }}>
            Dernière mise à jour : 12 mars 2026
          </p>
        </div>

        <div className="space-y-10" style={{ color: "#d1d5db", lineHeight: "1.75" }}>

          {/* Intro */}
          <section>
            <p>
              ImpulseMotion (&ldquo;nous&rdquo;, &ldquo;notre&rdquo;) exploite la plateforme d&rsquo;analyse de publicités
              accessible à <strong style={{ color: "#e5e7eb" }}>impulse-motion.vercel.app</strong> (le &ldquo;Service&rdquo;).
              La présente politique décrit comment nous collectons, utilisons et protégeons vos données personnelles
              lorsque vous utilisez notre Service.
            </p>
          </section>

          <Section title="1. Données collectées">
            <p>Nous collectons les catégories de données suivantes :</p>
            <ul className="mt-3 space-y-2 list-none">
              <Li><strong style={{ color: "#e5e7eb" }}>Données de compte :</strong> nom, adresse e-mail et photo de profil
                fournis par Meta lors de l&rsquo;authentification OAuth.</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>Données publicitaires Meta Ads :</strong> métriques de campagnes,
                ensembles de publicités, créatifs publicitaires, dépenses, impressions, clics, conversions et autres
                indicateurs de performance accessibles via l&rsquo;API Marketing de Meta.</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>Données TikTok Ads (optionnel) :</strong> métriques équivalentes
                issues de l&rsquo;API TikTok for Business, si vous connectez un compte TikTok.</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>Données d&rsquo;utilisation :</strong> logs de connexion, adresse IP,
                type de navigateur et pages consultées, à des fins de sécurité et d&rsquo;amélioration du Service.</Li>
            </ul>
          </Section>

          <Section title="2. Utilisation des données">
            <p>Vos données sont utilisées exclusivement pour :</p>
            <ul className="mt-3 space-y-2 list-none">
              <Li>Vous authentifier et maintenir votre session sur le Service.</Li>
              <Li>Récupérer et afficher vos données publicitaires depuis Meta Ads et TikTok Ads.</Li>
              <Li>Générer des analyses de performance, comparaisons créatives et rapports dans le Service.</Li>
              <Li>Améliorer le fonctionnement du Service (débogage, optimisation).</Li>
              <Li>Vous contacter en cas de problème technique ou de mise à jour importante.</Li>
            </ul>
            <p className="mt-3">
              Nous n&rsquo;utilisons pas vos données publicitaires à des fins de marketing tiers,
              de publicité ciblée ou d&rsquo;entraînement de modèles d&rsquo;intelligence artificielle.
            </p>
          </Section>

          <Section title="3. Base légale du traitement (RGPD)">
            <p>Conformément au Règlement Général sur la Protection des Données (RGPD), nous traitons vos données sur les bases suivantes :</p>
            <ul className="mt-3 space-y-2 list-none">
              <Li><strong style={{ color: "#e5e7eb" }}>Exécution du contrat :</strong> traitement nécessaire à la fourniture du Service que vous avez demandé.</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>Consentement :</strong> lors de l&rsquo;autorisation OAuth Meta/TikTok, vous consentez explicitement à nous donner accès à vos données publicitaires.</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>Intérêts légitimes :</strong> sécurité du Service, prévention des abus et amélioration technique.</Li>
            </ul>
          </Section>

          <Section title="4. Stockage et sécurité">
            <p>
              Les données de session et de compte sont stockées dans une base de données sécurisée.
              Les données publicitaires Meta et TikTok sont récupérées en temps réel via leurs APIs respectives
              et ne sont pas stockées de manière permanente sur nos serveurs, sauf mise en cache temporaire
              pour les besoins de performance du Service.
            </p>
            <p className="mt-3">
              Nous utilisons des connexions chiffrées (HTTPS/TLS) pour toutes les communications.
              L&rsquo;accès aux données est restreint au personnel technique autorisé.
            </p>
          </Section>

          <Section title="5. Partage avec des tiers">
            <p>Nous ne vendons pas vos données personnelles. Nous pouvons partager des données avec :</p>
            <ul className="mt-3 space-y-2 list-none">
              <Li><strong style={{ color: "#e5e7eb" }}>Vercel :</strong> hébergement de l&rsquo;application (serveurs en UE/USA, soumis aux clauses contractuelles types).</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>Meta Platforms :</strong> via OAuth, pour authentification et accès à l&rsquo;API Marketing.</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>TikTok for Business :</strong> via OAuth, pour accès à l&rsquo;API TikTok Ads (si applicable).</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>Prestataires techniques :</strong> fournisseurs de base de données et d&rsquo;infrastructure dans le cadre strict de la fourniture du Service.</Li>
            </ul>
            <p className="mt-3">
              Tout transfert hors UE est encadré par des garanties appropriées (clauses contractuelles types UE ou décisions d&rsquo;adéquation).
            </p>
          </Section>

          <Section title="6. Durée de conservation">
            <p>
              Vos données de compte sont conservées tant que votre compte est actif.
              En cas de suppression de compte, vos données sont effacées dans un délai de <strong style={{ color: "#e5e7eb" }}>30 jours</strong>.
              Les logs techniques sont conservés au maximum <strong style={{ color: "#e5e7eb" }}>90 jours</strong>.
            </p>
          </Section>

          <Section title="7. Vos droits (RGPD)">
            <p>Conformément au RGPD, vous disposez des droits suivants :</p>
            <ul className="mt-3 space-y-2 list-none">
              <Li><strong style={{ color: "#e5e7eb" }}>Droit d&rsquo;accès :</strong> obtenir une copie de vos données personnelles.</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>Droit de rectification :</strong> corriger des données inexactes.</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>Droit à l&rsquo;effacement :</strong> demander la suppression de vos données.</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>Droit à la portabilité :</strong> recevoir vos données dans un format structuré.</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>Droit d&rsquo;opposition :</strong> vous opposer à certains traitements.</Li>
              <Li><strong style={{ color: "#e5e7eb" }}>Droit de retrait du consentement :</strong> révoquer l&rsquo;accès OAuth à tout moment depuis les paramètres Meta ou TikTok.</Li>
            </ul>
            <p className="mt-3">
              Pour exercer ces droits, contactez-nous à l&rsquo;adresse indiquée ci-dessous.
              Vous pouvez également déposer une réclamation auprès de la CNIL (Commission Nationale de l&rsquo;Informatique et des Libertés).
            </p>
          </Section>

          <Section title="8. Cookies">
            <p>
              Nous utilisons uniquement des cookies strictement nécessaires au fonctionnement du Service
              (gestion de session d&rsquo;authentification via NextAuth.js). Aucun cookie publicitaire ou de tracking
              tiers n&rsquo;est utilisé.
            </p>
          </Section>

          <Section title="9. Modifications de cette politique">
            <p>
              Nous nous réservons le droit de modifier cette politique à tout moment.
              En cas de changement substantiel, vous serez notifié par e-mail ou via une bannière dans le Service.
              La date de &ldquo;Dernière mise à jour&rdquo; en haut de cette page est toujours actualisée.
            </p>
          </Section>

          <Section title="10. Contact">
            <p>
              Pour toute question relative à cette politique de confidentialité ou pour exercer vos droits,
              contactez-nous à :
            </p>
            <div className="mt-4 p-4 rounded-xl" style={{ background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.2)" }}>
              <p className="font-medium" style={{ color: "#e5e7eb" }}>ImpulseMotion</p>
              <p className="mt-1" style={{ color: "#a78bfa" }}>contact@impulse-motion.com</p>
            </div>
          </Section>

        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold mb-3" style={{ color: "#ffffff" }}>{title}</h2>
      <div style={{ color: "#d1d5db" }}>{children}</div>
    </section>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "#7c3aed" }} />
      <span>{children}</span>
    </li>
  );
}
