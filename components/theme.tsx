"use client";

import { useEffect, useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";

const themeStorageKey = "app.theme";
const themeChangeEvent = "app:theme-change";
const darkQuery = "(prefers-color-scheme: dark)";

/**
 * Runs in <head> before the first paint, so a dark page never flashes light.
 * It mirrors `applyTheme`; keep the two in step.
 */
export const themeScript = `(() => {
  try {
    const stored = localStorage.getItem(${JSON.stringify(themeStorageKey)});
    const dark = stored === "dark" || (stored !== "light" && matchMedia(${JSON.stringify(darkQuery)}).matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch {}
})();`;

function readPreference(): ThemePreference {
  const stored = window.localStorage.getItem(themeStorageKey);
  return stored === "light" || stored === "dark" ? stored : "system";
}

function subscribe(onStoreChange: () => void) {
  const media = window.matchMedia(darkQuery);
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(themeChangeEvent, onStoreChange);
  media.addEventListener("change", onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(themeChangeEvent, onStoreChange);
    media.removeEventListener("change", onStoreChange);
  };
}

function applyTheme(preference: ThemePreference) {
  const dark = preference === "dark" || (preference === "system" && window.matchMedia(darkQuery).matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

function setPreference(preference: ThemePreference) {
  if (preference === "system") window.localStorage.removeItem(themeStorageKey);
  else window.localStorage.setItem(themeStorageKey, preference);
  window.dispatchEvent(new Event(themeChangeEvent));
}

/** The stored theme (light, dark, or following the system) and a setter. */
export function useTheme() {
  const preference = useSyncExternalStore(subscribe, readPreference, () => "system" as const);
  return { preference, setPreference };
}

/**
 * Keeps `<html class="dark">` in step when the preference changes (here or in
 * another tab) or, when following the system, when the OS setting does. The
 * head script already applied it for the first paint.
 */
export function ThemeSync() {
  useEffect(() => subscribe(() => applyTheme(readPreference())), []);
  return null;
}
