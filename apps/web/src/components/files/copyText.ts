/**
 * Put a string on the clipboard, the way App's copyToClipboard does it: the
 * async clipboard API where it exists, a hidden textarea and execCommand
 * where it does not (older WebViews, plain-http LAN pages where the API is
 * withheld). Throws when neither worked so the caller can say so.
 */
export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const fallback = document.createElement("textarea");
  fallback.value = value;
  fallback.setAttribute("readonly", "true");
  fallback.style.position = "absolute";
  fallback.style.left = "-9999px";
  document.body.appendChild(fallback);
  try {
    fallback.select();
    if (!document.execCommand("copy")) throw new Error("copy command failed");
  } finally {
    document.body.removeChild(fallback);
  }
}
