/** Day / night of the client space: cookie read by app/layout.tsx, written by components/theme-toggle.tsx. */
export type UiTheme = "dark" | "light";
export const THEME_COOKIE = "im-theme";
export const parseTheme = (v: string | undefined | null): UiTheme => (v === "light" ? "light" : "dark");
