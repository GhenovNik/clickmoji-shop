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
- **No session, or a guest row cleanup has removed**: the request is anonymous and creates an
  ordinary account, exactly as for any visitor.

The promotion path, step by step:

1. Cleanup protection: `guestLastActiveAt` is refreshed (`recordGuestActivity`) before anything slow.
   Cleanup re-checks that field in its own delete, so a guest whose registration has begun is kept.
   A row that is already gone returns `401 guestSessionExpired`.
2. The email must not belong to another account (`400 userExists`).
3. The password is hashed. When verification is required, the verification email is sent.
   If sending fails, `503 verificationEmailFailed` is returned and nothing has changed. The guest
   is not deleted.
4. One transaction promotes the row (conditional `updateMany`) and writes the funnel event. A
   conditional update that matches no row means a concurrent request won (`already-registered`)
   or the row is gone (`expired`). A unique-email violation means another account holds the email.
5. The response sets a fresh ordinary session cookie for the same `User.id`, with `isGuest: false`.

### Old guest sessions are invalid

The promotion does not change `sessionIssuedAt` or `createdAt`, so the issuance check alone would
accept an old guest token for the same id. The NextAuth `jwt` callback therefore compares the
token's stored `isGuest` claim with the row on every refresh and rejects a token that says guest
while the row is an account (`Guest session superseded by account`). The same check runs for
every browser that still holds the old cookie. `requireUser` reads `isGuest` from the row, so
after promotion the ordinary AI and email behaviour applies with no extra switch.

### Funnel

Promotion writes one `REGISTER` on the guest's chain, with the same `User.id` and the signed
funnel `guestId`, inside the promotion transaction and under the chain lock. The funnel
enum is unchanged, so no migration is needed. The anonymous cookie is used only for this
analytics attribution; it never authenticates or recovers an account.

## Decisions (AGE-1667)

- **No account merging.** A promotion never merges a guest with an existing account. An email that
  belongs to another account is refused, and the guest keeps its lists and stays a guest.
- **In-place update, not a copy.** The guest row keeps its `id` and all owned data. A new row
  would orphan purchases and favorites and would split the funnel person.
- **Retries and races resolve to one account.** The conditional update
  (`where { id, isGuest: true }`) and the unique email decide the winner. Losers get
  `userExists` or `guestSessionExpired`, never a second account.
- **Refusal for a promoted stale token, not anonymous registration.** Only a guest that cleanup
  removed counts as "no session". A row that is an account makes the token a refused retry.
- **Verification email before commit.** Sending first means a failed email leaves the guest
  untouched, so no delete is needed. This path never deletes a row. The ordinary-registration
  error path deletes only the row it created in that request.
- **The promoted session is minted even when verification is required.** The new session replaces
  the guest session so the guest's lists stay reachable. Sign-in with a password still requires
  verification (`EmailNotVerified`). Open question for the operator: should an unverified
  promoted account keep an authenticated session until it verifies?
- **Analytics identity.** After promotion, events of this `User` are keyed by `User.id` in the
  report, so the guest's pre-promotion steps join that person. A second guest of the same browser
  started after promotion can add a `REGISTER` row on the chain. The report counts each chain once
  per stage, so counts are unchanged. An explicit conversion marker would need a funnel enum
  value and a migration, which this change does not add.
- **Copy.** Registration shows a retention notice to guests, in RU and EN. The account CTA and
  hiding the technical guest email belong to the account UI work (PR #167).

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
