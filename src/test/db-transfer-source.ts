import { readFileSync } from 'node:fs';

export function readDbTransferSource(): string {
  return readFileSync('scripts/db-transfer.ts', 'utf8');
}

export function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`signature not found: ${signature}`);
  }
  const end = source.indexOf('\n}', start);
  if (end === -1) {
    throw new Error(`closing brace not found for: ${signature}`);
  }
  return source.slice(start, end);
}
