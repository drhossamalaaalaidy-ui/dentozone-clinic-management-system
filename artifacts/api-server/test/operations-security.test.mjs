import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  getPrivateUploadUrl,
  newPrivateDocumentKey,
  newSealedDocumentKey,
  migrateLegacyDocumentToS3,
  promotePrivateUpload,
  verifyPrivateUpload,
} from "../src/lib/privateDocuments.ts";
import { invalidatesReminderDrafts } from "../src/lib/reminderConsent.ts";

function independentSignature(secret, scope, amzDate, canonicalRequest) {
  const [date, region] = scope.split("/");
  const sign = (key, value) => createHmac("sha256", key).update(value).digest();
  const dateKey = sign(`AWS4${secret}`, date);
  const regionKey = sign(dateKey, region);
  const serviceKey = sign(regionKey, "s3");
  const signingKey = sign(serviceKey, "aws4_request");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  return sign(signingKey, stringToSign).toString("hex");
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function assertS3Signature(url, method, options, secret) {
  const headers = new Headers(options.headers);
  if (url.searchParams.has("X-Amz-Signature")) {
    const signature = url.searchParams.get("X-Amz-Signature");
    const query = [...url.searchParams.entries()]
      .filter(([name]) => name !== "X-Amz-Signature")
      .sort(([nameA, valueA], [nameB, valueB]) =>
        nameA.localeCompare(nameB) || valueA.localeCompare(valueB))
      .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
      .join("&");
    const credential = url.searchParams.get("X-Amz-Credential").split("/");
    const scope = credential.slice(1).join("/");
    const amzDate = url.searchParams.get("X-Amz-Date");
    const canonicalHeaders = `host:${url.host}\n`;
    const canonical = [method, url.pathname, query, canonicalHeaders, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const legacyMissingNewline = [method, url.pathname, query, `host:${url.host}`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    assert.equal(signature, independentSignature(secret, scope, amzDate, canonical), "valid SigV4 presigned request");
    assert.notEqual(signature, independentSignature(secret, scope, amzDate, legacyMissingNewline),
      "signature must reject CanonicalHeaders without its trailing newline");
    return;
  }

  const authorization = headers.get("authorization");
  assert.ok(authorization, "signed S3 request has Authorization");
  const credential = authorization.match(/Credential=([^,]+)/)?.[1].split("/");
  const signedHeaders = authorization.match(/SignedHeaders=([^,]+)/)?.[1];
  const signature = authorization.match(/Signature=([0-9a-f]+)/)?.[1];
  assert.ok(credential && signedHeaders && signature, "valid SigV4 Authorization fields");
  const scope = credential.slice(1).join("/");
  const amzDate = headers.get("x-amz-date");
  const payloadHash = headers.get("x-amz-content-sha256");
  const body = options.body === undefined ? Buffer.alloc(0) : Buffer.from(options.body);
  assert.equal(payloadHash, createHash("sha256").update(body).digest("hex"), "signed payload hash matches request bytes");
  const canonicalHeaders = signedHeaders.split(";")
    .map((name) => `${name}:${(name === "host" ? headers.get(name) ?? url.host : headers.get(name)).trim()}`)
    .join("\n") + "\n";
  const canonical = [method, url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const missingNewline = canonicalHeaders.slice(0, -1);
  const broken = [method, url.pathname, "", missingNewline, signedHeaders, payloadHash].join("\n");
  assert.equal(signature, independentSignature(secret, scope, amzDate, canonical), "valid SigV4 signed request");
  assert.notEqual(signature, independentSignature(secret, scope, amzDate, broken),
    "signature must reject CanonicalHeaders without its trailing newline");
}

test("changing an opted-in channel or withdrawing consent invalidates drafts", () => {
  const original = { optIn: true, channel: "whatsapp" };
  assert.equal(invalidatesReminderDrafts(original, { optIn: true, channel: "sms" }), true);
  assert.equal(invalidatesReminderDrafts(original, { optIn: false, channel: "whatsapp" }), true);
  assert.equal(invalidatesReminderDrafts(original, { optIn: true, channel: "whatsapp" }), false);
});

test("completed private bytes cannot be replaced with the original upload URL", async () => {
  process.env.PRIVATE_OBJECT_DIR = "fake-bucket/private";
  const objects = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    if (String(input) === "http://127.0.0.1:1106/object-storage/signed-object-url") {
      const { object_name: name, method } = JSON.parse(options.body);
      return Response.json({ signed_url: `https://files.example.invalid/${encodeURIComponent(name)}?method=${method}` });
    }
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.slice(1));
    const method = options.method ?? url.searchParams.get("method");
    if (method === "PUT") {
      objects.set(key, { bytes: Buffer.from(options.body), type: options.headers["Content-Type"] });
      return new Response(null, { status: 200 });
    }
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    if (method === "HEAD") return new Response(null, {
      status: 200, headers: { "content-length": String(object.bytes.length), "content-type": object.type },
    });
    return new Response(object.bytes, {
      status: 200, headers: { "content-length": String(object.bytes.length), "content-type": object.type },
    });
  };
  try {
    const staged = newPrivateDocumentKey();
    const sealed = newSealedDocumentKey();
    const original = Buffer.from("%PDF-1.7 original consent");
    const replaced = Buffer.from("X".repeat(original.length));
    const checksum = createHash("sha256").update(original).digest("hex");
    const upload = await getPrivateUploadUrl(staged);
    await fetch(upload, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: original });
    assert.equal(await promotePrivateUpload(staged, sealed, original.length, "application/pdf", checksum), true);
    await assert.rejects(getPrivateUploadUrl(sealed), /Sealed documents cannot be uploaded directly/);
    // The original signed URL may remain valid, but it can only overwrite staging.
    await fetch(upload, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: replaced });
    assert.equal(await verifyPrivateUpload(sealed, original.length, "application/pdf", checksum), true);
    assert.equal(await verifyPrivateUpload(staged, original.length, "application/pdf", checksum), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("S3 provider issues private presigned uploads and conditionally creates sealed objects", async () => {
  const previous = Object.fromEntries([
    "STORAGE_PROVIDER", "PRIVATE_OBJECT_DIR", "S3_ENDPOINT", "S3_BUCKET", "S3_REGION",
    "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_SESSION_TOKEN",
  ].map((key) => [key, process.env[key]]));
  const objects = new Map();
  const realFetch = globalThis.fetch;
  process.env.STORAGE_PROVIDER = "s3";
  process.env.S3_ENDPOINT = "https://s3.example.invalid";
  process.env.S3_BUCKET = "dentozone-private";
  process.env.S3_REGION = "eu-west-1";
  process.env.S3_ACCESS_KEY_ID = "test-access";
  process.env.S3_SECRET_ACCESS_KEY = "test-secret";
  delete process.env.S3_SESSION_TOKEN;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method ?? "GET";
    assertS3Signature(url, method, options, "test-secret");
    const key = decodeURIComponent(url.pathname.replace(/^\/dentozone-private\//, ""));
    if (method === "PUT") {
      if (options.headers?.["if-none-match"] === "*" && objects.has(key)) {
        return new Response(null, { status: 412 });
      }
      const headers = new Headers(options.headers);
      if (headers.get("If-None-Match") === "*" && objects.has(key)) return new Response(null, { status: 412 });
      objects.set(key, { bytes: Buffer.from(options.body), type: headers.get("content-type") ?? "application/octet-stream" });
      return new Response(null, { status: 200 });
    }
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    if (method === "HEAD") return new Response(null, {
      status: 200, headers: { "content-length": String(object.bytes.length), "content-type": object.type },
    });
    return new Response(object.bytes, { status: 200, headers: { "content-type": object.type } });
  };
  try {
    const staged = newPrivateDocumentKey();
    const sealed = newSealedDocumentKey();
    const uploadUrl = await getPrivateUploadUrl(staged);
    const parsedUrl = new URL(uploadUrl);
    assert.equal(parsedUrl.hostname, "s3.example.invalid");
    assert.match(parsedUrl.pathname, new RegExp(`/dentozone-private/${staged}$`));
    assert.equal(parsedUrl.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
    assert.equal(parsedUrl.searchParams.get("X-Amz-Credential").startsWith("test-access/"), true);
    const bytes = Buffer.from("%PDF-1.7 private s3 document");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: bytes });
    assert.equal(await promotePrivateUpload(staged, sealed, bytes.length, "application/pdf", checksum), true);
    assert.equal(objects.get(sealed).bytes.toString(), bytes.toString());
    await assert.rejects(getPrivateUploadUrl(sealed), /Sealed documents cannot be uploaded directly/);
    assert.equal(await promotePrivateUpload(staged, sealed, bytes.length, "application/pdf", checksum), false);
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("active Replit documents can be copied idempotently without deleting their originals", async () => {
  const previous = Object.fromEntries([
    "STORAGE_PROVIDER", "PRIVATE_OBJECT_DIR", "S3_ENDPOINT", "S3_BUCKET",
    "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
  ].map((key) => [key, process.env[key]]));
  const objects = new Map();
  const originalBytes = Buffer.from("%PDF-1.7 original remains in app storage");
  const realFetch = globalThis.fetch;
  process.env.STORAGE_PROVIDER = "s3";
  process.env.PRIVATE_OBJECT_DIR = "legacy-bucket/private";
  process.env.S3_ENDPOINT = "https://s3.example.invalid";
  process.env.S3_BUCKET = "dentozone-private";
  process.env.S3_ACCESS_KEY_ID = "test-access";
  process.env.S3_SECRET_ACCESS_KEY = "test-secret";
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") {
      return Response.json({ signed_url: "https://legacy.example.invalid/old-active-object?method=GET" });
    }
    if (url.hostname === "legacy.example.invalid") {
      return new Response(originalBytes, { headers: { "content-type": "application/pdf" } });
    }
    assertS3Signature(url, options.method ?? "GET", options, "test-secret");
    const key = decodeURIComponent(url.pathname.replace(/^\/dentozone-private\//, ""));
    const method = options.method ?? "GET";
    const object = objects.get(key);
    if (method === "HEAD") return object
      ? new Response(null, { status: 200, headers: { "content-length": String(object.bytes.length), "content-type": object.type } })
      : new Response(null, { status: 404 });
    if (method === "PUT") {
      if (object) return new Response(null, { status: 412 });
      objects.set(key, { bytes: Buffer.from(options.body), type: new Headers(options.headers).get("content-type") });
      return new Response(null, { status: 200 });
    }
    return object
      ? new Response(object.bytes, { headers: { "content-length": String(object.bytes.length), "content-type": object.type } })
      : new Response(null, { status: 404 });
  };
  try {
    const key = newSealedDocumentKey();
    assert.equal(await migrateLegacyDocumentToS3(key, originalBytes.length, "application/pdf", "active"), "copied");
    assert.equal(await migrateLegacyDocumentToS3(key, originalBytes.length, "application/pdf", "active"), "already-present");
    const stagingKey = newPrivateDocumentKey();
    assert.equal(await migrateLegacyDocumentToS3(stagingKey, originalBytes.length, "application/pdf", "pending"), "copied");
    assert.deepEqual(objects.get(key).bytes, originalBytes);
    assert.deepEqual(objects.get(stagingKey).bytes, originalBytes);
    assert.deepEqual(originalBytes, Buffer.from("%PDF-1.7 original remains in app storage"));
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("migration skips only missing pending bytes and fails for missing active bytes", async () => {
  const previous = Object.fromEntries([
    "STORAGE_PROVIDER", "PRIVATE_OBJECT_DIR", "S3_ENDPOINT", "S3_BUCKET",
    "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
  ].map((key) => [key, process.env[key]]));
  const realFetch = globalThis.fetch;
  process.env.STORAGE_PROVIDER = "s3";
  process.env.PRIVATE_OBJECT_DIR = "legacy-bucket/private";
  process.env.S3_ENDPOINT = "https://s3.example.invalid";
  process.env.S3_BUCKET = "dentozone-private";
  process.env.S3_ACCESS_KEY_ID = "test-access";
  process.env.S3_SECRET_ACCESS_KEY = "test-secret";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") {
      return Response.json({ signed_url: "https://legacy.example.invalid/missing?method=GET" });
    }
    return new Response(null, { status: 404 });
  };
  try {
    const key = newPrivateDocumentKey();
    assert.equal(await migrateLegacyDocumentToS3(key, 12, "application/pdf", "pending"), "missing");
    await assert.rejects(
      migrateLegacyDocumentToS3(key, 12, "application/pdf", "active"),
      /Missing active document bytes/,
    );
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});