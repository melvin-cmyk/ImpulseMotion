/**
 * Highlights the matching search term inside a slide label.
 * Used by both the filmstrip search and the command palette.
 */
export function HighlightLabel({ label, search }: { label: string; search: string }) {
  const q = search.trim();
  if (!q) return <>{label}</>;
  const idx = label.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return <>{label}</>;
  return (
    <>
      {label.slice(0, idx)}
      <mark className="bg-yellow-200 text-yellow-900 rounded-sm px-0.5 not-italic font-semibold">
        {label.slice(idx, idx + q.length)}
      </mark>
      {label.slice(idx + q.length)}
    </>
  );
}
