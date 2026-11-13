// AC-7 predicate: lines that construct a Prisma client (or its adapter)
// outside function bodies, reported as 1-based line numbers.

export function findTopLevelClientConstructionLines(source: string): number[] {
  return source
    .split('\n')
    .map((line, i) => ({ line, i }))
    .filter(
      ({ line }) => /new PrismaClient|createPrismaPgAdapter\(/.test(line) && !/^\s/.test(line)
    )
    .map(({ i }) => i + 1);
}
