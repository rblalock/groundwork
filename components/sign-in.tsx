"use client";

import { MessageSquareText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { authClient, sendPhoneCode, verifyPhoneCode } from "@/lib/auth-client";
import { forgetSessions } from "@/components/assistant/session-cache";
import { copyFor } from "@/lib/copy";
import type { Language } from "@/core/language";

type Mode = "phone" | "code" | "admin";

function Mark() {
  return (
    <span className="flex size-9 items-center justify-center rounded-[10px] bg-ink text-canvas">
      <MessageSquareText aria-hidden="true" className="size-[18px]" />
    </span>
  );
}

/** The sign-in card: a centered paper form on the muted page. */
function AuthCard({ title, description, children, onSubmit }: { title: string; description: string; children: ReactNode; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 p-6">
      <form className="grid w-full max-w-sm gap-5 rounded-window bg-surface p-6 shadow-card" onSubmit={onSubmit}>
        <div>
          <Mark />
          <h1 className="mt-4 text-lg font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">{description}</p>
        </div>
        {children}
      </form>
    </main>
  );
}

/**
 * Members sign in with their cell: the assistant texts a code to their iMessage thread. Super admins
 * use email and password behind the small "Admin sign in" link.
 */
export function SignInScreen({ language: initialLanguage, initialMode }: { language: Language; initialMode: "phone" | "admin" }) {
  const router = useRouter();
  const [language, setLanguage] = useState(initialLanguage);
  const copy = copyFor(language);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  // The page's language follows the switch, for screen readers and the browser's translate.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  async function send() {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) {
      setError(copy.signIn.invalidPhone);
      return false;
    }
    setBusy(true);
    setError(undefined);
    const result = await sendPhoneCode(phone);
    setBusy(false);
    if (!result.ok) {
      setError(copy.signIn.failed);
      return false;
    }
    return true;
  }

  async function submitPhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await send()) {
      setCode("");
      setNotice(undefined);
      setMode("code");
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const result = await verifyPhoneCode(phone, code);
    if (result.ok) {
      router.replace("/");
      router.refresh();
      return;
    }
    setBusy(false);
    setError(
      result.error === "TOO_MANY_ATTEMPTS"
        ? copy.signIn.tooManyTries
        : result.error === "INVALID_CODE"
          ? copy.signIn.invalidCode
          : copy.signIn.failed,
    );
  }

  const footer = (
    <div className="flex items-center justify-between text-[12.5px]">
      <button className="text-ink-3 underline-offset-2 hover:text-ink hover:underline" onClick={() => { setError(undefined); setMode("admin"); }} type="button">
        {copy.signIn.adminLink}
      </button>
      <button
        className="text-ink-3 underline-offset-2 hover:text-ink hover:underline"
        lang={language === "es" ? "en" : "es"}
        onClick={() => setLanguage(language === "es" ? "en" : "es")}
        type="button"
      >
        {copy.signIn.language}
      </button>
    </div>
  );

  if (mode === "admin") return <AdminSignIn onBack={() => { setError(undefined); setMode("phone"); }} />;

  if (mode === "code") {
    return (
      <AuthCard description={copy.signIn.codeIntro(phone)} onSubmit={submitCode} title={copy.signIn.title}>
        <div className="grid gap-2">
          <Label htmlFor="code">{copy.signIn.codeLabel}</Label>
          <Input
            autoComplete="one-time-code"
            autoFocus
            className="font-mono tracking-[0.3em]"
            id="code"
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            pattern="\d{6}"
            required
            value={code}
          />
        </div>
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {notice ? <p className="text-sm text-ink-2" role="status">{notice}</p> : null}
        <Button disabled={busy || code.length !== 6} type="submit" variant="primary">
          {busy ? copy.signIn.verifying : copy.signIn.verify}
        </Button>
        <div className="flex items-center justify-between text-[12.5px]">
          <button className="text-ink-3 underline-offset-2 hover:text-ink hover:underline" onClick={() => { setError(undefined); setMode("phone"); }} type="button">
            {copy.signIn.otherNumber}
          </button>
          <button
            className="text-ink-3 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
            disabled={busy}
            onClick={async () => {
              if (await send()) setNotice(copy.signIn.codeIntro(phone));
            }}
            type="button"
          >
            {copy.signIn.resend}
          </button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard description={copy.signIn.phoneIntro} onSubmit={submitPhone} title={copy.signIn.title}>
      <div className="grid gap-2">
        <Label htmlFor="phone">{copy.signIn.phoneLabel}</Label>
        <Input
          autoComplete="tel"
          autoFocus
          id="phone"
          inputMode="tel"
          onChange={(event) => setPhone(event.target.value)}
          placeholder="(555) 555-0142"
          required
          type="tel"
          value={phone}
        />
        <p className="text-[12px] text-ink-3">{copy.signIn.neverTexted}</p>
      </div>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      <Button disabled={busy} type="submit" variant="primary">
        {busy ? copy.signIn.sending : copy.signIn.sendCode}
      </Button>
      {footer}
    </AuthCard>
  );
}

/** Email and password, for super admins. Their accounts are made by `npm run admin:create`, never here. */
function AdminSignIn({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const copy = copyFor("en").admin;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    const result = await authClient.signIn.email({ email, password });
    if (result.error) {
      setError(result.error.message ?? "Couldn't sign in.");
      setBusy(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <AuthCard description={copy.intro} onSubmit={submit} title={copy.title}>
      <div className="grid gap-2">
        <Label htmlFor="admin-email">{copy.email}</Label>
        <Input autoComplete="email" id="admin-email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="admin-password">{copy.password}</Label>
        <Input
          autoComplete="current-password"
          id="admin-password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </div>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      <Button disabled={busy} type="submit" variant="primary">
        {busy ? "Please wait…" : copy.submit}
      </Button>
      <button className="justify-self-start text-[12.5px] text-ink-3 underline-offset-2 hover:text-ink hover:underline" onClick={onBack} type="button">
        {copy.back}
      </button>
    </AuthCard>
  );
}

/** Signed in, but on no team. */
export function NoBusinessScreen({ language }: { language: Language }) {
  const router = useRouter();
  const copy = copyFor(language);
  return (
    <AuthCard
      description={copy.noBusiness.body}
      onSubmit={async (event) => {
        event.preventDefault();
        forgetSessions();
        await authClient.signOut();
        router.replace("/sign-in");
        router.refresh();
      }}
      title={copy.noBusiness.title}
    >
      <Button type="submit" variant="quiet">
        {copy.menu.signOut}
      </Button>
    </AuthCard>
  );
}

/** Signed in to a business a super admin has paused: say so, and offer to sign out. */
export function PausedScreen({ language }: { language: Language }) {
  const router = useRouter();
  const copy = copyFor(language);
  return (
    <AuthCard
      description={copy.paused.body}
      onSubmit={async (event) => {
        event.preventDefault();
        forgetSessions();
        await authClient.signOut();
        router.replace("/sign-in");
        router.refresh();
      }}
      title={copy.paused.title}
    >
      <Button type="submit" variant="quiet">
        {copy.menu.signOut}
      </Button>
    </AuthCard>
  );
}
