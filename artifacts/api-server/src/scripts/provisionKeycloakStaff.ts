import { asc } from "drizzle-orm";
import { db, pool, staffTable } from "@workspace/db";

type KeycloakUser = {
  id?: string;
  email?: string;
  username?: string;
};

class ProvisioningError extends Error {}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ProvisioningError(`${name} is required when using --apply`);
  return value;
}

function keycloakEndpoint(baseUrl: URL, path: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url;
}

async function requestAdminToken(baseUrl: URL, realm: string, username: string, password: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(keycloakEndpoint(
      baseUrl,
      `realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`,
    ), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username,
        password,
      }),
    });
  } catch {
    throw new ProvisioningError("Could not contact Keycloak to authenticate the admin");
  }
  if (!response.ok) throw new ProvisioningError(`Keycloak admin authentication failed (HTTP ${response.status})`);

  let payload: { access_token?: unknown };
  try {
    payload = await response.json() as { access_token?: unknown };
  } catch {
    throw new ProvisioningError("Keycloak returned an invalid admin authentication response");
  }
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new ProvisioningError("Keycloak admin authentication response did not include an access token");
  }
  return payload.access_token;
}

async function adminRequest(
  baseUrl: URL,
  path: string,
  accessToken: string,
  init?: RequestInit,
  query?: URLSearchParams,
): Promise<Response> {
  try {
    const url = keycloakEndpoint(baseUrl, path);
    if (query) url.search = query.toString();
    return await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ProvisioningError("Could not contact the Keycloak admin API");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply") || args.filter((arg) => arg === "--apply").length > 1) {
    throw new ProvisioningError("Usage: provisionKeycloakStaff.ts [--apply]");
  }
  const apply = args.includes("--apply");

  try {
    const staff = await db.select({
      email: staffTable.email,
      name: staffTable.name,
      status: staffTable.status,
    }).from(staffTable).orderBy(asc(staffTable.email));

    const counts = staff.reduce((summary, member) => {
      summary[member.status] = (summary[member.status] ?? 0) + 1;
      return summary;
    }, {} as Record<string, number>);

    if (!apply) {
      console.log(
        `DRY RUN: ${staff.length} clinic_staff rows (${counts.active ?? 0} active, ${counts.invited ?? 0} invited, ${counts.suspended ?? 0} suspended).`,
      );
      return;
    }

    const adminUrl = requiredEnvironment("KEYCLOAK_ADMIN_URL");
    const adminUser = requiredEnvironment("KEYCLOAK_ADMIN_USER");
    const adminPassword = requiredEnvironment("KEYCLOAK_ADMIN_PASSWORD");
    const realm = requiredEnvironment("KEYCLOAK_REALM");

    let baseUrl: URL;
    try {
      baseUrl = new URL(adminUrl);
    } catch {
      throw new ProvisioningError("KEYCLOAK_ADMIN_URL must be a valid HTTP(S) URL");
    }
    if (
      !["http:", "https:"].includes(baseUrl.protocol)
      || baseUrl.username
      || baseUrl.password
      || baseUrl.search
      || baseUrl.hash
    ) {
      throw new ProvisioningError("KEYCLOAK_ADMIN_URL must be an HTTP(S) base URL without credentials, query, or fragment");
    }

    const emailGroups = new Map<string, number>();
    for (const member of staff) {
      const email = member.email.trim().toLowerCase();
      emailGroups.set(email, (emailGroups.get(email) ?? 0) + 1);
    }
    if ([...emailGroups.values()].some((count) => count > 1)) {
      throw new ProvisioningError("Duplicate clinic_staff email addresses found; no Keycloak users were created");
    }

    // The bootstrap administrator belongs to Keycloak's master realm, not
    // the clinic realm being provisioned.
    const accessToken = await requestAdminToken(baseUrl, "master", adminUser, adminPassword);
    const realmResponse = await adminRequest(
      baseUrl,
      `admin/realms/${encodeURIComponent(realm)}`,
      accessToken,
    );
    if (!realmResponse.ok) {
      throw new ProvisioningError(`Could not verify the requested Keycloak realm (HTTP ${realmResponse.status})`);
    }

    const pending: Array<(typeof staff)[number]> = [];
    let alreadyPresent = 0;
    for (const member of staff) {
      const searchQuery = new URLSearchParams({ email: member.email, exact: "true" });
      const response = await adminRequest(
        baseUrl,
        `admin/realms/${encodeURIComponent(realm)}/users`,
        accessToken,
        undefined,
        searchQuery,
      );
      if (!response.ok) {
        throw new ProvisioningError(`Could not search Keycloak users (HTTP ${response.status}); no new users were created`);
      }

      let users: KeycloakUser[];
      try {
        users = await response.json() as KeycloakUser[];
      } catch {
        throw new ProvisioningError("Keycloak returned an invalid user search response; no new users were created");
      }
      if (!Array.isArray(users)) {
        throw new ProvisioningError("Keycloak returned an invalid user search response; no new users were created");
      }
      const matchingUsers = users.filter(
        (user) => typeof user.email === "string" && user.email.toLowerCase() === member.email.toLowerCase(),
      );
      if (matchingUsers.length > 1) {
        throw new ProvisioningError("Multiple Keycloak users share a clinic_staff email; no new users were created");
      }
      if (matchingUsers.length === 1) alreadyPresent += 1;
      else pending.push(member);
    }

    let created = 0;
    for (const member of pending) {
      const response = await adminRequest(
        baseUrl,
        `admin/realms/${encodeURIComponent(realm)}/users`,
        accessToken,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: member.email,
            email: member.email,
            firstName: member.name,
            enabled: member.status !== "suspended",
            emailVerified: false,
            requiredActions: ["VERIFY_EMAIL", "UPDATE_PASSWORD"],
          }),
        },
      );
      if (!response.ok) {
        throw new ProvisioningError(`Keycloak user creation failed (HTTP ${response.status}); ${created} users were created before the failure`);
      }
      created += 1;
    }
    console.log(`APPLY complete: ${created} created; ${alreadyPresent} already present; ${staff.length} clinic_staff rows read.`);
  } finally {
    await pool.end();
  }
}

// Required actions defer account activation until the user signs in; do not send
// execute-actions emails here. Configure and verify SMTP before enabling any email activation flow.
main().catch((error: unknown) => {
  const message = error instanceof ProvisioningError
    ? error.message
    : "Provisioning failed; database or Keycloak details are unavailable";
  console.error(message);
  process.exitCode = 1;
});