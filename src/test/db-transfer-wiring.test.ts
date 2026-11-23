import { describe, expect, it } from 'vitest';
import { functionBody, readDbTransferSource } from './db-transfer-source';

const text = readDbTransferSource();

describe('migrateData wiring (AC-9)', () => {
  it('AC-9: urls.source goes to the source-read client, urls.target to the write client', () => {
    const body = functionBody(text, 'async function migrateData');
    const clientPattern =
      /const (\w+) = new PrismaClient\(\{\s*adapter: createPrismaPgAdapter\((urls\.\w+)\)/g;
    const bindings = [...body.matchAll(clientPattern)].map((match) => ({
      variable: match[1],
      url: match[2],
    }));
    expect(bindings, 'migrateData must create exactly two clients from urls.*').toHaveLength(2);

    const sourceBinding = bindings.find((binding) => binding.url === 'urls.source');
    const targetBinding = bindings.find((binding) => binding.url === 'urls.target');
    expect(sourceBinding, 'a client must be created with urls.source').toBeDefined();
    expect(targetBinding, 'a client must be created with urls.target').toBeDefined();

    const sourceVar = sourceBinding!.variable;
    const targetVar = targetBinding!.variable;
    expect(sourceVar).not.toBe(targetVar);

    expect(body, `${sourceVar} (urls.source) must be the client read from during fetch`).toContain(
      `${sourceVar}.category.findMany`
    );
    expect(body, `${targetVar} (urls.target) must be the client cleaned before writing`).toContain(
      `${targetVar}.product.deleteMany`
    );
    expect(body, `${targetVar} (urls.target) must be the client written into`).toContain(
      `${targetVar}.category.create`
    );
    expect(
      body.includes(`${sourceVar}.product.deleteMany`),
      `${sourceVar} (urls.source) must not be the client cleaned before writing`
    ).toBe(false);
  });
});
