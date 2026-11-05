import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-medium text-ui-fg">Page introuvable</h1>
        <p className="text-sm text-ui-muted mt-2">Cette page n&apos;existe pas ou a été déplacée.</p>
        <Link
          href="/"
          className="inline-block mt-5 px-4 py-2 rounded-lg text-sm font-medium bg-ui-accent hover:brightness-110 text-ui-on-accent transition-colors"
        >
          Retour à l&apos;accueil
        </Link>
      </div>
    </div>
  );
}
