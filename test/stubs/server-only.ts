/**
 * `server-only` exists to make a build fail if server code is pulled into a
 * client bundle. Vitest resolves its client-guard entry and throws on import,
 * so it is stubbed here. Nothing is weakened: the guard protects browser
 * bundles, and these tests run in Node against a real database.
 */
export {};
