---
name: Clerk registry compatibility
description: Why frontend Clerk installs need live registry and peer-range checks.
---

Use versions actually available from the workspace package registry, then align the React workspace catalog with the installed Clerk release's declared peer range.

**Why:** A plausible Clerk version was unavailable behind the workspace package firewall, and the replacement release rejected the existing React patch version. Repeated installs were avoidable by checking both the registry and peer requirements first.

**How to apply:** Before adding or updating Clerk frontend packages, query the registry for available releases and inspect peer requirements; adjust compatible React patch versions in the shared catalog before installing.