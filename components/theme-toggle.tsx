"use client";

import { useState } from "react";
import { Moon, Sun } from "lucide-react";

import { THEME_COOKIE, type UiTheme } from "@/lib/ui-theme";

/** Applies the theme to the page at once and remembers it (one year, this browser). */
function applyTheme(next: UiTheme) {
  document.documentElement.dataset.theme = next;
  document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * Day / night switch of the client space. Stored in a cookie (one year, this
 * browser), applied at once on <html data-theme> — the interface tokens of
 * app/globals.css follow.
 */
export function ThemeToggle({ initial }: { initial: UiTheme }) {
  const [theme, setTheme] = useState<UiTheme>(initial);

  function choose(next: UiTheme) {
    setTheme(next);
    applyTheme(next);
  }

  const option = (value: UiTheme, label: string, Icon: typeof Sun) => {
    const on = theme === value;
    return (
      <button
        type="button"
        onClick={() => choose(value)}
        aria-pressed={on}
        title={label}
        className={`h-7 px-2 inline-flex items-center gap-1.5 rounded-md text-xs transition-colors duration-150 ease-ui ${on ? "bg-ui-card text-ui-fg shadow-[inset_0_0_0_1px_var(--ui-line-strong)]" : "text-ui-muted hover:text-ui-fg"}`}
      >
        <Icon className="w-3.5 h-3.5" strokeWidth={1.5} />
        <span className="hidden sm:inline">{label}</span>
      </button>
    );
  };

  return (
    <div role="group" aria-label="Affichage" className="inline-flex items-center gap-0.5 rounded-lg bg-ui-raised p-0.5">
      {option("light", "Jour", Sun)}
      {option("dark", "Nuit", Moon)}
    </div>
  );
}
