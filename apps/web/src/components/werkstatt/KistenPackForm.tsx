/**
 * The assign card of a crate that is not packed yet: who it is for, which of
 * their jobs it goes to, and "Packen & zuweisen".
 *
 * Split out of WerkstattKistenPage (already far past a focused size) so the
 * project rules sit next to the select that shows them. The page keeps the
 * state, because refetching the crate decides when it is reset.
 *
 * The project is optional but not decoration: the handover books its checkout
 * under the crate's project, and that is what puts the material under "Auf der
 * Baustelle" for the site. A crate packed without one is booked to nobody's site.
 */
import { CustomerCombobox, type CustomerComboboxValue } from "../customers/CustomerCombobox";
import { openProjectsForCustomer, projectOptionLabel, soleOpenProjectId } from "../../utils/boxes";
import type { CustomerListItem, Project } from "../../types";

/** Who the crate is being packed for, as chosen on the card. */
export type BoxAssignment = {
  customerId: number | null;
  /** Shown when `customers` does not hold the customer — a crate's own `customer_name`, or a server hit. */
  customerName: string;
  projectId: number | null;
};

/** The body of POST /werkstatt/boxes/{id}/pack. */
export type BoxPackPayload = { customer_id: number; project_id: number | null };

type Props = {
  language: "de" | "en";
  /** The complete active list (AppContext `customers`). */
  customers: CustomerListItem[];
  /** All projects (AppContext `projects`); only the customer's open ones are offered. */
  projects: Project[];
  /**
   * `projects` is every project (`seesEveryProject`). For an employee GET
   * /projects holds only their own jobs: the one they see may be one of
   * several, and "none" may only mean none of theirs. Anyone may pack, so the
   * form then neither picks the job nor says the customer has none.
   */
  allProjectsVisible: boolean;
  /** AppContext `searchCustomers`: finds a customer created since the list loaded. */
  searchCustomers: (query: string) => Promise<CustomerListItem[]>;
  value: BoxAssignment;
  onChange: (next: BoxAssignment) => void;
  /** Open and not empty — the only state with an offen → gepackt edge. */
  packable: boolean;
  onPack: (payload: BoxPackPayload) => void;
  /** Back from the site: it has to be re-opened before it can be packed again. */
  returned: boolean;
  onReopen: () => void;
  /** Open and empty. */
  empty: boolean;
};

/** The select's first line: what choosing nothing means right now. */
function emptyProjectOptionLabel(
  de: boolean,
  customerChosen: boolean,
  hasOptions: boolean,
  allProjectsVisible: boolean,
): string {
  if (!customerChosen) return de ? "Erst Kunde wählen" : "Choose a customer first";
  if (hasOptions) return de ? "Ohne Projekt" : "No project";
  // "None open" is a claim about the customer, and a packer's list holds
  // only their own jobs — it can only say that it shows none.
  if (!allProjectsVisible) return de ? "Keine Projekte sichtbar" : "No projects visible";
  return de ? "Keine offenen Projekte" : "No open projects";
}

export function KistenPackForm({
  language,
  customers,
  projects,
  allProjectsVisible,
  searchCustomers,
  value,
  onChange,
  packable,
  onPack,
  returned,
  onReopen,
  empty,
}: Props) {
  const de = language === "de";
  const options = openProjectsForCustomer(projects, value.customerId);
  // What the select shows is what gets sent. A project that is not among the
  // options (a crate's old job, archived since) is dropped rather than sent
  // unseen — and the server would refuse another customer's anyway.
  const projectId = options.some((option) => option.id === value.projectId) ? value.projectId : null;
  const emptyOptionLabel = emptyProjectOptionLabel(de, value.customerId != null, options.length > 0, allProjectsVisible);

  function changeCustomer(next: CustomerComboboxValue) {
    if (next.customerId === value.customerId) {
      onChange({ ...value, customerName: next.customerName });
      return;
    }
    // A new customer never inherits the last one's job. One open job is
    // almost always the one the crate is for, so it is chosen; with several
    // the packer has to say which — and so does a packer whose list may be
    // missing the others.
    onChange({
      customerId: next.customerId,
      customerName: next.customerName,
      projectId: allProjectsVisible ? soleOpenProjectId(projects, next.customerId) : null,
    });
  }

  function pack() {
    if (value.customerId == null) return;
    onPack({ customer_id: value.customerId, project_id: projectId });
  }

  return (
    <>
      <div className="werkstatt-field">
        <span className="werkstatt-field-label">{de ? "Kunde" : "Customer"}</span>
        {/* No onRequestCreate: this card cannot create a customer, and a row
            that did nothing looked like the way out for somebody the list
            could not find. The server check finds them instead. */}
        <CustomerCombobox
          language={language}
          customers={customers}
          value={{ customerId: value.customerId, customerName: value.customerName }}
          onChange={changeCustomer}
          searchRemote={searchCustomers}
          placeholder={de ? "Kunde wählen…" : "Choose a customer…"}
        />
      </div>
      <label className="werkstatt-field">
        <span className="werkstatt-field-label">{de ? "Projekt (optional)" : "Project (optional)"}</span>
        <select
          className="werkstatt-field-select"
          value={projectId ?? ""}
          disabled={options.length === 0}
          onChange={(event) =>
            onChange({ ...value, projectId: event.target.value ? Number(event.target.value) : null })
          }
        >
          <option value="">{emptyOptionLabel}</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {projectOptionLabel(option)}
            </option>
          ))}
        </select>
      </label>
      {!allProjectsVisible && value.customerId != null && (
        <p className="kisten-action-hint">
          {de
            ? "Es werden nur Projekte angezeigt, auf die du Zugriff hast."
            : "Only projects you have access to are shown."}
        </p>
      )}
      <div className="kisten-action-row">
        <button
          type="button"
          className="werkstatt-action-btn werkstatt-action-btn--primary"
          onClick={pack}
          disabled={!packable || value.customerId == null}
        >
          {de ? "Packen & zuweisen" : "Pack & assign"}
        </button>
        {returned && (
          <button type="button" className="werkstatt-action-btn" onClick={onReopen}>
            {de ? "Erneut öffnen" : "Re-open"}
          </button>
        )}
      </div>
      {returned ? (
        /* A returned crate cannot be packed — the FSM has no zurueck → gepackt
           edge, so the only honest button here is the one that re-opens it. */
        <p className="kisten-action-hint">
          {de
            ? "Die Kiste ist zurück – erst „Erneut öffnen“, dann packen."
            : "The box is back — re-open it before packing it again."}
        </p>
      ) : (
        <p className="kisten-action-hint">
          {de
            ? "Beim Zuweisen wird noch kein Bestand gebucht – erst bei der Übergabe."
            : "Assigning books no stock — the handover does."}
        </p>
      )}
      {empty && (
        <p className="kisten-note kisten-note--muted">
          {de ? "Erst packen, dann zuweisen." : "Pack the box before assigning it."}
        </p>
      )}
    </>
  );
}
