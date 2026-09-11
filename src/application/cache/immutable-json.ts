export async function loadImmutableJson<T>(
  defer: (promise: Promise<void>) => void,
  cacheKey: string | null,
  load: () => Promise<T>,
): Promise<T> {
  if (!cacheKey) return load();
  const request = new Request(`https://repo-read-cache.turbodiff.internal/${cacheKey}`);
  try {
    const cached = await caches.default.match(request);
    if (cached) return await cached.json<T>();
  } catch {
    // Cache API is best-effort and absent in some direct test harnesses. A
    // malformed cached response is also safe to replace from the source.
  }
  const value = await load();
  try {
    defer(
      caches.default
        .put(
          request,
          Response.json(value, {
            headers: { 'cache-control': 'public, max-age=31536000, immutable' },
          }),
        )
        .catch(() => {}),
    );
  } catch {
    // The read result remains valid when the edge cache is unavailable.
  }
  return value;
}
