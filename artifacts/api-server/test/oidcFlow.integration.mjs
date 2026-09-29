import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import express from "express";
import { build } from "esbuild";

if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT) {
  throw new Error("OIDC integration tests must never run against production");
}
if (!process.env.DATABASE_URL) throw new Error("A development DATABASE_URL is required");

const realFetch = globalThis.fetch;
const filePath = (relativePath) => fileURLToPath(new URL(relativePath, import.meta.url));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function availablePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function setCookiesFrom(response) {
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
  const combined = response.headers.get("set-cookie");
  return combined ? combined.split(/, (?=[^;,]+=)/) : [];
}

function updateCookieJar(jar, response) {
  for (const header of setCookiesFrom(response)) {
    const [pair, ...attributes] = header.split(";");
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!value || attributes.some((attribute) => attribute.trim().toLowerCase() === "max-age=0")) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function csrfFrom(jar) {
  const value = jar.get("dentozone_csrf");
  assert.ok(value, "the successful login should set a CSRF cookie");
  return decodeURIComponent(value);
}

function signedIdToken(claims, privateKey, keyId) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: keyId, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

test("portable OIDC login, staff authorization, CSRF, and logout run against an isolated local issuer", async (t) => {
  const originalEnv = new Map();
  const envKeys = [
    "NODE_ENV", "AUTH_PROVIDER", "STORAGE_PROVIDER", "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI",
    "OIDC_SESSION_SECRET", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY", "COOKIE_SECURE", "OIDC_APP_URL",
  ];
  for (const key of envKeys) originalEnv.set(key, process.env[key]);

  const issuerApp = express();
  issuerApp.use(express.urlencoded({ extended: false }));
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyId = "oidc-test-rsa-key";
  const publicJwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: keyId,
    use: "sig",
    alg: "RS256",
  };
  const authorizationCodes = new Map();
  const observedAuthorizationRequests = [];
  const observedTokenRequests = [];
  const marker = randomUUID();
  let issuerUrl;
  issuerApp.get("/.well-known/openid-configuration", (_req, res) => {
    res.json({
      issuer: issuerUrl,
      authorization_endpoint: `${issuerUrl}/authorize`,
      token_endpoint: `${issuerUrl}/token`,
      jwks_uri: `${issuerUrl}/jwks`,
      end_session_endpoint: `${issuerUrl}/logout`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      scopes_supported: ["openid", "email", "profile"],
    });
  });
  issuerApp.get("/jwks", (_req, res) => res.json({ keys: [publicJwk] }));
  issuerApp.get("/authorize", (req, res) => {
    const params = req.query;
    observedAuthorizationRequests.push({ ...params });
    if (
      params.response_type !== "code" ||
      params.client_id !== "dentozone-api-test" ||
      params.scope !== "openid email profile" ||
      params.code_challenge_method !== "S256" ||
      typeof params.code_challenge !== "string" ||
      typeof params.state !== "string" ||
      typeof params.nonce !== "string" ||
      typeof params.redirect_uri !== "string"
    ) {
      res.status(400).send("Invalid authorization request");
      return;
    }
    const code = randomUUID();
    authorizationCodes.set(code, {
      challenge: params.code_challenge,
      nonce: params.nonce,
      loginHint: typeof params.login_hint === "string" ? params.login_hint : "owner",
    });
    const callback = new URL(params.redirect_uri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", params.state);
    res.redirect(302, callback.toString());
  });
  issuerApp.post("/token", (req, res) => {
    const record = authorizationCodes.get(req.body.code);
    const verifier = req.body.code_verifier;
    const basic = req.get("authorization")?.match(/^Basic (.+)$/)?.[1];
    const credentials = basic ? Buffer.from(basic, "base64").toString() : "";
    const challenge = typeof verifier === "string"
      ? createHash("sha256").update(verifier).digest("base64url")
      : "";
    observedTokenRequests.push({
      code: req.body.code,
      hasVerifier: typeof verifier === "string",
      validPkce: Boolean(record && challenge === record.challenge),
      validClient: credentials === "dentozone-api-test:oidc-test-client-secret",
    });
    if (!record || challenge !== record.challenge ||
        credentials !== "dentozone-api-test:oidc-test-client-secret") {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    authorizationCodes.delete(req.body.code);
    const unverified = record.loginHint === "unverified";
    const receptionist = record.loginHint === "reception";
    const now = Math.floor(Date.now() / 1000);
    const idToken = signedIdToken({
      iss: issuerUrl,
      aud: "dentozone-api-test",
      sub: unverified ? "oidc-unverified-user" : receptionist ? "oidc-reception-user" : "oidc-owner-user",
      iat: now,
      exp: now + 300,
      nonce: record.nonce,
      email: unverified ? `unverified-oidc-fixture-${marker}@example.invalid`
        : receptionist ? `reception-oidc-fixture-${marker}@example.invalid`
          : `owner-oidc-fixture-${marker}@example.invalid`,
      email_verified: !unverified,
      name: unverified ? "Unverified Fixture User" : receptionist ? "Reception Fixture User" : "Owner Fixture User",
    }, privateKey, keyId);
    res.json({ access_token: randomUUID(), token_type: "Bearer", expires_in: 300, id_token: idToken });
  });
  issuerApp.get("/logout", (_req, res) => res.status(204).end());

  const issuerServer = issuerApp.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    issuerServer.once("listening", resolve);
    issuerServer.once("error", reject);
  });
  issuerUrl = `http://127.0.0.1:${issuerServer.address().port}`;

  let apiServer;
  let db;
  let pool;
  let staffTable;
  const fixtureStaffIds = [];
  let ownerCookieJar;
  try {
    const apiPort = await availablePort();
    Object.assign(process.env, {
      NODE_ENV: "test",
      AUTH_PROVIDER: "oidc",
      STORAGE_PROVIDER: "s3",
      OIDC_ISSUER_URL: issuerUrl,
      OIDC_CLIENT_ID: "dentozone-api-test",
      OIDC_CLIENT_SECRET: "oidc-test-client-secret",
      OIDC_REDIRECT_URI: `http://127.0.0.1:${apiPort}/api/auth/callback`,
      OIDC_SESSION_SECRET: "isolated-oidc-integration-session-secret-over-32-bytes",
      S3_ENDPOINT: "http://127.0.0.1:1106",
      S3_BUCKET: "dentozone-oidc-integration",
      S3_ACCESS_KEY_ID: "integration-test-access-key",
      S3_SECRET_ACCESS_KEY: "integration-test-secret-key",
      COOKIE_SECURE: "false",
    });
    delete process.env.OIDC_APP_URL;

    const output = filePath("../node_modules/.cache/oidc-flow-integration-test.mjs");
    await mkdir(dirname(output), { recursive: true });
    await build({
      stdin: {
        contents: `
          import app from "../src/app.ts";
          import { db, pool, staffTable } from "@workspace/db";
          export { app, db, pool, staffTable };
        `,
        resolveDir: dirname(filePath("./oidcFlow.integration.mjs")),
        sourcefile: "oidc-flow-test-entry.ts",
        loader: "ts",
      },
      outfile: output,
      platform: "node",
      format: "esm",
      bundle: true,
      external: ["pg-native", "pino", "pino-pretty", "thread-stream"],
      banner: { js: "import { createRequire } from 'node:module'; globalThis.require = createRequire(import.meta.url);" },
      logLevel: "silent",
    });
    const api = await import(pathToFileURL(output).href);
    ({ db, pool, staffTable } = api);
    apiServer = api.app.listen(apiPort, "127.0.0.1");
    await new Promise((resolve, reject) => {
      apiServer.once("listening", resolve);
      apiServer.once("error", reject);
    });
    const apiBase = `http://127.0.0.1:${apiPort}`;

    const seededStaff = await db.insert(staffTable).values([
      {
        email: `owner-oidc-fixture-${marker}@example.invalid`,
        name: `OIDC Integration Owner ${marker}`,
        role: "owner",
        status: "active",
      },
      {
        email: `reception-oidc-fixture-${marker}@example.invalid`,
        name: `OIDC Integration Reception ${marker}`,
        role: "reception",
        status: "active",
      },
    ]).returning();
    fixtureStaffIds.push(...seededStaff.map((staff) => staff.id));

    async function startLogin(loginHint) {
      const jar = new Map();
      const loginResponse = await realFetch(`${apiBase}/api/auth/login`, { redirect: "manual" });
      assert.equal(loginResponse.status, 302);
      updateCookieJar(jar, loginResponse);
      assert.ok(jar.has("dentozone_oidc_tx"), "login should set a signed OIDC transaction cookie");

      const authorization = new URL(loginResponse.headers.get("location"));
      if (loginHint) authorization.searchParams.set("login_hint", loginHint);
      assert.equal(authorization.origin, issuerUrl);
      assert.equal(authorization.pathname, "/authorize");
      assert.match(authorization.searchParams.get("state"), /^[A-Za-z0-9_-]{20,}$/);
      assert.match(authorization.searchParams.get("nonce"), /^[A-Za-z0-9_-]{20,}$/);
      const challenge = authorization.searchParams.get("code_challenge");
      assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.equal(authorization.searchParams.has("code_verifier"), false);

      const issuerResponse = await realFetch(authorization, { redirect: "manual" });
      assert.equal(issuerResponse.status, 302);
      const callback = issuerResponse.headers.get("location");
      assert.ok(callback);
      assert.equal(new URL(callback).searchParams.get("state"), authorization.searchParams.get("state"));
      const callbackResponse = await realFetch(callback, {
        redirect: "manual",
        headers: { Cookie: cookieHeader(jar) },
      });
      updateCookieJar(jar, callbackResponse);
      return { jar, callbackResponse };
    }

    await t.test("verified staff login validates state/PKCE and establishes role session", async () => {
      const { jar, callbackResponse } = await startLogin();
      assert.equal(callbackResponse.status, 303);
      assert.equal(callbackResponse.headers.get("location"), "/dashboard");
      assert.ok(jar.has("dentozone_session"));
      assert.ok(jar.has("dentozone_csrf"));
      assert.equal(jar.has("dentozone_oidc_tx"), false);
      const sessionResponse = await realFetch(`${apiBase}/api/session`, {
        headers: { Cookie: cookieHeader(jar) },
      });
      assert.equal(sessionResponse.status, 200);
      const session = await sessionResponse.json();
      assert.equal(session.email, `owner-oidc-fixture-${marker}@example.invalid`);
      assert.equal(session.role, "owner");
      assert.equal(session.status, "active");
      assert.equal(observedAuthorizationRequests.length, 1);
      assert.equal(observedTokenRequests.length, 1);
      assert.deepEqual(observedTokenRequests[0], {
        code: observedTokenRequests[0].code,
        hasVerifier: true,
        validPkce: true,
        validClient: true,
      });
      ownerCookieJar = [...jar];
    });

    await t.test("CSRF is rejected without a token and accepted before owner action", async () => {
      const jar = new Map(ownerCookieJar);
      const invite = {
        email: `oidc-csrf-created-${marker}@example.invalid`,
        name: "OIDC CSRF Fixture Invite",
        role: "dentist",
      };
      const requestOptions = {
        method: "POST",
        headers: {
          Origin: apiBase,
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify(invite),
      };
      const rejected = await realFetch(`${apiBase}/api/staff`, requestOptions);
      assert.equal(rejected.status, 403);
      assert.match((await rejected.json()).error, /CSRF token/);

      const accepted = await realFetch(`${apiBase}/api/staff`, {
        ...requestOptions,
        headers: { ...requestOptions.headers, "X-CSRF-Token": csrfFrom(jar) },
      });
      assert.equal(accepted.status, 201);
      const created = await accepted.json();
      fixtureStaffIds.push(created.id);
      assert.equal(created.email, invite.email);
      assert.equal(observedTokenRequests.length, 1, "API mutations do not trigger extra OIDC token exchanges");
    });

    await t.test("logout clears all auth cookies and returns the issuer end-session URL", async () => {
      const jar = new Map(ownerCookieJar);
      const response = await realFetch(`${apiBase}/api/auth/logout`, {
        method: "POST",
        headers: {
          Origin: apiBase,
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
          "X-CSRF-Token": csrfFrom(jar),
        },
        body: "{}",
      });
      assert.equal(response.status, 200);
      const logoutData = await response.json();
      const endSession = new URL(logoutData.redirectUrl);
      assert.equal(endSession.origin, issuerUrl);
      assert.equal(endSession.pathname, "/logout");
      assert.equal(endSession.searchParams.get("client_id"), "dentozone-api-test");
      assert.equal(endSession.searchParams.get("post_logout_redirect_uri"), `${apiBase}/`);
      const cleared = setCookiesFrom(response);
      for (const name of ["dentozone_session", "dentozone_csrf", "dentozone_oidc_tx"]) {
        assert.ok(cleared.some((cookie) => cookie.startsWith(`${name}=`) && /Max-Age=0/i.test(cookie)),
          `logout should clear ${name}`);
      }
      updateCookieJar(jar, response);
      assert.equal(jar.size, 0);
      const afterLogout = await realFetch(`${apiBase}/api/session`, { headers: { Cookie: cookieHeader(jar) } });
      assert.equal(afterLogout.status, 401);
    });

    await t.test("an authenticated receptionist is denied an owner-only staff action", async () => {
      const { jar, callbackResponse } = await startLogin("reception");
      assert.equal(callbackResponse.status, 303);
      const sessionResponse = await realFetch(`${apiBase}/api/session`, {
        headers: { Cookie: cookieHeader(jar) },
      });
      assert.equal((await sessionResponse.json()).role, "reception");
      const denied = await realFetch(`${apiBase}/api/staff`, {
        method: "POST",
        headers: {
          Origin: apiBase,
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
          "X-CSRF-Token": csrfFrom(jar),
        },
        body: JSON.stringify({
          email: `oidc-role-denied-${marker}@example.invalid`,
          name: "Should Not Be Created",
          role: "dentist",
        }),
      });
      assert.equal(denied.status, 403);
      assert.match((await denied.json()).error, /role does not allow/);
      const logout = await realFetch(`${apiBase}/api/auth/logout`, {
        method: "POST",
        headers: {
          Origin: apiBase,
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
          "X-CSRF-Token": csrfFrom(jar),
        },
        body: "{}",
      });
      assert.equal(logout.status, 200);
    });

    await t.test("unverified email claims cannot establish a session", async () => {
      const { jar, callbackResponse } = await startLogin("unverified");
      assert.equal(callbackResponse.status, 303);
      assert.match(callbackResponse.headers.get("location"), /\/sign-in\?auth_error=login_failed$/);
      assert.equal(jar.has("dentozone_session"), false);
      assert.equal(jar.has("dentozone_csrf"), false);
      const sessionResponse = await realFetch(`${apiBase}/api/session`, {
        headers: { Cookie: cookieHeader(jar) },
      });
      assert.equal(sessionResponse.status, 401);
    });

    assert.equal(observedTokenRequests.length, 3, "each completed authorization code uses the local token endpoint");
    assert.ok(observedTokenRequests.every((request) => request.validPkce && request.validClient));
  } finally {
    try {
      if (db && fixtureStaffIds.length) {
        const { inArray } = await import("drizzle-orm");
        await db.delete(staffTable).where(inArray(staffTable.id, fixtureStaffIds));
      }
    } finally {
      await close(apiServer);
      await close(issuerServer);
      if (pool) await pool.end();
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});