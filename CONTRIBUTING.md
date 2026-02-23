# Contributing

## Branching model

- `master` is the production branch (deployed to Vercel production).
- `develop` is the integration branch.
- Create feature branches from `develop` using `feature/<name>`.

## Pull request flow

1. Open PR from `feature/*` to `develop`.
2. Merge to `develop` after checks pass.
3. Open PR from `develop` to `master` for release.
4. Merge to `master` to publish to production.

## Required repository rules

- Do not push directly to `master` or `develop`.
- Require pull requests before merge for both `master` and `develop`.
- Require CI checks before merge:
  - `CI / validate`
- Require at least one approval for `master`.

## Local quality gate

Run before opening PR:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```
