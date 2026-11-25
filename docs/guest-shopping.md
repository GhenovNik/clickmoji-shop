# Server-backed guest shopping (AGE-1667)

Pressing **Start** on the landing page creates a real, server-backed guest session. The guest
can build lists, add products, purchase, and read history, without registering.

## Flow

1. `Start` calls `POST /api/auth/guest` (no body).
2. The route creates a `User` row with `isGuest = true`, a placeholder email, and five starter
   lists in one transaction. It then mints an ordinary NextAuth session cookie (JWT) for that
   row. A valid existing session is reused instead of creating another guest.
3. Lists, items, purchases, history and restore use the normal authenticated routes. Their
   ownership checks are unchanged, so a guest sees and changes only its own data.
4. Registration is `POST /api/auth/register`. With a live guest session it promotes that guest in
   place, keeping the same `User.id` and its data (see "Guest to account promotion" below). Without
   one it creates an ordinary account as before.

## Decisions

- **Identity.** A guest is a `User` row. The placeholder email is
  `guest_<uuid>@guest.clickmoji.invalid`; `.invalid` is reserved (RFC 2606), and
  `isGuestEmail` identifies it. Nothing is ever sent to it: `send()` in `src/lib/email.ts`
  refuses guest addresses, and password reset, resend and verification skip guest rows.
- **Session validation.** The NextAuth `jwt` callback and `requireUser` resolve the user by
  `User.id` only (never by email) and reject a token whose immutable `sessionIssuedAt` claim
  (whole seconds, stamped once at issuance and copied unchanged on refresh) is older than the
  row's `createdAt`. NextAuth's `iat` is not used, because it is rewritten on every refresh. A deleted guest, or a guest recreated under the same email, cannot
  be revived by an old cookie. This rule is shared with the account-session work and must be
  kept when the two branches are merged.
- **Guest AI is off.** `aiDailyLimit(role, isGuest)` returns `0` for guests, so the common quota
  path answers `403` (`api.aiQuota.guestDisabled`) before any budget reservation. Quotas are
  per `User.id`, and a guest can be recreated, so any non-zero guest allowance could be
  multiplied by churning new guests. Turning guest AI on would need an IP- or
  device-level daily cap first. `import-text` and `smart-create` also refuse guests directly.
- **Churn limit.** Guest creation is rate-limited per client IP (20 per hour, `auth:guest:ip`).
- **Funnel.** The proxy records `VISIT` as before. Guest start records `REGISTER` and
  `LIST_CREATE` against the signed funnel `guestId`, with `dedupeByGuest`: at most one of each
  per live `guestId`, so a retry or a recreated guest from the same browser does not inflate the
  funnel. The new `User.id` is still correlated to the funnel rows. Guest funnel rows are
  deleted with the guest by the existing `onDelete: Cascade`.
- **Guest funnel identity.** One browser's guest chain is one funnel person: every event whose
  `User` is a guest is keyed by the funnel `guestId`, whichever guest row wrote it. A restarted
  or concurrent start creates another guest row, but it does not start a new person. Ordinary
  users stay keyed by `User.id`. The analytics cookie never authenticates or recovers an account.
  Milestones are stamped under the same per-guest lock, after the chain's newest row, so the
  chain's order holds under concurrent starts.
- **Chain join on a new start.** A new guest start writes one `VISIT` on its funnel chain, under
  the chain lock and in the guest creation transaction. That row ties the new guest to the chain.
  When an older guest of the chain is cleaned up, its shared milestones (`VISIT`, `REGISTER`,
  `LIST_CREATE`) move to the newest active guest of the chain: the earliest row of each type moves
  unless the replacement already holds that type from an earlier moment. So the chain stays whole
  even when the new guest adds no event before the older guest is cleaned. The newer guest is not
  affected when the older one stays active, and the chain still follows retention when no active
  guest remains. A guest created before this change has no such row; it becomes a replacement
  only after it has a chain row of its own.

## Guest to account promotion (AGE-1667)

