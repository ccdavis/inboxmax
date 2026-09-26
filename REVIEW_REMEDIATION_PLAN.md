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

# Follow-up review (2026-09-26)

Bugs, UI glitches, and design issues found in a second review, all addressed.

## Correctness

- [x] Day grouping no longer drops emails in non-English locales or from later in
      the day exactly a week ago (groups are keyed by calendar-day offset).
- [x] Decode RFC 2047 encoded-words in subjects and sender names.
- [x] Leaving the page advances the last-seen marker to the highest UID, only
      forwards, and never overrides a marker the user placed by hand.
- [x] Expire the in-memory email-window cursor before the server's seven-day limit.
- [x] Keep search loading/errors separate from the inbox's; show a search-specific
      empty state.
- [x] Missing messages return 404; the requested UID is matched in FETCH replies.
- [x] Non-ASCII searches declare `CHARSET UTF-8`.
- [x] Password length counts characters on both client and server.
- [x] First UIDVALIDITY observation keeps legacy watermarks; pre-tracking bookmarks
      are backfilled (migration 005 plus first refresh).
- [x] A lost mail session returns the user to the connect screen with a notice.

## Security

- [x] Rate-limit failed sign-ins per account and rejected mailbox logins per user;
      equalize sign-in timing for unknown accounts.
- [x] Block NAT64, 6to4, and Teredo IPv6 targets that reach private IPv4.

## UI and accessibility

- [x] Install the Tailwind typography plugin so HTML email formatting and links render.
- [x] Mobile drawer fits the screen, only closes on navigation, supports Escape,
      manages focus, and makes hidden content inert.
- [x] Light and dark themes via semantic color tokens; seen rows are subtly greyed
      in both.
- [x] Labelled form fields with autocomplete, keyboard-operable rows, labelled icon
      buttons, visible focus, AA-contrast secondary text, 36px touch targets.
- [x] Reader: "(no subject)" fallback, themed back link, blocked-image notice,
      focus on open; selected email highlighted in the sidebar.
- [x] Single sidebar border; router link on the 404 page; dismissible notices.

## Design

- [x] Main pane shows every unseen email plus the rest of today, so unseen mail
      does not disappear at midnight.
- [x] Registration and sign-in go straight to the inbox (connect step for new users).
- [x] Connect screen offers sign-out, an IMAP port override, and explains that the
      mail password is held only in memory.
- [x] The sidebar always browses the inbox (not search results) and omits empty days.
- [x] Clean, user-facing error messages without status-code prefixes.

## Tooling

- [x] E2E runs on its own port and throwaway database; README screenshots only
      regenerate via `npm run screenshots`.
- [x] Removed dead code (unused `since` argument, `sinceTimestamp`, angle-bracket
      stripping, unused derives and dependencies) and fixed a misplaced doc comment.
