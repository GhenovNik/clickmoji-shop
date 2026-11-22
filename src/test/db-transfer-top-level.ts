import ts from 'typescript';

// A line is a violation when it constructs a Prisma client, its adapter, or
// calls the lazy factory in module evaluation context: either outside any
// function-like boundary or inside a directly invoked function/arrow IIFE
// (including parenthesized callees and default parameter initializers).
// Analysis is strictly syntactic: deferred callbacks (e.g. Promise.resolve().then(...))
// and calls through aliases/variables are outside this boundary.

const isFunctionLike = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessor(node) ||
  ts.isSetAccessor(node) ||
  ts.isConstructorDeclaration(node);

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const calleeName = (expression: ts.Expression): string | undefined => {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) {
    return target.text;
  }
  if (ts.isPropertyAccessExpression(target)) {
    return target.name.text;
  }
  return undefined;
};

const directIifeTarget = (node: ts.Node): ts.FunctionExpression | ts.ArrowFunction | undefined => {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) {
    return undefined;
  }
  const target = unwrapExpression(node.expression);
  if (ts.isFunctionExpression(target) || ts.isArrowFunction(target)) {
    return target;
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
  const immediateFunctions = new Set<ts.Node>();
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
      const iife = directIifeTarget(node);
      if (iife) {
        immediateFunctions.add(iife);
      }
    }
    const scopesToFunction = inFunction || (isFunctionLike(node) && !immediateFunctions.has(node));
    ts.forEachChild(node, (child) => visit(child, scopesToFunction));
  };
  visit(sourceFile, false);
  return [...lines].sort((a, b) => a - b);
}
