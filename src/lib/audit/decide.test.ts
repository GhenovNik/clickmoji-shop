import { describe, expect, it } from 'vitest';
import {
  BRACES_URL,
  EMPTY_PROD,
  GHSA_BRACES,
  GHSA_OTHER,
  NOW,
  OTHER_URL,
  advisory,
  allowlistJson,
  decide,
  entry,
  initialAllowlistJson,
  liveFull,
  liveFullWithAdvisorySeverity,
  liveProduction,
  node,
  reportJson,
  text,
} from './test-helpers';
import { readFileSync } from 'node:fs';
import { ALLOWLIST_FILE, readFixture } from './test-helpers';

function bracesChain(via: unknown[]): string {
  return reportJson({
    braces: node({ via }),
  });
}

describe('AC-1 live braces chain', () => {
  it('accepts the saved live full report with the repository allowlist and empty production report', () => {
    const repositoryAllowlist = readFileSync(ALLOWLIST_FILE, 'utf8');

    const decision = decide(liveFull(), liveProduction(), repositoryAllowlist);

    expect(decision.exitCode).toBe(0);
    expect(text(decision)).toContain(GHSA_BRACES);
    expect(text(decision)).toContain('braces');
    expect(text(decision)).toContain('2026-11-04');
  });

  it('agrees with the live report shape: six high nodes and one advisory object', () => {
    const parsed = JSON.parse(liveFull()) as {
      vulnerabilities: Record<string, { severity: string; via: unknown[] }>;
    };
    const entries = Object.entries(parsed.vulnerabilities);

    expect(entries).toHaveLength(6);
    expect(entries.every(([, value]) => value.severity === 'high')).toBe(true);
    expect(
      entries.flatMap(([, value]) => value.via).filter((item) => typeof item === 'object')
    ).toHaveLength(1);
  });
});

