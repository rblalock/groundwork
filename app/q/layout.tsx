import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Your quote", robots: { index: false, follow: false } };

/** The customer's pages for a quote's link: no sign-in, no shell, one card on the canvas. */
export default function QuoteLinkLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-start justify-center bg-canvas px-4 py-16 sm:items-center sm:py-10">
      <div className="w-full max-w-md rounded-[14px] border border-line bg-page p-6 shadow-card">{children}</div>
    </main>
  );
}
