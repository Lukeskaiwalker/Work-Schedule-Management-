/**
 * The click-through file viewer. Three hosts render it (project files,
 * customer files, task attachments) and code against one contract, so what is
 * pinned here is the contract: the sequence and its wrap-around, the ways out,
 * and one rendering per file type — including the two PDF paths, which depend
 * on a navigator probe rather than on anything the test can see in the DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  FileLightbox,
  fileDownloadUrl,
  filePreviewUrl,
  isLightboxPreviewable,
} from "../components/files/FileLightbox";
import type { FileLightboxProps, LightboxFile } from "../components/files/lightboxTypes";

// Mutable so one test can flip the surface without re-importing the module;
// everything else in the shell module stays real (apiUrl is the identity here).
const surface = vi.hoisted(() => ({ native: false }));
vi.mock("../native/shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../native/shell")>();
  return {
    ...actual,
    get IS_NATIVE_SHELL() {
      return surface.native;
    },
  };
});

const FILES: readonly LightboxFile[] = [
  { id: 11, file_name: "Zählerschrank.jpg", content_type: "image/jpeg", subtitle: "Bilder" },
  { id: 12, file_name: "Bericht.pdf", content_type: "application/pdf", subtitle: "Berichte" },
  { id: 13, file_name: "Export.zip", content_type: "application/zip" },
];

function renderLightbox(overrides: Partial<FileLightboxProps> = {}) {
  const props: FileLightboxProps = {
    files: FILES,
    index: 1,
    onIndexChange: vi.fn(),
    onClose: vi.fn(),
    language: "de",
    ...overrides,
  };
  const view = render(<FileLightbox {...props} />);
  return { ...props, ...view };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function bytesResponse(type: string): Response {
  return new Response(new Blob([new Uint8Array([1, 2, 3])], { type }), {
    status: 200,
    headers: { "Content-Type": type },
  });
}

/** Route the stubbed fetch by URL; anything unrouted fails loudly. */
function routeFetch(routes: (url: string) => Response | undefined) {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const response = routes(url);
    if (!response) throw new Error(`unexpected fetch: ${url}`);
    return response;
  });
}

function setPdfViewerEnabled(value: boolean | undefined) {
  Object.defineProperty(navigator, "pdfViewerEnabled", { value, configurable: true });
}

beforeEach(() => {
  surface.native = false;
  setPdfViewerEnabled(true);
  // The stub is shared by the whole file: forget the previous test's calls.
  vi.mocked(fetch).mockClear();
  routeFetch(() => jsonResponse([]));
});

afterEach(() => {
  setPdfViewerEnabled(undefined);
  window.localStorage.removeItem("smpl_token");
});

