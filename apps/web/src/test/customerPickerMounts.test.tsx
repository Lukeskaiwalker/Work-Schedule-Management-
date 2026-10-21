/**
 * The customer combobox's server check, as each form that mounts it uses it.
 *
 * The combobox tests prove the mechanism; these pin the wiring, because the
 * mechanism does nothing where a form forgets to pass it:
 *
 *  - the project form and the Schaltplan picker CAN create customers, so
 *    without `searchRemote` they offer "+ Neuen Kunden anlegen" for somebody
 *    created in another browser since the list loaded — the duplicate path;
 *  - a customer found only by the server is not in `customers` yet, so a form
 *    that looks the pick up there instead of taking the picked row files it as
 *    free text (the project form then match-or-creates a second one on save,
 *    the Baustellenbericht loses the address).
 *
 * The customer is invented; the list is the complete one minus her.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { ProjectModal } from "../components/modals/ProjectModal";
import { PanelScopePicker } from "../components/schaltplan/PanelScopePicker";
import { ConstructionPage } from "../pages/ConstructionPage";
import { SchaltplanPage } from "../pages/SchaltplanPage";
import { EMPTY_REPORT_DRAFT } from "../constants";
import type { CustomerListItem, ProjectFormState } from "../types";
import { makeAppContextStub } from "./appContextStub";
import { MUSTERMANN_ID, customerRow, productionLikeCustomers } from "./fixtures/customerServer";

// The report form's signature pads draw on a canvas, which jsdom does not have.
vi.mock("../components/shared/SignaturePad", () => ({ SignaturePad: () => null }));

const CREATE_ROW = /Neuen Kunden anlegen/;
const CHECKING = "Kundenstamm wird durchsucht…";

/** Created in another browser after this one loaded its list. */
const ERIKA = customerRow(MUSTERMANN_ID, "Mustermann, Erika", {
  address: "Musterweg 1, 12345 Musterstadt",
  contact_person: "Erika Mustermann",
  email: "erika@example.com",
  phone: "0123 456789",
});
const WITHOUT_ERIKA = productionLikeCustomers(222).filter((row) => row.id !== MUSTERMANN_ID);

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A server check that answers only when told to, recording what it was asked. */
function heldSearch() {
  const answer = deferred<CustomerListItem[]>();
  const search = vi.fn((_query: string) => answer.promise);
  return { search, answer };
}

