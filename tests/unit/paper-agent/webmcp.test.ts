import { describe, expect, it } from 'vite-plus/test';
import { normaliseTools } from '../../../src/paper-agent/webmcp.ts';

describe('normaliseTools', () => {
  it('accepts a bare array of tools', () => {
    const tools = normaliseTools([
      { name: 'create_frame', description: 'Add a frame', inputSchema: { type: 'object' } },
    ]);
    expect(tools).toEqual([
      { name: 'create_frame', description: 'Add a frame', inputSchema: { type: 'object' } },
    ]);
  });

  it('accepts a { tools: [...] } envelope', () => {
    const tools = normaliseTools({ tools: [{ name: 'add_text' }] });
    expect(tools).toEqual([{ name: 'add_text' }]);
  });

  it('reads the schema from input_schema or parameters', () => {
    const tools = normaliseTools([
      { name: 'a', input_schema: { type: 'object', properties: {} } },
      { name: 'b', parameters: { type: 'object' } },
    ]);
    expect(tools[0].inputSchema).toEqual({ type: 'object', properties: {} });
    expect(tools[1].inputSchema).toEqual({ type: 'object' });
  });

  it('drops entries without a string name and non-object shapes', () => {
    expect(normaliseTools([{ description: 'no name' }, 42, null, { name: 7 }])).toEqual([]);
    expect(normaliseTools('nonsense')).toEqual([]);
    expect(normaliseTools(null)).toEqual([]);
  });

  it('omits a non-object schema rather than forwarding it', () => {
    const tools = normaliseTools([{ name: 'x', inputSchema: 'not-an-object' }]);
    expect(tools).toEqual([{ name: 'x' }]);
  });
});
