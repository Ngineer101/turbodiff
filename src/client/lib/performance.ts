interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

const metrics = new Map<string, number>();

function observe(type: string, record: (entry: PerformanceEntry) => void): void {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record(entry);
    });
    observer.observe({ type, buffered: true });
  } catch {
    // Older browsers simply omit unsupported metrics.
  }
}

// A 10% real-user sample is enough to catch regressions without turning a
// performance feature into a meaningful source of network or log volume.
export function startPerformanceMonitoring(): void {
  if (Math.random() >= 0.1) return;
  const navigation = performance.getEntriesByType('navigation')[0];
  if (navigation instanceof PerformanceNavigationTiming) {
    metrics.set('ttfb', navigation.responseStart);
    metrics.set('dom_interactive', navigation.domInteractive);
  }
  observe('largest-contentful-paint', (entry) => metrics.set('lcp', entry.startTime));
  observe('event', (entry) =>
    metrics.set('inp', Math.max(metrics.get('inp') ?? 0, entry.duration)),
  );
  observe('layout-shift', (entry) => {
    // SAFETY: entries delivered by the layout-shift observer implement the
    // LayoutShift Performance API extension.
    const shift = entry as LayoutShiftEntry;
    if (!shift.hadRecentInput) metrics.set('cls', (metrics.get('cls') ?? 0) + shift.value);
  });

  const report = () => {
    if (metrics.size === 0) return;
    const body = JSON.stringify({ path: location.pathname, metrics: Object.fromEntries(metrics) });
    void fetch('/api/performance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    });
  };
  addEventListener('pagehide', report, { once: true });
}
