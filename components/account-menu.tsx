"use client";

import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import GlideMenu from "@/ui/beautiful/primitives/GlideMenu";
import { Check, ChevronsUpDown, LogOut, Monitor, Moon, Sun, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTheme, type ThemePreference } from "@/components/theme";
import { authClient } from "@/lib/auth-client";
import { forgetSessions } from "@/components/assistant/session-cache";
import type { Copy } from "@/lib/copy";

export type BusinessOption = { id: string; name: string };

/** Where the open menu sits: above the sidebar's account row, or below a compact avatar. */
type Anchor = { left: number; bottom: number } | { right: number; top: number };

export function monogram(name: string) {
  return name.trim().charAt(0).toUpperCase() || "?";
}

// Every row shares one 24px leading slot so labels line up down the menu.
// The glide highlight is the focus indicator, so rows drop the global outline.
const rowClass =
  "relative z-10 flex w-full items-center gap-2 rounded-[8px] px-2 text-left focus-visible:outline-none!";
const glideHighlight = "inset-x-0 rounded-[8px] bg-hover-2";

/** The business's logo when it has one (`logoSrc`), else its first letter. */
export function BusinessMark({ name, logoSrc }: { name: string; logoSrc?: string | null }) {
  if (logoSrc) {
    return (
      // The sidebar's slot is a fixed square, so a wide wordmark is scaled down to fit it.
      <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-white shadow-hairline">
        {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, 24 px */}
        <img alt="" className="size-full object-contain p-px" src={logoSrc} />
      </span>
    );
  }
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-ink text-[11px] font-semibold text-surface">
      {monogram(name)}
    </span>
  );
}

function ActionRow({ icon, label, onSelect }: { icon: ReactNode; label: string; onSelect: () => void }) {
  return (
    <button className={`${rowClass} h-9`} data-menu-row onClick={onSelect} role="menuitem" type="button">
      <span className="flex size-6 shrink-0 items-center justify-center text-ink-2">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{label}</span>
    </button>
  );
}

