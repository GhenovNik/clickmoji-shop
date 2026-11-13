'use client';

import { useState } from 'react';
import Image from 'next/image';

interface ProductCardImageProps {
  imageUrl: string;
  alt: string;
  emoji: string;
}

// Owns the load lifecycle of exactly one picture address. ProductCard keys this component by
// the address, so a new address remounts it and a late load/error from the previous address
// can only reach a detached element.
export default function ProductCardImage({ imageUrl, alt, emoji }: ProductCardImageProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <span className="text-4xl md:text-6xl leading-none">{emoji}</span>;
  }

  return (
    <>
      {!loaded && (
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center text-4xl md:text-6xl leading-none"
        >
          {emoji}
        </span>
      )}
      <Image
        src={imageUrl}
        alt={alt}
        width={80}
        height={80}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={`h-14 w-14 md:h-20 md:w-20 object-contain ${loaded ? '' : 'opacity-0'}`}
      />
    </>
  );
}
