/**
 * useServerEvents - subscribes to backend SSE stream.
 *
 * WHY THE URL CARRIES NO SESSION TOKEN
 *
 * EventSource cannot send an Authorization header, so this hook used to open
 * `/api/events?token=<JWT>`. A query string is exactly what access logs print:
 * a dump of the production proxy log held the eight-hour session tokens of
 * whoever had the app open. Now:
 *
 *  - A browser opens the bare `/api/events`. It is same-origin, so the
 *    httpOnly session cookie set at login rides along, and the server reads
 *    it. Nothing secret is in the URL at all.
 *  - The native shell cannot do that — its pages live on capacitor://localhost
 *    and a SameSite=Strict cookie never travels to the server from there. It
 *    first fetches a single-use, sixty-second ticket with its normal bearer
 *    token and opens `/api/events?ticket=…`. By the time a log line holding
 *    that ticket could be read, the ticket has been spent.
 *  - A browser whose cookie fails to open the stream (cleared, logged out in
 *    another tab, a Secure cookie on a plain-http LAN address) switches to
 *    tickets. Should a ticket in turn fail to open it, the next attempt tries
 *    the cookie again — whichever credential just failed is not tried next.
 *
 * RECONNECTING
 *
 * The browser retries a dropped connection by itself, with the same URL. That
 * suits the cookie, which is sent again. It cannot work for a ticket, which
 * was spent on the first connect — so a ticket stream is closed on error and
 * reopened here with a fresh one. Some failures the browser never retries at
 * all: any non-200 answer, including the maintenance page during a deploy,
 * closes the EventSource for good. Those are reopened here too, with backoff,
 * which is what lets a tab left open across a deploy come back live.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../api/client";
import { IS_NATIVE_SHELL } from "../native/shell";

export type ServerEvent = {
  type: string;
  data: Record<string, unknown>;
};

export type SseStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

type Options = {
  onEvent: (event: ServerEvent) => void;
  onReconnect?: () => void;
};

const EVENT_STREAM_PATH = "/api/events";

/** Waits before the 1st, 2nd, … reconnect attempt; the last one repeats. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * How long a stream must stay open before its loss starts the backoff over.
 * Longer than the server's 25-second heartbeat, so "opened, then died before
 * the first heartbeat" (the API answering but unable to reach Postgres) keeps
 * backing off instead of minting a ticket every second.
 */
const HEALTHY_STREAM_MS = 30_000;

type StreamTicket = { ticket: string; expires_in: number };

/** The stream URL: the bare path for the cookie, or carrying only a ticket. */
export function eventStreamUrl(ticket: string | null): string {
  return ticket ? `${EVENT_STREAM_PATH}?ticket=${encodeURIComponent(ticket)}` : EVENT_STREAM_PATH;
}

async function requestStreamTicket(token: string): Promise<string> {
  const { ticket } = await apiFetch<StreamTicket>("/events/ticket", token, { method: "POST" });
  return ticket;
}

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

    const canUseCookie = !IS_NATIVE_SHELL;
    let useTicket = !canUseCookie;
    let disposed = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const scheduleReconnect = () => {
      if (disposed || retryTimer !== null) return;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)];
      attempts += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      let ticket: string | null = null;
      if (useTicket) {
        try {
          ticket = await requestStreamTicket(token);
        } catch (error) {
          // A 401 means the session itself is over. apiFetch has already told
          // App, which signs out and tears this effect down — retrying would
          // only repeat the 401. Anything else (server restarting, network
          // gone) is worth another attempt.
          if (error instanceof ApiError && error.status === 401) return;
          scheduleReconnect();
          return;
        }
      }
      if (disposed) return;

      const eventSource = new EventSource(eventStreamUrl(ticket));
      source = eventSource;
      let opened = false;
      let openedAt = 0;

      eventSource.onopen = () => {
        opened = true;
        openedAt = Date.now();
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
        setStatus("reconnecting");
        // CONNECTING: the browser is already retrying with the same URL, and
        // with the cookie that is exactly right. Leave it to it.
        if (!useTicket && eventSource.readyState === EventSource.CONNECTING) return;
        eventSource.close();
        if (source === eventSource) source = null;
        // Never opened on this credential: try the other one next time. Only
        // a browser has two; the shell stays on tickets.
        if (!opened && canUseCookie) useTicket = !useTicket;
        if (opened && Date.now() - openedAt >= HEALTHY_STREAM_MS) attempts = 0;
        scheduleReconnect();
      };
    };

    setStatus("connecting");
    void connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      source?.close();
      setStatus("disconnected");
      hasConnectedRef.current = false;
    };
  }, [token]);

  return { status };
}
