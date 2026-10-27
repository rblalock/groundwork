import type { ApprovalPolicy } from "eve/tools/approval";
import { isPrivileged, resolveCaller } from "./members";

/**
 * Passes for an active owner or admin and denies everyone else with a reason the model can relay.
 * The code checks identity; the model only judges intent.
 */
export function privilegedOnly(what: string): ApprovalPolicy {
  const reason = `Only the owner or an admin can ${what.trim().replace(/\.$/, "")}.`;
  return async ({ session }) => {
    const caller = await resolveCaller(session.auth.current);
    return caller && isPrivileged(caller.role)
      ? "not-applicable"
      : { type: "denied", reason };
  };
}

export const approveQuotePolicy: ApprovalPolicy = privilegedOnly(
  "approve quotes. Use request_owner_approval to ask the owner.",
);
