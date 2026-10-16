// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createNpmAuditRunner } from './npm-runner';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

afterEach(() => vi.resetAllMocks());

it('decodes a multibyte symbol split across deterministic stderr chunks', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const pending = createNpmAuditRunner()([], { ...process.env }, 10_000);
  const symbol = Buffer.from('☃😀');
  // PassThrough delivers each write synchronously: the decoder must see incomplete symbols.
  child.stderr.write(symbol.subarray(0, 2));
  child.stderr.write(symbol.subarray(2, 5));
  child.stderr.write(symbol.subarray(5));
  child.emit('close', 2, null);

  const result = await pending;
  expect(spawn).toHaveBeenCalledOnce();
  expect(result.status).toBe(2);
  expect(result.stderr).toBe('☃😀');
  expect(result.stderr).not.toContain('\ufffd');
  expect(result.stderr.isWellFormed()).toBe(true);
});
