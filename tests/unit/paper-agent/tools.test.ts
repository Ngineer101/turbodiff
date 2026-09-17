import { describe, expect, it } from 'vite-plus/test';
import {
  buildToolCatalog,
  CONTROL_TOOLS,
  JOB_COMPLETE,
  PAPER_PREFIX,
} from '../../../src/paper-agent/tools.ts';

describe('buildToolCatalog', () => {
  it('always exposes the control tools', () => {
    const { definitions } = buildToolCatalog([]);
    const names = definitions.map((d) => d.name);
    for (const control of CONTROL_TOOLS) expect(names).toContain(control.name);
    expect(names).toContain(JOB_COMPLETE);
  });

  it('aliases paper tools under a sanitised, prefixed name and maps back', () => {
    const { definitions, paperAlias } = buildToolCatalog([
      { name: 'frames.create', description: 'Create a frame' },
    ]);
    const alias = `${PAPER_PREFIX}frames_create`;
    expect(paperAlias.get(alias)).toBe('frames.create');
    const def = definitions.find((d) => d.name === alias);
    expect(def?.description).toBe('Create a frame');
    // Every tool definition carries an object input schema for the Messages API.
    expect(def?.input_schema.type).toBe('object');
  });

  it('gives colliding sanitised names distinct aliases', () => {
    const { paperAlias } = buildToolCatalog([{ name: 'a.b' }, { name: 'a/b' }]);
    const originals = [...paperAlias.values()].sort();
    expect(originals).toEqual(['a.b', 'a/b']);
    expect(paperAlias.size).toBe(2);
  });

  it('coerces a missing or non-object schema into a permissive object schema', () => {
    const { definitions } = buildToolCatalog([{ name: 'noschema' }]);
    const def = definitions.find((d) => d.name === `${PAPER_PREFIX}noschema`);
    expect(def?.input_schema).toMatchObject({ type: 'object' });
  });
});
