import { describe, expect, it } from 'vitest';
import { functionBody, readDbTransferSource } from './db-transfer-source';
import { findTopLevelClientConstructionLines } from './db-transfer-top-level';

const text = readDbTransferSource();

describe('db-transfer shared client lifecycle (AC-7)', () => {
  it('AC-7: no client construction at module top level', () => {
    const offenders = findTopLevelClientConstructionLines(text).map(
      (line) => `scripts/db-transfer.ts:${line}`
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('AC-7: migrateData calls readTransferUrls before any client creation', () => {
    const body = functionBody(text, 'async function migrateData');
    const urlsIndex = body.indexOf('readTransferUrls');
    const clientIndices = ['new PrismaClient', 'createPrismaPgAdapter(']
      .map((needle) => body.indexOf(needle))
      .filter((index) => index !== -1);
    expect(urlsIndex, 'readTransferUrls must be present in migrateData').toBeGreaterThanOrEqual(0);
    expect(clientIndices.length, 'migrateData must create at least one client').toBeGreaterThan(0);
    expect(urlsIndex).toBeLessThan(Math.min(...clientIndices));
  });

  it('AC-7: shared client is created lazily inside getPrisma and used by export/import paths', () => {
    expect(text).toContain('function getPrisma');
    const getPrismaBody = functionBody(text, 'function getPrisma');
    expect(getPrismaBody).toContain('new PrismaClient');

    const exportBody = functionBody(text, 'async function exportNeon');
    const importBody = functionBody(text, 'async function importToLocal');
    expect(exportBody).toContain('getPrisma(');
    expect(importBody).toContain('getPrisma(');
    expect(exportBody).not.toContain('new PrismaClient');
    expect(importBody).not.toContain('new PrismaClient');
  });

  it('AC-7: main() finally disconnects the shared client only if it was created', () => {
    const finallyIndex = text.indexOf('.finally(');
    expect(finallyIndex, '.finally( not found').toBeGreaterThanOrEqual(0);
    const finallyBlock = text.slice(finallyIndex);
    const ifIndex = finallyBlock.indexOf('if (');
    const disconnectIndex = finallyBlock.indexOf('$disconnect(');
    expect(disconnectIndex, '$disconnect( not found in finally').toBeGreaterThanOrEqual(0);
    expect(
      ifIndex,
      'shared client disconnect must be guarded by a condition'
    ).toBeGreaterThanOrEqual(0);
    expect(ifIndex, 'guard must precede the disconnect call').toBeLessThan(disconnectIndex);
  });
});
