/**
 * useServerEvents - subscribes to backend SSE stream.
 *
 * Opens an EventSource connection to /api/events with the JWT.
 * EventSource handles reconnects automatically.
 */
import { useEffect, useRef } from "react";

export type ServerEvent = {
  type: string;
  data: Record<string, unknown>;
};

type Options = {
  onEvent: (event: ServerEvent) => void;
  onReconnect?: () => void;
};

export function useServerEvents(
  token: string | null,
  { onEvent, onReconnect }: Options,
): void {
  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(onReconnect);
  onEventRef.current = onEvent;
  onReconnectRef.current = onReconnect;

  const hasConnectedRef = useRef(false);

  useEffect(() => {
    if (!token) return;

    const url = `/api/events?token=${encodeURIComponent(token)}`;
    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      if (hasConnectedRef.current) {
        onReconnectRef.current?.();
      }
      hasConnectedRef.current = true;
    };

    eventSource.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as ServerEvent;
        if (parsed.type === "connected" || parsed.type === "heartbeat") return;
        onEventRef.current(parsed);
      } catch {
        // ignore malformed payloads
      }
    };

    eventSource.onerror = () => {
      // no-op: EventSource reconnects automatically
    };

    return () => {
      eventSource.close();
      hasConnectedRef.current = false;
    };
  }, [token]);
}
