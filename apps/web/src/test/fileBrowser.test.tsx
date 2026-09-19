/**
 * The shared file browser. The project files tab and the customer files
 * card render their rows and tiles through it, so what is pinned here is
 * what both rely on: every folder collapsed with an honest count, the flat
 * list a search produces, the exact sequence a click hands to the viewer,
 * the same files as tiles, and "Löschen" only where the host may delete.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FileBrowser, type FileBrowserProps } from "../components/files/FileBrowser";
import type { StoredFile } from "../types";

const KEYS = {
  viewMode: "smpl_test_files_view_mode",
  gallerySize: "smpl_test_files_gallery_size",
};

function file(id: number, file_name: string, folder: string, content_type = "image/jpeg"): StoredFile {
  return { id, project_id: 1, folder, file_name, content_type, created_at: "2026-09-17T10:00:00" };
}

const NOTIZ = file(1, "Notiz.txt", "", "text/plain");
const BERICHT = file(2, "Bericht.pdf", "Berichte", "application/pdf");
const ZAEHLER = file(3, "Zählerschrank.jpg", "Bilder");
const KABEL = file(4, "Kabelweg.jpg", "Bilder");
/** API order, newest first — deliberately not the grouped order. */
const ROWS: StoredFile[] = [KABEL, ZAEHLER, BERICHT, NOTIZ];

function renderBrowser(overrides: Partial<FileBrowserProps> = {}) {
  const props: FileBrowserProps = {
    rows: ROWS,
    query: "",
    onQueryChange: vi.fn(),
    storageKeys: KEYS,
    language: "de",
    title: "Dateien",
    onOpen: vi.fn(),
    ...overrides,
  };
  const view = render(<FileBrowser {...props} />);
  return { ...props, ...view };
}

function folderNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".file-browser-folder")).map(
    (folder) => folder.querySelector(".file-folder-name")?.textContent ?? "",
  );
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByRole("button", { name }).closest(".file-browser-row");
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${name}`);
  return row;
}

beforeEach(() => {
  window.localStorage.removeItem(KEYS.viewMode);
  window.localStorage.removeItem(KEYS.gallerySize);
});

describe("FileBrowser", () => {
  it("shows every folder collapsed, root first, with its count", () => {
    const { container } = renderBrowser();
    expect(folderNames(container)).toEqual(["📁 Hauptordner", "📁 Berichte", "📁 Bilder"]);
    for (const folder of container.querySelectorAll(".file-browser-folder")) {
      expect(folder).toHaveAttribute("aria-expanded", "false");
    }
    expect(screen.getByRole("button", { name: /Bilder/ })).toHaveTextContent("2 Dateien");
    expect(screen.getByRole("button", { name: /Berichte/ })).toHaveTextContent("1 Datei");
    expect(screen.queryByText("Kabelweg.jpg")).not.toBeInTheDocument();
  });

  it("opens a folder on click and closes it again", () => {
    renderBrowser();
    const bilder = screen.getByRole("button", { name: /Bilder/ });
    fireEvent.click(bilder);
    expect(bilder).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Kabelweg.jpg" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zählerschrank.jpg" })).toBeInTheDocument();
    fireEvent.click(bilder);
    expect(screen.queryByRole("button", { name: "Kabelweg.jpg" })).not.toBeInTheDocument();
  });

  it("flattens to the matching rows while searching, without folders", () => {
    const { container } = renderBrowser({ query: "bericht" });
    expect(folderNames(container)).toEqual([]);
    expect(screen.getByRole("button", { name: "Bericht.pdf" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kabelweg.jpg" })).not.toBeInTheDocument();
  });

  it("says so when the search matches nothing", () => {
    renderBrowser({ query: "gibt es nicht" });
    expect(screen.getByText("Keine Treffer")).toBeInTheDocument();
  });

  it("hands the viewer the clicked file and the displayed sequence, in group order", () => {
    const { onOpen } = renderBrowser();
    fireEvent.click(screen.getByRole("button", { name: /Bilder/ }));
    fireEvent.click(screen.getByRole("button", { name: "Zählerschrank.jpg" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(ZAEHLER, [NOTIZ, BERICHT, KABEL, ZAEHLER]);
  });

  it("hands the viewer the search results as the sequence", () => {
    const { onOpen } = renderBrowser({ query: "jpg" });
    fireEvent.click(within(rowOf("Kabelweg.jpg")).getByRole("button", { name: "Vorschau" }));
    expect(onOpen).toHaveBeenCalledWith(KABEL, [KABEL, ZAEHLER]);
  });

  it("keeps a real download link on every row", () => {
    renderBrowser({ query: "notiz" });
    const link = within(rowOf("Notiz.txt")).getByRole("link", { name: "Download" });
    expect(link).toHaveAttribute("href", "/api/files/1/download");
    expect(link).toHaveAttribute("download", "Notiz.txt");
  });

  it("renders a tile per file in gallery view and remembers the choice", () => {
    const { container, onOpen } = renderBrowser();
    fireEvent.click(screen.getByRole("tab", { name: "Galerie" }));
    expect(container.querySelectorAll(".gallery-tile")).toHaveLength(4);
    expect(window.localStorage.getItem(KEYS.viewMode)).toBe("gallery");

    fireEvent.click(screen.getByRole("tab", { name: "S" }));
    expect(window.localStorage.getItem(KEYS.gallerySize)).toBe("s");
    expect(container.querySelector(".file-gallery")).toHaveStyle({ "--gallery-tile-min": "100px" });

    fireEvent.click(screen.getByRole("button", { name: /Bericht\.pdf/ }));
    expect(onOpen).toHaveBeenCalledWith(BERICHT, ROWS);
  });

  it("starts in the remembered view", () => {
    window.localStorage.setItem(KEYS.viewMode, "gallery");
    const { container } = renderBrowser();
    expect(container.querySelectorAll(".gallery-tile")).toHaveLength(4);
  });

  it("offers Löschen only when the host may delete, and asks first", () => {
    const { rerender } = renderBrowser({ query: "bericht" });
    expect(screen.queryByRole("button", { name: "Löschen" })).not.toBeInTheDocument();

    const onDelete = vi.fn();
    rerender(
      <FileBrowser
        rows={ROWS}
        query="bericht"
        onQueryChange={vi.fn()}
        storageKeys={KEYS}
        language="de"
        title="Dateien"
        onOpen={vi.fn()}
        onDelete={onDelete}
      />,
    );
    const row = rowOf("Bericht.pdf");
    fireEvent.click(within(row).getByRole("button", { name: "Löschen" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "Abbrechen" }));
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole("button", { name: "Löschen" }));
    fireEvent.click(within(row).getByRole("button", { name: "Löschen" }));
    expect(onDelete).toHaveBeenCalledWith(BERICHT);
  });

  it("shows the upload button and takes a drop only with their handlers", () => {
    const { container, rerender } = renderBrowser();
    expect(screen.queryByRole("button", { name: "Datei hochladen" })).not.toBeInTheDocument();

    const onUpload = vi.fn();
    const onDropFiles = vi.fn();
    rerender(
      <FileBrowser
        rows={ROWS}
        query=""
        onQueryChange={vi.fn()}
        storageKeys={KEYS}
        language="de"
        title="Dateien"
        onOpen={vi.fn()}
        onUpload={onUpload}
        onDropFiles={onDropFiles}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Datei hochladen" }));
    expect(onUpload).toHaveBeenCalledTimes(1);

    const card = container.querySelector(".file-browser");
    if (!card) throw new Error("no browser card");
    const dropped = new File(["x"], "Plan.pdf", { type: "application/pdf" });
    fireEvent.drop(card, { dataTransfer: { files: [dropped], types: ["Files"] } });
    expect(onDropFiles).toHaveBeenCalledWith([dropped]);
    // Text dragged across the page is not an upload.
    fireEvent.drop(card, { dataTransfer: { files: [], types: ["text/plain"] } });
    expect(onDropFiles).toHaveBeenCalledTimes(1);
  });

  it("passes the search on and reports the status instead of rows", () => {
    const onQueryChange = vi.fn();
    const onRetry = vi.fn();
    const { rerender } = renderBrowser({ onQueryChange });
    fireEvent.change(screen.getByRole("textbox", { name: "Datei suchen" }), {
      target: { value: "plan" },
    });
    expect(onQueryChange).toHaveBeenCalledWith("plan");

    const base = {
      rows: ROWS,
      query: "",
      onQueryChange,
      storageKeys: KEYS,
      language: "de" as const,
      title: "Dateien",
      onOpen: vi.fn(),
    };
    rerender(<FileBrowser {...base} status={{ kind: "loading", text: "Dateien werden geladen…" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Dateien werden geladen…");
    expect(screen.queryByRole("button", { name: /Bilder/ })).not.toBeInTheDocument();

    rerender(
      <FileBrowser
        {...base}
        status={{ kind: "error", text: "Dateien konnten nicht geladen werden.", detail: "403", onRetry }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Dateien konnten nicht geladen werden.");
    expect(screen.getByRole("alert")).toHaveTextContent("403");
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
