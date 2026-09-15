export function getSandbox(): never {
  throw new Error('Sandbox is not available in service integration tests');
}
