import { describe, expect, it } from 'vitest';
import { findTopLevelClientConstructionLines } from './db-transfer-top-level';

const SYNTHETIC_CASES: ReadonlyArray<{
  name: string;
  source: string;
  expectLines: number[];
}> = [
  {
    name: 'indented top-level construction is a violation',
    source: '  const unexpected = new PrismaClient({ adapter: createPrismaPgAdapter() });\n',
    expectLines: [1],
  },
  {
    name: 'getPrisma() call at module top level is a violation',
    source: 'const shared = getPrisma();\n',
    expectLines: [1],
  },
  {
    name: 'client in a top-level initializer is a violation',
    source: 'const unexpected = new PrismaClient();\n',
    expectLines: [1],
  },
  {
    name: 'createPrismaPgAdapter() call at top level is a violation',
    source: 'const adapter = createPrismaPgAdapter();\n',
    expectLines: [1],
  },
  {
    name: 'construction inside a top-level if block is a violation',
    source: 'if (process.env.CI) {\n  const unexpected = new PrismaClient();\n}\n',
    expectLines: [2],
  },
  {
    name: 'creation inside a function is not a violation',
    source:
      'function buildClient() {\n  return new PrismaClient({ adapter: createPrismaPgAdapter() });\n}\n',
    expectLines: [],
  },
  {
    name: 'getPrisma() call inside a function is not a violation',
    source: 'async function migrateData() {\n  const client = getPrisma();\n  return client;\n}\n',
    expectLines: [],
  },
  {
    name: 'client factory inside an arrow function in a top-level initializer is not a violation',
    source: 'const buildClient = () => new PrismaClient();\n',
    expectLines: [],
  },
];

describe('top-level client construction predicate self-checks (AC-7)', () => {
  for (const { name, source, expectLines } of SYNTHETIC_CASES) {
    it(`${name}`, () => {
      expect(findTopLevelClientConstructionLines(source)).toEqual(expectLines);
    });
  }
});
