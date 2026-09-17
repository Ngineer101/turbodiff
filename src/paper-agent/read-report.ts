// Pure helpers for the read-only design-readability proof. Kept free of browser
// and platform bindings so they can be unit-tested in isolation.

import type { DesignReadReport, WebMcpTool } from './types.ts';

// Only tools whose name looks like a read afford structured reading. The
// denylist wins so a "getOrCreate"-style name is never treated as safe — read
// mode must never mutate the design.
const READ_TOOL_ALLOW =
  /(?:get|list|read|export|describe|dump|snapshot|inspect|current|selection|tree|nodes?|document|canvas|frames?|layers?|pages?)/i;
const READ_TOOL_DENY =
  /(?:create|add|insert|update|set|delete|remove|move|write|rename|duplicate|paste|apply|import|undo|redo|clear|save)/i;

/** Choose one WebMCP tool that is safe to call for reading, or null. */
export function pickReadTool(tools: WebMcpTool[]): string | null {
  for (const tool of tools) {
    if (READ_TOOL_DENY.test(tool.name)) continue;
    if (READ_TOOL_ALLOW.test(tool.name)) return tool.name;
  }
  return null;
}

/** Summarise a report as a one-line human-readable proof statement. */
export function summariseReadReport(report: DesignReadReport): string {
  const parts = [
    report.screenshot ? 'screenshot captured' : 'no screenshot',
    `dom text ${report.dom.textLength} chars`,
    report.webMcp.available
      ? `webmcp ${report.webMcp.tools.length} tools${report.webMcp.read ? ` (read via ${report.webMcp.read.tool})` : ''}`
      : 'webmcp unavailable',
  ];
  return `read proof: ${parts.join('; ')}`;
}
