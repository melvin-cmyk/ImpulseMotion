"use client";

import { useState } from "react";

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

/** A client bot's video creative (/api/bot/<id>/video?…): a player, the image when the video cannot be played. */
const BOT_VIDEO = /^\/api\/bot\/[\w-]+\/video\?/;

function BotVideo({ src, alt }: { src: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const poster = src.replace("/video?", "/image?");
  // eslint-disable-next-line @next/next/no-img-element
  if (failed) return <img src={poster} alt={alt ?? ""} className="max-w-full max-h-72 w-auto rounded-lg border border-gray-800 my-2" loading="lazy" />;
  return <video src={src} poster={poster} controls playsInline preload="metadata" onError={() => setFailed(true)} className="max-w-full max-h-96 rounded-lg border border-gray-800 my-2 bg-black" aria-label={alt} />;
}

export function SafeImage({ src, alt }: { src?: unknown; alt?: string }) {
  if (typeof src === "string" && BOT_VIDEO.test(src)) return <BotVideo src={src} alt={alt} />;
  if (isOwnImage(src)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt ?? ""} className="max-w-full max-h-72 w-auto rounded-lg border border-gray-800 my-2" loading="lazy" />;
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
