import { createHash, createHmac, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Response as ExpressResponse } from "express";

const SIDECAR = "http://127.0.0.1:1106";
// Legacy keys remain readable, but new uploads are staged and never become the
// active object. Only the server knows the signed PUT URL for a sealed object.
const KEY_PATTERN = /^patient-documents\/(?:staging\/|sealed\/)?[0-9a-f-]{36}$/;
const STAGING_KEY_PATTERN = /^patient-documents\/(?:staging\/)?[0-9a-f-]{36}$/;
const SEALED_KEY_PATTERN = /^patient-documents\/sealed\/[0-9a-f-]{36}$/;
const s3Mode = () => process.env.STORAGE_PROVIDER?.toLowerCase() === "s3";

function legacyLocation(key: string) {
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid private document key");
  const dir = process.env.PRIVATE_OBJECT_DIR;
  if (!dir) throw new Error("Private object storage is not configured");
  const [bucketName, ...prefix] = dir.split("/").filter(Boolean);
  if (!bucketName) throw new Error("Invalid private object directory");
  return { bucketName, objectName: [...prefix, key].join("/") };
}

function s3Config() {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    throw new Error("S3 storage requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY");
  }
  const endpoint = new URL(S3_ENDPOINT);
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("S3_ENDPOINT must use HTTP or HTTPS");
  return {
    endpoint,
    bucket: S3_BUCKET,
    region: process.env.S3_REGION || "us-east-1",
    accessKey: S3_ACCESS_KEY_ID,
    secretKey: S3_SECRET_ACCESS_KEY,
    sessionToken: process.env.S3_SESSION_TOKEN,
  };
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function awsHmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const dateKey = awsHmac(`AWS4${secret}`, date);
  const regionKey = awsHmac(dateKey, region);
  const serviceKey = awsHmac(regionKey, "s3");
  return awsHmac(serviceKey, "aws4_request");
}

function encodedPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(decodeURIComponent(part))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

function objectUrl(key: string): { url: URL; config: ReturnType<typeof s3Config> } {
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid private document key");
  const config = s3Config();
  const basePath = config.endpoint.pathname.replace(/\/+$/, "");
  const path = `${basePath}/${config.bucket}/${key}`;
  return { url: new URL(`${config.endpoint.origin}${encodedPath(path)}`), config };
}

function presignedS3Url(key: string, method: "PUT" | "GET" | "HEAD"): string {
  const { url, config } = objectUrl(key);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${config.region}/s3/aws4_request`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKey}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": "300",
    "X-Amz-SignedHeaders": "host",
  };
  if (config.sessionToken) query["X-Amz-Security-Token"] = config.sessionToken;
  const canonicalQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
  const canonicalRequest = [method, url.pathname, canonicalQuery, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, digest(canonicalRequest)].join("\n");
  const signature = awsHmac(signingKey(config.secretKey, date, config.region), stringToSign).toString("hex");
  url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
  return url.toString();
}

async function legacySignedUrl(key: string, method: "PUT" | "GET" | "HEAD"): Promise<string> {
  const { bucketName, objectName } = legacyLocation(key);
  const response = await fetch(`${SIDECAR}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Private storage signing failed (${response.status})`);
  const body = await response.json() as { signed_url?: string };
  if (!body.signed_url) throw new Error("Private storage did not return a signed URL");
  return body.signed_url;
}

async function signedUrl(key: string, method: "PUT" | "GET" | "HEAD"): Promise<string> {
  if (s3Mode()) return presignedS3Url(key, method);
  return legacySignedUrl(key, method);
}

async function signedS3Request(key: string, method: "PUT" | "HEAD", body?: Buffer, contentType?: string) {
  const { url, config } = objectUrl(key);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = body ? digest(body) : digest("");
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["content-type"] = contentType;
  if (method === "PUT") headers["if-none-match"] = "*";
  if (config.sessionToken) headers["x-amz-security-token"] = config.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = `${names.map((name) => `${name}:${headers[name].trim()}`).join("\n")}\n`;
  const signedHeaders = names.join(";");
  const canonicalRequest = [method, url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, digest(canonicalRequest)].join("\n");
  const signature = awsHmac(signingKey(config.secretKey, date, config.region), stringToSign).toString("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Authorization", authorization);
  return fetch(url, {
    method,
    headers: requestHeaders,
    body: method === "PUT" ? body : undefined,
    signal: AbortSignal.timeout(60_000),
  });
}

export function newPrivateDocumentKey(): string {
  return `patient-documents/staging/${randomUUID()}`;
}

export function newSealedDocumentKey(): string {
  return `patient-documents/sealed/${randomUUID()}`;
}

export async function getPrivateUploadUrl(key: string): Promise<string> {
  if (!STAGING_KEY_PATTERN.test(key)) throw new Error("Sealed documents cannot be uploaded directly");
  return signedUrl(key, "PUT");
}

export async function promotePrivateUpload(
  stagingKey: string,
  sealedKey: string,
  expectedBytes: number,
  expectedType: string,
  checksumSha256?: string,
): Promise<boolean> {
  if (!STAGING_KEY_PATTERN.test(stagingKey) || !SEALED_KEY_PATTERN.test(sealedKey)) {
    throw new Error("Invalid document promotion keys");
  }
  const source = await fetch(await signedUrl(stagingKey, "GET"), {
    signal: AbortSignal.timeout(60_000),
  });
  if (source.status === 404) return false;
  if (!source.ok || !source.body) throw new Error(`Private storage download failed (${source.status})`);
  if (source.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== expectedType.toLowerCase()) {
    await source.body.cancel();
    return false;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const hash = createHash("sha256");
  for await (const chunk of Readable.fromWeb(source.body as Parameters<typeof Readable.fromWeb>[0])) {
    size += chunk.length;
    if (size > expectedBytes) return false;
    hash.update(chunk);
    chunks.push(chunk);
  }
  if (size !== expectedBytes) return false;
  const digest = hash.digest("hex");
  if (checksumSha256 && digest !== checksumSha256.toLowerCase()) return false;

  const bytes = Buffer.concat(chunks, size);
  const stored = s3Mode()
    ? await signedS3Request(sealedKey, "PUT", bytes, expectedType)
    : await fetch(await signedUrl(sealedKey, "PUT"), {
      method: "PUT",
      headers: { "Content-Type": expectedType },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    });
  // Never replace an object at a sealed key, even if a key is accidentally reused.
  if (stored.status === 412 || stored.status === 409) return false;
  if (!stored.ok) throw new Error(`Private storage promotion failed (${stored.status})`);
  // Verify the sealed bytes, not the staging object that may still be writable.
  return verifyPrivateUpload(sealedKey, expectedBytes, expectedType, digest);
}

export async function verifyPrivateUpload(
  key: string,
  expectedBytes: number,
  expectedType: string,
  checksumSha256?: string,
): Promise<boolean> {
  const response = await fetch(await signedUrl(key, "HEAD"), {
    method: "HEAD",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Private storage verification failed (${response.status})`);
  const size = Number(response.headers.get("content-length"));
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (size !== expectedBytes || contentType !== expectedType.toLowerCase()) return false;
  if (!checksumSha256) return true;
  const uploaded = await fetch(await signedUrl(key, "GET"), { signal: AbortSignal.timeout(60_000) });
  if (!uploaded.ok || !uploaded.body) return false;
  const hash = createHash("sha256");
  for await (const chunk of Readable.fromWeb(uploaded.body as Parameters<typeof Readable.fromWeb>[0])) {
    hash.update(chunk);
  }
  return hash.digest("hex") === checksumSha256.toLowerCase();
}

