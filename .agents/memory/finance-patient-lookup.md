---
name: Finance patient lookup boundary
description: Keep billing patient selection separate from clinical patient profile access.
---

Finance-only staff should receive just enough patient identity to select an invoice recipient, not general access to patient records.

**Why:** The full patient directory includes clinical and contact details; widening its role permissions to make invoice entry work would disclose medical information to accounting staff.

**How to apply:** New billing workflows should use a narrowly scoped, searchable patient identity lookup. Do not grant finance roles general patient read access just to populate a selector.