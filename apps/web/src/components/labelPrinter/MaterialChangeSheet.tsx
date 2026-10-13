/**
 * Quick flow "Material gewechselt" (docs/LABEL_PRINTER_CALIBRATION.md §7.4).
 *
 * Five steps, in the order a person works at the printer: choose the loaded
 * material → set the sensor and load → transfer settings (no paper) → sense
 * (feeds, behind a confirmation) → judge and save. The server enforces the
 * order too; the buttons gate on the session's phase TOGETHER with `applied`,
 * never on `applied` alone, so a material switch cannot skip its apply.
 *
 * The session is acquired at step 1's [Weiter] and the hook ends it on
 * unmount. Cancelling after the material was activated asks first and names
 * what already happened on the printer — nothing is rolled back.
 */
import { useCallback, useEffect, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import type { LabelPrinterOverview, Offer } from "../../types/labelPrinter";
import { apiErrorCode, apiErrorDetail, errorText } from "../../utils/labelCalibration";
import { getLabelPrinterOverview } from "../../utils/labelPrinterApi";
import { ApplyPanel } from "./ApplyPanel";
import { CalibrationSheetFrame } from "./CalibrationSheetFrame";
import { CancelCalibrationDialog } from "./CancelCalibrationDialog";
import { LoadingChecklist } from "./LoadingChecklist";
import { MaterialPickStep, type LockHolder } from "./MaterialPickStep";
import { SensePanel } from "./SensePanel";
import { canStartSensing, useCalibrationSession } from "./useCalibrationSession";
import { VerdictCard } from "./VerdictCard";
import "../../styles/label-calibration.css";

export interface MaterialChangeSheetProps {
  onClose: () => void;
  /** Material to preselect in step 1 (the admin card's row button); none from the Werkstatt page. */
  preselectId?: string | null;
}

type Step = 1 | 2 | 3 | 4 | 5;

const STEP_TITLES: Record<Step, [string, string]> = {
  1: ["Welches Material ist eingelegt?", "Which material is loaded?"],
  2: ["Sensor stellen und Material einlegen", "Set the sensor and load the media"],
  3: ["Einstellungen übertragen", "Transfer settings"],
  4: ["Einmessen", "Sense"],
  5: ["Ergebnis", "Result"],
};

export function MaterialChangeSheet({ onClose, preselectId = null }: MaterialChangeSheetProps) {
  const { token, language, setNotice } = useAppContext();
  const de = language === "de";
  const [overview, setOverview] = useState<LabelPrinterOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [staffDisabled, setStaffDisabled] = useState<string | null>(null);
  const [lockedBy, setLockedBy] = useState<LockHolder | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [selectedId, setSelectedId] = useState<string | null>(preselectId);
  const [checklistReady, setChecklistReady] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [stepError, setStepError] = useState<unknown>(null);

  const calibration = useCalibrationSession({ token, onVerdict: () => setStep(5) });
  const { session, verdict, busy } = calibration;

  useEffect(() => {
    let alive = true;
    getLabelPrinterOverview(token)
      .then((next) => {
        if (!alive) return;
        setOverview(next);
        if (!next.configured) setNotConfigured(true);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (apiErrorCode(err) === "not_configured") setNotConfigured(true);
        else setLoadError(errorText(err));
      });
    return () => {
      alive = false;
    };
  }, [token]);

  /** Shell-level reactions to codes any step can meet. */
  const onError = useCallback((err: unknown) => {
    if (apiErrorCode(err) === "not_configured") setNotConfigured(true);
  }, []);

  const onReadyChange = useCallback((ready: boolean) => setChecklistReady(ready), []);
  // The checklist starts unticked every time step 2 is entered; its old
  // "ready" must not enable [Weiter] for the frame before it reports again.
  useEffect(() => {
    if (step !== 2) setChecklistReady(false);
  }, [step]);

  const materials = overview?.materials ?? [];
  const selected = materials.find((m) => m.id === selectedId) ?? null;
  const subject = materials.find((m) => m.id === session?.material_id) ?? selected;
  const foreignSession = overview?.session && !overview.session.mine ? overview.session : null;
  // Once this sheet holds its own session (e.g. after a takeover), the
  // overview's snapshot of someone else's session is history.
  const holder: LockHolder | null = session
    ? null
    : lockedBy ?? (foreignSession ? { name: foreignSession.user_name, since: foreignSession.acquired_at } : null);

  async function begin(takeover: boolean) {
    if (!selectedId) return;
    setStepError(null);
    try {
      // null: Abbrechen came before the server answered; the hook released it.
      if (!(await calibration.start("quick", selectedId, takeover))) return;
      setLockedBy(null);
      setStep(2);
    } catch (err) {
      const code = apiErrorCode(err);
      const detail = apiErrorDetail(err);
      if (code === "session_locked" && detail) {
        setLockedBy({ name: String(detail.holder_name ?? ""), since: String(detail.since ?? "") });
      } else if (code === "staff_flow_disabled") {
        setStaffDisabled(err instanceof Error ? err.message : String(err));
      } else if (code === "not_configured") {
        setNotConfigured(true);
      } else {
        setStepError(err);
      }
    }
  }

  async function next() {
    setStepError(null);
    try {
      if (step === 1) {
        if (session) setStep(2);
        else await begin(false);
      } else if (step === 2 && selectedId) {
        await calibration.activate(selectedId);
        setStep(3);
      } else if (step === 3) {
        setStep(4);
      } else if (step === 4 && verdict) {
        setStep(5);
      }
    } catch (err) {
      setStepError(err);
      onError(err);
    }
  }

  async function offer(kind: Offer, materialId?: string) {
    setStepError(null);
    const name = subject?.name ?? "";
    try {
      if (kind === "save" || kind === "accept_anyway") {
        const accepted = kind === "accept_anyway";
        await calibration.save({ notes: "", accept_verdict: accepted, pattern: null });
        setNotice(
          accepted
            ? de ? "Gespeichert – Ergebnis ohne Bestätigung." : "Saved – result not confirmed."
            : de ? `Gespeichert – „${name}“ ist eingemessen.` : `Saved – "${name}" is sensed.`,
        );
        onClose();
      } else if (kind === "switch_material" && materialId) {
        await calibration.activate(materialId);
        calibration.setVerifyWithoutSensing(true);
        setSelectedId(materialId);
        setStep(2);
      } else if (kind === "resense") {
        calibration.setVerifyWithoutSensing(false);
        setStep(2);
      } else if (kind === "requery") {
        await calibration.verify();
      } else if (kind === "reapply") {
        await calibration.apply();
        await calibration.verify();
      }
    } catch (err) {
      setStepError(err);
      onError(err);
    }
  }

  async function cancel() {
    if (!session || session.phase === "open") {
      await calibration.end();
      onClose();
      return;
    }
    setCancelOpen(true);
  }

  async function endSetup() {
    setCancelOpen(false);
    await calibration.end();
    onClose();
  }

  const nextEnabled =
    !busy &&
    ((step === 1 && !!selectedId && !holder) ||
      (step === 2 && checklistReady) ||
      (step === 3 && canStartSensing(session)) ||
      (step === 4 && !!verdict && !calibration.polling));
  const nextLabel = step === 2 ? (de ? "Weiter – Material ist eingelegt" : "Next – media is loaded") : de ? "Weiter" : "Next";
  const backEnabled = step > 1 && !busy && !calibration.polling;

  const footer = notConfigured || staffDisabled || !overview ? (
    <div className="werkstatt-modal-foot-actions">
      <button type="button" className="werkstatt-action-btn lc-btn" onClick={() => void cancel()}>
        {de ? "Schließen" : "Close"}
      </button>
    </div>
  ) : (
    <>
      <button type="button" className="werkstatt-action-btn lc-btn" onClick={() => setStep((s) => (s - 1) as Step)} disabled={!backEnabled}>
        {de ? "Zurück" : "Back"}
      </button>
      {step < 5 && (
        <button type="button" className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn" onClick={() => void next()} disabled={!nextEnabled}>
          {nextLabel}
        </button>
      )}
    </>
  );

  let body;
  if (notConfigured) {
    body = <p className="lc-info">{de ? "Kein Etikettendrucker konfiguriert" : "No label printer configured"}</p>;
  } else if (staffDisabled) {
    body = <p className="lc-info">{staffDisabled}</p>;
  } else if (!overview) {
    body = loadError ? <p className="lc-error" role="alert">{loadError}</p> : <p className="lc-small">{de ? "Lädt …" : "Loading …"}</p>;
  } else {
    body = (
      <>
        <h3 className="lc-step-title">{STEP_TITLES[step][de ? 0 : 1]}</h3>
        {step === 1 && (
          <MaterialPickStep
            materials={materials}
            activeId={overview.active_material_id}
            selectedId={selectedId}
            onSelect={setSelectedId}
            holder={holder}
            onTakeover={overview.can_full ? () => void begin(true) : null}
            busy={!!busy}
            de={de}
          />
        )}
        {step === 2 && selected && <LoadingChecklist key={selected.id} material={selected} onReadyChange={onReadyChange} de={de} />}
        {step === 3 && subject && <ApplyPanel material={subject} calibration={calibration} onError={onError} de={de} />}
        {step === 4 && subject && (
          <SensePanel material={subject} calibration={calibration} onBackToSensor={() => setStep(2)} onError={onError} de={de} />
        )}
        {step === 5 && verdict && (
          <VerdictCard verdict={verdict} materials={materials} mode="quick" busy={!!busy} onOffer={(kind, id) => void offer(kind, id)} de={de} />
        )}
        {stepError !== null && (
          <p className="lc-error" role="alert">
            {errorText(stepError)}
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <CalibrationSheetFrame
        title={de ? "Material gewechselt" : "Material changed"}
        subtitle={de ? "WAGO-Etikettendrucker" : "WAGO label printer"}
        stepLine={overview && !notConfigured && !staffDisabled ? (de ? `Schritt ${step} von 5` : `Step ${step} of 5`) : null}
        onCancel={() => void cancel()}
        footer={footer}
        de={de}
      >
        {body}
      </CalibrationSheetFrame>
      {cancelOpen && session && (
        <CancelCalibrationDialog
          session={session}
          materialName={subject?.name ?? ""}
          feed={calibration.feed}
          onEnd={() => void endSetup()}
          onContinue={() => setCancelOpen(false)}
          de={de}
        />
      )}
    </>
  );
}
