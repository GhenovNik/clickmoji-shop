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
  {
    name: 'uncalled arrow factory with default parameter is not a violation',
    source: 'const buildClient = (client = getPrisma()) => client;\n',
    expectLines: [],
  },
  {
    name: 'parenthesized arrow IIFE calling getPrisma() is a violation',
    source: '(() => getPrisma())();\n',
    expectLines: [1],
  },
  {
    name: 'arrow IIFE at module top level is a violation',
    source: '(() => new PrismaClient())();\n',
    expectLines: [1],
  },
  {
    name: 'multi-line arrow IIFE calling getPrisma() is a violation',
    source: '(() => {\n  return getPrisma();\n})();\n',
    expectLines: [2],
  },
  {
    name: 'doubly-parenthesized arrow IIFE is a violation',
    source: '((() => createPrismaPgAdapter()))();\n',
    expectLines: [1],
  },
  {
    name: 'function expression IIFE with parenthesized callee is a violation',
    source: '(function () {\n  return new PrismaClient();\n})();\n',
    expectLines: [2],
  },
  {
    name: 'function expression IIFE wrapped in outer parentheses is a violation',
    source: '(function () {\n  return getPrisma();\n}());\n',
    expectLines: [2],
  },
  {
    name: 'arrow IIFE default parameter initializer at top level is a violation',
    source: '((client = getPrisma()) => client)();\n',
    expectLines: [1],
  },
  {
    name: 'function IIFE default parameter initializer at top level is a violation',
    source: '(function (adapter = createPrismaPgAdapter()) {\n  return adapter;\n})();\n',
    expectLines: [1],
  },
  {
    name: 'destructured default parameter in IIFE is a violation',
    source: '(({ client = new PrismaClient() } = {}) => client)();\n',
    expectLines: [1],
  },
  {
    name: 'uncalled arrow inside IIFE default parameter is not a violation',
    source: '((factory = () => getPrisma()) => factory)();\n',
    expectLines: [],
  },
  {
    name: 'nested uncalled function inside top-level IIFE is not a violation',
    source: '(() => {\n  const lazy = () => new PrismaClient();\n  return lazy;\n})();\n',
    expectLines: [],
  },
  {
    name: 'IIFE inside an uncalled function is not a violation',
    source: 'function buildLater() {\n  return (() => getPrisma())();\n}\n',
    expectLines: [],
  },
  {
    name: 'static class field initializer is a violation',
    source: 'class Holder {\n  static client = getPrisma();\n}\n',
    expectLines: [2],
  },
  {
    name: 'export initializer is a violation',
    source: 'export const client = new PrismaClient();\n',
    expectLines: [1],
  },
  {
    name: 'top-level await is a violation',
    source: 'await getPrisma();\n',
    expectLines: [1],
  },
  {
    name: 'top-level await on async arrow IIFE is a violation',
    source: 'export {};\nawait (async () => {\n  return getPrisma();\n})();\n',
    expectLines: [3],
  },
  {
    name: 'boundary: deferred Promise.then callback is outside direct-call analysis',
    source: 'Promise.resolve().then(() => getPrisma());\n',
    expectLines: [],
  },
  {
    name: 'boundary: calling factory via alias is outside direct-call analysis',
    source: 'const makePrisma = getPrisma;\nmakePrisma();\n',
    expectLines: [],
  },
  {
    name: 'boundary: calling top-level arrow factory via identifier is outside direct-call analysis',
    source: 'const buildClient = () => new PrismaClient();\nbuildClient();\n',
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
