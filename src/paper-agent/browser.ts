// Browser Run session control for the Paper design agent.
//
// Wraps @cloudflare/puppeteer so the rest of the agent works against a small,
// intention-revealing surface: open or resume a persistent session, drive
// Paper primarily through its WebMCP tools, and fall back to screenshots and
// DOM inspection for everything WebMCP does not cover.
//
// The session is deliberately long-lived. Browser Run keeps the Chrome session
// warm (`keep_alive`) after we disconnect, so an agent turn can run inside one
// Worker/alarm invocation, disconnect, and a later turn can reconnect by
// sessionId without the user's tab ever being open.

import puppeteer, { type Browser, type BrowserWorker, type Page } from '@cloudflare/puppeteer';
import { BROWSER_KEEP_ALIVE_SECONDS } from './config.ts';
import { normaliseTools } from './webmcp.ts';
import type { WebMcpTool, WebMcpToolResult } from './types.ts';
import { isString } from '../shared/json.ts';
import type { JsonValue } from '../shared/json.ts';

// Shape of the WebMCP surface Paper injects on its origin. Not part of the
// Worker's type lib (it lives in the page), so it is described here and reached
// through the browser-global view inside page.evaluate closures.
interface PaperMcpSurface {
  listTools: () => JsonValue | Promise<JsonValue>;
  executeTool: (name: string, args: JsonValue) => JsonValue | Promise<JsonValue>;
}
interface PaperNavigator {
  modelContextTesting?: PaperMcpSurface;
}
interface PaperDocument {
  body?: { innerText?: string };
  querySelector: (selector: string) => { innerText?: string } | null;
}
// A single, non-chained view of the page's globals. In the Worker type lib
// `navigator` exists but lacks WebMCP and `document` is absent; this widening
// gives the evaluate closures a typed handle to both.
interface BrowserGlobals {
  navigator?: PaperNavigator;
  document?: PaperDocument;
}

export interface OpenSessionOptions {
  // Reconnect to this Browser Run session instead of launching a new one.
  sessionId?: string;
  // Enable Browser Run's experimental "lab" environment, where the WebMCP
  // surface is currently exposed. Defaults to true for this agent.
  lab?: boolean;
  // When reconnecting, prefer a tab already on this URL's host (e.g. the Paper
  // document the operator signed into), rather than a blank tab.
  preferUrl?: string;
}

export class PaperSession {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
  ) {}

  /**
   * Launch a fresh Browser Run session, or resume an existing one by id. On
   * resume the current page is reused so Paper's authenticated document and
   * WebMCP environment survive across turns.
   */
  static async open(
    binding: BrowserWorker,
    options: OpenSessionOptions = {},
  ): Promise<PaperSession> {
    if (options.sessionId) {
      const browser = await puppeteer.connect(binding, options.sessionId);
      const page = await pickPage(browser, options.preferUrl);
      return new PaperSession(browser, page);
    }
    const browser = await puppeteer.launch(binding, {
      keep_alive: BROWSER_KEEP_ALIVE_SECONDS * 1000,
      lab: options.lab ?? true,
    });
    const page = await browser.newPage();
    return new PaperSession(browser, page);
  }

  /** The Browser Run session id, used to reconnect on a later turn. */
  sessionId(): string {
    return this.browser.sessionId();
  }

  /** Navigate to `url` unless the page is already there. */
  async ensureAt(url: string): Promise<void> {
    if (this.page.url() === url) return;
    await this.page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
  }

  /** Capture a full-page PNG screenshot for visual evaluation. */
  async screenshot(): Promise<Uint8Array> {
    const shot = await this.page.screenshot({ type: 'png' });
    return isString(shot) ? new TextEncoder().encode(shot) : new Uint8Array(shot);
  }

  /** The current page title. */
  async title(): Promise<string> {
    return this.page.title();
  }

  /** DOM fallback: return trimmed visible text for a selector (or the body). */
  async inspect(selector?: string): Promise<string> {
    return this.readText(selector, 8000);
  }

  /** Extract visible text from the page (or a selector), up to `limit` chars. */
  async readText(selector?: string, limit = 500_000): Promise<string> {
    return this.page.evaluate(
      (sel: string | undefined, max: number) => {
        // SAFETY: this closure runs in the page, where `document` is the real DOM.
        const doc = (globalThis as BrowserGlobals).document;
        const node = sel ? doc?.querySelector(sel) : doc?.body;
        return (node?.innerText ?? '').slice(0, max);
      },
      selector,
      limit,
    );
  }

  /** Whether Paper's WebMCP surface is present and usable on this page. */
  async webMcpAvailable(): Promise<boolean> {
    return this.page.evaluate(() => {
      // SAFETY: this closure runs in the page, where `navigator` carries WebMCP.
      const surface = (globalThis as BrowserGlobals).navigator?.modelContextTesting;
      return Boolean(surface && surface.listTools instanceof Function);
    });
  }

  /** Discover the Paper tools exposed through WebMCP. */
  async listWebMcpTools(): Promise<WebMcpTool[]> {
    const raw = await this.page.evaluate(async () => {
      // SAFETY: this closure runs in the page, where `navigator` carries WebMCP.
      const surface = (globalThis as BrowserGlobals).navigator?.modelContextTesting;
      return surface ? await surface.listTools() : [];
    });
    return normaliseTools(raw);
  }

  /** Execute one Paper WebMCP tool and normalise success/failure. */
  async executeWebMcpTool(name: string, args: JsonValue): Promise<WebMcpToolResult> {
    return this.page.evaluate(
      async (toolName: string, toolArgs: JsonValue) => {
        // SAFETY: this closure runs in the page, where `navigator` carries WebMCP.
        const surface = (globalThis as BrowserGlobals).navigator?.modelContextTesting;
        if (!surface) return { ok: false, error: 'WebMCP surface unavailable' };
        try {
          return { ok: true, value: await surface.executeTool(toolName, toolArgs) };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'tool threw a non-error value',
          };
        }
      },
      name,
      args,
    );
  }

  /** Disconnect but leave the Browser Run session warm for later resumption. */
  async disconnect(): Promise<void> {
    await this.browser.disconnect();
  }

  /** End the session entirely, releasing the Browser Run instance. */
  async close(): Promise<void> {
    await this.browser.close();
  }
}

/**
 * Choose which existing tab to drive after reconnecting: prefer one already on
 * the target URL's host (the document the operator signed into), else the first
 * tab, else a new one.
 */
async function pickPage(browser: Browser, preferUrl?: string): Promise<Page> {
  const pages = await browser.pages();
  const host = hostOf(preferUrl);
  if (host) {
    const match = pages.find((page) => hostOf(page.url()) === host);
    if (match) return match;
  }
  return pages[0] ?? (await browser.newPage());
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