export async function sendPrivateDocument(
  key: string,
  filename: string,
  contentType: string,
  res: ExpressResponse,
): Promise<void> {
  const response = await fetch(await signedUrl(key, "GET"), {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) {
    res.status(response.status === 404 ? 404 : 502).json({ error: "Document is unavailable" });
    return;
  }
  const safeName = filename.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 140) || "document";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const length = response.headers.get("content-length");
  if (length) res.setHeader("Content-Length", length);
  Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    .on("error", () => res.destroy())
    .pipe(res);
}

/**
 * Idempotent migration helper: copies a legacy Replit object to the identical
 * logical key in S3. It never deletes or changes the source object.
 */
export async function migrateLegacyDocumentToS3(
  key: string,
  expectedBytes: number,
  expectedType: string,
  status: "active" | "pending" | "withdrawn",
): Promise<"copied" | "already-present" | "missing"> {
  if (!s3Mode()) throw new Error("Set STORAGE_PROVIDER=s3 before migrating documents");
  const source = await fetch(await legacySignedUrl(key, "GET"), { signal: AbortSignal.timeout(60_000) });
  if (source.status === 404 && status === "pending") return "missing";
  if (source.status === 404) throw new Error(`Missing ${status} document bytes for ${key}`);
  if (!source.ok || !source.body) throw new Error(`Legacy document read failed (${source.status}) for ${key}`);
  const chunks: Buffer[] = [];
  let size = 0;
  const hash = createHash("sha256");
  for await (const chunk of Readable.fromWeb(source.body as Parameters<typeof Readable.fromWeb>[0])) {
    size += chunk.length;
    if (size > expectedBytes) throw new Error(`Legacy document size mismatch for ${key}`);
    hash.update(chunk);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  if (size !== expectedBytes || source.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== expectedType.toLowerCase()) {
    throw new Error(`Legacy document metadata mismatch for ${key}`);
  }
  const sha = hash.digest("hex");
  const verifyExisting = async (): Promise<boolean> => {
    const existing = await fetch(presignedS3Url(key, "GET"), { signal: AbortSignal.timeout(60_000) });
    if (existing.status === 404) return false;
    if (!existing.ok || !existing.body) throw new Error(`Could not verify existing S3 object ${key} (${existing.status})`);
    if (Number(existing.headers.get("content-length")) !== expectedBytes
      || existing.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== expectedType.toLowerCase()) {
      throw new Error(`Existing S3 object does not match active document ${key}`);
    }
    const existingHash = createHash("sha256");
    for await (const chunk of Readable.fromWeb(existing.body as Parameters<typeof Readable.fromWeb>[0])) existingHash.update(chunk);
    if (existingHash.digest("hex") !== sha) throw new Error(`Existing S3 bytes differ for ${key}`);
    return true;
  };
  const head = await signedS3Request(key, "HEAD");
  if (head.ok) {
    if (Number(head.headers.get("content-length")) !== expectedBytes
      || head.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== expectedType.toLowerCase()) {
      throw new Error(`Existing S3 object does not match active document ${key}`);
    }
    if (!await verifyExisting()) throw new Error(`S3 object disappeared during migration: ${key}`);
    return "already-present";
  }
  // A provider may conceal missing objects with 403 when ListBucket is denied.
  if (head.status !== 404 && head.status !== 403) throw new Error(`S3 destination check failed (${head.status}) for ${key}`);
  const put = await signedS3Request(key, "PUT", bytes, expectedType);
  if (put.status === 412 || put.status === 409) {
    // Another migration worker (or an earlier run) already created this key.
    if (await verifyExisting()) return "already-present";
    throw new Error(`S3 key conflict without a verifiable destination object: ${key}`);
  }
  if (!put.ok) throw new Error(`S3 migration upload failed (${put.status}) for ${key}`);
  return "copied";
}