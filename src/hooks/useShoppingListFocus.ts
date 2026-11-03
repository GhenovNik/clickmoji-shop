'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// Owned by the list, not an item or a particular list/grid presentation. The
// intent survives optimistic moves and rollbacks; refs supply the current node.
export function useShoppingListFocus() {
  const intent = useRef<{ itemId: string; target: HTMLElement | null } | null>(null);

  const rememberFocus = useCallback((itemId: string, target: HTMLElement) => {
    intent.current = { itemId, target };
  }, []);

  const registerTarget = useCallback((itemId: string, target: HTMLElement | null) => {
    if (intent.current?.itemId === itemId) intent.current.target = target;
  }, []);

  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      // Unmounting the focused control leaves focus on body without a focusin
      // event. An explicit move to another control cancels our restoration.
      if (intent.current && event.target !== intent.current.target) intent.current = null;
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);

  useLayoutEffect(() => {
    const target = intent.current?.target;
    if (target?.isConnected && document.activeElement === document.body) target.focus();
  });

  return { rememberFocus, registerTarget };
}
