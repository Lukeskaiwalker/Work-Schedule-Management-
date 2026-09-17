/**
 * "The numbers could not be loaded" — the banner both overview screens show
 * when their fetch failed.
 *
 * It names the server's own message underneath the plain-language line. The
 * workshop needs the first sentence; whoever they call about it needs the
 * second, and asking them to reproduce it in a console is not a thing that
 * happens on a shop floor.
 */
export interface WerkstattLoadErrorProps {
  /** Plain-language line: what could not be loaded, in the user's language. */
  headline: string;
  /** The raw server / transport message. Rendered verbatim, quietly. */
  detail: string;
  retryLabel: string;
  onRetry: () => void;
}

export function WerkstattLoadError({
  headline,
  detail,
  retryLabel,
  onRetry,
}: WerkstattLoadErrorProps) {
  return (
    <div className="wsov-error" role="alert">
      <span className="wsov-error-text">
        {headline}
        <span className="wsov-error-detail">{detail}</span>
      </span>
      <button type="button" className="wsov-retry" onClick={onRetry}>
        {retryLabel}
      </button>
    </div>
  );
}
