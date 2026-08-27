/**
 * Find React hooks called after an early return.
 *
 *     npm run check --prefix apps/web
 *
 * React counts hooks per render. A hook below an `if (...) return` runs only on
 * some renders, so the count changes and React throws — and it throws at the
 * moment the component becomes visible, which is the worst time to find out.
 *
 * This exists because the repo has no ESLint (so no react-hooks/rules-of-hooks)
 * and no test that renders a page, and this bug shipped to production once
 * already: the Bestand page crashed on open because a useCallback sat two lines
 * below `if (mainView !== "werkstatt") return null`. TypeScript cannot see it.
 *
 * Heuristic, not a parser: it looks at component top level (two-space indent),
 * which is how every component in this codebase is written. It would miss a
 * hook nested deeper, and that is an acceptable trade for zero dependencies.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname: the repo path contains a space, which
// .pathname hands back percent-encoded and readdir cannot open.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

const EARLY_RETURN = /^ {2}(if\s*\(.*\)\s*return\b|return\b)/;
const HOOK_CALL = /^ {2}(?:const\s+.*=\s*)?(use[A-Z]\w*)\s*\(/;
const COMPONENT_END = /^\}/;

const findings = [];
for (const file of walk(SRC)) {
  const lines = readFileSync(file, "utf8").split("\n");
  let returnedAt = null;
  lines.forEach((line, i) => {
    if (COMPONENT_END.test(line)) { returnedAt = null; return; }
    if (returnedAt === null && EARLY_RETURN.test(line)) { returnedAt = i + 1; return; }
    if (returnedAt !== null) {
      const hook = HOOK_CALL.exec(line);
      // useRef/useState/etc. all count; so does a custom hook.
      if (hook) {
        findings.push({
          file: file.slice(SRC.length),
          line: i + 1,
          hook: hook[1],
          afterReturnOnLine: returnedAt,
        });
      }
    }
  });
}

if (findings.length) {
  console.log("hook order: PROBLEMS FOUND\n");
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  ${f.hook}() runs after the early return on line ${f.afterReturnOnLine}`);
  }
  console.log("\nMove these above the early return, or the component crashes when the branch flips.");
  process.exit(1);
}
console.log("hook order: no hook runs after an early return");
