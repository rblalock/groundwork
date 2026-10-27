"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { EmptyState, PaperPage } from "@/components/paper";
import { pageCopyFor } from "@/lib/page-copy";

/** A page in the shell that failed to load: the shell stays, and the page offers to try again. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // The member's language isn't known here; the browser's is the best guess.
  const [language, setLanguage] = useState<"en" | "es">("en");
  useEffect(() => {
    console.error(error);
    if (navigator.language.toLowerCase().startsWith("es")) setLanguage("es");
  }, [error]);
  const copy = pageCopyFor(language).common;
  return (
    <PaperPage title={copy.errorTitle}>
      <EmptyState icon={<TriangleAlert size={18} />}>
        <span className="block">{copy.errorBody}</span>
        <Button className="mt-4" onClick={reset} size="sm">
          {copy.retry}
        </Button>
      </EmptyState>
    </PaperPage>
  );
}
