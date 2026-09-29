# Protected clinic route checks

Run `pnpm --filter @workspace/api-server test:integration` against the **development** database.
The suite refuses production, inserts uniquely named fictional records, and removes them
afterward. It mounts the real Express route handlers on a loopback-only test server,
injecting distinct test staff identities at the authentication boundary. It does not
replace or bypass Clerk in the running app. App Storage requests are intercepted with
an in-process fake, so no real patient files or outbound messages are used.

These tests cover role authorization and route/database behavior, **not** an actual
Clerk sign-in. A separate UI check still needs a genuinely invited, verified staff
account to validate protected English and Arabic screens.