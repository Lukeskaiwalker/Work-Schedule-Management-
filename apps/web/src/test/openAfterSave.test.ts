/**
 * `openAfterSave` — a server-rendered PDF opens only once the autosave has
 * landed, without tripping the popup rule.
 *
 * iOS Safari (and Chrome's blocker) let a tap open a window, but not a
 * promise that resolves after the tap. So the window must be opened before
 * the first await and pointed at the PDF afterwards; a save that fails must
 * not leave an empty tab behind, nor show the old board as if it were new.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { PAGE_NOT_SAVED, PDF_BLOCKED, PDF_NOT_SAVED, isPlainClick, openAfterSave, reloadAfterSave, savedPdfClick } from "../utils/openAfterSave";

const URL = "/api/schaltplan/panels/7/pdf";

function fakeWindow() {
  return { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.unstubAllGlobals());

describe("openAfterSave", () => {
  it("opens the window synchronously and navigates it once the saves have settled", async () => {
    const win = fakeWindow();
    const open = vi.fn(() => win);
    vi.stubGlobal("open", open);
    const settle = deferred<boolean>();
    const report = vi.fn();

    const result = openAfterSave(URL, () => settle.promise, report);

    // Before anything was awaited — inside the tap.
    expect(open).toHaveBeenCalledWith("", "_blank");
    // What rel="noopener" did for the old link: the PDF tab cannot reach back.
    expect(win.opener).toBeNull();
    expect(win.location.href).toBe("");

    settle.resolve(true);
    await expect(result).resolves.toBe(true);
    expect(win.location.href).toBe(URL);
    expect(win.close).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("closes the window and reports when the saves did not land", async () => {
    const win = fakeWindow();
    vi.stubGlobal("open", vi.fn(() => win));
    const report = vi.fn();

    await expect(openAfterSave(URL, async () => false, report)).resolves.toBe(false);

    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.location.href).toBe("");
    expect(report).toHaveBeenCalledWith(PDF_NOT_SAVED);
  });

  it("treats a settle that throws like one that failed", async () => {
    const win = fakeWindow();
    vi.stubGlobal("open", vi.fn(() => win));
    const report = vi.fn();

    await expect(
      openAfterSave(URL, () => Promise.reject(new Error("boom")), report),
    ).resolves.toBe(false);

    expect(win.close).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(PDF_NOT_SAVED);
  });

  it("reports a blocked window instead of failing silently", async () => {
    vi.stubGlobal("open", vi.fn(() => null));
    const settle = vi.fn(async () => true);
    const report = vi.fn();

    await expect(openAfterSave(URL, settle, report)).resolves.toBe(false);

    expect(report).toHaveBeenCalledWith(PDF_BLOCKED);
  });

  it("words both failures in German, naming what did not happen", () => {
    expect(PDF_NOT_SAVED).toMatch(/^PDF nicht geöffnet: /);
    expect(PDF_BLOCKED).toMatch(/Pop-ups/);
  });
});

describe("savedPdfClick", () => {
  const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

  it("takes a plain tap over: no browser navigation, the window waits for the save", async () => {
    const win = fakeWindow();
    vi.stubGlobal("open", vi.fn(() => win));
    const preventDefault = vi.fn();
    const settle = vi.fn(async () => true);

    savedPdfClick(URL, settle, vi.fn())({ ...plain, preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(win.location.href).toBe(URL));
  });

  it("leaves a cmd-click to the browser", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const preventDefault = vi.fn();
    const settle = vi.fn(async () => true);

    savedPdfClick(URL, settle, vi.fn())({ ...plain, metaKey: true, preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});

describe("reloadAfterSave", () => {
  it("reloads only once the saves have settled", async () => {
    const settle = deferred<boolean>();
    const reload = vi.fn();
    const report = vi.fn();
    const result = reloadAfterSave(() => settle.promise, report, reload);
    expect(reload).not.toHaveBeenCalled();
    settle.resolve(true);
    await expect(result).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it("keeps the page when the latest edits are not on the server, and says why", async () => {
    for (const settle of [() => Promise.resolve(false), () => Promise.reject(new Error("offline"))]) {
      const reload = vi.fn();
      const report = vi.fn();
      await expect(reloadAfterSave(settle, report, reload)).resolves.toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith(PAGE_NOT_SAVED);
    }
    expect(PAGE_NOT_SAVED).toMatch(/^Seite nicht neu geladen: /);
  });
});

describe("isPlainClick", () => {
  it("is a plain primary click only — a modified click stays the browser's", () => {
    const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPlainClick(plain)).toBe(true);
    expect(isPlainClick({ ...plain, metaKey: true })).toBe(false);
    expect(isPlainClick({ ...plain, ctrlKey: true })).toBe(false);
    expect(isPlainClick({ ...plain, shiftKey: true })).toBe(false);
    expect(isPlainClick({ ...plain, altKey: true })).toBe(false);
    expect(isPlainClick({ ...plain, button: 1 })).toBe(false);
  });
});
