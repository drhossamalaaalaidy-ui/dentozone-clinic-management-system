---
name: Private document immutability
description: Why private clinical uploads must not become active at the key exposed to a browser upload URL.
---

Never activate a clinical document at the same object key for which a client received a signed PUT URL. Verify and promote its bytes to a distinct server-only key, or pin an immutable storage generation before activation.

**Why:** A successful upload-completion check does not revoke a short-lived signed PUT URL. Until that URL expires, someone holding it can overwrite a supposedly verified consent document without another audit event.

**How to apply:** This matters for any new upload flow with irreversible clinical or legal significance. Keep the upload key temporary; only the server should obtain write authorization for the active object.