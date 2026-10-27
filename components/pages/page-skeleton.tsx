import { Paper, PaperTitle } from "@/components/paper";

/** What a business page shows while its data loads: the paper panel with the shape of a table. */
export function PageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Paper className="flex-1">
      <PaperTitle>
        <span className="block h-3 w-24 animate-pulse rounded bg-hover-2" />
      </PaperTitle>
      <div aria-busy="true" className="min-h-0 flex-1 px-4 py-5 sm:px-10 sm:py-8" role="status">
        <span className="sr-only">Loading…</span>
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <div className="flex justify-between gap-3">
            <span className="h-7 w-64 animate-pulse rounded-full bg-hover-2" />
            <span className="hidden h-7 w-56 animate-pulse rounded-full bg-hover-2 sm:block" />
          </div>
          <div className="overflow-hidden rounded-card bg-surface shadow-card">
            {Array.from({ length: rows }, (_, i) => (
              <div className="flex items-center gap-4 border-b border-line px-4 py-3.5 last:border-0" key={i}>
                <span className="h-3 w-1/3 animate-pulse rounded bg-hover-2" />
                <span className="ml-auto h-3 w-16 animate-pulse rounded bg-hover-2" />
                <span className="h-3 w-20 animate-pulse rounded bg-hover-2" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Paper>
  );
}
