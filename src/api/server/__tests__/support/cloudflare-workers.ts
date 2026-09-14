const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required for service integration tests');
}

export const env = {
  HYPERDRIVE: { connectionString },
};
