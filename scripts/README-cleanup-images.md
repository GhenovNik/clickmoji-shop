# UploadThing Image Cleanup

`scripts/db-files.ts` compares UploadThing storage with category and product image references in
PostgreSQL.

## Safe preview

Always inspect a dry run first:

```bash
npm run db:files:dry
```

The command lists unused files and the estimated storage that would be reclaimed. It does not
delete data.

## Delete unused images

After reviewing the dry-run output:

```bash
npm run db:files
```

Deletion is permanent. Confirm that `DATABASE_URL` and `UPLOADTHING_TOKEN` point to the intended
environment before running the command.

## Orphan cleanup command

The lower-level command checks all stored files, waits five seconds, and permanently removes files
that are not referenced by a category or product:

```bash
npx tsx scripts/db-files.ts cleanup-orphaned-files
```

Prefer `cleanup-unused-images --dry-run` for routine maintenance. The orphan command currently has no
dry-run mode and should be treated as an operator-only recovery tool.

## Scope

- Referenced `Category.imageUrl` files are preserved.
- Referenced `Product.imageUrl` files are preserved.
- Unicode emoji are not stored in UploadThing and are unaffected.
- User avatars are not part of the current application upload surface.
