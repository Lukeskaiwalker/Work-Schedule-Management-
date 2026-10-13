/**
 * Full wizard "Material einrichten" for `settings:manage`
 * (docs/LABEL_PRINTER_CALIBRATION.md §7.6).
 *
 * Six steps: printer check → profile → sensor and loading → apply, sense and
 * judge → measuring pattern → print values and save. Steps 3–4 reuse the
 * quick flow's panels so both flows send the same commands in the same order.
 *
 * Two rules keep it from fighting the server:
 *   * the SUBJECT is `session.material_id`, not the material the wizard was
 *     opened for — after [Auf „X“ umstellen] title, PUTs and the record all
 *     go to X;
 *   * every PUT sends the highest configuration revision seen anywhere (the
 *     settings it holds AND every session response, `activate` included),
 *     so a PUT after `activate` on a non-active material is not stale.
 */
import { useCallback, useEffect, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import type { LabelPrinterSettings, Offer, PatternMeasurements, PatternResult } from "../../types/labelPrinter";
import { apiErrorCode, apiErrorDetail, errorText, formatMmDe } from "../../utils/labelCalibration";
import { getLabelPrinterSettings } from "../../utils/labelPrinterApi";
import { ApplyPanel } from "./ApplyPanel";
import { CalibrationSheetFrame } from "./CalibrationSheetFrame";
import { CancelCalibrationDialog } from "./CancelCalibrationDialog";
import { LoadingChecklist } from "./LoadingChecklist";
import { LockBanner } from "./MaterialPickStep";
import { SensePanel } from "./SensePanel";
import { useCalibrationSession } from "./useCalibrationSession";
import { VerdictCard } from "./VerdictCard";
import { StepFinish } from "./wizard/StepFinish";
import { StepMaterial } from "./wizard/StepMaterial";
import { EMPTY_PATTERN_INPUTS, StepPattern, measured, type PatternInputs } from "./wizard/StepPattern";
import { StepPrinter } from "./wizard/StepPrinter";
import "../../styles/label-calibration.css";

export interface CalibrationWizardProps {
  materialId: string;
  settings: LabelPrinterSettings;
  onSettings: (settings: LabelPrinterSettings) => void;
  onClose: () => void;
}

type Step = 1 | 2 | 3 | 4 | 5 | 6;
const TITLES: Record<Step, [string, string]> = {
  1: ["Drucker prüfen", "Check the printer"],
  2: ["Material und Sensor", "Material and sensor"],
  3: ["Sensor stellen und einlegen", "Set the sensor and load"],
  4: ["Übertragen und einmessen", "Transfer and sense"],
  5: ["Messmuster", "Measuring pattern"],
  6: ["Druckwerte und Abschluss", "Print values and finish"],
};

function patternMeasurements(inputs: PatternInputs, pattern: PatternResult | null): PatternMeasurements | null {
  if (!pattern) return null;
  const v = (text: string, max: number) => {
    const value = measured(text, max);
    return value === null || Number.isNaN(value) ? null : value;
  };
  const { ruler_from_mm: from, ruler_to_mm: to } = pattern.geometry;
  const ruler = v(inputs.ruler, 800);
  return {
    lead_mm: v(inputs.lead, 30),
    trail_mm: v(inputs.trail, 30),
    left_mm: v(inputs.left, 30),
    right_mm: v(inputs.right, 30),
    ruler_nominal_mm: ruler !== null && from !== null && to !== null ? to - from : null,
    ruler_measured_mm: ruler,
  };
}

export function CalibrationWizard({ materialId, settings: initial, onSettings, onClose }: CalibrationWizardProps) {
  const { token, language } = useAppContext();
  const de = language === "de";
  const [settings, setSettings] = useState(initial);
  const [step, setStep] = useState<Step>(1);
  const [startError, setStartError] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const [stepError, setStepError] = useState<unknown>(null);
  const [checklistReady, setChecklistReady] = useState(false);
  const [acceptVerdict, setAcceptVerdict] = useState(false);
  const [pattern, setPattern] = useState<PatternResult | null>(null);
  const [inputs, setInputs] = useState<PatternInputs>(EMPTY_PATTERN_INPUTS);
  const [savedOffsets, setSavedOffsets] = useState<{ x: number | null; across: number | null }>({ x: null, across: null });
  const [cancelOpen, setCancelOpen] = useState(false);

  const calibration = useCalibrationSession({ token, initialRevision: initial.revision });
  const { session, verdict, busy, noteRevision } = calibration;
  const revision = Math.max(settings.revision, calibration.latestRevision);
  const subjectId = session?.material_id ?? materialId;
  const subject = settings.materials.find((m) => m.id === subjectId) ?? null;
  const startMaterial = initial.materials.find((m) => m.id === materialId) ?? null;

  const adoptSettings = useCallback(
    (next: LabelPrinterSettings) => {
      setSettings(next);
      noteRevision(next.revision);
      onSettings(next);
    },
    [noteRevision, onSettings],
  );

  const { start } = calibration;
  const begin = useCallback(
    async (takeover: boolean) => {
      setStartError(null);
      try {
        await start("full", materialId, takeover);
      } catch (err) {
        setStartError(err);
      }
    },
    [start, materialId],
  );

  useEffect(() => {
    void begin(false);
  }, [begin]);

  // The checklist starts unticked whenever step 3 is entered again.
  useEffect(() => {
    if (step !== 3) setChecklistReady(false);
  }, [step]);

  const onPutError = useCallback((err: unknown) => {
    if (apiErrorCode(err) === "stale_revision") setStale(true);
  }, []);

  async function reload() {
    try {
      adoptSettings(await getLabelPrinterSettings(token));
      setStale(false);
    } catch (err) {
      setStepError(err);
    }
  }

  async function next() {
    setStepError(null);
    try {
      if (step === 3) await calibration.activate(subjectId);
      setStep((s) => (s + 1) as Step);
    } catch (err) {
      setStepError(err);
    }
  }

  async function offer(kind: Offer, id?: string) {
    setStepError(null);
    try {
      if (kind === "save" || kind === "accept_anyway") {
        setAcceptVerdict(kind === "accept_anyway");
        setStep(5);
      } else if (kind === "switch_material" && id) {
        await calibration.activate(id);
        calibration.setVerifyWithoutSensing(true);
        setStep(3);
      } else if (kind === "resense") {
        calibration.setVerifyWithoutSensing(false);
        setStep(3);
      } else if (kind === "requery") {
        await calibration.verify();
      } else if (kind === "reapply") {
        await calibration.apply();
        await calibration.verify();
      }
    } catch (err) {
      setStepError(err);
    }
  }

  async function endAndClose() {
    setCancelOpen(false);
    await calibration.end();
    onClose();
  }

  const offsetLines: string[] = [];
  if (savedOffsets.x !== null) offsetLines.push(de ? `Versatz Vorschub ${formatMmDe(savedOffsets.x)} mm` : `feed offset ${formatMmDe(savedOffsets.x)} mm`);
  if (savedOffsets.across !== null) offsetLines.push(de ? `Versatz quer ${formatMmDe(savedOffsets.across)} mm` : `across offset ${formatMmDe(savedOffsets.across)} mm`);
  const alreadySaved = offsetLines.length ? `${de ? "Bereits gespeichert" : "Already saved"}: ${offsetLines.join(", ")}.` : null;

  const lockDetail = apiErrorCode(startError) === "session_locked" ? apiErrorDetail(startError) : null;
  const notConfigured = apiErrorCode(startError) === "not_configured";
  const nextEnabled =
    !!session && !busy && ((step === 1) || (step === 3 && checklistReady) || (step === 5));

  let body;
  if (!session || !subject) {
    body = notConfigured ? (
      <p className="lc-info">{de ? "Kein Etikettendrucker konfiguriert" : "No label printer configured"}</p>
    ) : lockDetail ? (
      <LockBanner
        holder={{ name: String(lockDetail.holder_name ?? ""), since: String(lockDetail.since ?? "") }}
        onTakeover={() => void begin(true)}
        de={de}
      />
    ) : startError !== null ? (
      <p className="lc-error" role="alert">{errorText(startError)}</p>
    ) : (
      <p className="lc-small">{de ? "Startet …" : "Starting …"}</p>
    );
  } else {
    body = (
      <>
        <h3 className="lc-step-title">{TITLES[step][de ? 0 : 1]}</h3>
        {step === 1 && <StepPrinter settings={settings} revision={revision} onSettings={adoptSettings} onPutError={onPutError} />}
        {step === 2 && (
          <StepMaterial
            material={subject}
            revision={revision}
            onSaved={(next) => {
              if (next) adoptSettings(next);
              setStep(3);
            }}
            onReload={() => void reload()}
          />
        )}
        {step === 3 && <LoadingChecklist key={subject.id} material={subject} onReadyChange={setChecklistReady} de={de} />}
        {step === 4 && (
          <>
            <ApplyPanel material={subject} calibration={calibration} de={de} />
            {/* From the apply on, not only while sensing may START: during phase
                "sensing" the panel carries the stop hint, the poll line and, for a
                silent printer, the only [Ergebnis abfragen]. Its own buttons gate
                on canStartSensing. */}
            {session.applied && !verdict && (
              <SensePanel material={subject} calibration={calibration} onBackToSensor={() => setStep(3)} de={de} />
            )}
            {verdict && <VerdictCard verdict={verdict} materials={settings.materials} mode="full" busy={!!busy} onOffer={(k, id) => void offer(k, id)} de={de} />}
          </>
        )}
        {step === 5 && (
          <StepPattern
            material={subject}
            calibration={calibration}
            revision={revision}
            pattern={pattern}
            onPattern={setPattern}
            inputs={inputs}
            onInputs={setInputs}
            onSettings={adoptSettings}
            onPutError={onPutError}
            onSavedOffsets={(x, across) => setSavedOffsets((prev) => ({ x: x ?? prev.x, across: across ?? prev.across }))}
            onSkip={() => setStep(6)}
          />
        )}
        {step === 6 && (
          <StepFinish
            material={subject}
            baseline={settings.baseline}
            revision={revision}
            calibration={calibration}
            verdict={verdict}
            acceptVerdict={acceptVerdict}
            pattern={patternMeasurements(inputs, pattern)}
            offsetSummary={offsetLines}
            onSettings={adoptSettings}
            onPutError={onPutError}
            onDone={onClose}
          />
        )}
        {stale && (
          <div className="lc-error" role="alert">
            <p className="lc-intro">{de ? "Einstellungen wurden inzwischen geändert – bitte neu laden" : "Settings changed meanwhile – please reload"}</p>
            <button type="button" className="werkstatt-action-btn lc-btn" onClick={() => void reload()}>
              {de ? "Neu laden" : "Reload"}
            </button>
          </div>
        )}
        {stepError !== null && <p className="lc-error" role="alert">{errorText(stepError)}</p>}
      </>
    );
  }

  const footer = (
    <>
      <button type="button" className="werkstatt-action-btn lc-btn" onClick={() => setStep((s) => (s - 1) as Step)} disabled={step === 1 || !!busy || calibration.polling}>
        {de ? "Zurück" : "Back"}
      </button>
      {session && [1, 3, 5].includes(step) && (
        <button type="button" className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn" onClick={() => void next()} disabled={!nextEnabled}>
          {step === 3 ? (de ? "Weiter – Material ist eingelegt" : "Next – media is loaded") : de ? "Weiter" : "Next"}
        </button>
      )}
    </>
  );

  const name = subject?.name ?? startMaterial?.name ?? materialId;
  return (
    <>
      <CalibrationSheetFrame
        title={de ? `Material einrichten: ${name}` : `Set up material: ${name}`}
        subtitle={de ? "WAGO-Etikettendrucker" : "WAGO label printer"}
        stepLine={session ? (de ? `Schritt ${step} von 6` : `Step ${step} of 6`) : null}
        onCancel={() => (session && session.phase !== "open" ? setCancelOpen(true) : void endAndClose())}
        footer={footer}
        de={de}
      >
        {body}
      </CalibrationSheetFrame>
      {cancelOpen && session && (
        <CancelCalibrationDialog
          session={session}
          materialName={name}
          extra={alreadySaved}
          feed={calibration.feed}
          onEnd={() => void endAndClose()}
          onContinue={() => setCancelOpen(false)}
          de={de}
        />
      )}
    </>
  );
}
