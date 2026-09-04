/**
 * Test environment shims.
 *
 * jsdom implements the document, not the browser around it. Pages reach for
 * these on mount, and an undefined one throws before the component under test
 * has done anything interesting — which would make every failure look like a
 * page bug rather than a missing shim.
 */
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
// Registers toBeDisabled / toBeInTheDocument / … on expect(), and their
// types. Without this every test re-derives them from raw DOM properties.
import "@testing-library/jest-dom/vitest";

afterEach(() => cleanup());

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!window.IntersectionObserver) {
  window.IntersectionObserver = class {
    root = null;
    rootMargin = "";
    thresholds = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
}

if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => undefined;
}

// Pages fetch on mount. Nothing here asserts on the network, and a real
// request would hang the suite, so every call resolves to an empty list.
vi.stubGlobal(
  "fetch",
  vi.fn(async () =>
    new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
  ),
);
