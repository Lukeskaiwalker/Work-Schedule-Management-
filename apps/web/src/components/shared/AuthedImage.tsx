/**
 * An `<img>` that can load a protected /api image inside the native shell.
 *
 * On the web this is a plain `<img>` — the request is same-origin, the session
 * cookie rides along, and nothing changes.
 *
 * In the shell the same markup silently fails. An `<img>` cannot carry an
 * Authorization header, and the cookie is SameSite=Strict so it is not sent to
 * a cross-site server either; the API answers 401 and the crew sees a broken
 * image where an avatar or a photo should be. So here the bytes are fetched
 * with the bearer token and handed to the `<img>` as an object URL.
 *
 * NOTE FOR ANYONE TESTING THIS: the bug does not reproduce against a server on
 * `localhost`. WebKit treats capacitor://localhost and http://localhost as the
 * same site, so the cookie IS sent and the plain `<img>` works. Point the app
 * at a LAN IP or a real hostname to see the real behaviour.
 */
import { useEffect, useState } from "react";

import { currentToken } from "../../native/fileOpen";
import { IS_NATIVE_SHELL } from "../../native/shell";

type Props = {
  src: string;
  alt: string;
  className?: string;
  /** Called when the image cannot be shown, so callers can fall back. */
  onError?: () => void;
  loading?: "lazy" | "eager";
};

export function AuthedImage({ src, alt, className, onError, loading }: Props) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_NATIVE_SHELL) return;

    let cancelled = false;
    let created: string | null = null;

    const token = currentToken();
    void fetch(src, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => {
        if (!cancelled) onError?.();
      });

    return () => {
      cancelled = true;
      // Revoke whatever this effect run created. Doing it here rather than in a
      // separate unmount effect keeps it correct when `src` changes: each run
      // owns exactly one object URL.
      if (created) URL.revokeObjectURL(created);
      setObjectUrl(null);
    };
    // onError is intentionally excluded: callers pass inline arrows, and
    // including it would refetch the image on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (!IS_NATIVE_SHELL) {
    return <img src={src} alt={alt} className={className} onError={onError} loading={loading} />;
  }

  // Nothing to show until the bytes arrive; callers render their own fallback
  // (initials, a file icon) underneath, so an empty frame is the right interim.
  if (!objectUrl) return null;
  return <img src={objectUrl} alt={alt} className={className} loading={loading} />;
}
