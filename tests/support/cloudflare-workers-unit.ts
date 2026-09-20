// Unit tests that inject their data boundaries may import Worker modules but
// must never open a database connection. Keep only the binding shape required
// while those modules initialize.
export const env = {
  HYPERDRIVE: { connectionString: 'postgres://unit-test-binding-is-never-used' },
};
