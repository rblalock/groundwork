import { after } from "next/server";
import { auth } from "@/lib/auth";
import { setDeferScheduler } from "@/core/deferred";

// A sign-in code is looked up, saved, and texted after the response (lib/phone-code-plugin.ts).
setDeferScheduler((task) => after(task));

// Better Auth: sessions, the phone-code sign-in (/api/auth/phone-code/*), and admin email sign-in.
export const GET = (request: Request) => auth().handler(request);
export const POST = (request: Request) => auth().handler(request);