describe("FileLightbox", () => {
  it("opens on files[index] and counts the sequence", () => {
    renderLightbox();
    const dialog = screen.getByRole("dialog", { name: "Bericht.pdf" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByText("2 / 3")).toBeInTheDocument();
    expect(within(dialog).getByText("Bericht.pdf")).toBeInTheDocument();
    expect(within(dialog).getByText("Berichte")).toBeInTheDocument();
  });

  it("steps forward with › and ArrowRight, wrapping at the end", () => {
    const { onIndexChange } = renderLightbox({ index: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Nächste Datei" }));
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
    expect(onIndexChange).toHaveBeenCalledTimes(2);
  });

  it("steps back with ‹ and ArrowLeft, wrapping at the start", () => {
    const { onIndexChange } = renderLightbox({ index: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Vorherige Datei" }));
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    expect(onIndexChange).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape, the close button and a backdrop click — not on the stage content", () => {
    const { onClose } = renderLightbox({ index: 0 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("img"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("moves on a horizontal swipe, not on a vertical one", () => {
    const { onIndexChange } = renderLightbox({ index: 0 });
    const image = screen.getByRole("img");
    fireEvent.pointerDown(image, { clientX: 220, clientY: 300, pointerType: "touch" });
    fireEvent.pointerUp(image, { clientX: 140, clientY: 310, pointerType: "touch" });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    fireEvent.pointerDown(image, { clientX: 220, clientY: 300, pointerType: "touch" });
    fireEvent.pointerUp(image, { clientX: 230, clientY: 120, pointerType: "touch" });
    expect(onIndexChange).toHaveBeenCalledTimes(1);
  });

  it("shows an image through the preview endpoint", () => {
    renderLightbox({ index: 0 });
    const image = screen.getByRole("img", { name: "Zählerschrank.jpg" });
    expect(image.getAttribute("src")).toMatch(/\/api\/files\/11\/preview$/);
    expect(screen.getByRole("link", { name: "Herunterladen" }).getAttribute("href")).toMatch(
      /\/api\/files\/11\/download$/,
    );
  });

  it("falls back to the name and a download link when an image cannot be shown", () => {
    renderLightbox({ index: 0 });
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Datei konnte nicht geladen werden.")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Herunterladen" }).length).toBeGreaterThan(1);
  });

  it("frames a PDF where the engine can draw one", () => {
    renderLightbox();
    const frame = screen.getByTitle("Bericht.pdf");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toMatch(/\/api\/files\/12\/preview$/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("pages a PDF as rendered images where a frame cannot draw it", async () => {
    setPdfViewerEnabled(false);
    routeFetch((url) => {
      if (url.endsWith("/api/files/12/preview-pages")) return jsonResponse({ page_count: 3 });
      if (/\/api\/files\/12\/preview-pages\/\d+$/.test(url)) return bytesResponse("image/png");
      return undefined;
    });
    renderLightbox();
    expect(screen.getByText("Wird geladen…")).toBeInTheDocument();
    expect(await screen.findByText("Seite 1 / 3")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Bericht.pdf – Seite 1" })).toBeInTheDocument();
    expect(screen.queryByTitle("Bericht.pdf")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vorherige Seite" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Nächste Seite" }));
    expect(await screen.findByRole("img", { name: "Bericht.pdf – Seite 2" })).toBeInTheDocument();
    expect(screen.getByText("Seite 2 / 3")).toBeInTheDocument();
    const requested = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(requested).toContain("/api/files/12/preview-pages/2");
  });

  it("says so when the page count cannot be read", async () => {
    setPdfViewerEnabled(false);
    routeFetch(() => new Response("nope", { status: 403 }));
    renderLightbox();
    expect(await screen.findByText("Keine Berechtigung für diese Datei.")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Herunterladen" }).length).toBeGreaterThan(1);
  });

  it("shows a text file inline", async () => {
    routeFetch((url) =>
      url.endsWith("/api/files/14/preview")
        ? new Response("L1 = 230 V\nN = 0 V", { status: 200, headers: { "Content-Type": "text/plain" } })
        : undefined,
    );
    renderLightbox({
      files: [{ id: 14, file_name: "messung.txt", content_type: "text/plain; charset=utf-8" }],
      index: 0,
    });
    const pre = await screen.findByText(/L1 = 230 V/);
    expect(pre.tagName).toBe("PRE");
  });

  it("offers download instead of a preview for other types, still inside the sequence", () => {
    renderLightbox({ index: 2 });
    expect(screen.getByText("Keine Vorschau für diesen Dateityp")).toBeInTheDocument();
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: "Herunterladen" });
    expect(links.length).toBeGreaterThan(1);
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/\/api\/files\/13\/download$/);
      expect(link).toHaveAttribute("download", "Export.zip");
    }
  });

  it("renders Löschen only when asked to, and hands it the open file", async () => {
    renderLightbox();
    expect(screen.queryByRole("button", { name: "Löschen" })).not.toBeInTheDocument();

    const onDelete = vi.fn(async () => undefined);
    renderLightbox({ onDelete });
    fireEvent.click(screen.getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(FILES[1]));
  });

  it("hides the arrows and the counter for a single file", () => {
    renderLightbox({ files: [FILES[0]], index: 0 });
    expect(screen.queryByRole("button", { name: "Nächste Datei" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vorherige Datei" })).not.toBeInTheDocument();
    expect(screen.queryByText("1 / 1")).not.toBeInTheDocument();
  });

  it("locks body scroll, takes focus, and gives both back on close", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    try {
      const { unmount } = renderLightbox();
      expect(document.body.style.overflow).toBe("hidden");
      expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
      unmount();
      expect(document.body.style.overflow).toBe("");
      expect(trigger).toHaveFocus();
    } finally {
      trigger.remove();
    }
  });

  it("fetches a framed PDF with the bearer token in the native shell", async () => {
    surface.native = true;
    window.localStorage.setItem("smpl_token", "t0k3n");
    routeFetch((url) => (url.endsWith("/api/files/12/preview") ? bytesResponse("application/pdf") : undefined));
    renderLightbox();
    expect(screen.getByText("Wird geladen…")).toBeInTheDocument();
    const frame = await screen.findByTitle("Bericht.pdf");
    expect(frame.getAttribute("src")).toMatch(/^blob:/);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer t0k3n");
  });

  it("exposes the URL helpers and the previewable predicate", () => {
    expect(filePreviewUrl(5)).toBe("/api/files/5/preview");
    expect(fileDownloadUrl(5)).toBe("/api/files/5/download");
    expect(isLightboxPreviewable("image/png")).toBe(true);
    expect(isLightboxPreviewable("application/pdf")).toBe(true);
    expect(isLightboxPreviewable("text/plain; charset=utf-8")).toBe(true);
    expect(isLightboxPreviewable("TEXT/CSV")).toBe(true);
    expect(isLightboxPreviewable("application/zip")).toBe(false);
    expect(isLightboxPreviewable("")).toBe(false);
  });
});
