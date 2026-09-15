import { useEffect, useState } from "react";

// Light (honeycomb) or dark. index.html applies the saved choice before the
// first paint; this module owns the toggle and keeps <meta theme-color> in step.
export type Theme = "light" | "dark";
const KEY = "hive.theme";
const THEME_COLOR: Record<Theme, string> = { light: "#f4f4f2", dark: "#0b0c0a" };

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* private mode */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode */
  }
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  return [theme, () => setTheme(theme === "light" ? "dark" : "light")];
}
