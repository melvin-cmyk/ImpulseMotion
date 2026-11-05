"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-medium text-ui-fg">Une erreur est survenue</h1>
        <p className="text-sm text-ui-muted mt-2">
          Réessayez — si le problème persiste, contactez votre consultant.
        </p>
        {error.digest && <p className="text-[11px] text-ui-muted mt-2 font-mono">ref {error.digest}</p>}
        <button
          type="button"
          onClick={reset}
          className="mt-5 px-4 py-2 rounded-lg text-sm font-medium bg-ui-accent hover:brightness-110 text-ui-on-accent transition-colors"
        >
          Réessayer
        </button>
      </div>
    </div>
  );
}
