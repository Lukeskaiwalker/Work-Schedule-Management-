/**
 * `useWerkstattOverview`, from the two frames it got wrong.
 *
 * The first render of an active screen reported `loading: false` with no data
 * and no error, because the request only starts in an effect afterwards — and
 * the pages read that as "nothing to report". The second is a retry: the old
 * failure stayed in state for the whole new request, so the red banner sat
 * above a card that said "Lädt…" and the user clicked retry again.
 *
 * Both are about a single render, so the assertions are on a recorded render
 * log rather than on the settled DOM.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useWerkstattOverview } from "../hooks/useWerkstattOverview";

/** `Array.prototype.at` is above this project's TS lib target. */
function last(frames: Frame[]): Frame | undefined {
  return frames[frames.length - 1];
}

interface Frame {
  loading: boolean;
  data: string | null;
  error: string | null;
}

function renderHookFrames(
  active: boolean,
  load: (token: string | null, signal: AbortSignal) => Promise<string>,
) {
  const frames: Frame[] = [];
  let reload = () => {};

  function Probe() {
    const state = useWerkstattOverview(active, "t", load, "Nicht geladen.");
    frames.push({ loading: state.loading, data: state.data, error: state.error });
    reload = state.reload;
    return null;
  }

  render(<Probe />);
  return { frames, reload: () => reload() };
}

describe("useWerkstattOverview", () => {
  it("is already loading on the very first render of an active screen", async () => {
    const load = vi.fn().mockResolvedValue("payload");
    const { frames } = renderHookFrames(true, load);

    // The frame the browser would paint before the effect runs.
    expect(frames[0]).toEqual({ loading: true, data: null, error: null });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  it("stays idle while the screen is not showing", () => {
    const load = vi.fn().mockResolvedValue("payload");
    const { frames } = renderHookFrames(false, load);

    expect(frames[0]).toEqual({ loading: false, data: null, error: null });
    expect(load).not.toHaveBeenCalled();
  });

  it("clears the failure when a retry starts, not when it finishes", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Bad Gateway"))
      .mockReturnValueOnce(new Promise(() => {}));
    const { frames, reload } = renderHookFrames(true, load);

    await waitFor(() => expect(last(frames)?.error).toBe("Bad Gateway"));

    act(() => reload());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    // The second request never settles — the banner must already be gone.
    expect(last(frames)).toEqual({ loading: true, data: null, error: null });
  });

  it("falls back to its own message when the failure carries none", async () => {
    const load = vi.fn().mockRejectedValue(new Error(""));
    const { frames } = renderHookFrames(true, load);

    await waitFor(() => expect(last(frames)?.error).toBe("Nicht geladen."));
  });

  it("drops the payload on a later failure rather than showing stale numbers", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce("payload")
      .mockRejectedValueOnce(new Error("kaputt"));
    const { frames, reload } = renderHookFrames(true, load);

    await waitFor(() => expect(last(frames)?.data).toBe("payload"));
    act(() => reload());
    await waitFor(() => expect(last(frames)?.error).toBe("kaputt"));
    expect(last(frames)?.data).toBeNull();
  });
});
