import { Component, type ErrorInfo, type ReactNode } from "react";

import { DashboardWidgetFrame } from "./DashboardWidgetFrame";

/**
 * One widget's crash stays in that widget's card (docs/DASHBOARD.md §9.1).
 *
 * „Start“ is the first page everyone sees; a render error in one of twenty
 * widgets must not blank it. The card shows the widget error copy with a
 * retry; the host bumps the boundary's key on retry, which also asks the
 * registry again for the widget's code (a failed chunk download is not
 * cached there).
 */
type Props = {
  widgetId: string;
  title: string;
  onRetry: () => void;
  children: ReactNode;
};

type State = { failed: boolean };

export class DashboardWidgetBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    // The id and the error's name only: a message can carry the data the
    // widget was rendering (LOG_HYGIENE).
    console.warn("dashboard: a widget crashed", this.props.widgetId, error instanceof Error ? error.name : typeof error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <DashboardWidgetFrame
        title={this.props.title}
        state={{ loading: false, error: "crashed", onRetry: this.props.onRetry }}
      />
    );
  }
}
