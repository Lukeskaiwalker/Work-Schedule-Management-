/**
 * The 3D view's own error boundary and its lazy loader
 * (docs/PANEL_ENCLOSURE.md §11 "3D", §12).
 *
 * The 3D chunk is the one part of the Schaltplan page that is fetched late:
 * on a weak site network, or in a tab left open across a deploy that removed
 * the hashed chunk. Either way the failure must stay inside the Schrank tab —
 * never reach AppErrorBoundary, which can only offer "reload the app" — and
 * "3D neu laden" must import again rather than replay the cached rejection.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEnclosure3DView,
  Enclosure3DBoundary,
  Enclosure3DPane,
  type Enclosure3DLoader,
} from "../components/schaltplan/enclosure/Enclosure3DBoundary";
import type { Enclosure3DViewProps } from "../components/schaltplan/enclosure/Enclosure3DView";
import type { EnclosureScene } from "../types/panelEnclosure";

const SCENE: EnclosureScene = { width: 800, height: 1100, depth: 205, view: "open", boxes: [] };

/** Stands in for AppErrorBoundary: if it ever shows, the failure escaped the Schrank tab. */
class Outer extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <p>outer boundary</p> : this.props.children;
  }
}

function FakeView({ scene, onExit }: Enclosure3DViewProps) {
  return (
    <button type="button" onClick={onExit}>
      fake 3D {scene.width}
    </button>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** React's dev build re-throws a caught render error through a window "error" event; jsdom would print it. */
const quietWindowError = (event: ErrorEvent) => event.preventDefault();

beforeEach(() => {
  // React reports every caught render error on the console; the boundary logs once more.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  window.addEventListener("error", quietWindowError);
});

afterEach(() => {
  window.removeEventListener("error", quietWindowError);
  vi.restoreAllMocks();
});

describe("Enclosure3DBoundary", () => {
  it("catches a render error inside the Schrank tab and offers 3D neu laden and 2D", () => {
    let broken = true;
    function Flaky() {
      if (broken) throw new Error("render failed");
      return <p>3D läuft</p>;
    }
    const onRetry = vi.fn(() => {
      broken = false;
    });
    const onExit = vi.fn();
    render(
      <Outer>
        <Enclosure3DBoundary onRetry={onRetry} onExit={onExit}>
          <Flaky />
        </Enclosure3DBoundary>
      </Outer>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("3D konnte nicht geladen werden.");
    expect(screen.queryByText("outer boundary")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "2D" }));
    expect(onExit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "3D neu laden" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText("3D läuft")).toBeInTheDocument();
  });

  it("renders its children untouched while nothing fails", () => {
    render(
      <Enclosure3DBoundary onRetry={() => undefined} onExit={() => undefined}>
        <p>3D läuft</p>
      </Enclosure3DBoundary>,
    );
    expect(screen.getByText("3D läuft")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("createEnclosure3DView", () => {
  it("makes a fresh lazy component on every call, so a retry imports again", async () => {
    const load = vi.fn<Enclosure3DLoader>(() => Promise.resolve({ default: FakeView }));
    const first = createEnclosure3DView(load);
    const second = createEnclosure3DView(load);
    expect(first).not.toBe(second);
    render(<>{[first, second].map((View, i) => <View key={i} scene={SCENE} onExit={() => undefined} />)}</>);
    expect(await screen.findAllByRole("button", { name: "fake 3D 800" })).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("Enclosure3DPane", () => {
  it("shows 3D wird geladen… while the chunk is on its way", async () => {
    const pending = deferred<{ default: typeof FakeView }>();
    render(<Enclosure3DPane scene={SCENE} onExit={() => undefined} load={() => pending.promise} />);
    expect(screen.getByRole("status")).toHaveTextContent("3D wird geladen…");
    await act(async () => pending.resolve({ default: FakeView }));
    expect(screen.getByRole("button", { name: "fake 3D 800" })).toBeInTheDocument();
  });

  it("turns a failed chunk fetch into the boundary text, and 3D neu laden imports again", async () => {
    const load = vi
      .fn<Enclosure3DLoader>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
      .mockResolvedValueOnce({ default: FakeView });
    render(
      <Outer>
        <Enclosure3DPane scene={SCENE} onExit={() => undefined} load={load} />
      </Outer>,
    );
    expect(await screen.findByText("3D konnte nicht geladen werden.")).toBeInTheDocument();
    expect(screen.queryByText("outer boundary")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "3D neu laden" }));
    expect(await screen.findByRole("button", { name: "fake 3D 800" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("offers to reload the page once 3D neu laden failed as well", async () => {
    const load = vi.fn<Enclosure3DLoader>().mockRejectedValue(new Error("offline"));
    const onReloadPage = vi.fn();
    render(<Enclosure3DPane scene={SCENE} onExit={() => undefined} load={load} onReloadPage={onReloadPage} />);
    expect(await screen.findByText("3D konnte nicht geladen werden.")).toBeInTheDocument();
    // A first failure may be the site network: trying again is the first answer.
    expect(screen.queryByRole("button", { name: "Seite neu laden" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "3D neu laden" }));
    fireEvent.click(await screen.findByRole("button", { name: "Seite neu laden" }));
    expect(onReloadPage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(/nach einem Update/i);
    expect(screen.getByRole("button", { name: "3D neu laden" })).toBeInTheDocument();
  });

  it("offers it at once when the browser says the chunk itself is gone", async () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://app.example/chunks/Enclosure3DView-abc123.js",
      "error loading dynamically imported module: https://app.example/chunks/Enclosure3DView-abc123.js",
      "Importing a module script failed.",
    ]) {
      const { unmount } = render(
        <Enclosure3DPane scene={SCENE} onExit={() => undefined} load={() => Promise.reject(new TypeError(message))} onReloadPage={() => undefined} />,
      );
      expect(await screen.findByRole("button", { name: "Seite neu laden" })).toBeInTheDocument();
      unmount();
    }
  });

  it("never offers a page reload nobody can carry out", async () => {
    const load = vi.fn<Enclosure3DLoader>().mockRejectedValue(new TypeError("Failed to fetch dynamically imported module"));
    render(<Enclosure3DPane scene={SCENE} onExit={() => undefined} load={load} />);
    fireEvent.click(await screen.findByRole("button", { name: "3D neu laden" }));
    await screen.findByText("3D konnte nicht geladen werden.");
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "Seite neu laden" })).toBeNull();
  });

  it("hands onExit to the view and to the boundary's 2D button", async () => {
    const onExit = vi.fn();
    const load = vi.fn<Enclosure3DLoader>().mockRejectedValueOnce(new Error("offline"));
    render(<Enclosure3DPane scene={SCENE} onExit={onExit} load={load} />);
    fireEvent.click(await screen.findByRole("button", { name: "2D" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("passes the scene through to the loaded view", async () => {
    const onExit = vi.fn();
    render(
      <Enclosure3DPane
        scene={{ ...SCENE, width: 1050 }}
        onExit={onExit}
        load={() => Promise.resolve({ default: FakeView })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "fake 3D 1050" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
