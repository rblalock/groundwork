import { Paper, PaperTitle } from "@/components/paper";

/** What a conversation page shows while it loads: the paper panel with the shape of a chat. */
export function ChatSkeleton() {
  return (
    <Paper className="flex-1">
      <PaperTitle>
        <span className="block h-3 w-28 animate-pulse rounded bg-hover-2" />
      </PaperTitle>
      <div aria-busy="true" className="flex min-h-0 flex-1 flex-col" role="status">
        <span className="sr-only">Loading…</span>
        <div className="mx-auto w-full max-w-[720px] flex-1 space-y-6 px-4 pt-8 sm:px-8">
          <span className="ml-auto block h-9 w-2/5 animate-pulse rounded-[14px] bg-hover-2" />
          <span className="block h-3 w-3/4 animate-pulse rounded bg-hover-2" />
          <span className="block h-3 w-1/2 animate-pulse rounded bg-hover-2" />
          <span className="ml-auto block h-9 w-1/3 animate-pulse rounded-[14px] bg-hover-2" />
          <span className="block h-3 w-2/3 animate-pulse rounded bg-hover-2" />
        </div>
        <div className="mx-auto w-full max-w-[720px] px-3 pb-4 sm:px-8">
          <span className="block h-12 w-full animate-pulse rounded-[14px] bg-hover-2" />
        </div>
      </div>
    </Paper>
  );
}
