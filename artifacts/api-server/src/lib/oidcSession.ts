import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response } from "express";
import { Issuer, generators, type Client } from "openid-client";

const SESSION_COOKIE = "dentozone_session";
const CSRF_COOKIE = "dentozone_csrf";
const TRANSACTION_COOKIE = "dentozone_oidc_tx";
const SESSION_SECONDS = 8 * 60 * 60;
const TRANSACTION_SECONDS = 10 * 60;

export interface OidcSession {
  subject: string;
  email: string;
  name: string;
  verifiedEmail: true;
  csrf: string;
  expiresAt: number;
}

interface OidcTransaction {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}

export function verifiedOidcIdentity(
  issuer: string,
  claims: {
    sub?: unknown;
    email_verified?: unknown;
    email?: unknown;
    name?: unknown;
  },
): { email: string; name: string; subject: string } {
  if (typeof claims.sub !== "string" || !claims.sub) {
    throw new Error("OIDC identity is missing a subject");
  }
  if (claims.email_verified !== true) {
    throw new Error("A verified email address is required");
  }
  if (typeof claims.email !== "string" || !claims.email.trim()) {
    throw new Error("OIDC identity is missing an email address");
  }
  const email = claims.email.trim().toLowerCase();
  return {
    subject: `${issuer.replace(/\/+$/, "")}|${claims.sub}`,
    email,
    name: typeof claims.name === "string" && claims.name.trim()
      ? claims.name.trim()
      : email.split("@")[0],
  };
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing required OIDC setting: ${key}`);
  return value;
}

export function oidcRedirectUri(): string {
  return requiredEnv("OIDC_REDIRECT_URI");
}

export function oidcSessionSecret(): string {
  const value = requiredEnv("OIDC_SESSION_SECRET");
  if (Buffer.byteLength(value) < 32) {
    throw new Error("OIDC_SESSION_SECRET must contain at least 32 bytes");
  }
  return value;
}

let clientPromise: Promise<Client> | undefined;
export function getOidcClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = Issuer.discover(requiredEnv("OIDC_ISSUER_URL")).then((issuer) =>
      new issuer.Client({
        client_id: requiredEnv("OIDC_CLIENT_ID"),
        client_secret: requiredEnv("OIDC_CLIENT_SECRET"),
        redirect_uris: [oidcRedirectUri()],
        response_types: ["code"],
      }),
    );
  }
  return clientPromise;
}

function cookieSecure(): boolean {
  return process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
}

function cookieAttributes(httpOnly: boolean, maxAge: number): string {
  return `Path=/; SameSite=Lax; Max-Age=${maxAge}${httpOnly ? "; HttpOnly" : ""}${cookieSecure() ? "; Secure" : ""}`;
}

function requestCookies(req: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    try {
      cookies.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      // Ignore malformed unrelated cookies; the credential cookie will fail closed.
    }
  }
  return cookies;
}

function sessionKey(): Buffer {
  return createHash("sha256").update(oidcSessionSecret()).digest();
}

function encryptSession(session: OidcSession): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session)), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decryptSession(value: string): OidcSession | null {
  try {
    const [ivText, tagText, ciphertextText] = value.split(".");
    if (!ivText || !tagText || !ciphertextText) return null;
    const decipher = createDecipheriv("aes-256-gcm", sessionKey(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const session = JSON.parse(plaintext) as OidcSession;
    if (
      typeof session.subject !== "string" ||
      typeof session.email !== "string" ||
      typeof session.name !== "string" ||
      session.verifiedEmail !== true ||
      typeof session.csrf !== "string" ||
      typeof session.expiresAt !== "number" ||
      session.expiresAt <= Date.now()
    ) return null;
    return session;
  } catch {
    return null;
  }
}

function signTransaction(transaction: OidcTransaction): string {
  const payload = Buffer.from(JSON.stringify(transaction)).toString("base64url");
  const signature = createHmac("sha256", oidcSessionSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readTransaction(value: string | undefined): OidcTransaction | null {
  try {
    if (!value) return null;
    const [payload, signature] = value.split(".");
    if (!payload || !signature) return null;
    const expected = createHmac("sha256", oidcSessionSecret()).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const transaction = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OidcTransaction;
    if (
      typeof transaction.state !== "string" ||
      typeof transaction.nonce !== "string" ||
      typeof transaction.verifier !== "string" ||
      typeof transaction.expiresAt !== "number" ||
      transaction.expiresAt <= Date.now()
    ) return null;
    return transaction;
  } catch {
    return null;
  }
}

export function makeAuthorizationTransaction(): {
  cookie: string;
} {
  const state = generators.state();
  const nonce = generators.nonce();
  const verifier = generators.codeVerifier();
  const transaction: OidcTransaction = {
    state,
    nonce,
    verifier,
    expiresAt: Date.now() + TRANSACTION_SECONDS * 1000,
  };
  return {
    cookie: signTransaction(transaction),
  };
}

export async function authorizationUrl(transactionCookie: string): Promise<string> {
  const transaction = readTransaction(transactionCookie);
  if (!transaction) throw new Error("Invalid OIDC authorization transaction");
  const client = await getOidcClient();
  return client.authorizationUrl({
    scope: "openid email profile",
    response_type: "code",
    redirect_uri: oidcRedirectUri(),
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: generators.codeChallenge(transaction.verifier),
    code_challenge_method: "S256",
  });
}

export async function completeOidcLogin(
  req: Request,
): Promise<{ email: string; name: string; subject: string }> {
  const cookies = requestCookies(req);
  const transaction = readTransaction(cookies.get(TRANSACTION_COOKIE));
  const client = await getOidcClient();
  if (!transaction) throw new Error("OIDC login expired; please try again");
  const params = client.callbackParams(req);
  if (params.state !== transaction.state) throw new Error("OIDC state validation failed");
  const tokens = await client.callback(oidcRedirectUri(), params, {
    state: transaction.state,
    nonce: transaction.nonce,
    code_verifier: transaction.verifier,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error("OIDC identity is missing a subject");
  return verifiedOidcIdentity(requiredEnv("OIDC_ISSUER_URL"), claims);
}

export function setOidcSession(
  res: Response,
  identity: Omit<OidcSession, "csrf" | "expiresAt" | "verifiedEmail">,
): void {
  const session: OidcSession = {
    ...identity,
    verifiedEmail: true,
    csrf: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
  };
  res.append("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(encryptSession(session))}; ${cookieAttributes(true, SESSION_SECONDS)}`);
  res.append("Set-Cookie", `${CSRF_COOKIE}=${encodeURIComponent(session.csrf)}; ${cookieAttributes(false, SESSION_SECONDS)}`);
}

