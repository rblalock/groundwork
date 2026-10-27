// Work that runs after a response is on its way: today, looking up, saving, and texting a sign-in code.
// Every task is tracked here, whoever starts it, so tests can wait for all of it (`settleDeferred`) and
// `withTestDb` does after every test: deferred work never outlives the test that started it.

/** Starts a task once the response is on its way. The web app's auth route hands in Next's `after()`. */
export type Scheduler = (task: () => Promise<unknown>) => void;

const inProcess: Scheduler = (task) => {
  void Promise.resolve().then(task);
};

let scheduler: Scheduler = inProcess;
const pending = new Set<Promise<unknown>>();

/** Sets how deferred work starts. Without one (tests, scripts) it runs in this process. Null restores that. */
export function setDeferScheduler(fn: Scheduler | null): void {
  scheduler = fn ?? inProcess;
}

/** Runs `task` after the response. Its errors are the task's to handle; one that escapes is logged. */
export function defer(task: () => Promise<unknown>): void {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  pending.add(done);
  scheduler(async () => {
    try {
      await task();
    } catch (error) {
      console.error("deferred: task failed", error);
    } finally {
      pending.delete(done);
      finish();
    }
  });
}

/** Deferred tasks started and not yet finished, in this process. */
export function pendingDeferred(): number {
  return pending.size;
}

/**
 * Waits for every deferred task in this process, including ones they start. Rejects after `timeoutMs`
 * rather than hanging when a task never finishes.
 */
export async function settleDeferred(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0) {
    const left = deadline - Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), Math.max(left, 0))));
    const result = await Promise.race([Promise.all([...pending]), timedOut]);
    clearTimeout(timer);
    if (result === "timeout") throw new Error(`${pending.size} deferred task(s) still running after ${timeoutMs}ms`);
  }
}
