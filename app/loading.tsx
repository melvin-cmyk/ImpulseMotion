export default function GlobalLoading() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="flex items-center gap-3 text-ui-muted text-sm">
        <span className="w-4 h-4 rounded-full border-2 border-ui-line-strong border-t-violet-500 animate-spin" />
        Chargement…
      </div>
    </div>
  );
}
