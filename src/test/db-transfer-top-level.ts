import ts from 'typescript';

// A line is a violation when it constructs a Prisma client, its adapter, or
// calls the lazy factory, and no enclosing function body scopes it away from
// module evaluation time.

const isFunctionLike = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessor(node) ||
  ts.isSetAccessor(node) ||
  ts.isConstructorDeclaration(node);

const calleeName = (expression: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
};

export function findTopLevelClientConstructionLines(source: string): number[] {
  const sourceFile = ts.createSourceFile(
    'scripts/db-transfer.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  const lines = new Set<number>();
  const record = (node: ts.Node): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    lines.add(line + 1);
  };
  const visit = (node: ts.Node, inFunction: boolean): void => {
    if (!inFunction) {
      if (ts.isNewExpression(node) && calleeName(node.expression) === 'PrismaClient') {
        record(node);
      } else if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        if (name === 'createPrismaPgAdapter' || name === 'getPrisma') {
          record(node);
        }
      }
    }
    const scopesToFunction = inFunction || isFunctionLike(node);
    ts.forEachChild(node, (child) => visit(child, scopesToFunction));
  };
  visit(sourceFile, false);
  return [...lines].sort((a, b) => a - b);
}