Registration with a live guest session promotes that guest **in place**. `POST /api/auth/register`
resolves the request's NextAuth session cookie (signature verified, row checked in the database):

- **Live guest** (`isGuest = true`, fresh token): the same `User` row is updated in one conditional
  write, `where { id, isGuest: true }`, which sets the real email, password hash, name and
  `emailVerified`, and `isGuest = false`. Lists, items, purchases, history and favorites keep their
  owner. No second row is created, no starter lists are re-created and no accounts are merged.
- **Guest token whose row is already an account** (a retry, a second tab, a stale cookie): refused
  with `400 userExists`, whatever email is sent. One browser never opens a second account.
- **A signed guest token whose row cleanup removed, or that no longer matches it** (stale): the
  request fails with `401 guestSessionExpired`, creates no account, and clears the guest cookie.
  Creating an account here would be a second user for the same browser.
- **No guest session at all**: the request is anonymous and creates an ordinary account, exactly as
  for any visitor.

The promotion path, step by step:

1. Cleanup protection: `guestLastActiveAt` is refreshed (`recordGuestActivity`) before anything slow.
   Cleanup re-checks that field in its own delete, so a guest whose registration has begun is kept.
   A row that is already gone returns `401 guestSessionExpired`.
2. The email must not belong to another account (`400 userExists`).
3. The password is hashed.
4. One transaction promotes the row (conditional `updateMany`). A conditional update that matches
   no row means a concurrent request won (`already-registered`) or the row is gone (`expired`). A
   unique-email violation means another account holds the email (`email-taken`). Only after the
   update succeeded, and only when verification is required, the verification token is created and
   its email sent inside the same transaction, before commit. If the email cannot be sent, the
   transaction rolls back: the guest, its lists, the token table and the funnel are unchanged, and
   the response is `503 verificationEmailFailed`. The guest is never deleted on this path.
5. The same transaction writes one `GUEST_REGISTERED` funnel event and commits.
6. With verification required, no session is issued: the response clears the guest cookie, and the
   user signs in after confirming the email. Without verification, the response sets a fresh
   ordinary session cookie for the same `User.id`, with `isGuest: false`.

### Old guest sessions are invalid

The promotion does not change `sessionIssuedAt` or `createdAt`, so the issuance check alone would
accept an old guest token for the same id. The NextAuth `jwt` callback therefore compares the
token's stored `isGuest` claim with the row on every refresh and rejects a token that says guest
while the row is an account (`Guest session superseded by account`). The same check runs for
every browser that still holds the old cookie. `requireUser` reads `isGuest` from the row, so
after promotion the ordinary AI and email behaviour applies with no extra switch.

### Google sign-in from a guest session

Google has two paths, chosen by explicit intent and never by the guest cookie alone.

**Explicit upgrade.** The register page sets `clickmoji_guest_upgrade=google` (Max-Age 300,
SameSite Lax, not a secret) right before Google sign-in from the guest's "Save account with Google"
button. Only a callback that carries this cookie and a live guest session runs the upgrade:

- **Live guest, verified Google address, no account holds it**: the guest is promoted in place with
  `promoteGuestWithGoogleIdentity` (same `User.id`, no password, verified now, `GUEST_REGISTERED`).
