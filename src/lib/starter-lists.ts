import type { getServerTranslator } from '@/lib/auth-security';

type Translator = ReturnType<typeof getServerTranslator>;

// Starter shopping lists for a brand-new account, built from the existing
// api.lists.defaultNames.* keys in the language of the request.
export const STARTER_LISTS = [
  { key: 'main', isActive: true },
  { key: 'weekend', isActive: false },
  { key: 'holidays', isActive: false },
  { key: 'party', isActive: false },
  { key: 'urgent', isActive: false },
] as const;

export function starterListData(t: Translator, userId: string) {
  return STARTER_LISTS.map(({ key, isActive }) => ({
    name: t(`api.lists.defaultNames.${key}`),
    isActive,
    userId,
  }));
}
