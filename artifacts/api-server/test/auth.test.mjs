import assert from "node:assert/strict";
import test from "node:test";
import { csrfIsValid, getOidcSession, setOidcSession } from "../src/lib/oidcSession.ts";
import { staffIdentityLinkPatch } from "../src/lib/staffAuthPolicy.ts";
import { verifiedOidcIdentity } from "../src/lib/oidcSession.ts";

test("OIDC identities require a boolean verified-email claim and normalize the allowlist email", () => {
  const identity = verifiedOidcIdentity("https://id.example/realms/clinic/", {
    sub: "user-123",
    email: "  STAFF@Example.COM ",
    email_verified: true,
    name: "Clinic Staff",
  });
  assert.deepEqual(identity, {
    subject: "https://id.example/realms/clinic|user-123",
    email: "staff@example.com",
    name: "Clinic Staff",
  });
  assert.throws(
    () => verifiedOidcIdentity("https://id.example", {
      sub: "user-123",
      email: "staff@example.com",
      email_verified: false,
    }),
    /verified email/,
  );
  assert.throws(
    () => verifiedOidcIdentity("https://id.example", {
      sub: "user-123",
      email: "staff@example.com",
      email_verified: "true",
    }),
    /verified email/,
  );
  assert.throws(
    () => verifiedOidcIdentity("https://id.example", {
      sub: "user-123",
      email_verified: true,
    }),
    /missing an email/,
  );
});

test("Clerk links preserve auto-activation while OIDC links preserve invited status", () => {
  const invited = {
    clerkUserId: null,
    name: "Invited Dentist",
    status: "invited",
  };
  const identity = {
    subject: "https://id.example/realms/clinic|staff-1",
    email: "dentist@example.com",
    name: "Dentist",
  };

  assert.deepEqual(staffIdentityLinkPatch(invited, identity, "clerk"), {
    clerkUserId: identity.subject,
    name: "Invited Dentist",
    status: "active",
  });
  assert.deepEqual(staffIdentityLinkPatch(invited, identity, "oidc"), {
    clerkUserId: identity.subject,
    name: "Invited Dentist",
  });
});

test("OIDC account linking rejects another account at the same issuer but can replace a legacy Clerk id", () => {
  const identity = {
    subject: "https://id.example/realms/clinic|staff-1",
    email: "dentist@example.com",
    name: "Dentist",
  };
  assert.equal(staffIdentityLinkPatch({
    clerkUserId: "https://id.example/realms/clinic|other-user",
    name: "Dentist",
    status: "active",
  }, identity, "oidc"), null);
  assert.deepEqual(staffIdentityLinkPatch({
    clerkUserId: "user_clerk_legacy",
    name: "Dentist",
    status: "active",
  }, identity, "oidc"), {
    clerkUserId: identity.subject,
    name: "Dentist",
  });
  assert.equal(staffIdentityLinkPatch({
    clerkUserId: "another-clerk-user",
    name: "Dentist",
    status: "active",
  }, identity, "clerk"), null);
});

test("OIDC sessions are encrypted HttpOnly cookies and require the matching CSRF token", () => {
  const originalSecret = process.env.OIDC_SESSION_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.OIDC_SESSION_SECRET = "auth-test-session-secret-that-is-over-32-bytes";
  process.env.NODE_ENV = "production";
  try {
    const setCookies = [];
    setOidcSession({ append: (name, value) => {
      assert.equal(name, "Set-Cookie");
      setCookies.push(value);
    } }, {
      subject: "https://id.example/realms/clinic|staff-1",
      email: "staff@example.com",
      name: "Staff",
    });
    assert.equal(setCookies.length, 2);
    assert.match(setCookies[0], /HttpOnly/);
    assert.match(setCookies[0], /Secure/);
    assert.match(setCookies[0], /SameSite=Lax/);
    assert.doesNotMatch(setCookies[1], /HttpOnly/);
    assert.match(setCookies[1], /Secure/);

    const cookieHeader = setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
    const csrf = decodeURIComponent(cookieHeader.match(/dentozone_csrf=([^;]+)/)[1]);
    const req = {
      headers: { cookie: cookieHeader },
      get: (name) => name.toLowerCase() === "x-csrf-token" ? csrf : undefined,
    };
    const session = getOidcSession(req);
    assert.equal(session?.email, "staff@example.com");
    assert.equal(csrfIsValid(req, session), true);
    assert.equal(csrfIsValid({
      ...req,
      get: () => "wrong-token",
    }, session), false);

    const tamperedRequest = {
      ...req,
      headers: { cookie: cookieHeader.replace(/dentozone_session=([^;])/, (_match, first) =>
        `dentozone_session=${first === "A" ? "B" : "A"}`) },
    };
    assert.equal(getOidcSession(tamperedRequest), null);
  } finally {
    if (originalSecret === undefined) delete process.env.OIDC_SESSION_SECRET;
    else process.env.OIDC_SESSION_SECRET = originalSecret;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});