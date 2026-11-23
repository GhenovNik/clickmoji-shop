import { describe, expect, it } from 'vitest';
import { findCredentialViolations } from './db-transfer-tree-scan';

const REMOTE_BASE = 'postgresql://u:p@' + 'db.example.com/x';
const REMOTE_BARE = 'postgres://u:p@' + 'db.example.com';

const SYNTHETIC_CASES: ReadonlyArray<{
  name: string;
  line: string;
  expectViolation: boolean;
}> = [
  {
    name: 'remote host in single quotes',
    line: `'${REMOTE_BASE}'`,
    expectViolation: true,
  },
  {
    name: 'remote host in double quotes',
    line: `"${REMOTE_BASE}"`,
    expectViolation: true,
  },
  {
    name: 'remote host in backticks',
    line: `\`${REMOTE_BASE}\``,
    expectViolation: true,
  },
  {
    name: 'remote host without path',
    line: REMOTE_BARE,
    expectViolation: true,
  },
  {
    name: 'localhost is allowed',
    line: 'postgresql://u:p@localhost',
    expectViolation: false,
  },
  {
    name: 'localhost in backticks with closing backtick right after host',
    line: '`postgresql://u:p@localhost`',
    expectViolation: false,
  },
  {
    name: 'localhost with port and path is allowed',
    line: 'postgresql://u:p@127.0.0.1:5432/db',
    expectViolation: false,
  },
  {
    name: 'localhost with query string is allowed',
    line: 'postgresql://u:p@localhost?schema=public',
    expectViolation: false,
  },
  {
    name: 'localhost with fragment is allowed',
    line: 'postgresql://u:p@localhost#frag',
    expectViolation: false,
  },
];

describe('tree scanner self-checks (AC-8)', () => {
  for (const { name, line, expectViolation } of SYNTHETIC_CASES) {
    it(`${name}`, () => {
      const violations = findCredentialViolations(line);
      expect(violations.length > 0, violations.join(',')).toBe(expectViolation);
    });
  }
});