describe('AC-2 unresolved advisories', () => {
  it('(a) blocks another high advisory without an allowlist entry', () => {
    const decision = decide(
      reportJson({
        'other-pkg': node({
          name: 'other-pkg',
          via: [advisory({ name: 'other-pkg', url: OTHER_URL })],
        }),
      }),
      EMPTY_PROD,
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('no allowlist entry');
    expect(text(decision)).toContain(GHSA_OTHER);
    expect(text(decision)).toContain('other-pkg');
    expect(text(decision)).toContain('severity high');
  });

  it('(b) blocks a critical advisory without an allowlist entry', () => {
    const decision = decide(
      reportJson({
        'other-pkg': node({
          name: 'other-pkg',
          severity: 'critical',
          via: [advisory({ name: 'other-pkg', severity: 'critical', url: OTHER_URL })],
        }),
      }),
      EMPTY_PROD,
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('no allowlist entry');
    expect(text(decision)).toContain('severity critical');
  });

  it('(c) blocks a node that mixes the allowed advisory with a second unresolved high advisory', () => {
    const decision = decide(
      bracesChain([advisory(), advisory({ name: 'other-pkg', url: OTHER_URL })]),
      EMPTY_PROD,
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain(`allowed advisory ${GHSA_BRACES}`);
    expect(text(decision)).toContain('no allowlist entry');
    expect(text(decision)).toContain(GHSA_OTHER);
  });

  it('(d1) blocks an advisory whose url is not a GitHub advisory url', () => {
    const decision = decide(
      bracesChain([advisory({ url: `https://example.com/${GHSA_BRACES}` })]),
      EMPTY_PROD,
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('is not a GitHub Security Advisory URL');
  });

  it('(d2) blocks an advisory url that only contains the id as a substring', () => {
    const decision = decide(
      bracesChain([advisory({ url: `${BRACES_URL}/extra` })]),
      EMPTY_PROD,
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('is not a GitHub Security Advisory URL');
  });

  it('(d3) blocks an advisory without a url', () => {
    const { url, ...withoutUrl } = advisory();
    const decision = decide(bracesChain([withoutUrl]), EMPTY_PROD, initialAllowlistJson());

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('is not a GitHub Security Advisory URL');
    expect(text(decision)).toContain('url n/a');
  });

  it('(e) blocks an advisory whose package is not listed in the entry packages', () => {
    const decision = decide(
      bracesChain([advisory({ name: 'brace-expansion', dependency: 'brace-expansion' })]),
      EMPTY_PROD,
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('does not list package brace-expansion');
  });

  it('(f) blocks one GHSA reported for two source packages when only one is listed', () => {
    const decision = decide(
      bracesChain([
        advisory(),
        advisory({ name: 'brace-expansion', dependency: 'brace-expansion' }),
      ]),
      EMPTY_PROD,
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('does not list package brace-expansion');
    expect(text(decision)).toContain(GHSA_BRACES);
  });

  it('(g) blocks a critical advisory when the entry caps severity at high', () => {
    const decision = decide(
      bracesChain([advisory({ severity: 'critical' })]),
      EMPTY_PROD,
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('is above maxSeverity high');
  });
});

describe('Б-01 every advisory object is judged on its own', () => {
  const sameIdentity = { name: 'other-pkg', url: OTHER_URL, source: 1240992 };

  function twoObjects(first: string, second: string): string {
    return reportJson({
      'moderate-node': node({
        name: 'other-pkg',
        severity: first,
        via: [advisory({ ...sameIdentity, severity: first })],
      }),
      'critical-node': node({
        name: 'other-pkg',
        severity: second,
        via: [advisory({ ...sameIdentity, severity: second })],
      }),
    });
  }

  it('blocks a critical object that repeats a moderate object with the same url, name and source', () => {
    const decision = decide(twoObjects('moderate', 'critical'), EMPTY_PROD, initialAllowlistJson());

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('severity critical');
    expect(text(decision)).toContain(`no allowlist entry for ${GHSA_OTHER}`);
  });

  it('blocks a critical object that repeats an allowed object and exceeds maxSeverity', () => {
    const decision = decide(
      twoObjects('moderate', 'critical'),
      EMPTY_PROD,
      allowlistJson([entry({ id: GHSA_OTHER, packages: ['other-pkg'], maxSeverity: 'high' })])
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('severity critical');
    expect(text(decision)).toContain('is above maxSeverity high');
  });

  it('blocks a critical object that repeats a high object without any entry', () => {
    const decision = decide(twoObjects('high', 'critical'), EMPTY_PROD, allowlistJson([]));

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('severity critical');
    expect(text(decision)).toContain(`no allowlist entry for ${GHSA_OTHER}`);
  });

  it('still blocks when the critical object comes first and the moderate one repeats it', () => {
    const decision = decide(twoObjects('critical', 'moderate'), EMPTY_PROD, initialAllowlistJson());

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain(`no allowlist entry for ${GHSA_OTHER}`);
  });

  it('allows the high object of two objects that differ only in severity', () => {
    const decision = decide(
      reportJson({
        'other-pkg': node({
          name: 'other-pkg',
          severity: 'high',
          via: [
            advisory({ ...sameIdentity, severity: 'moderate' }),
            advisory({ ...sameIdentity, severity: 'high' }),
          ],
        }),
      }),
      EMPTY_PROD,
      allowlistJson([entry({ id: GHSA_OTHER, packages: ['other-pkg'] })])
    );

    expect(decision.exitCode).toBe(0);
    expect(text(decision)).toContain(`allowed advisory ${GHSA_OTHER}`);
  });

  it('reports the repeated live advisory object once instead of once per node', () => {
    const decision = decide(liveFull(), liveProduction(), initialAllowlistJson());

    const allowedLines = decision.lines.filter((line) =>
      line.includes(`allowed advisory ${GHSA_BRACES}`)
    );

    expect(decision.exitCode).toBe(0);
    expect(allowedLines).toHaveLength(1);
  });
});

describe('AC-3 via graph traversal and severity consistency', () => {
  it('(a) blocks a string via entry that references a missing node', () => {
    const decision = decide(bracesChain(['micromatch']), EMPTY_PROD, initialAllowlistJson());

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('references missing node micromatch');
  });

  it('(b) blocks a high node that reaches no advisory object at all', () => {
    const decision = decide(
      reportJson({
        first: node({ name: 'first', via: ['second'] }),
        second: node({ name: 'second', via: ['first'] }),
      }),
      EMPTY_PROD,
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('does not reach any advisory');
  });

  it('(c) blocks the live report when the single advisory is downgraded to moderate', () => {
    const decision = decide(
      liveFullWithAdvisorySeverity('moderate'),
      liveProduction(),
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain(
      'declared severity high is above the highest reachable advisory severity moderate'
    );
  });

  it('(d) blocks the live report when six nodes are critical while the allowed advisory is high', () => {
    const decision = decide(
      liveFullWithAdvisorySeverity('high', 'critical'),
      liveProduction(),
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain(
      'declared severity critical is above the highest reachable advisory severity high'
    );
  });

  it('terminates and accepts a via cycle that carries the allowed advisory', () => {
    const decision = decide(
      reportJson({
        braces: node({ via: [advisory(), 'micromatch'] }),
        micromatch: node({ name: 'micromatch', via: ['braces'] }),
      }),
      EMPTY_PROD,
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(0);
    expect(text(decision)).toContain(`allowed advisory ${GHSA_BRACES}`);
  });

  it('accepts a consistent low and moderate report', () => {
    const decision = decide(
      reportJson({
        'low-pkg': node({
          name: 'low-pkg',
          severity: 'low',
          via: [advisory({ name: 'low-pkg', severity: 'moderate', url: OTHER_URL })],
        }),
        'moderate-pkg': node({ name: 'moderate-pkg', severity: 'moderate', via: ['low-pkg'] }),
      }),
      EMPTY_PROD,
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(0);
  });

  it('accepts the saved real npm two-version graph once the high advisory is allowed', () => {
    const realGraph = readFixture('real-npm-graph.json');

    const decision = decide(
      realGraph,
      EMPTY_PROD,
      allowlistJson([
        entry({
          id: 'GHSA-3456-3456-3456',
          packages: ['audit-leaf'],
          expires: '2026-11-04',
        }),
      ])
    );

    expect(decision.exitCode).toBe(0);
    expect(text(decision)).toContain('allowed advisory GHSA-3456-3456-3456');
    expect(text(decision)).toContain('audit-leaf');
  });

  it('keeps the real two-version fixture honest: the parent is moderate and the leaf is high', () => {
    const graph = JSON.parse(readFixture('real-npm-graph.json')) as {
      vulnerabilities: Record<string, { severity: string }>;
    };

    expect(graph.vulnerabilities['audit-parent'].severity).toBe('moderate');
    expect(graph.vulnerabilities['audit-leaf'].severity).toBe('high');
  });
});

describe('AC-4 clean reports and unused exceptions', () => {
  it('accepts a report that only carries low and moderate findings', () => {
    const decision = decide(
      reportJson({
        'low-pkg': node({
          name: 'low-pkg',
          severity: 'low',
          via: [advisory({ name: 'low-pkg', severity: 'low', url: OTHER_URL })],
        }),
      }),
      EMPTY_PROD,
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(0);
    expect(text(decision)).toContain(`warning: allowlist entry ${GHSA_BRACES}`);
  });

  it('accepts an empty v2 vulnerabilities object and warns about the unused exception', () => {
    const decision = decide(reportJson({}), EMPTY_PROD, initialAllowlistJson());

    expect(decision.exitCode).toBe(0);
    expect(text(decision)).toContain(`warning: allowlist entry ${GHSA_BRACES}`);
    expect(text(decision)).toContain('AGE-951');
  });
});

describe('AC-6 production gate', () => {
  it('(a) blocks a high finding that only appears in the production report', () => {
    const decision = decide(
      reportJson({}),
      reportJson({ braces: node({ via: [advisory()] }) }),
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('production gate');
  });

  it('(b) blocks a second production high finding while the full report is only the allowed GHSA', () => {
    const decision = decide(
      bracesChain([advisory()]),
      reportJson({
        'prod-pkg': node({
          name: 'prod-pkg',
          via: [advisory({ name: 'prod-pkg', url: OTHER_URL })],
        }),
      }),
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('production gate');
    expect(text(decision)).toContain('prod-pkg');
  });

  it('(c) blocks the allowed GHSA when the production report also carries it', () => {
    const decision = decide(
      bracesChain([advisory()]),
      reportJson({ braces: node({ via: [advisory()] }) }),
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('production gate');
  });

  it('(c2) blocks a critical advisory object in the production report even when its node is moderate', () => {
    const decision = decide(
      reportJson({}),
      reportJson({
        'prod-pkg': node({
          name: 'prod-pkg',
          severity: 'moderate',
          via: [advisory({ name: 'prod-pkg', severity: 'critical', url: OTHER_URL })],
        }),
      }),
      initialAllowlistJson(),
      NOW
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('production gate');
    expect(text(decision)).toContain('prod-pkg');
  });

  it('(c3) blocks a production node whose own severity is high even when its advisory is moderate', () => {
    const decision = decide(
      reportJson({}),
      reportJson({
        'prod-pkg': node({
          name: 'prod-pkg',
          severity: 'high',
          via: [advisory({ name: 'prod-pkg', severity: 'moderate', url: OTHER_URL })],
        }),
      }),
      initialAllowlistJson()
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain(
      'package prod-pkg (severity high, source n/a, url n/a) - production gate'
    );
  });
});

describe('AC-5 allowlist expiry inside the pure decision', () => {
  const cleanReport = reportJson({
    'low-pkg': node({
      name: 'low-pkg',
      severity: 'low',
      via: [advisory({ name: 'low-pkg', severity: 'low' })],
    }),
  });

  it('keeps an exception whose expires day is still running in UTC', () => {
    const decision = decide(
      cleanReport,
      EMPTY_PROD,
      initialAllowlistJson({ expires: '2026-10-04' }),
      '2026-10-04T23:59:59.999Z'
    );

    expect(decision.exitCode).toBe(0);
  });

  it('rejects an exception from the first millisecond of the next UTC day', () => {
    const decision = decide(
      cleanReport,
      EMPTY_PROD,
      initialAllowlistJson({ expires: '2026-10-04' }),
      '2026-10-05T00:00:00.000Z'
    );

    expect(decision.exitCode).toBe(1);
    expect(text(decision)).toContain('exceptions[0].expires 2026-10-04 is in the past');
  });
});
