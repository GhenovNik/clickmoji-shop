'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import Modal, { ModalBody, openModalFromTrigger } from '@/components/ui/Modal';
import { cn } from '@/lib/utils';

// Shared "open this preview full-size" control. The Modal supplies the dialog
// semantics: Esc, backdrop click, the close button and focus back to this button.
export default function ImagePreviewButton({
  src,
  alt,
  className,
  imgClassName,
  imageWidth = 64,
  imageHeight = 64,
}: {
  src: string;
  alt: string;
  className?: string;
  imgClassName?: string;
  imageWidth?: number;
  imageHeight?: number;
}) {
  const t = useTranslations('admin');
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label={`${t('shared.openImageLarge')}: ${alt}`}
        onClick={openModalFromTrigger(() => setOpen(true))}
        className={cn(
          'inline-block rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500',
          className
        )}
      >
        <Image
          src={src}
          alt={alt}
          width={imageWidth}
          height={imageHeight}
          className={cn('object-contain', imgClassName)}
          unoptimized
        />
      </button>
      {open && (
        <Modal
          label={t('shared.largeImageTitle')}
          onClose={() => setOpen(false)}
          className="max-w-3xl"
        >
          <ModalBody className="flex flex-col items-center gap-4">
            <Image
              src={src}
              alt={alt}
              width={1024}
              height={1024}
              className="h-auto w-auto max-w-full max-h-[70vh] object-contain"
              style={{ width: 'auto', height: 'auto' }}
              unoptimized
            />
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-semibold transition-colors"
            >
              {t('shared.close')}
            </button>
          </ModalBody>
        </Modal>
      )}
    </>
  );
}
