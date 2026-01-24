import { PrismaClient } from '@prisma/client';
import { UTApi } from 'uploadthing/server';

const prisma = new PrismaClient();
const utapi = new UTApi();

// Проверяем режим dry-run
const isDryRun = process.argv.includes('--dry-run');

async function main() {
  if (isDryRun) {
    console.log('🔍 Running in DRY-RUN mode (no files will be deleted)\n');
  } else {
    console.log('🧹 Starting cleanup of unused images...\n');
  }

  try {
    // 1. Получаем все используемые imageUrl из базы данных
    console.log('📊 Fetching used images from database...');

    const categories = await prisma.category.findMany({
      where: {
        isCustom: true,
        imageUrl: { not: null },
      },
      select: { imageUrl: true },
    });

    const products = await prisma.product.findMany({
      where: {
        isCustom: true,
        imageUrl: { not: null },
      },
      select: { imageUrl: true },
    });

    // Собираем все используемые URL
    const usedUrls = new Set<string>();
    categories.forEach((cat) => {
      if (cat.imageUrl) usedUrls.add(cat.imageUrl);
    });
    products.forEach((prod) => {
      if (prod.imageUrl) usedUrls.add(prod.imageUrl);
    });

    console.log(`✅ Found ${usedUrls.size} images in use`);
    console.log(`   - Categories: ${categories.length}`);
    console.log(`   - Products: ${products.length}\n`);

    // 2. Извлекаем fileKeys из URL
    const usedFileKeys = new Set<string>();
    usedUrls.forEach((url) => {
      // Format: https://utfs.io/f/{fileKey}
      const fileKey = url.split('/f/')[1];
      if (fileKey) {
        usedFileKeys.add(fileKey);
      }
    });

    console.log(`🔑 Extracted ${usedFileKeys.size} file keys from URLs\n`);

    // 3. Получаем все файлы из UploadThing
    console.log('☁️  Fetching files from UploadThing...');

    const uploadThingFiles = await utapi.listFiles();

    if (!uploadThingFiles.files || uploadThingFiles.files.length === 0) {
      console.log('ℹ️  No files found in UploadThing storage');
      return;
    }

    console.log(`✅ Found ${uploadThingFiles.files.length} files in UploadThing\n`);

    // 4. Находим неиспользуемые файлы
    const unusedFiles = uploadThingFiles.files.filter((file) => !usedFileKeys.has(file.key));

    if (unusedFiles.length === 0) {
      console.log('✨ No unused files found. Storage is clean!');
      return;
    }

    console.log(`🗑️  Found ${unusedFiles.length} unused files:\n`);

    // Показываем список неиспользуемых файлов
    unusedFiles.forEach((file, index) => {
      const uploadDate = new Date(file.uploadedAt).toLocaleDateString('ru-RU');
      const sizeKB = (file.size / 1024).toFixed(2);
      console.log(`   ${index + 1}. ${file.name}`);
      console.log(`      Key: ${file.key}`);
      console.log(`      Size: ${sizeKB} KB`);
      console.log(`      Uploaded: ${uploadDate}\n`);
    });

    // Подсчитываем общий размер
    const totalSize = unusedFiles.reduce((sum, file) => sum + file.size, 0);
    const totalSizeMB = (totalSize / 1024 / 1024).toFixed(2);
    console.log(`📦 Total size to free: ${totalSizeMB} MB\n`);

    // 5. Удаляем неиспользуемые файлы (или показываем что будет удалено)
    if (isDryRun) {
      console.log('ℹ️  DRY-RUN: Files that WOULD be deleted:\n');
      console.log(`   - Would delete: ${unusedFiles.length} files`);
      console.log(`   - Would free: ${totalSizeMB} MB`);
      console.log(`   - Remaining in use: ${usedFileKeys.size} files\n`);
      console.log('💡 Run without --dry-run to actually delete these files');
      console.log('   Command: npm run cleanup-images');
    } else {
      console.log('🗑️  Deleting unused files...\n');

      const fileKeysToDelete = unusedFiles.map((file) => file.key);

      // Удаляем пакетами для надежности
      const BATCH_SIZE = 10;
      let deletedCount = 0;

      for (let i = 0; i < fileKeysToDelete.length; i += BATCH_SIZE) {
        const batch = fileKeysToDelete.slice(i, i + BATCH_SIZE);

        try {
          await utapi.deleteFiles(batch);
          deletedCount += batch.length;
          console.log(`   Deleted ${deletedCount}/${fileKeysToDelete.length} files...`);
        } catch (error) {
          console.error(`   ❌ Error deleting batch ${i / BATCH_SIZE + 1}:`, error);
        }
      }

      console.log(`\n✅ Cleanup completed!`);
      console.log(`   - Deleted: ${deletedCount} files`);
      console.log(`   - Freed: ${totalSizeMB} MB`);
      console.log(`   - Remaining in use: ${usedFileKeys.size} files`);
    }
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    throw error;
  }
}

main()
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
