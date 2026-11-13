import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findCredentialViolations } from './db-transfer-tree-scan';

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', 'scripts', 'src'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').filter((line) => line.length > 0);
}

function credentialViolations(): string[] {
  const violations: string[] = [];
  for (const file of trackedFiles()) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      violations.push(`${file}:0`);
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const count = findCredentialViolations(lines[i]).length;
      for (let j = 0; j < count; j += 1) {
        violations.push(`${file}:${i + 1}`);
      }
    }
  }
  return violations;
}

describe('tracked tree: connection strings', () => {
  it('AC-1: no credentialed non-localhost connection strings in tracked scripts/ and src/', () => {
    const violations = credentialViolations();
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('AC-2: scripts/db-transfer.ts contains no "://"', () => {
    let text: string;
    try {
      text = readFileSync('scripts/db-transfer.ts', 'utf8');
    } catch {
      expect.unreachable('scripts/db-transfer.ts must be readable');
    }
    const hits = (text as string)
      .split('\n')
      .map((line, i) => (line.includes('://') ? `scripts/db-transfer.ts:${i + 1}` : null))
      .filter((hit): hit is string => hit !== null);
    expect(hits, hits.join('\n')).toEqual([]);
  });
});
