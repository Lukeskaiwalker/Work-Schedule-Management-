/**
 * The Schrank tab's one sheet stack (docs/PANEL_ENCLOSURE.md §11): RailSheet
 * → DeviceInspector → Palette / RailPicker, one backdrop, and back, Escape
 * or a tap on the backdrop always closes only the top sheet — closing the
 * inspector lands on the RailSheet it came from, not on the bare drawing.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";

import { SheetBackdrop, SheetFrame } from "../components/schaltplan/enclosure/EnclosureSheetFrame";
import { useSheetStack, type EnclosureSheet } from "../components/schaltplan/enclosure/useSheetStack";

const rail: EnclosureSheet = { kind: "rail", moduleId: "mod-a", railKey: "r1", deviceId: null };
const inspector: EnclosureSheet = { kind: "inspector", deviceId: "dev-1" };
const picker: EnclosureSheet = { kind: "rail-picker", deviceId: "dev-1" };

function pressEscape(init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe("useSheetStack", () => {
  it("pushes, pops and reports the top", () => {
    const { result } = renderHook(() => useSheetStack());
    expect(result.current.top).toBeNull();
    expect(result.current.depth).toBe(0);
    act(() => result.current.push(rail));
    act(() => result.current.push(inspector));
    expect(result.current.depth).toBe(2);
    expect(result.current.top).toEqual(inspector);
    act(() => result.current.pop());
    expect(result.current.top).toEqual(rail);
    act(() => result.current.pop());
    act(() => result.current.pop());
    expect(result.current.depth).toBe(0);
  });

  it("never edits the list it handed out", () => {
    const { result } = renderHook(() => useSheetStack());
    act(() => result.current.push(rail));
    const before = result.current.entries;
    act(() => result.current.push(inspector));
    expect(before).toEqual([rail]);
    expect(result.current.entries).not.toBe(before);
  });

  it("replaces the top, resets to one sheet and closes everything", () => {
    const { result } = renderHook(() => useSheetStack());
    act(() => result.current.push(rail));
    act(() => result.current.push(inspector));
    act(() => result.current.replaceTop(picker));
    expect(result.current.entries).toEqual([rail, picker]);
    act(() => result.current.reset(inspector));
    expect(result.current.entries).toEqual([inspector]);
    act(() => result.current.close());
    expect(result.current.entries).toEqual([]);
    act(() => result.current.replaceTop(rail));
    expect(result.current.entries).toEqual([rail]);
  });

  it("drops sheets whose target is gone", () => {
    const { result } = renderHook(() => useSheetStack());
    act(() => result.current.push(rail));
    act(() => result.current.push(inspector));
    act(() => result.current.removeWhere((entry) => entry.kind === "inspector" && entry.deviceId === "dev-1"));
    expect(result.current.entries).toEqual([rail]);
  });

  it("Escape closes only the top sheet", () => {
    const { result } = renderHook(() => useSheetStack());
    act(() => result.current.push(rail));
    act(() => result.current.push(inspector));
    const event = pressEscape();
    expect(event.defaultPrevented).toBe(true);
    expect(result.current.entries).toEqual([rail]);
    pressEscape();
    expect(result.current.depth).toBe(0);
  });

  it("leaves Escape alone with nothing open, while composing, or when someone else took it", () => {
    const { result } = renderHook(() => useSheetStack());
    expect(pressEscape().defaultPrevented).toBe(false);
    act(() => result.current.push(rail));
    pressEscape({ isComposing: true });
    expect(result.current.depth).toBe(1);
    const taken = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    taken.preventDefault();
    act(() => {
      window.dispatchEvent(taken);
    });
    expect(result.current.depth).toBe(1);
  });

  it("leaves an Escape typed into a text field to the field", () => {
    const { result } = renderHook(() => useSheetStack());
    act(() => result.current.push(rail));
    for (const make of [
      () => document.createElement("input"),
      () => document.createElement("textarea"),
      () => Object.assign(document.createElement("input"), { type: "search" }),
      () => document.createElement("select"),
      () => {
        const editable = document.createElement("div");
        editable.setAttribute("contenteditable", "true");
        return editable;
      },
    ]) {
      const field = make();
      document.body.append(field);
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      act(() => {
        field.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(result.current.depth).toBe(1);
      field.remove();
    }
  });

  it("still goes back on an Escape from a checkbox or a button", () => {
    const { result } = renderHook(() => useSheetStack());
    act(() => result.current.push(rail));
    act(() => result.current.push(inspector));
    const box = Object.assign(document.createElement("input"), { type: "checkbox" });
    document.body.append(box);
    act(() => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(result.current.depth).toBe(1);
    box.remove();
  });

  it("lets the top sheet take over ‹, Escape and the backdrop while it has its own way back", () => {
    const { result } = renderHook(() => useSheetStack());
    act(() => result.current.push(rail));
    act(() => result.current.push(inspector));
    const ownBack = vi.fn();
    act(() => result.current.setBackHandler(ownBack));
    expect(pressEscape().defaultPrevented).toBe(true);
    act(() => result.current.back());
    expect(ownBack).toHaveBeenCalledTimes(2);
    expect(result.current.depth).toBe(2);
    // pop() is the stack's own move and is never intercepted.
    act(() => result.current.pop());
    expect(result.current.depth).toBe(1);
    act(() => result.current.setBackHandler(null));
    act(() => result.current.back());
    expect(result.current.depth).toBe(0);
    expect(ownBack).toHaveBeenCalledTimes(2);
  });

  it("stops listening once unmounted", () => {
    const { result, unmount } = renderHook(() => useSheetStack());
    act(() => result.current.push(rail));
    unmount();
    expect(pressEscape().defaultPrevented).toBe(false);
  });
});

function StackHost() {
  const stack = useSheetStack();
  const top = stack.top;
  return (
    <div>
      <button type="button" onClick={() => stack.push(rail)}>
        Hutschiene öffnen
      </button>
      {top ? <SheetBackdrop onDismiss={stack.pop} /> : null}
      {top?.kind === "rail" ? (
        <SheetFrame title="F1 · Verteiler 1" onBack={stack.depth > 1 ? stack.pop : undefined} onClose={stack.close}>
          <button type="button" onClick={() => stack.push(inspector)}>
            F1.1
          </button>
        </SheetFrame>
      ) : null}
      {top?.kind === "inspector" ? (
        <SheetFrame title="Leitungsschutzschalter" onBack={stack.pop} onClose={stack.close}>
          <p>Gerät</p>
        </SheetFrame>
      ) : null}
    </div>
  );
}

describe("one stack, one backdrop", () => {
  it("shows one backdrop and the top sheet only; back returns to the rail", () => {
    const { container } = render(<StackHost />);
    fireEvent.click(screen.getByText("Hutschiene öffnen"));
    fireEvent.click(screen.getByText("F1.1"));
    expect(container.querySelectorAll(".sp-sheet-backdrop")).toHaveLength(1);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Leitungsschutzschalter" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zurück" }));
    expect(screen.getByRole("dialog", { name: "F1 · Verteiler 1" })).toBeInTheDocument();
    // The first sheet has nowhere to go back to.
    expect(screen.queryByRole("button", { name: "Zurück" })).toBeNull();
  });

  it("a tap on the backdrop closes the top sheet; × closes the stack", () => {
    const { container } = render(<StackHost />);
    fireEvent.click(screen.getByText("Hutschiene öffnen"));
    fireEvent.click(screen.getByText("F1.1"));
    fireEvent.click(container.querySelector(".sp-sheet-backdrop")!);
    expect(screen.getByRole("dialog", { name: "F1 · Verteiler 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("F1.1"));
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector(".sp-sheet-backdrop")).toBeNull();
  });
});
