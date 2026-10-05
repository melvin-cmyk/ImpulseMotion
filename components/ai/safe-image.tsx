"use client";

/**
 * Images written by an AI in its replies are shown only when they come from
 * the application itself (its routes, the sandbox files, inline data). An
 * image from any other address is NOT loaded: a crafted reply could otherwise
 * put data in the address of an image and send it to another site the moment
 * it is displayed. It becomes a plain link instead.
 */

export function isOwnImage(src: unknown): src is string {
  if (typeof src !== "string" || !src) return false;
  if (src.startsWith("data:image/")) return true;
  // Same-origin paths only ("/api/…"), never protocol-relative ("//host").
  return src.startsWith("/") && !src.startsWith("//");
}

export function SafeImage({ src, alt }: { src?: unknown; alt?: string }) {
  if (isOwnImage(src)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt ?? ""} className="max-w-full rounded-lg border border-gray-800 my-2" loading="lazy" />;
  }
  let host = "";
  try { host = typeof src === "string" ? new URL(src).host : ""; } catch { host = ""; }
  return typeof src === "string" && /^https:\/\//.test(src)
    ? <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="text-xs text-gray-400 underline">image externe{host ? ` (${host})` : ""}{alt ? ` — ${alt}` : ""}</a>
    : <span className="text-xs text-gray-500">[image non affichée]</span>;
}

/** `components` for react-markdown wherever AI text is shown. */
export const SAFE_MD_COMPONENTS = {
  img: ({ src, alt }: { src?: unknown; alt?: string }) => <SafeImage src={src} alt={alt} />,
};