- **Address held by any account**: refused with `/register?upgrade=email-taken`. No sign-in, no
  switch, no merge; the page shows "Эта почта уже зарегистрирована — войдите" (EN: "This email is
  already registered — sign in").
- **Address not verified by Google**: refused with `/register?upgrade=unverified`. No account is
  created and the guest stays a guest.
- **Stale, removed or already-promoted guest**: refused with `/register?upgrade=expired`. This is
  the guest-side equivalent of `guestSessionExpired`: no second user is created.
- **No guest session behind the cookie**: the intent is ignored and the ordinary path below runs.

**Ordinary sign-in** (no intent cookie): unchanged from #167. The browser signs into the account
that holds the address, or a new account is created. A guest row is never promoted, merged or
removed by this path, so a guest's own Google login cannot silently convert the guest.

Decisions:

- A forged intent cookie can only select the stricter explicit path. It never grants a promotion
  the guest session does not already hold.
- The register page clears the intent cookie when it loads. The callback itself cannot set cookies,
  so the cookie also expires on its own after 5 minutes.
- A refused explicit upgrade cannot clear the stale guest cookie (a NextAuth redirect). The next
  guest API call clears it, as it does for any stale guest.
- Two promotions at once (two guests, or Google and email for one guest): the conditional update and
  the unique email decide. The loser is refused, and no second account is created.

### Funnel

A promotion writes `GUEST_REGISTERED`, not `REGISTER`. It is a new enum value, added by a
SQL-only migration (`20261125060000_add_guest_registered_funnel_event`). The promotion writes it
once, inside the promotion transaction. With the analytics cookie it joins the guest's chain under
the chain lock; without the cookie it is written with `guestId` null, so the promotion is still
counted. The report puts `GUEST_REGISTERED` in the `auth` stage, like `REGISTER`, and shows the
promotions in a separate line (`guestPromotions`), so a promotion never adds a second `REGISTER`.
The anonymous cookie is used only for this analytics attribution; it never authenticates or
recovers an account.

## Decisions (AGE-1667)

- **No account merging.** A promotion never merges a guest with an existing account. An email that
  belongs to another account is refused, and the guest keeps its lists and stays a guest.
- **In-place update, not a copy.** The guest row keeps its `id` and all owned data. A new row
  would orphan purchases and favorites and would split the funnel person.
- **Retries and races resolve to one account.** The conditional update
  (`where { id, isGuest: true }`) and the unique email decide the winner. Losers get
  `userExists` or `guestSessionExpired`, never a second account.
- **Refusal for a promoted stale token, not anonymous registration.** A row that is an account
  makes the token a refused retry (`userExists`). A signed token whose row is gone or stale fails
  with `guestSessionExpired` and clears the cookie, so no second account is created for it.
- **Verification is in the promotion transaction.** The token and the email are created after the
  conditional update and before commit. Any failure, including a lost email race, rolls them back:
  an unsuccessful request never leaves a usable verification token for the address.
- **No session until the email is confirmed.** When verification is required the promoted account
  has no session: the guest cookie is cleared, and sign-in with the password requires the confirmed
  email (`EmailNotVerified`). Without verification the ordinary session replaces the guest cookie.
- **Analytics identity.** After promotion, events of this `User` are keyed by `User.id` in the
  report, so the guest's pre-promotion steps join that person. A second guest of the same browser
  started after promotion can add a `REGISTER` row on the chain. The report counts each person once
  per stage, so counts are unchanged.
- **Copy.** Registration shows a retention notice to guests, in RU and EN. The account CTA and
  hiding the technical guest email belong to the account UI work (PR #167); they are not in this
  change.

## Inactive guest cleanup

No schedule is added to the repository. Run it on demand, or from an external scheduler:

```sh
npm run db:cleanup-guests -- --dry-run            # count only
npm run db:cleanup-guests -- --inactive-days 45   # delete guests idle for 45+ days
```

- The threshold is `--inactive-days`, else `GUEST_CLEANUP_INACTIVE_DAYS`, else 30. Zero,
  negative, fractional or malformed values fail closed with exit code 1.
- Eligibility is strict: `isGuest = true`, `role = 'USER'`, and `guestLastActiveAt` (or
  `createdAt` when that is null) older than the cutoff. Each batch re-checks the same filter in
  its `deleteMany`, so a guest that became active or stopped being a guest in the meantime is kept.
- Regular users, admins and recent guests are never matched. Deletion cascades to the guest's
  lists, items, history, favorites, AI counters and funnel rows.
- `guestLastActiveAt` is refreshed by `requireUser` at most once a minute, and by the guest
  start route when it reuses a session. A refresh must succeed before the request is served:
  a write failure returns `503` (`api.errors.guestActivityFailed`) and a guest row that is already
  gone returns `401`, so cleanup at the cutoff never races a served request.
