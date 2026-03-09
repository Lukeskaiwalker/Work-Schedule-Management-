import { Component, type ErrorInfo, type ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Unhandled React render error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="app-error-boundary" role="alert" aria-live="assertive">
          <section className="app-error-boundary-card">
            <h1>Something went wrong.</h1>
            <p>The page crashed while rendering. Reload to recover.</p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload app
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
