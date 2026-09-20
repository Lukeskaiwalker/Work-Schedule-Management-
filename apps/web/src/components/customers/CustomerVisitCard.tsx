/**
 * "Kundenbesuche" on the customer page: the customer's visit feed.
 *
 * Whoever goes out to the customer writes a few lines about it. Each
 * entry may be linked to one of the customer's projects — then it opens
 * that project's Projektbericht — or to none, and then it opens every
 * Projektbericht of the customer. The feed replaced the single visit text
 * on the customer row that every new appointment overwrote.
 *
 * The card fetches its own list, newest posted first, and the answer of a
 * post, an edit or a delete is folded into the list in place: no refetch,
 * because the server does not page this feed. The composer opens at the
 * top on "Besuch erfassen"; an entry's edit opens inline in its row, with
 * the same form. Editing and deleting is for the named visitor or a
 * project manager — the same rule the note feed applies to its delete.
 */
import { useEffect, useRef, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import type { CustomerVisit } from "../../types";
import {
  deleteCustomerVisit,
  listCustomerVisits,
  postCustomerVisit,
  updateCustomerVisit,
  type CustomerProjectSummary,
} from "../../utils/customersApi";
import { CustomerVisitEntry } from "./CustomerVisitEntry";
import {
  CustomerVisitForm,
  EMPTY_VISIT_DRAFT,
  visitWriteFromDraft,
  type CustomerVisitDraft,
  type CustomerVisitWrite,
} from "./CustomerVisitForm";
import "../../styles/customer-detail.css";

type Props = {
  customerId: number;
  projects: CustomerProjectSummary[];
  language: "de" | "en";
};

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function CustomerVisitCard({ customerId, projects, language }: Props) {
  const { token, user, canCreateProject, setError, setNotice } = useAppContext();
  const de = language === "de";

  const [visits, setVisits] = useState<CustomerVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  // Which customer the in-flight requests belong to. A switch to another
  // customer bumps it, and a late answer for the old one is dropped instead
  // of landing in the new feed — together with any half-written form.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const ticket = generation.current;
    setVisits([]);
    setComposing(false);
    setEditingId(null);
    setLoadError(null);
    setLoading(true);

    listCustomerVisits(token, customerId)
      .then((list) => {
        if (generation.current !== ticket) return;
        setVisits(list);
      })
      .catch((err: unknown) => {
        if (generation.current !== ticket) return;
        setLoadError(messageOf(err, de ? "Kundenbesuche konnten nicht geladen werden" : "Failed to load customer visits"));
      })
      .finally(() => {
        if (generation.current !== ticket) return;
        setLoading(false);
      });

    return () => {
      generation.current += 1;
    };
  }, [customerId, token, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function canEdit(visit: CustomerVisit): boolean {
    const own = visit.visit_by_user_id != null && visit.visit_by_user_id === user?.id;
    return own || canCreateProject;
  }

  /** The draft trimmed and typed, or null with the refusal already reported. */
  function writeFrom(draft: CustomerVisitDraft): CustomerVisitWrite | null {
    const body = visitWriteFromDraft(draft);
    if (!body.summary) {
      setError(de ? "Bitte eine Zusammenfassung des Besuchs eintragen" : "Please enter a summary of the visit");
      return null;
    }
    return body;
  }

  async function create(draft: CustomerVisitDraft) {
    if (saving) return;
    const body = writeFrom(draft);
    if (!body) return;
    const ticket = generation.current;
    setSaving(true);
    try {
      const created = await postCustomerVisit(token, customerId, body);
      if (generation.current !== ticket) return;
      setVisits((current) => [created, ...current]);
      setComposing(false);
      setNotice(de ? "Kundenbesuch gespeichert" : "Customer visit saved");
    } catch (err) {
      // The form stays open: a failed save is retried, not retyped.
      setError(messageOf(err, de ? "Kundenbesuch konnte nicht gespeichert werden" : "Failed to save customer visit"));
    } finally {
      setSaving(false);
    }
  }

  async function update(visit: CustomerVisit, draft: CustomerVisitDraft) {
    if (saving) return;
    const body = writeFrom(draft);
    if (!body) return;
    const ticket = generation.current;
    setSaving(true);
    try {
      const updated = await updateCustomerVisit(token, customerId, visit.id, body);
      if (generation.current !== ticket) return;
      setVisits((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      setEditingId(null);
      setNotice(de ? "Kundenbesuch gespeichert" : "Customer visit saved");
    } catch (err) {
      setError(messageOf(err, de ? "Kundenbesuch konnte nicht gespeichert werden" : "Failed to save customer visit"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(visit: CustomerVisit) {
    if (removingId !== null) return;
    if (!window.confirm(de ? "Diesen Kundenbesuch löschen?" : "Delete this customer visit?")) return;
    const ticket = generation.current;
    setRemovingId(visit.id);
    try {
      await deleteCustomerVisit(token, customerId, visit.id);
      if (generation.current !== ticket) return;
      setVisits((current) => current.filter((row) => row.id !== visit.id));
      setNotice(de ? "Kundenbesuch gelöscht" : "Customer visit deleted");
    } catch (err) {
      setError(messageOf(err, de ? "Kundenbesuch konnte nicht gelöscht werden" : "Failed to delete customer visit"));
    } finally {
      setRemovingId(null);
    }
  }

  function openComposer() {
    setEditingId(null);
    setComposing(true);
  }

  function startEdit(visit: CustomerVisit) {
    setComposing(false);
    setEditingId(visit.id);
  }

  const recordLabel = de ? "Besuch erfassen" : "Record visit";
  const showHeaderAction = !loading && loadError === null && !composing && visits.length > 0;

  return (
    <section className="customer-visit-card">
      <header className="customer-contact-card-head">
        <h3 className="customer-contact-card-title">{de ? "Kundenbesuche" : "Customer visits"}</h3>
        {showHeaderAction && (
          <button type="button" className="linklike" onClick={openComposer}>
            {recordLabel}
          </button>
        )}
      </header>

      {composing && (
        <div className="customer-visit-composer">
          <CustomerVisitForm
            initial={EMPTY_VISIT_DRAFT}
            projects={projects}
            language={language}
            saving={saving}
            onSubmit={(draft) => void create(draft)}
            onCancel={() => setComposing(false)}
          />
        </div>
      )}

      {loading ? (
        <small className="muted" role="status">
          {de ? "Kundenbesuche werden geladen…" : "Loading customer visits…"}
        </small>
      ) : loadError !== null ? (
        <div className="customer-visit-error" role="alert">
          <span>{de ? "Kundenbesuche konnten nicht geladen werden." : "Customer visits could not be loaded."}</span>
          <small className="muted">{loadError}</small>
          <button type="button" className="linklike" onClick={() => setReloadKey((current) => current + 1)}>
            {de ? "Erneut versuchen" : "Try again"}
          </button>
        </div>
      ) : visits.length === 0 ? (
        !composing && (
          <>
            <p className="muted customer-visit-empty">
              {de
                ? "Noch kein Besuch erfasst — was ein Termin beim Kunden ergeben hat, gehört hierher. Wird am Anfang des Projektberichts gedruckt."
                : "No visit recorded yet — what an appointment at the customer found belongs here. Printed at the head of the project report."}
            </p>
            <div className="customer-visit-actions">
              <button type="button" className="customers-action-btn" onClick={openComposer}>
                {recordLabel}
              </button>
            </div>
          </>
        )
      ) : (
        <ul className="customer-visit-list">
          {visits.map((visit) => (
            <CustomerVisitEntry
              key={`customer-visit-${visit.id}`}
              visit={visit}
              projects={projects}
              language={language}
              canEdit={canEdit(visit)}
              editing={editingId === visit.id}
              saving={saving && editingId === visit.id}
              removing={removingId === visit.id}
              onEdit={() => startEdit(visit)}
              onCancelEdit={() => setEditingId(null)}
              onSave={(draft) => void update(visit, draft)}
              onDelete={() => void remove(visit)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
