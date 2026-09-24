"use client";

/**
 * Markdown renderer for AI replies on the staff surfaces. Understands the
 * sandbox convention: `sandbox:out/x.png` / `sandbox:out/x.xlsx` produced by
 * run_python are rewritten to the surface's files proxy (`filesBase`), which
 * checks the session before streaming the file from the relay.
 */

import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";

export function AiMarkdown({ content, filesBase, className }: { content: string; filesBase: string | null; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url: string) =>
          url.startsWith("sandbox:")
            ? (filesBase ? `${filesBase}/${url.slice(8).replace(/^\/+/, "")}` : null)
            : defaultUrlTransform(url)}
        components={{
          img: ({ src, alt }: { src?: string; alt?: string }) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="max-w-full rounded-lg border border-gray-800 my-2" loading="lazy" />
          ),
          a: ({ href, children }: { href?: string; children?: ReactNode }) => {
            const local = !!filesBase && typeof href === "string" && href.startsWith(filesBase);
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={local ? "inline-flex items-center gap-1 text-violet-300 hover:text-violet-200 no-underline border border-violet-900/60 rounded-md px-2 py-0.5" : undefined}
              >
                {local ? "⬇ " : null}{children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
