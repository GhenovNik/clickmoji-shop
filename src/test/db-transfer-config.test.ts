import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface TransferUrls {
  source: string;
  target: string;
}

interface TransferConfigModule {
  readTransferUrls: (env: Record<string, string | undefined>) => TransferUrls;
}

const MODULE_SPEC = '../../scripts/db-transfer-config';

async function loadConfig(): Promise<TransferConfigModule> {
  expect(
    existsSync(join(process.cwd(), 'scripts', 'db-transfer-config.ts')),
    'scripts/db-transfer-config.ts must exist'
  ).toBe(true);
  const mod = (await import(MODULE_SPEC)) as TransferConfigModule;
  expect(typeof mod.readTransferUrls, 'readTransferUrls must be exported').toBe('function');
  return mod;
}

describe('readTransferUrls', () => {
  it('AC-3: returns source and target from the given env', async () => {
    const { readTransferUrls } = await loadConfig();
    expect(
      readTransferUrls({
        DB_TRANSFER_SOURCE_URL: 'source-value',
        DB_TRANSFER_TARGET_URL: 'target-value',
      })
    ).toEqual({ source: 'source-value', target: 'target-value' });
  });

  it('AC-4: missing source names DB_TRANSFER_SOURCE_URL and hides the target value', async () => {
    const { readTransferUrls } = await loadConfig();
    const secretTarget = 'target-secret-value-12345';
    let error: Error | undefined;
    try {
      readTransferUrls({ DB_TRANSFER_TARGET_URL: secretTarget });
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'expected an error').toBeDefined();
    expect(error!.message).toContain('DB_TRANSFER_SOURCE_URL');
    expect(error!.message).not.toContain(secretTarget);
  });

  it('AC-4: missing target names DB_TRANSFER_TARGET_URL and hides the source value', async () => {
    const { readTransferUrls } = await loadConfig();
    const secretSource = 'source-secret-value-67890';
    let error: Error | undefined;
    try {
      readTransferUrls({ DB_TRANSFER_SOURCE_URL: secretSource });
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'expected an error').toBeDefined();
    expect(error!.message).toContain('DB_TRANSFER_TARGET_URL');
    expect(error!.message).not.toContain(secretSource);
  });

  it('AC-4: empty string is rejected and names the variable', async () => {
    const { readTransferUrls } = await loadConfig();
    expect(() =>
      readTransferUrls({
        DB_TRANSFER_SOURCE_URL: '',
        DB_TRANSFER_TARGET_URL: 'target-value',
      })
    ).toThrowError(/DB_TRANSFER_SOURCE_URL/);
  });

  it('AC-4: whitespace-only value is rejected and names the variable', async () => {
    const { readTransferUrls } = await loadConfig();
    expect(() =>
      readTransferUrls({
        DB_TRANSFER_SOURCE_URL: 'source-value',
        DB_TRANSFER_TARGET_URL: '   ',
      })
    ).toThrowError(/DB_TRANSFER_TARGET_URL/);
  });

  it('AC-4: both missing names both variables', async () => {
    const { readTransferUrls } = await loadConfig();
    let error: Error | undefined;
    try {
      readTransferUrls({});
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'expected an error').toBeDefined();
    expect(error!.message).toContain('DB_TRANSFER_SOURCE_URL');
    expect(error!.message).toContain('DB_TRANSFER_TARGET_URL');
  });
});
