import { uiText } from "./uiLanguage";

/**
 * What to tell the user about an upload that got no answer at all.
 *
 * `apiUploadWithProgress` rejects a dropped connection or an abort with an
 * ApiError of status 0 and its own message ("Network request failed",
 * "Upload aborted"). Those messages stay — tests and the retry logic key on
 * the code, not the words — but they are a developer's sentences, in English,
 * and a German crew saw them verbatim wherever a caller printed `err.message`.
 *
 * Read by shape, not `instanceof ApiError`, so a test that mocks the API
 * client module does not take this helper down with it. null when the server
 * did answer: then its own `detail` is the message.
 */
export function connectionErrorText(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { status, code } = error as { status?: unknown; code?: unknown };
  if (status !== 0) return null;
  if (code === "abort") return uiText("Hochladen abgebrochen.", "Upload cancelled.");
  return uiText(
    "Verbindung unterbrochen — bitte die Verbindung prüfen und erneut versuchen.",
    "Connection lost — check the connection and try again.",
  );
}