export function clearOidcCookies(res: Response): void {
  for (const [name, httpOnly] of [[SESSION_COOKIE, true], [CSRF_COOKIE, false], [TRANSACTION_COOKIE, true]] as const) {
    res.append("Set-Cookie", `${name}=; ${cookieAttributes(httpOnly, 0)}`);
  }
}

export function getOidcSession(req: Request): OidcSession | null {
  const token = requestCookies(req).get(SESSION_COOKIE);
  return token ? decryptSession(token) : null;
}

export function csrfIsValid(req: Request, session: OidcSession): boolean {
  const cookies = requestCookies(req);
  const header = req.get("x-csrf-token");
  const cookie = cookies.get(CSRF_COOKIE);
  if (!header || !cookie) return false;
  const expected = Buffer.from(session.csrf);
  const headerValue = Buffer.from(header);
  const cookieValue = Buffer.from(cookie);
  return expected.length === headerValue.length &&
    expected.length === cookieValue.length &&
    timingSafeEqual(expected, headerValue) &&
    timingSafeEqual(expected, cookieValue);
}

export function oidcCookieNames() {
  return { session: SESSION_COOKIE, transaction: TRANSACTION_COOKIE };
}

export function setOidcTransactionCookie(res: Response, value: string): void {
  res.setHeader("Set-Cookie", `${TRANSACTION_COOKIE}=${encodeURIComponent(value)}; ${cookieAttributes(true, TRANSACTION_SECONDS)}`);
}

export function clearOidcTransactionCookie(res: Response): void {
  res.append("Set-Cookie", `${TRANSACTION_COOKIE}=; ${cookieAttributes(true, 0)}`);
}