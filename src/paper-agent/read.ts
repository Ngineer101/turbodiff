// Read-only "can we read this design?" proof.
//
// The current proof-of-concept goal: given an existing Paper design, verify it
// can be read through the Browser Run + WebMCP setup, without ever writing to
// Paper. This is the piece the eventual factory flow depends on — a cloud agent
// reading a delegated design before implementing it.
//
// Three independent proofs are gathered:
//   1. Screenshot — visual proof the design renders.
//   2. DOM        — extracted page text (layer/page names, copy).
//   3. WebMCP     — discover Paper's tools and, if a safe read-only one exists,
//                   invoke it to pull structured design data.
//
// WebMCP requires an authenticated Paper session and the Browser Run lab; when
// it is absent the screenshot and DOM proofs still confirm the design is
// visually and textually readable, and the report says WebMCP was unavailable.

import type { PaperSession } from './browser.ts';
import { storeScreenshot } from './artifacts.ts';
import { pickReadTool } from './read-report.ts';
import type { DesignReadReport } from './types.ts';

export async function readDesign(
  session: PaperSession,
  jobId: string,
  iteration: number,
  paperUrl: string,
): Promise<DesignReadReport> {
  const report: DesignReadReport = {
    paperUrl,
    capturedAt: new Date().toISOString(),
    webMcp: { available: false, tools: [] },
    dom: { textSample: '', textLength: 0 },
  };

  // Visual proof.
  try {
    const png = await session.screenshot();
    const stored = await storeScreenshot(jobId, iteration, png);
    report.screenshot = stored.url;
  } catch {
    // A missing screenshot is not fatal to the report.
  }

  // Text proof.
  try {
    const title = await session.title();
    const text = await session.inspect();
    report.dom = {
      title: title || undefined,
      textSample: text.slice(0, 2000),
      textLength: text.length,
    };
  } catch {
    // Leave the empty DOM proof in place.
  }

  // Structural proof via WebMCP (read-only).
  if (await session.webMcpAvailable()) {
    report.webMcp.available = true;
    const tools = await session.listWebMcpTools();
    report.webMcp.tools = tools.map((tool) => tool.name);
    const readTool = pickReadTool(tools);
    if (readTool) {
      const result = await session.executeWebMcpTool(readTool, {});
      if (result.ok) {
        report.webMcp.read = { tool: readTool, result: JSON.stringify(result.value ?? null) };
      } else {
        report.webMcp.error = result.error ?? 'read tool failed';
      }
    } else if (tools.length) {
      report.webMcp.error = 'no read-only tool matched; discovered tools listed';
    }
  } else {
    report.webMcp.error = 'WebMCP surface unavailable (needs an authenticated Paper session + lab)';
  }

  return report;
}
