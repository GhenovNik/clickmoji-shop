declare module '*.webp' {
  import type { StaticImageData } from 'next/image';
  const src: StaticImageData;
  export default src;
}
