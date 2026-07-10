import type { MetadataRoute } from 'next';

const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://clickmoji-shop.vercel.app';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/categories'],
      disallow: ['/admin', '/api', '/lists', '/history', '/categories/favorites'],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
