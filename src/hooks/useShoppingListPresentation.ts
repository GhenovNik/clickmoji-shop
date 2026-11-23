'use client';

import { useEffect, useState } from 'react';

export type ShoppingView = 'list' | 'grid';
type Preferences = { view: ShoppingView; collapsed: string[] };
const storageKey = 'clickmoji:shopping-presentation:v1';
const defaults: Preferences = { view: 'list', collapsed: [] };

// Device-local presentation only: never write shopping data to browser storage.
export function useShoppingListPresentation() {
  const [preferences, setPreferences] = useState<Preferences>(defaults);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (
        saved &&
        typeof saved === 'object' &&
        'view' in saved &&
        (saved.view === 'list' || saved.view === 'grid') &&
        'collapsed' in saved &&
        Array.isArray(saved.collapsed) &&
        saved.collapsed.every((key: unknown) => typeof key === 'string')
      ) {
        setPreferences({ view: saved.view, collapsed: [...new Set<string>(saved.collapsed)] });
      }
    } catch {
      // Private mode, blocked storage and malformed JSON all use the defaults.
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(preferences));
    } catch {
      // Quota/security failures must not disable the in-memory controls.
    }
  }, [loaded, preferences]);

  const setView = (view: ShoppingView) => setPreferences((current) => ({ ...current, view }));
  const toggleGroup = (key: string) =>
    setPreferences((current) => ({
      ...current,
      collapsed: current.collapsed.includes(key)
        ? current.collapsed.filter((value) => value !== key)
        : [...current.collapsed, key],
    }));

  const expandGroups = (keys: string[]) =>
    setPreferences((current) => {
      const collapsed = current.collapsed.filter((key) => !keys.includes(key));
      return collapsed.length === current.collapsed.length ? current : { ...current, collapsed };
    });

  return {
    view: preferences.view,
    collapsed: preferences.collapsed,
    setView,
    toggleGroup,
    expandGroups,
  };
}
