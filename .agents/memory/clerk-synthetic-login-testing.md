---
name: Clerk synthetic login testing
description: Why synthetic test sign-ins may not activate an invited clinic staff member
---

Synthetic login claim overrides need not alter the email returned by Clerk's user API. An invitation matched to an overridden claim alone may therefore not activate the intended staff member.

**Why:** The remote Clerk user record is the security source of truth. Weakening production identity checks to make a synthetic browser fixture pass would create an authorization risk. A development-only Clerk user with a verified reserved test email, matched to an active clinic staff invitation, did pass the authenticated browser check without weakening authorization. Reserved test email verification uses a publicly documented fixed code, so an owner invitation for such an address must not be left active after testing.

**How to apply:** For authenticated role checks, make sure the actual Clerk identity and clinic invitation match; never loosen verified-email checks merely to accommodate synthetic claims. Deactivate the staff invitation before removing its temporary Clerk test user, and remove both when testing finishes.