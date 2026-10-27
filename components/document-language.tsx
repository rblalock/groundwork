"use client";

import { useEffect } from "react";
import type { Language } from "@/core/language";

/** Sets the page's `<html lang>` to this language: a public page in the customer's language, or the sign-in page's choice. */
export function DocumentLanguage({ lang }: { lang: Language }) {
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return null;
}
