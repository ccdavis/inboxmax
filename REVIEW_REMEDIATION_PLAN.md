# Review remediation plan

This checklist tracks the issues found in the 2026-09-07 project review. It is
ordered so that security and data-integrity changes land before UI cleanup.

## 1. Authentication and network boundaries

- [x] Prevent IMAP connections to local/private/special-use addresses, including
      after DNS resolution, and apply timeouts to DNS, TCP, TLS, login, and mail
      operations.
- [x] Give in-memory sessions a TTL and capacity bound; remove replaced sessions
      during authentication so plaintext IMAP credentials are not retained.
- [x] Enforce device-token expiry on the server, keep at most ten tokens, and make
      sign-out failures visible.
- [x] Issue and remove cookies with consistent attributes (`Path=/`, `HttpOnly`,
      `SameSite=Lax`, and configurable `Secure`).

## 2. Account and mailbox correctness

- [x] Normalize and validate email addresses consistently.
- [x] Make account ownership enforcement atomic and case-insensitive; preserve a
      reconnecting account's watermark/window state.
- [x] Scope and age-limit the client-side email-window cursor so it cannot leak
      between users or accounts or grow without bound.
- [x] Keep inbox results separate from search results so search/visibility events
      cannot overwrite the inbox watermark.
- [x] Re-fetch remembered messages after an IMAP account is connected.
- [x] Return the newest 50 search matches deterministically.
- [x] Apply the exact requested timestamp after IMAP's day-granularity search.
- [x] Serialize watermark writes and surface manual refresh/bookmark failures.
- [x] Record IMAP UIDVALIDITY with remembered-message and watermark state so UID
      reuse cannot silently point at another message.

## 3. Email rendering and API truthfulness

- [x] Correct the DOMPurify allow-list configuration and block remote-content
      tracking in HTML email.
- [x] Remove the permanently-false attachment field until attachment detection is
      implemented.
- [x] Remove the unused SMTP/reply path and related configuration/dependencies.

## 4. Organization and stale material

- [x] Extract a reusable application router for production and integration tests.
- [x] Consolidate duplicate authentication response/session-issuing code.
- [x] Pass a mailbox credential object through the mail abstraction instead of
      repeating connection arguments.
- [x] Delete the obsolete duplicated login screen and unused template assets and
      dependency.
- [x] Fix the PWA manifest to reference assets that exist.
- [x] Commit the Vite development proxy and correct obsolete README instructions.
- [x] Replace vacuous/incorrect tests and add regressions for the fixes above.

## 5. Quality gates

- [x] Make ESLint pass without suppressing meaningful React rules.
- [x] Make `cargo clippy --all-targets -- -D warnings` pass.
- [x] Resolve dependency advisories discovered during implementation and verify
      both npm package trees audit clean.
- [x] Run server, client, production-build, and browser test suites; re-assess this
      plan and record any follow-up work.

## Reassessment notes

- Refreshing the client lockfile exposed 22 npm advisories (including vulnerable
  direct versions of DOMPurify, React Router, Vite, and Vitest). Compatible
  upgrades and transitive patches were added to this plan rather than deferred.
- Exact timestamp filtering intentionally changes direct API refresh behavior:
  callers that want a stable visible window must resend the returned
  `since_timestamp`. The client does this with an account-scoped, seven-day cursor.
- The legacy SMTP database columns remain physically present so existing migration
  history and databases stay compatible, but SMTP is removed from runtime types,
  requests, configuration, code, and dependencies.
- The final SSRF review expanded embedded-IPv4 handling to cover both mapped and
  deprecated compatible IPv6 literal forms; both are now regression-tested.

## Completion verification

- `cargo test --all-targets`: 26 tests passed.
- `cargo clippy --all-targets -- -D warnings`: passed.
- `npm test`: 14 tests passed.
- `npm run lint`: passed.
- `npm run build`: passed and generated the PWA bundle.
- Playwright behavior suite: 35 tests passed.
- `npm audit` in both `client` and `e2e`: zero known vulnerabilities.
