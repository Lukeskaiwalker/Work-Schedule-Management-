/**
 * A `matchMedia` for one screen width that can be changed mid-test.
 *
 * The global jsdom shim (setup.ts) answers every query with false, which is
 * a phone to the start page (docs/DASHBOARD.md §9.2). Tests that need a
 * tablet or a desktop — or a window resized across a breakpoint — stub it
 * per query with this, as werkstattMobileHome.test.tsx does for its own
 * breakpoint. Only `min-width` queries are understood; that is all the start
 * page asks.
 */
import { vi } from "vitest";

type Listener = () => void;

export type WidthStub = {
  /** Changes the width and fires `change` on every list, like a browser. */
  resize(width: number): void;
  listenerCount(): number;
};

export function stubWidth(initial: number): WidthStub {
  let width = initial;
  const listeners = new Set<Listener>();
  const minWidth = (query: string) => Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? Number.NaN);
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return width >= minWidth(query);
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    dispatchEvent: () => false,
  }));
  return {
    resize(next) {
      width = next;
      Array.from(listeners).forEach((listener) => listener());
    },
    listenerCount: () => listeners.size,
  };
}