function mount(element: JSX.Element, overrides: Record<string, unknown>) {
  return render(
    <AppContext.Provider value={makeAppContextStub({ overrides }) as never}>{element}</AppContext.Provider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

const EMPTY_PROJECT_FORM: ProjectFormState = {
  project_number: "",
  name: "",
  description: "",
  status: "active",
  last_state: "",
  last_status_at: "",
  customer_id: null,
  customer_name: "",
  customer_address: "",
  construction_site_address: "",
  customer_contact: "",
  customer_email: "",
  customer_phone: "",
  use_separate_site_address: false,
  site_access_type: "",
  site_access_note: "",
  class_template_ids: [],
};

describe("project form (creates customers)", () => {
  it("waits for the server before offering to create, and links the customer it found", async () => {
    const { search, answer } = heldSearch();
    const updateProjectFormField = vi.fn();
    mount(<ProjectModal />, {
      projectModalMode: "create",
      projectForm: EMPTY_PROJECT_FORM,
      projectStatusSelectOptions: [{ value: "active", label: "Aktiv" }],
      customers: WITHOUT_ERIKA,
      searchCustomers: search,
      updateProjectFormField,
    });
    const input = screen.getByPlaceholderText("Kunde suchen oder anlegen…");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Mustermann, Erika" } });
    expect(screen.queryByText(CREATE_ROW)).toBeNull();
    await waitFor(() => expect(search).toHaveBeenCalledWith("Mustermann, Erika"));
    expect(screen.getByText(CHECKING)).toBeInTheDocument();
    expect(screen.queryByText(CREATE_ROW)).toBeNull();

    await act(async () => answer.resolve([ERIKA]));
    const hit = await screen.findByText("Mustermann, Erika");
    expect(screen.queryByText(CREATE_ROW)).toBeNull();

    updateProjectFormField.mockClear();
    fireEvent.mouseDown(hit);
    const written = Object.fromEntries(updateProjectFormField.mock.calls);
    expect(written).toMatchObject({
      customer_id: MUSTERMANN_ID,
      customer_name: "Mustermann, Erika",
      customer_address: "Musterweg 1, 12345 Musterstadt",
      customer_contact: "Erika Mustermann",
      customer_email: "erika@example.com",
      customer_phone: "0123 456789",
    });
  });
});

describe("Baustellenbericht (cannot create customers)", () => {
  it("finds a customer the list lacks and hands the picked row to the report", async () => {
    const search = vi.fn(async (query: string) => (query.toLowerCase().includes("mustermann") ? [ERIKA] : []));
    const applyReportCustomerSelection = vi.fn();
    mount(<ConstructionPage />, {
      mainView: "construction",
      customers: WITHOUT_ERIKA,
      searchCustomers: search,
      applyReportCustomerSelection,
      reportCustomerId: null,
      reportDraft: EMPTY_REPORT_DRAFT,
      reportProjectId: "",
      // Read field by field further down the form; the stub cannot guess their shapes.
      reportStatus: {
        arrival_completed: false,
        work_finished: false,
        handed_over_clean: false,
        further_work_needed: false,
        extra_material_used: false,
        note: "",
      },
      reportDistance: { kilometers: null, source: "unset" },
      reportSignatureSmpl: { name: "", image_base64: "" },
      reportSignatureCustomer: { name: "", image_base64: "" },
    });
    const input = screen.getByPlaceholderText("Kunde suchen oder eintippen…");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Mustermann" } });
    const hit = await screen.findByText("Mustermann, Erika");
    expect(search).toHaveBeenCalledWith("Mustermann");
    expect(screen.queryByText(CREATE_ROW)).toBeNull();

    applyReportCustomerSelection.mockClear();
    fireEvent.mouseDown(hit);
    expect(applyReportCustomerSelection).toHaveBeenCalledWith(
      MUSTERMANN_ID,
      "Mustermann, Erika",
      expect.objectContaining({ id: MUSTERMANN_ID, address: "Musterweg 1, 12345 Musterstadt" }),
    );
  });
});

describe("Schaltplan scope picker (creates customers)", () => {
  function renderPicker(searchCustomers: (query: string) => Promise<CustomerListItem[]>, onCustomerChange = vi.fn()) {
    render(
      <PanelScopePicker
        language="de"
        customers={WITHOUT_ERIKA}
        projects={[]}
        customerId={null}
        projectId={null}
        onCustomerChange={onCustomerChange}
        onProjectChange={vi.fn()}
        onRequestCreateCustomer={vi.fn()}
        searchCustomers={searchCustomers}
        panels={[]}
        activePanelId={null}
        onSelectPanel={vi.fn()}
        onNewPanel={vi.fn()}
        canEdit
        loading={false}
      />,
    );
    return { onCustomerChange, input: screen.getByPlaceholderText("Kunde suchen…") };
  }

  it("hands its server search to the combobox: no create row until the server has answered", async () => {
    const { search, answer } = heldSearch();
    const { input, onCustomerChange } = renderPicker(search);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Mustermann, Erika" } });
    await waitFor(() => expect(search).toHaveBeenCalledWith("Mustermann, Erika"));
    expect(screen.queryByText(CREATE_ROW)).toBeNull();

    await act(async () => answer.resolve([ERIKA]));
    fireEvent.mouseDown(await screen.findByText("Mustermann, Erika"));
    expect(screen.queryByText(CREATE_ROW)).toBeNull();
    expect(onCustomerChange).toHaveBeenCalledWith(MUSTERMANN_ID);
  });

  it("is given the context's search by the Schaltplan page", async () => {
    const { search } = heldSearch();
    mount(<SchaltplanPage />, { mainView: "schaltplan", customers: WITHOUT_ERIKA, searchCustomers: search });
    const input = await screen.findByPlaceholderText("Kunde suchen…");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Mustermann, Erika" } });

    await waitFor(() => expect(search).toHaveBeenCalledWith("Mustermann, Erika"));
    expect(screen.queryByText(CREATE_ROW)).toBeNull();
  });
});
