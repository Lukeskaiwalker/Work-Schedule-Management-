/**
 * The Schrank toolbar (docs/PANEL_ENCLOSURE.md §11): Offen / Geschlossen /
 * 3D, stepped zoom buttons (gloves: no pinch needed), Reihen ordnen, and
 * Aufbau als PDF — a real link whose tap the tab routes through
 * `savedPdfClick`, carrying the in-app viewer opt-out like every PDF link.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { EnclosureToolbar, type EnclosureToolbarProps } from "../components/schaltplan/enclosure/EnclosureToolbar";
import { ENCLOSURE_ZOOM_STEPS } from "../components/schaltplan/enclosure/enclosureFrontLayout";
import { OWN_OPENER_ATTR } from "../native/fileOpen";

function setup(overrides: Partial<EnclosureToolbarProps> = {}) {
  const props: EnclosureToolbarProps = {
    view: "open",
    onViewChange: vi.fn(),
    zoomStep: 2,
    onZoomStepChange: vi.fn(),
    onOrderRows: vi.fn(),
    rowsInOrder: false,
    pdfHref: "/api/schaltplan/panels/12/aufbau/pdf",
    onPdfClick: vi.fn(),
    ...overrides,
  };
  render(<EnclosureToolbar {...props} />);
  return props;
}

describe("EnclosureToolbar", () => {
  it("switches between Offen, Geschlossen and 3D and says which is on", () => {
    const props = setup({ view: "closed" });
    expect(screen.getByRole("button", { name: "Geschlossen" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Offen" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "3D" }));
    expect(props.onViewChange).toHaveBeenCalledWith("3d");
    fireEvent.click(screen.getByRole("button", { name: "Offen" }));
    expect(props.onViewChange).toHaveBeenLastCalledWith("open");
  });

  it("zooms one step at a time", () => {
    const props = setup({ zoomStep: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Vergrößern" }));
    expect(props.onZoomStepChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole("button", { name: "Verkleinern" }));
    expect(props.onZoomStepChange).toHaveBeenLastCalledWith(1);
    expect(screen.getByText(`3 / ${ENCLOSURE_ZOOM_STEPS.length}`)).toBeInTheDocument();
  });

  it("stops at either end of the steps", () => {
    setup({ zoomStep: 0 });
    expect(screen.getByRole("button", { name: "Verkleinern" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Vergrößern" })).toBeEnabled();
  });

  it("stops at the largest step", () => {
    setup({ zoomStep: ENCLOSURE_ZOOM_STEPS.length - 1 });
    expect(screen.getByRole("button", { name: "Vergrößern" })).toBeDisabled();
  });

  it("has no 2D zoom in 3D (the 3D view brings its own)", () => {
    setup({ view: "3d" });
    expect(screen.queryByRole("button", { name: "Vergrößern" })).toBeNull();
    expect(screen.getByRole("button", { name: "3D" })).toHaveAttribute("aria-pressed", "true");
  });

  it("orders the rows on request", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Reihen ordnen" }));
    expect(props.onOrderRows).toHaveBeenCalledTimes(1);
  });

  it("says on the button that the rows are in cabinet order, and offers nothing to tap", () => {
    // A tablet shows no title tooltip: the disabled button's own label is the reason.
    setup({ rowsInOrder: true });
    expect(screen.queryByRole("button", { name: "Reihen ordnen" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reihen geordnet" })).toBeDisabled();
  });

  it("hides Reihen ordnen on a read-only board", () => {
    setup({ onOrderRows: null });
    expect(screen.queryByRole("button", { name: "Reihen ordnen" })).toBeNull();
  });

  it("offers the Aufbau PDF as a link that opts out of the in-app viewer and hands the tap to the tab", () => {
    const props = setup();
    const link = screen.getByRole("link", { name: "Aufbau als PDF" });
    expect(link).toHaveAttribute("href", "/api/schaltplan/panels/12/aufbau/pdf");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(link).toHaveAttribute(OWN_OPENER_ATTR);
    fireEvent.click(link);
    expect(props.onPdfClick).toHaveBeenCalledTimes(1);
  });
});
