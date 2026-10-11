/**
 * Text made outside a render still follows the UI language.
 *
 * Error fallbacks (`err.message ?? "Failed to load data"`), the transport
 * messages of a dropped upload ("Network request failed") and the crash
 * screen all reached the German UI in English. They read the language from
 * <html lang>, which App keeps in step with its own state.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ApiError } from "../api/client";
import { AppErrorBoundary } from "../components/AppErrorBoundary";
import { connectionErrorText } from "../utils/connectionError";
import { uiText } from "../utils/uiLanguage";

afterEach(() => {
  document.documentElement.lang = "";
});

describe("uiText", () => {
  it("picks German unless the page says English", () => {
    document.documentElement.lang = "de";
    expect(uiText("Daten konnten nicht geladen werden", "Failed to load data")).toBe("Daten konnten nicht geladen werden");
    document.documentElement.lang = "";
    expect(uiText("Ja", "Yes")).toBe("Ja");
    document.documentElement.lang = "en";
    expect(uiText("Ja", "Yes")).toBe("Yes");
  });
});

describe("connectionErrorText", () => {
  it("says a dropped connection in German instead of the XHR's English", () => {
    document.documentElement.lang = "de";
    const dropped = new ApiError("Network request failed", 0, null, null, "network");
    expect(connectionErrorText(dropped)).toBe(
      "Verbindung unterbrochen — bitte die Verbindung prüfen und erneut versuchen.",
    );
    const aborted = new ApiError("Upload aborted", 0, null, null, "abort");
    expect(connectionErrorText(aborted)).toBe("Hochladen abgebrochen.");
  });

  it("leaves a server's own answer to the caller", () => {
    expect(connectionErrorText(new ApiError("Datei zu groß", 413, "Datei zu groß"))).toBeNull();
    expect(connectionErrorText(new Error("boom"))).toBeNull();
    expect(connectionErrorText("boom")).toBeNull();
    expect(connectionErrorText(null)).toBeNull();
  });

  it("speaks English in the English UI", () => {
    document.documentElement.lang = "en";
    expect(connectionErrorText(new ApiError("Network request failed", 0, null, null, "network"))).toBe(
      "Connection lost — check the connection and try again.",
    );
  });
});

describe("the crash screen", () => {
  function Boom(): never {
    throw new Error("render failed");
  }

  it("is German in the German UI", () => {
    document.documentElement.lang = "de";
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    quiet.mockRestore();
    expect(screen.getByRole("heading", { name: "Etwas ist schiefgelaufen." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "App neu laden" })).toBeInTheDocument();
  });
});
