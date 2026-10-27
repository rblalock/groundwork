"use client";

import { Menu } from "lucide-react";
import { createContext, useContext, type ComponentProps } from "react";
import { AccountMenu } from "@/components/account-menu";

// Below the `lg` breakpoint the shell drops its sidebar: each page's title bar becomes the top bar, with
// the menu button that opens the navigation drawer on its left and the account on its right. The shell
// provides both through this context, so the pages' title bars (server components) can place them.

type AccountProps = Omit<ComponentProps<typeof AccountMenu>, "compact">;

export type ShellChrome = {
  openNav: () => void;
  navOpen: boolean;
  menuLabel: string;
  account: AccountProps;
};

const ShellContext = createContext<ShellChrome | null>(null);

export const ShellChromeProvider = ShellContext.Provider;

/** Opens the navigation drawer. Phone and tablet widths only; nothing outside the shell. */
export function ShellMenuButton() {
  const shell = useContext(ShellContext);
  if (!shell) return null;
  return (
    <button
      aria-expanded={shell.navOpen}
      aria-label={shell.menuLabel}
      className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-ink-2 transition-[background-color,color,transform] duration-150 [grid-area:menu] hover:bg-hover hover:text-ink active:scale-[0.96] lg:hidden"
      onClick={shell.openNav}
      type="button"
    >
      <Menu aria-hidden="true" className="size-5" />
    </button>
  );
}

/** The signed-in person, as an avatar at the end of the top bar. Phone and tablet widths only. */
export function ShellAccountButton() {
  const shell = useContext(ShellContext);
  if (!shell) return null;
  return (
    <div className="flex shrink-0 items-center [grid-area:account] lg:hidden">
      <AccountMenu {...shell.account} compact />
    </div>
  );
}
