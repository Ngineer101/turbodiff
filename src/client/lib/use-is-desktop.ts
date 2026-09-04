import { useCallback, useSyncExternalStore } from 'react';

// md breakpoint — the width at which the sidebar appears (app-shell.tsx).
const DESKTOP_QUERY = '(min-width: 768px)';
// lg breakpoint — the width at which the cockpit's chat rail sits beside the
// page instead of folding into a bottom sheet (chat-rail.tsx).
const WIDE_QUERY = '(min-width: 1024px)';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}

export function useIsWide(): boolean {
  return useMediaQuery(WIDE_QUERY);
}
