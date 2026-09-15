import { isString } from '../../src/shared/json.ts';

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required for service integration tests');
}

export const env = {
  HYPERDRIVE: { connectionString },
  ARTIFACTS: {
    async put(key: string, value: string | Uint8Array) {
      artifactBodies.set(key, isString(value) ? new TextEncoder().encode(value) : value);
    },
    async get(key: string) {
      const value = artifactBodies.get(key);
      if (!value) return null;
      return {
        text: async () => new TextDecoder().decode(value),
        json: async () => JSON.parse(new TextDecoder().decode(value)),
      };
    },
  },
};

const artifactBodies = new Map<string, Uint8Array>();
