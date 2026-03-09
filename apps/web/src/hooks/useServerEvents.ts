/**
 * useServerEvents - subscribes to backend SSE stream.
 *
 * Opens an EventSource connection to /api/events with the JWT.
 * EventSource handles reconnects automatically.
 */
import { useEffect, useRef, useState } from "react";

export type ServerEvent = {
  type: string;
  data: Record<string, unknown>;
};

export type SseStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

type Options = {
  onEvent: (event: ServerEvent) => void;
  onReconnect?: () => void;
};

export function useServerEvents(
  token: string | null,
  { onEvent, onReconnect }: Options,
): { status: SseStatus } {
  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(onReconnect);
  onEventRef.current = onEvent;
  onReconnectRef.current = onReconnect;

  const hasConnectedRef = useRef(false);
  const [status, setStatus] = useState<SseStatus>(token ? "connecting" : "disconnected");

  useEffect(() => {
    if (!token) {
      setStatus("disconnected");
      return;
    }

    setStatus("connecting");
    const url = `/api/events?token=${encodeURIComponent(token)}`;
    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      setStatus("connected");
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
      // EventSource reconnects automatically; onopen fires on successful reconnect.
      setStatus("reconnecting");
    };

    return () => {
      eventSource.close();
      setStatus("disconnected");
      hasConnectedRef.current = false;
    };
  }, [token]);

  return { status };
}
