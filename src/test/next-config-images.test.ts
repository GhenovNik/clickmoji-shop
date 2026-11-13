// @vitest-environment node
import { describe, expect, it } from 'vitest';

import nextConfig from '../../next.config';

describe('next.config images', () => {
  it('sets minimumCacheTTL to 2592000 (30 days)', () => {
    expect(nextConfig.images?.minimumCacheTTL).toBe(2592000);
  });

  it('keeps the base remotePatterns hosts', () => {
    const hostnames = nextConfig.images?.remotePatterns?.map((pattern) => pattern.hostname);
    expect(hostnames).toEqual(['utfs.io', '3kv5vvupx6.ufs.sh']);
  });
});
