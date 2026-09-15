export interface HttpApiTestResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly status?: number;
}

export async function testHttpApiEndpoint(
  url: string,
  auth?: { readonly headerName: string; readonly headerValue: string },
): Promise<HttpApiTestResult> {
  const headers = new Headers();
  if (auth) headers.set(auth.headerName, auth.headerValue);

  try {
    const response = await fetch(url, { method: 'GET', headers });
    return {
      ok: response.ok,
      detail: `HTTP ${response.status} ${response.statusText}`.trim(),
      status: response.status,
    };
  } catch {
    return { ok: false, detail: 'The integration could not be reached. Check its URL.' };
  }
}
