import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api-messages';
import { requireAdmin } from '@/lib/auth-guards';
import { UTApi } from 'uploadthing/server';
import { isStoredImageInUse } from '@/lib/services/emoji-library';

const utapi = new UTApi();

// An explicit admin delete, refused while anything shows the file. The check and the delete are
// not atomic: a request attaching the same URL in between can still race it (Linear AGE-1472).

export async function DELETE(request: Request) {
  try {
    const guard = await requireAdmin();
    if (guard instanceof Response) return guard;

    const { imageUrl } = await request.json();

    if (!imageUrl) {
      return NextResponse.json(
        { error: await apiText(request, 'imageUrlRequired') },
        { status: 400 }
      );
    }

    if (await isStoredImageInUse(imageUrl)) {
      return NextResponse.json({ error: await apiText(request, 'imageInUse') }, { status: 409 });
    }

    // Extract file key from UploadThing URL
    // Format: https://utfs.io/f/{fileKey}
    const fileKey = imageUrl.split('/f/')[1];

    if (!fileKey) {
      console.warn('Could not extract file key from URL:', imageUrl);
      return NextResponse.json(
        { error: await apiText(request, 'invalidImageUrl') },
        { status: 400 }
      );
    }

    await utapi.deleteFiles(fileKey);

    return NextResponse.json({ message: await apiText(request, 'imageDeleted') });
  } catch (error) {
    console.error('Error deleting emoji:', error);
    return NextResponse.json(
      { error: await apiText(request, 'deleteImageFailed') },
      { status: 500 }
    );
  }
}
