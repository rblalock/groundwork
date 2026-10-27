"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ComponentProps, type ReactNode } from "react";
import { Label } from "@/ui/components/label";
import { cn } from "@/ui/lib/utils";

/** A search field that keeps its words in the URL (`?q=`), so the server filters and the link can be shared. */
export function SearchBox({ placeholder, label }: { placeholder: string; label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [value, setValue] = useState(params.get("q") ?? "");
  const [pending, startTransition] = useTransition();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (value.trim()) next.set("q", value.trim());
      else next.delete("q");
      next.delete("page"); // new words start from the first page
      const query = next.toString();
      startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
    }, 250);
    return () => clearTimeout(timer);
    // Only typing should search; params changing from a filter link must not re-run this.
  }, [value]);

  return (
    <label className="relative block w-full sm:max-w-xs">
      <span className="sr-only">{label}</span>
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
      <input
        className={cn(
          "h-8 w-full rounded-full bg-surface pr-3 pl-8 text-[13px] text-ink shadow-hairline outline-none placeholder:text-ink-3 focus-visible:ring-3 focus-visible:ring-ring/50",
          pending && "opacity-70",
        )}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
    </label>
  );
}

/** A labelled form field: an input by default, or whatever control is passed as children. */
export function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
  ...props
}: { id: string; label: string; hint?: string; error?: string; children?: ReactNode } & ComponentProps<"input">) {
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <Label className="text-[13px]" htmlFor={id}>
        {label}
      </Label>
      {children ?? <input aria-invalid={error ? true : undefined} className={inputClass} id={id} name={id} {...props} />}
      {error ? (
        <p className="text-[12px] text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[12px] text-ink-3 text-pretty">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base text-ink outline-none transition-colors placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

/** A native select, styled like the kit's inputs (native, so it's at home on a phone). */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(inputClass, "pr-7", className)} {...props} />;
}

/**
 * Sends one change to a route handler and refreshes the page's server data when it lands. `error` is the
 * route's message (already in the member's language) or the fallback.
 */
export function useMutation(fallbackError: string) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [, startTransition] = useTransition();

  /** `refresh: false` when the caller leaves the page next: on iPhone Safari the refresh cancels that navigation. */
  async function send<T = Record<string, unknown>>(
    key: string,
    url: string,
    init: { method: string; body?: unknown; refresh?: boolean },
  ): Promise<T | null> {
    setBusy(key);
    setError(undefined);
    try {
      const response = await fetch(url, {
        method: init.method,
        headers: init.body === undefined ? undefined : { "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
      if (!response.ok) {
        setError(data?.error ?? fallbackError);
        return null;
      }
      if (init.refresh !== false) startTransition(() => router.refresh());
      return data;
    } catch {
      setError(fallbackError);
      return null;
    } finally {
      setBusy(null);
    }
  }

  return { send, busy, error, setError };
}

export function ErrorLine({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="text-[13px] text-destructive" role="alert">
      {children}
    </p>
  );
}
