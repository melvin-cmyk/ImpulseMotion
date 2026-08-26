import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-bold text-white">Page introuvable</h1>
        <p className="text-sm text-gray-500 mt-2">Cette page n&apos;existe pas ou a été déplacée.</p>
        <Link
          href="/"
          className="inline-block mt-5 px-4 py-2 rounded-lg text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors"
        >
          Retour à l&apos;accueil
        </Link>
      </div>
    </div>
  );
}
