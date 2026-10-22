/**
 * A widget chunk that failed to download can be fetched again.
 *
 * React.lazy remembers a rejected import for good, so without care one
 * dropped request on a building-site connection would leave that widget
 * broken until a full reload, and „Erneut versuchen“ would do nothing. The
 * registry forgets a lazy component whose import failed; the next ask builds
 * a fresh one.
 */
import { Component, Suspense, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const loader = vi.hoisted(() => vi.fn());

vi.mock("../components/dashboard/widgets/personal", () => ({
  PERSONAL_WIDGET_LOADERS: { my_status: loader },
}));

import { getLazyWidget } from "../components/dashboard/widgetRegistry";

class Catch extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <p>failed</p> : this.props.children;
  }
}

describe("widget registry, failed imports", () => {
  it("drops a lazy component whose import rejected and builds a new one on the next ask", async () => {
    // React (dev) reports an error a boundary caught to the console and to
    // jsdom's window; both are expected here and would only add noise.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const swallow = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", swallow);
    loader.mockRejectedValueOnce(new Error("chunk failed"));
    loader.mockResolvedValueOnce({ default: () => <p>status widget</p> });

    const First = getLazyWidget("my_status");
    expect(First).not.toBeNull();
    const props = { size: "medium" as const, settings: null, device: "desktop" as const };
    const first = render(
      <Catch>
        <Suspense fallback={<p>loading</p>}>{First ? <First {...props} /> : null}</Suspense>
      </Catch>,
    );
    expect(await screen.findByText("failed")).toBeInTheDocument();
    first.unmount();

    const Second = getLazyWidget("my_status");
    expect(Second).not.toBe(First);
    render(<Suspense fallback={<p>loading</p>}>{Second ? <Second {...props} /> : null}</Suspense>);
    expect(await screen.findByText("status widget")).toBeInTheDocument();
    expect(getLazyWidget("my_status")).toBe(Second);
    expect(loader).toHaveBeenCalledTimes(2);
    window.removeEventListener("error", swallow);
    errorSpy.mockRestore();
  });
});
