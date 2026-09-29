---
name: Managed workflow port collisions
description: Distinguishing a failed artifact workflow restart from an older process still serving the preview
---

When an artifact workflow reports a port-in-use startup failure while its preview still responds, check for an earlier process group owned by the same managed workflow before changing any configuration. If the older group is confirmed to be the conflicting listener, terminate only that group, then restart the existing managed workflow once.

**Why:** A previous server remained alive after its workflow was marked failed. A new launch collided with it even though the application itself was healthy and publicly previewable.

**How to apply:** Use this diagnosis for EADDRINUSE after a managed workflow restart. Avoid adding replacement workflows or changing artifact ports to hide the collision.