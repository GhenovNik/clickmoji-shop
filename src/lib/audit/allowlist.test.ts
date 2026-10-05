import { describe, expect, it } from 'vitest';
import { runAuditCheck } from './run';
import type { Decision } from './decide';
import {
  GHSA_BRACES,
  allowlistJson,
  entry,
  fixturesRunner,
  forbiddenRunner,
  initialAllowlistJson,
  liveFull,
  liveProduction,
  text,
} from './test-helpers';

const NOW = '2026-10-04T12:00:00.000Z';

async function check(raw: string | null): Promise<Decision> {
  return runAuditCheck({
    runner: forbiddenRunner(),
    readAllowlistFile: () => raw,
    findProjectNpmrc: () => null,
    now: new Date(NOW),
  });
}

async function expectRejected(raw: string | null, expected: string): Promise<void> {
  const decision = await check(raw);

  expect(decision.exitCode).toBe(1);
  expect(text(decision)).toContain('error [schema]');
  expect(text(decision)).toContain('audit-allowlist.json');
  expect(text(decision)).toContain(expected);
}

describe('AC-7 allowlist file schema', () => {
  it('rejects a missing file', async () => {
    await expectRejected(null, 'file is missing');
  });

  it('rejects a file that is not JSON', async () => {
    await expectRejected('{ not json', 'file is not valid JSON');
  });

  it('rejects a root array', async () => {
    await expectRejected('[]', 'root must be a JSON object');
  });

  it('rejects a root scalar', async () => {
    await expectRejected('7', 'root must be a JSON object');
  });

  it('rejects an unknown root field', async () => {
    await expectRejected(allowlistJson([], { surprise: true }), 'unknown field "surprise"');
  });

  it('rejects a version other than 1', async () => {
    await expectRejected(allowlistJson([], { version: 2 }), 'version must be 1');
  });

  it.each([[null], [7], ['entries']])(
    'rejects exceptions that are not an array: %s',
    async (value) => {
      await expectRejected(allowlistJson(value), 'exceptions must be an array');
    }
  );

  it.each(['id', 'packages', 'reason', 'scope', 'maxSeverity', 'expires', 'issue'])(
    'rejects an entry without %s',
    async (field) => {
      const incomplete = entry();
      delete incomplete[field];

      await expectRejected(allowlistJson([incomplete]), `exceptions[0].${field} is required`);
    }
  );

  it('rejects an unknown field inside an entry', async () => {
    await expectRejected(
      allowlistJson([entry({ surprise: 1 })]),
      'exceptions[0].surprise: unknown field'
    );
  });

  it.each([
    ['not-a-ghsa', 'must match ^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$'],
    ['GHSA-vfj7-8cjw', 'must match ^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$'],
    ['GHSA-VFJ7-8CJW-P6XM', 'must match ^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$'],
    ['ghsa-vfj7-8cjw-p6xm', 'must match ^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$'],
    ['GHSA-zzzz-1111-2222', 'must match ^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$'],
  ])('rejects the id %s', async (id, expected) => {
    await expectRejected(allowlistJson([entry({ id })]), expected);
  });

  it('rejects a duplicate id', async () => {
    await expectRejected(
      allowlistJson([entry(), entry({ packages: ['brace-expansion'] })]),
      'exceptions[1].id: duplicate id'
    );
  });

  it('rejects an empty packages array', async () => {
    await expectRejected(
      allowlistJson([entry({ packages: [] })]),
      'packages must be a non-empty array'
    );
  });

  it('rejects duplicated packages', async () => {
    await expectRejected(
      allowlistJson([entry({ packages: ['braces', 'braces'] })]),
      'packages must not contain duplicates'
    );
  });

  it.each([[null], [7], ['braces']])(
    'rejects packages that are not an array: %s',
    async (value) => {
      await expectRejected(
        allowlistJson([entry({ packages: value })]),
        'packages must be a non-empty array'
      );
    }
  );

  it.each([
    [['', 'braces'], 'packages[0] must be a non-empty string'],
    [['braces', ''], 'packages[1] must be a non-empty string'],
    [['braces', 7], 'packages[1] must be a non-empty string'],
    [['braces', null], 'packages[1] must be a non-empty string'],
  ])('rejects a broken package name in %s', async (packages, expected) => {
    await expectRejected(allowlistJson([entry({ packages })]), expected);
  });

  it.each([
    ['id', null],
    ['id', 7],
    ['id', ''],
    ['reason', null],
    ['reason', 7],
    ['reason', ''],
    ['issue', null],
    ['issue', 7],
    ['issue', ''],
  ])('rejects %s set to %s', async (field, value) => {
    await expectRejected(
      allowlistJson([entry({ [field]: value })]),
      `exceptions[0].${field} must be a non-empty string`
    );
  });

  it('rejects a scope other than dev', async () => {
    await expectRejected(allowlistJson([entry({ scope: 'prod' })]), 'scope must be "dev"');
  });

  it.each([['moderate'], ['info'], ['HIGH'], [null], [7]])(
    'rejects maxSeverity %s',
    async (maxSeverity) => {
      await expectRejected(
        allowlistJson([entry({ maxSeverity })]),
        'maxSeverity must be "high" or "critical"'
      );
    }
  );

  it.each([
    ['2026-02-30'],
    ['2026-13-01'],
    ['2026-1-1'],
    ['tomorrow'],
    ['2026-11-04T00:00:00Z'],
    [''],
  ])('rejects the impossible date %s', async (expires) => {
    await expectRejected(
      allowlistJson([entry({ expires })]),
      'must be an existing calendar date (YYYY-MM-DD)'
    );
  });

  it.each([['TASK-1'], ['AGE-'], ['AGE-abc'], ['age-951'], ['AGE-951 ']])(
    'rejects the issue %s',
    async (issue) => {
      await expectRejected(allowlistJson([entry({ issue })]), 'issue must match ^AGE-[0-9]+$');
    }
  );

  it('accepts a valid initial allowlist and only then calls npm', async () => {
    const { runner, calls } = fixturesRunner(liveFull(), liveProduction());

    const decision = await runAuditCheck({
      runner,
      readAllowlistFile: () => initialAllowlistJson(),
      findProjectNpmrc: () => null,
      now: new Date(NOW),
    });

    expect(decision.exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(text(decision)).toContain(GHSA_BRACES);
  });

  it('accepts a valid file whose packages are a list of several names', async () => {
    const { runner } = fixturesRunner(liveFull(), liveProduction());

    const decision = await runAuditCheck({
      runner,
      readAllowlistFile: () => allowlistJson([entry({ packages: ['braces', 'brace-expansion'] })]),
      findProjectNpmrc: () => null,
      now: new Date(NOW),
    });

    expect(decision.exitCode).toBe(0);
  });
});
