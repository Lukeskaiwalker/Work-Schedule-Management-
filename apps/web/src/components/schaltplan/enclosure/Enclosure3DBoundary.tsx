/**
 * The 3D view's own error boundary and lazy loader (docs/PANEL_ENCLOSURE.md
 * §11 "3D", §12).
 *
 * The 3D chunk is fetched late — on a weak site network, or by a tab left
 * open across a deploy that removed the hashed chunk — and WebGL code can
 * throw on odd GPUs. Both failures stay inside the Schrank tab: this boundary
 * shows "3D konnte nicht geladen werden." with "3D neu laden" and "2D", and
 * nothing reaches AppErrorBoundary, which could only offer reloading the app.
 *
 * After a deploy the old hashed chunk is gone for good: every "3D neu
 * laden" asks for the same URL and gets index.html back. So once a retry
 * failed too — or the browser already said the module itself could not be
 * fetched — the boundary also offers "Seite neu laden" (`onReloadPage`; the
 * tab saves first and reloads only when the saves landed).
 *
 * `React.lazy` caches its promise, a rejection included, so a retry needs a
 * new lazy instance: `createEnclosure3DView` makes one per call, and
 * `Enclosure3DPane` swaps it in when "3D neu laden" is pressed.
 *
 * This file is in the Schaltplan page's chunk and must never import `three`
 * or the view itself statically (enclosureThreeScene.test.ts scans for it).
 */
import {
  Component,
  type ComponentType,
  type ErrorInfo,
  type LazyExoticComponent,
  type ReactNode,
  Suspense,
  lazy,
  useCallback,
  useState,
} from "react";

import type { EnclosureScene } from "../../../types/panelEnclosure";
import { EXIT_LABEL, FAILED_TEXT, LOADING_TEXT, RELOAD_LABEL, RELOAD_PAGE_HINT, RELOAD_PAGE_LABEL } from "./enclosure3DTexts";
import type { Enclosure3DViewProps } from "./Enclosure3DView";
import "../../../styles/schaltplan-enclosure-3d.css";

export interface Enclosure3DModule {
  default: ComponentType<Enclosure3DViewProps>;
}
export type Enclosure3DLoader = () => Promise<Enclosure3DModule>;
export type LazyEnclosure3DView = LazyExoticComponent<ComponentType<Enclosure3DViewProps>>;

/** The one place the 3D chunk is imported — dynamically, so Vite splits it off. */
export const loadEnclosure3DView: Enclosure3DLoader = () => import("./Enclosure3DView");

/** A fresh lazy component per call: each one imports again, so a failed fetch can be retried. */
export function createEnclosure3DView(load: Enclosure3DLoader = loadEnclosure3DView): LazyEnclosure3DView {
  return lazy(load);
}

/**
 * The browsers' words for "the module file itself could not be fetched or was
 * not JavaScript" — what a stale tab gets for a chunk a deploy removed.
 */
const CHUNK_GONE = /dynamically imported module|Importing a module script failed|Failed to load module script|Unable to preload/i;

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_GONE.test(error.message);
}

export interface Enclosure3DBoundaryProps {
  children: ReactNode;
  /** "3D neu laden": swap in a fresh lazy instance; the boundary then renders its children again. */
  onRetry(): void;
  /** "2D": leave the 3D view. */
  onExit(): void;
  /** "Seite neu laden" — offered after a failed retry or a missing chunk; never without this. */
  onReloadPage?: () => void;
  /** A "3D neu laden" has already failed once. */
  retried?: boolean;
}

interface BoundaryState {
  failed: boolean;
  chunkGone: boolean;
}

export class Enclosure3DBoundary extends Component<Enclosure3DBoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, chunkGone: false };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failed: true, chunkGone: isChunkLoadError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("3D-Ansicht fehlgeschlagen", error, info.componentStack);
  }

  private readonly retry = (): void => {
    this.props.onRetry();
    this.setState({ failed: false, chunkGone: false });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { onReloadPage, retried = false } = this.props;
    const offerPageReload = onReloadPage !== undefined && (retried || this.state.chunkGone);
    return (
      <div className="sp-encl-3d-failed" role="alert">
        <p>{FAILED_TEXT}</p>
        <div className="sp-encl-3d-failed-actions">
          <button type="button" className="sp-btn sp-btn--primary sp-encl-3d-btn" onClick={this.retry}>
            {RELOAD_LABEL}
          </button>
          {offerPageReload ? (
            <button type="button" className="sp-btn sp-encl-3d-btn" onClick={onReloadPage}>
              {RELOAD_PAGE_LABEL}
            </button>
          ) : null}
          <button type="button" className="sp-btn sp-encl-3d-btn" onClick={this.props.onExit}>
            {EXIT_LABEL}
          </button>
        </div>
        {offerPageReload ? <p className="sp-encl-3d-hint">{RELOAD_PAGE_HINT}</p> : null}
      </div>
    );
  }
}

export interface Enclosure3DPaneProps {
  scene: EnclosureScene;
  onExit(): void;
  /** Tests inject a loader; the app uses the dynamic import. */
  load?: Enclosure3DLoader;
  /** "Seite neu laden" (the tab: save first, then reload). Without it the boundary never offers it. */
  onReloadPage?: () => void;
}

/** Boundary + Suspense + lazy view in one: what the Schrank tab renders for "3D". */
export function Enclosure3DPane({ scene, onExit, load = loadEnclosure3DView, onReloadPage }: Enclosure3DPaneProps) {
  const [View, setView] = useState<LazyEnclosure3DView>(() => createEnclosure3DView(load));
  const [retried, setRetried] = useState(false);
  const retry = useCallback(() => {
    setRetried(true);
    setView(() => createEnclosure3DView(load));
  }, [load]);
  return (
    <Enclosure3DBoundary onRetry={retry} onExit={onExit} onReloadPage={onReloadPage} retried={retried}>
      <Suspense
        fallback={
          <p className="sp-encl-3d-loading" role="status">
            {LOADING_TEXT}
          </p>
        }
      >
        <View scene={scene} onExit={onExit} />
      </Suspense>
    </Enclosure3DBoundary>
  );
}
