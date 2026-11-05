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
  if (failed) return <img src={poster} alt={alt ?? ""} className="max-w-full max-h-72 w-auto rounded-lg border border-ui-line my-2" loading="lazy" />;
  return <video src={src} poster={poster} controls playsInline preload="metadata" onError={() => setFailed(true)} className="max-w-full max-h-96 rounded-lg border border-ui-line my-2 bg-black" aria-label={alt} />;
}

/** A client bot's image creative: a missing visual shows its name, not a broken image icon. */
const BOT_IMAGE = /^\/api\/bot\/[\w-]+\/image\?/;

function BotImage({ src, alt }: { src: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="block text-xs text-ui-muted my-2">Visuel momentanément indisponible{alt ? ` — ${alt}` : ""}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt ?? ""} onError={() => setFailed(true)} className="max-w-full max-h-72 w-auto rounded-lg border border-ui-line my-2" loading="lazy" />;
}

export function SafeImage({ src, alt }: { src?: unknown; alt?: string }) {
  if (typeof src === "string" && BOT_VIDEO.test(src)) return <BotVideo src={src} alt={alt} />;
  if (typeof src === "string" && BOT_IMAGE.test(src)) return <BotImage src={src} alt={alt} />;
  if (isOwnImage(src)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt ?? ""} className="max-w-full max-h-72 w-auto rounded-lg border border-ui-line my-2" loading="lazy" />;
  }
  let host = "";
  try { host = typeof src === "string" ? new URL(src).host : ""; } catch { host = ""; }
  return typeof src === "string" && /^https:\/\//.test(src)
    ? <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="text-xs text-ui-fg2 underline">image externe{host ? ` (${host})` : ""}{alt ? ` — ${alt}` : ""}</a>
    : <span className="text-xs text-ui-muted">[image non affichée]</span>;
}

/**
 * Visual of a creative card (components/bot/bot-creative-cards.tsx): fills the
 * card's frame uncropped; the bot's video address gets a player (poster = the
 * image, image again when the MP4 is refused). Anything but the bot's own media
 * addresses is not loaded.
 */
export function BotCardMedia({ src, alt }: { src: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  if (!BOT_VIDEO.test(src) && !BOT_IMAGE.test(src)) return <span className="text-xs text-ui-muted px-3 text-center">Visuel non affiché</span>;
  if (failed) return <span className="text-xs text-ui-muted px-3 text-center">Visuel momentanément indisponible</span>;
  if (BOT_VIDEO.test(src) && !videoFailed) {
    return <video src={src} poster={src.replace("/video?", "/image?")} controls playsInline preload="metadata" onError={() => setVideoFailed(true)} className="w-full h-full object-contain bg-black" aria-label={alt} />;
  }
  const img = BOT_VIDEO.test(src) ? src.replace("/video?", "/image?") : src;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={img} alt={alt ?? ""} loading="lazy" onError={() => setFailed(true)} className="w-full h-full object-contain" />;
}

/** `components` for react-markdown wherever AI text is shown. */
export const SAFE_MD_COMPONENTS = {
  img: ({ src, alt }: { src?: unknown; alt?: string }) => <SafeImage src={src} alt={alt} />,
};
