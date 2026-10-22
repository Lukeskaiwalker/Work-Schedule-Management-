import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A lazily loaded part of the start page — the edit mode, the tile chooser —
 * that fails stays inside that part (docs/DASHBOARD.md §9.1, §9.7).
 *
 * The usual failure is the chunk download: a deploy replaced the hashed file
 * under a tablet that kept the app open, or a building-site connection
 * dropped the request. Without a boundary the rejection reaches main.tsx's
 * AppErrorBoundary and the whole app turns into „Etwas ist schiefgelaufen“.
 *
 * The caller renders the fallback (with its own retry) and retries by
 * changing this boundary's `key`, after making sure the next render asks for
 * a fresh lazy component: React.lazy remembers a rejected import for good.
 */
type Props = {
  /** For the log line only. */
  name: string;
  fallback: ReactNode;
  children: ReactNode;
};

type State = { failed: boolean };

export class DashboardLoadBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    // The part's name and the error's name only: a message can carry data
    // the part was rendering (LOG_HYGIENE).
    console.warn("dashboard: a part failed to load", this.props.name, error instanceof Error ? error.name : typeof error);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
