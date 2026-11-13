export interface TransferUrls {
  source: string;
  target: string;
}

export function readTransferUrls(
  env: Record<string, string | undefined> = process.env
): TransferUrls {
  const source = env.DB_TRANSFER_SOURCE_URL?.trim() ?? '';
  const target = env.DB_TRANSFER_TARGET_URL?.trim() ?? '';
  const missing: string[] = [];
  if (!source) {
    missing.push('DB_TRANSFER_SOURCE_URL');
  }
  if (!target) {
    missing.push('DB_TRANSFER_TARGET_URL');
  }
  if (missing.length > 0) {
    throw new Error(
      `Cannot run migrate-data: missing or empty environment variable(s): ${missing.join(
        ', '
      )}. Set DB_TRANSFER_SOURCE_URL (source database) and DB_TRANSFER_TARGET_URL (target database).`
    );
  }
  return { source, target };
}
