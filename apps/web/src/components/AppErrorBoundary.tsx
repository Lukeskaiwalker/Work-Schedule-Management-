import { Component, type ErrorInfo, type ReactNode } from "react";
import { isGerman } from "../utils/uiLanguage";

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
      // The app's state is gone by now, so the language comes from <html lang>,
      // which App keeps in step with the UI.
      const de = isGerman();
      return (
        <main className="app-error-boundary" role="alert" aria-live="assertive">
          <section className="app-error-boundary-card">
            <h1>{de ? "Etwas ist schiefgelaufen." : "Something went wrong."}</h1>
            <p>
              {de
                ? "Die Seite ist beim Anzeigen abgestürzt. Neu laden behebt das."
                : "The page crashed while rendering. Reload to recover."}
            </p>
            <button type="button" onClick={() => window.location.reload()}>
              {de ? "App neu laden" : "Reload app"}
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
