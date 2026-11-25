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
4. Regular registration is `POST /api/auth/register`, unchanged. It ignores the guest cookie and
   creates a separate account; it never modifies or adopts the guest (see below).

## Decisions

- **Identity.** A guest is a `User` row. The placeholder email is
  `guest_<uuid>@guest.clickmoji.invalid`; `.invalid` is reserved (RFC 2606), and
  `isGuestEmail` identifies it. Nothing is ever sent to it: `send()` in `src/lib/email.ts`
  refuses guest addresses, and password reset, resend and verification skip guest rows.
- **Session validation.** The NextAuth `jwt` callback and `requireUser` resolve the user by
  `User.id` only (never by email) and reject a token whose `iat` (whole seconds) is older than
  the row's `createdAt`. A deleted guest, or a guest recreated under the same email, cannot
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

## Not in this change: guest to regular account

Registration does not convert a guest. `POST /api/auth/register` ignores the guest session
cookie: it creates a new `User` row with starter lists, exactly as before, and never updates
the guest row. The guest keeps its placeholder email, `isGuest = true`, lists and purchases.
A duplicate email returns `400 userExists`, and a guest email is refused with `400 invalidEmail`.

A later change may convert a guest in place, keeping the same `User.id`. That change is out of
scope here and needs its own design. It must update the existing row (`where { id, isGuest: true }`)
to set the real email, password hash and name, and `isGuest = false`. It must not create a second
row, copy or merge lists, or re-run starter lists. A guest cookie must never be used to change
another account.

A later conversion would show in analytics as `users.isGuest` changing from `true` to `false` on
the same id, with no second `REGISTER` written.

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
  start route when it reuses a session.
