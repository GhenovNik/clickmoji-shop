import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

const FALLBACK_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/postgres?schema=public';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL?.trim() ? env('DATABASE_URL') : FALLBACK_DATABASE_URL,
  },
});
