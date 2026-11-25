import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MODAL_FOOTER_ADMIN,
  MODAL_FOOTER_DB,
  MODAL_FOOTER_DB_ENV,
  modalFooterDatabaseUrl,
} from './modal-footer-db-config';

// Migrates and seeds ONLY the validated loopback fixture database. Without the variable
// this is a no-op, so local runs without PostgreSQL still execute the non-admin scenarios.
export default async function modalFooterGlobalSetup() {
  const url = modalFooterDatabaseUrl(process.env[MODAL_FOOTER_DB_ENV]);
  if (!url) {
    return;
  }

  const prismaCli = fileURLToPath(
    new URL('../../../node_modules/prisma/build/index.js', import.meta.url)
  );
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });

  const { PrismaClient } = await import('@prisma/client');
  const { createPrismaPgAdapter } = await import('../../../src/lib/prisma-adapter');
  const db = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
  try {
    // Defence in depth: confirm the live connection really is the fixture database.
    const [{ name }] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (name !== MODAL_FOOTER_DB.database) {
      throw new Error(`Connected to unexpected database "${name}"; refusing to seed`);
    }

    await db.user.upsert({
      where: { id: MODAL_FOOTER_ADMIN.id },
      create: {
        id: MODAL_FOOTER_ADMIN.id,
        email: MODAL_FOOTER_ADMIN.email,
        name: MODAL_FOOTER_ADMIN.name,
        role: 'ADMIN',
        createdAt: new Date(MODAL_FOOTER_ADMIN.createdAt),
      },
      update: { role: 'ADMIN' },
    });
  } finally {
    await db.$disconnect();
  }
}
