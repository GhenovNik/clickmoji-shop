export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const CREDENTIALED_URL = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@(\[[0-9a-f:.]+\]|[^/\s:'"@]+)/gi;

export function findCredentialHosts(line: string): string[] {
  const pattern = new RegExp(CREDENTIALED_URL.source, CREDENTIALED_URL.flags);
  const hosts: string[] = [];
  for (const match of line.matchAll(pattern)) {
    hosts.push(match[1].toLowerCase());
  }
  return hosts;
}

export function findCredentialViolations(line: string): string[] {
  return findCredentialHosts(line).filter((host) => !LOCAL_HOSTS.has(host));
}
