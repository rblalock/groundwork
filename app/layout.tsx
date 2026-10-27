import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ThemeSync, themeScript } from "@/components/theme";
import { requestLanguage } from "@/lib/page-session";
import { TooltipProvider } from "@/ui/components/tooltip";
import "./globals.css";

// Beautiful UI's type: its @theme reads these two variables.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-mono-face", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Assistant",
  description: "Quotes, customers, and the assistant your team texts.",
};

// `cover` lets the phone shell draw under the status bar and home indicator; it pads by the safe areas itself.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // A member's pages are in their language; a public page (a quote or pay link) sets its own (DocumentLanguage).
  const lang = (await requestLanguage()) ?? "en";
  return (
    <html
      lang={lang}
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
      // The theme script sets `dark` and `color-scheme` before React hydrates.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeSync />
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