/** Light, dark, or following the system, as a segmented control. */
function ThemeRow({ copy }: { copy: Copy["menu"] }) {
  const { preference, setPreference } = useTheme();
  const options: { value: ThemePreference; label: string; icon: ReactNode }[] = [
    { value: "light", label: copy.light, icon: <Sun aria-hidden="true" className="size-3.5" /> },
    { value: "dark", label: copy.dark, icon: <Moon aria-hidden="true" className="size-3.5" /> },
    { value: "system", label: copy.system, icon: <Monitor aria-hidden="true" className="size-3.5" /> },
  ];
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 px-2">
      <span className="min-w-0 flex-1 text-[13.5px] text-ink">{copy.theme}</span>
      <div aria-label={copy.theme} className="flex rounded-control bg-inset p-0.5 shadow-hairline" role="radiogroup">
        {options.map((option) => {
          const selected = preference === option.value;
          return (
            <button
              aria-checked={selected}
              aria-label={option.label}
              className={`flex h-6 w-8 items-center justify-center rounded-[6px] transition-colors ${
                selected ? "bg-surface text-ink shadow-btn" : "text-ink-3 hover:text-ink"
              }`}
              key={option.value}
              onClick={() => setPreference(option.value)}
              role="radio"
              title={option.label}
              type="button"
            >
              {option.icon}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The signed-in person at the bottom of the sidebar. Opens upward with the business
 * switcher (for super admins, and anyone on more than one team), the theme, and sign-out.
 */
export function AccountMenu({
  name,
  subtitle,
  superAdmin,
  businesses,
  activeBusinessId,
  copy,
  hasAccountPage = false,
  compact = false,
}: {
  name: string;
  /** The open business's name, or the email when none is open. */
  subtitle: string;
  superAdmin: boolean;
  businesses: BusinessOption[];
  activeBusinessId: string | null;
  copy: Copy["menu"];
  /** A business is open, so there's an Account page (the member's forwarding address). */
  hasAccountPage?: boolean;
  /** Just the avatar, opening downward from the end of a top bar (phone and tablet widths). */
  compact?: boolean;
}) {
  const router = useRouter();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Rendered in a portal (the sidebar clips overflow), anchored above the button, or below it when compact.
  const [position, setPosition] = useState<Anchor | null>(null);
  const [switching, setSwitching] = useState(false);
  const showBusinesses = superAdmin || businesses.length > 1;

  useEffect(() => {
    if (!position) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest("[data-account-menu]") && !target.closest("[data-account-trigger]")) setPosition(null);
    };
    // The menu is placed from the trigger's rect, so a resize would strand it.
    const dismiss = () => setPosition(null);
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", dismiss);
    };
  }, [position]);

  function rows() {
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-row]") ?? []);
  }

  function toggle(fromKeyboard: boolean) {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (position || !rect) {
      setPosition(null);
      return;
    }
    setPosition(
      compact
        ? { right: Math.max(8, window.innerWidth - rect.right), top: rect.bottom + 6 }
        : { left: rect.left, bottom: window.innerHeight - rect.top + 6 },
    );
    // Keyboard users land inside the menu; pointer users keep focus on the trigger.
    if (fromKeyboard) requestAnimationFrame(() => rows()[0]?.focus());
  }

  function close() {
    setPosition(null);
    buttonRef.current?.focus();
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = rows();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  }

  async function openBusiness(id: string) {
    setPosition(null);
    if (id === activeBusinessId || switching) return;
    setSwitching(true);
    try {
      const response = await fetch("/api/session/business", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: id }),
      });
      if (response.ok) {
        router.push("/");
        router.refresh();
      }
    } finally {
      setSwitching(false);
    }
  }

  async function signOut() {
    setPosition(null);
    forgetSessions();
    await authClient.signOut();
    router.replace("/sign-in");
    router.refresh();
  }

  return (
    <>
      {compact ? (
        <button
          aria-expanded={Boolean(position)}
          aria-haspopup="menu"
          aria-label={`${copy.account}: ${name}`}
          className={`flex size-10 items-center justify-center rounded-full transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.96] ${position ? "bg-hover" : ""}`}
          data-account-trigger
          onClick={(event) => toggle(event.detail === 0)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && position) close();
          }}
          ref={buttonRef}
          type="button"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-inset text-[12px] font-semibold text-ink-2 shadow-hairline">
            {monogram(name)}
          </span>
        </button>
      ) : (
      <button
        aria-expanded={Boolean(position)}
        aria-haspopup="menu"
        className={`flex h-10 w-full items-center gap-2 rounded-[8px] px-2 text-left transition-[background-color,transform] duration-150 hover:bg-hover-2 active:scale-[0.99] ${position ? "bg-hover-2" : ""}`}
        data-account-trigger
        onClick={(event) => toggle(event.detail === 0)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && position) close();
        }}
        ref={buttonRef}
        type="button"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-inset text-[11px] font-semibold text-ink-2 shadow-hairline">
          {monogram(name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-4 font-medium text-ink">{name}</span>
          <span className="block truncate text-[12px] leading-4 text-ink-3">{subtitle}</span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
      </button>
      )}

      {position && typeof document !== "undefined"
        ? createPortal(
            <div
              aria-label="Account"
              className="fixed z-50 flex w-64 flex-col rounded-[14px] bg-surface p-1.5 shadow-overlay"
              data-account-menu
              onKeyDown={onMenuKeyDown}
              ref={menuRef}
              role="menu"
              style={{
                ...position,
                maxWidth: "calc(100vw - 16px)",
                maxHeight: `calc(100dvh - ${("bottom" in position ? position.bottom : position.top) + 12}px)`,
                animation: "pop-in 180ms var(--ease-out-strong) both",
                transformOrigin: "bottom" in position ? "bottom left" : "top right",
              }}
            >
              <div className="flex h-8 shrink-0 items-center gap-2 px-2">
                <p className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">{name}</p>
                {superAdmin ? (
                  <StatusPill className="h-5 shrink-0 px-2 text-[11px]" dot={false} tone="accent">
                    {copy.superAdmin}
                  </StatusPill>
                ) : null}
              </div>

              {showBusinesses && businesses.length > 0 ? (
                <>
                  <div className="my-1 h-px shrink-0 bg-line" />
                  <p className="flex h-7 shrink-0 items-center px-2 text-[12px] font-medium text-ink-3">
                    {superAdmin ? copy.allBusinesses : copy.businesses}
                  </p>
                  {/* Long lists scroll here so the theme and Sign out stay in reach. */}
                  <div className="max-h-[300px] min-h-0 overflow-y-auto overscroll-contain">
                    <GlideMenu className="flex flex-col gap-px" highlightClassName={glideHighlight}>
                      {businesses.map((business) => {
                        const current = business.id === activeBusinessId;
                        return (
                          <button
                            aria-checked={current}
                            className={`${rowClass} h-10`}
                            data-menu-row
                            key={business.id}
                            onClick={() => void openBusiness(business.id)}
                            role="menuitemradio"
                            title={business.name}
                            type="button"
                          >
                            <BusinessMark name={business.name} />
                            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">
                              {business.name}
                            </span>
                            {current ? <Check aria-hidden="true" className="size-4 shrink-0 text-ink" /> : null}
                          </button>
                        );
                      })}
                    </GlideMenu>
                  </div>
                </>
              ) : null}

              <div className="my-1 h-px shrink-0 bg-line" />
              <ThemeRow copy={copy} />
              <div className="my-1 h-px shrink-0 bg-line" />
              <GlideMenu className="flex shrink-0 flex-col gap-px" highlightClassName={glideHighlight}>
                {hasAccountPage ? (
                  <ActionRow
                    icon={<UserRound aria-hidden="true" className="size-4" />}
                    label={copy.account}
                    onSelect={() => {
                      setPosition(null);
                      router.push("/account");
                    }}
                  />
                ) : null}
                <ActionRow
                  icon={<LogOut aria-hidden="true" className="size-4" />}
                  label={copy.signOut}
                  onSelect={() => void signOut()}
                />
              </GlideMenu>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
