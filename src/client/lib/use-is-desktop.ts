import { useSyncExternalStore } from 'react';

// md breakpoint — the width at which the sidebar appears (app-shell.tsx).
const QUERY = '(min-width: 768px)';

export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(QUERY);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(QUERY).matches,
  );
}
