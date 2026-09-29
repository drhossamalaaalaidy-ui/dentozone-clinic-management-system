export interface ExistingStaffAuthLink {
  clerkUserId: string | null;
  name: string;
  status: string;
}

export interface StaffAuthIdentity {
  subject: string;
  email: string;
  name: string;
}

export function staffIdentityLinkPatch(
  existing: ExistingStaffAuthLink,
  identity: StaffAuthIdentity,
  provider: "clerk" | "oidc",
): { clerkUserId: string; name: string; status?: "active" } | null {
  const oidcPrefix = identity.subject.slice(0, identity.subject.lastIndexOf("|") + 1);
  const canReplaceLegacyClerkId =
    provider === "oidc" && !existing.clerkUserId?.startsWith(oidcPrefix);
  if (
    existing.clerkUserId &&
    existing.clerkUserId !== identity.subject &&
    !canReplaceLegacyClerkId
  ) {
    return null;
  }

  return {
    clerkUserId: identity.subject,
    name: existing.name || identity.name || identity.email.split("@")[0],
    // Keep the historical Clerk invitation activation behavior. OIDC identity
    // association is not an activation signal; an owner must activate it.
    ...(provider === "clerk" ? { status: "active" as const } : {}),
  };
}
