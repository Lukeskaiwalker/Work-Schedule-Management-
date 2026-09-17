/**
 * The sliver of `node:fs` the suite uses, declared here because this package
 * has no Node type definitions.
 *
 * `apps/web/tsconfig.json` sets `types: ["vite/client"]` and nothing pulls in
 * `@types/node`, so `import … from "node:fs"` is a compile error even though
 * vitest runs in Node and the module is right there at runtime. Most tests
 * dodge this with `import.meta.glob(…, { query: "?raw" })` — see
 * `mockDataImports.test.ts` — but that route returns an EMPTY STRING for `.css`
 * files (vitest's `css: false` stubs them by extension), so a test that has to
 * read a stylesheet cannot use it, and would silently assert against nothing.
 *
 * Deliberately minimal, and ambient rather than a module, so that adding real
 * `@types/node` later merges with it as extra overloads instead of clashing.
 * Delete this file the moment `@types/node` lands.
 */
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
