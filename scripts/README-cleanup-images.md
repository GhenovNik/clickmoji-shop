# UploadThing Image Cleanup

`scripts/db-files.ts` compares UploadThing storage with every picture reference in PostgreSQL
(`src/lib/services/stored-image-references.ts`): both pictures of a product (`imageUrl`,
`imageUrlEn`), every category `imageUrl` whatever its `isCustom` flag says, and every emoji
library picture.

## Run it only with the app stopped

The references are read once and the files are deleted afterwards. If the application is running,
a picture attached by an admin or an import between those two moments is deleted while in use and
the product shows a broken image. Stop the application (or every writer) for the whole run. A
protocol that is safe with writers running (tombstones / a maintenance gate) is Linear AGE-1472;
until it lands, this cleanup is not a safe replacement for deleting files in the app.

## Preview

Always inspect a dry run first:

```bash
npm run db:files:dry
```

The command lists unused files and the estimated storage that would be reclaimed. It does not
delete data.

## Delete unused images

After reviewing the dry-run output, with the app stopped:

```bash
npm run db:files
```

Deletion is permanent. Confirm that `DATABASE_URL` and `UPLOADTHING_TOKEN` point to the intended
environment before running the command.

## Orphan cleanup command

The lower-level command checks all stored files, waits five seconds, and permanently removes files
that nothing references:

```bash
npx tsx scripts/db-files.ts cleanup-orphaned-files
```

Prefer `cleanup-unused-images --dry-run` for routine maintenance. The orphan command currently has no
dry-run mode and should be treated as an operator-only recovery tool, under the same stopped-app rule.

## Scope

- Product (`imageUrl`, `imageUrlEn`), category and emoji library pictures are preserved.
- Unicode emoji are not stored in UploadThing and are unaffected.
- User avatars are not part of the current application upload surface.
