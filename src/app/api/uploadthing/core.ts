import { createUploadthing, type FileRouter } from "uploadthing/next";
import { auth } from "@/lib/auth";

const f = createUploadthing();

export const ourFileRouter = {
  // Загрузка кастомных emoji для продуктов
  productImage: f({ image: { maxFileSize: "2MB", maxFileCount: 1 } })
    .middleware(async () => {
      const session = await auth();

      if (!session || session.user.role !== "ADMIN") {
        throw new Error("Unauthorized: Admin access required");
      }

      return { userId: session.user.id };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      console.log("✅ Upload complete for userId:", metadata.userId);
      console.log("file url", file.url);
      return { url: file.url };
    }),

  // Загрузка аватаров пользователей
  userAvatar: f({ image: { maxFileSize: "1MB", maxFileCount: 1 } })
    .middleware(async () => {
      const session = await auth();

      if (!session) {
        throw new Error("Unauthorized");
      }

      return { userId: session.user.id };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      console.log("Avatar upload complete for userId:", metadata.userId);
      console.log("file url", file.url);

      return { url: file.url };
    }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;
