/**
 * The cabinet in 3D (docs/PANEL_ENCLOSURE.md §11 "3D", §12) — lazy-loaded,
 * so `three` lives in this chunk only and the Schaltplan page never pays for
 * it. Reached through `Enclosure3DBoundary` (`Enclosure3DPane` or
 * `createEnclosure3DView`), never imported statically.
 *
 * View-only: devices are chosen in the 2D view, where every tap target is
 * glove-sized. Here every control is a 56 px button (Front, Schräg, Seite,
 * Tür auf/zu, −, +, 2D); dragging to orbit is an extra, never needed.
 */
import { useEffect, useRef, useState } from "react";

import type { EnclosureScene } from "../../../types/panelEnclosure";
import { EXIT_LABEL, FAILED_TEXT, RELOAD_LABEL, UNSUPPORTED_TEXT } from "./enclosure3DTexts";
import type { CameraPreset } from "./enclosureThreeScene";
import { mountStage, type Stage } from "./enclosureThreeStage";
import "../../../styles/schaltplan-enclosure-3d.css";

export interface Enclosure3DViewProps {
  /** Normally the open scene; a closed one works too (its cover layer is skipped). */
  scene: EnclosureScene;
  /** "2D": back to the 2D view. */
  onExit(): void;
}

type Status = "ready" | "unsupported" | "lost";

const PRESETS: ReadonlyArray<{ preset: CameraPreset; label: string }> = [
  { preset: "front", label: "Front" },
  { preset: "oblique", label: "Schräg" },
  { preset: "side", label: "Seite" },
];

export default function Enclosure3DView({ scene, onExit }: Enclosure3DViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const sceneRef = useRef(scene);
  const [doorOpen, setDoorOpen] = useState(true);
  const doorRef = useRef(doorOpen);
  const [status, setStatus] = useState<Status>("ready");
  // Bumped by "3D neu laden": a new stage on a new canvas.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const stage = mountStage(host, sceneRef.current, doorRef.current, () => setStatus("lost"));
    if (!stage) {
      setStatus("unsupported");
      return undefined;
    }
    stageRef.current = stage;
    setStatus("ready");
    return () => {
      stage.dispose();
      if (stageRef.current === stage) stageRef.current = null;
    };
  }, [generation]);

  useEffect(() => {
    sceneRef.current = scene;
    stageRef.current?.setScene(scene);
  }, [scene]);

  useEffect(() => {
    doorRef.current = doorOpen;
    stageRef.current?.setDoorOpen(doorOpen);
  }, [doorOpen]);

  const ready = status === "ready";
  return (
    <section className="sp-encl-3d" aria-label="Schrank in 3D">
      <div className="sp-encl-3d-toolbar" role="toolbar" aria-label="3D-Ansicht">
        {PRESETS.map(({ preset, label }) => (
          <button
            key={preset}
            type="button"
            className="sp-btn sp-encl-3d-btn"
            disabled={!ready}
            onClick={() => stageRef.current?.preset(preset)}
          >
            {label}
          </button>
        ))}
        <button type="button" className="sp-btn sp-encl-3d-btn" disabled={!ready} onClick={() => setDoorOpen((open) => !open)}>
          {doorOpen ? "Tür zu" : "Tür auf"}
        </button>
        <button
          type="button"
          className="sp-btn sp-encl-3d-btn sp-encl-3d-btn--zoom"
          aria-label="Verkleinern"
          disabled={!ready}
          onClick={() => stageRef.current?.zoom("out")}
        >
          −
        </button>
        <button
          type="button"
          className="sp-btn sp-encl-3d-btn sp-encl-3d-btn--zoom"
          aria-label="Vergrößern"
          disabled={!ready}
          onClick={() => stageRef.current?.zoom("in")}
        >
          +
        </button>
        <button type="button" className="sp-btn sp-encl-3d-btn sp-encl-3d-btn--exit" onClick={onExit}>
          {EXIT_LABEL}
        </button>
      </div>
      <div className="sp-encl-3d-stage">
        <div ref={hostRef} className="sp-encl-3d-canvas-host" role="img" aria-label="Schrank in 3D, mit den Knöpfen drehen und zoomen" />
        {status === "unsupported" && (
          <p className="sp-encl-3d-notice" role="status">
            {UNSUPPORTED_TEXT}
          </p>
        )}
        {status === "lost" && (
          <div className="sp-encl-3d-notice" role="alert">
            <p>{FAILED_TEXT}</p>
            <button type="button" className="sp-btn sp-btn--primary sp-encl-3d-btn" onClick={() => setGeneration((n) => n + 1)}>
              {RELOAD_LABEL}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
