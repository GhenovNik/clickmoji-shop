import { PrismaPg } from '@prisma/adapter-pg';

export function createPrismaPgAdapter(connectionString?: string) {
  const url = connectionString || process.env.DATABASE_URL;

  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }

  return new PrismaPg({ connectionString: url });
}
