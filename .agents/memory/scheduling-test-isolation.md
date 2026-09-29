---
name: Scheduling test isolation
description: Avoid false booking conflicts when creating independent clinic test fixtures
---

Scheduling integration fixtures must isolate globally shared chairs as well as staff and patients, and keep unrelated UTC-relative appointments apart from Cairo-local appointments around daylight-saving changes.

**Why:** Scheduling fixtures share chair capacity and Cairo-local booking rules, so independent-looking tests can still conflict and report false failures.

**How to apply:** Isolate all capacity resources per run, use one timezone for expected intervals, and scope fixture cleanup to all related test records.