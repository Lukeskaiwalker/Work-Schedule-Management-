/**
 * The Protokoll's rows: server-filtered, paged back on demand, newest-wins.
 *
 * Lifted out of App (it used to hold one `auditLogs` array filled by a
 * parameterless fetch) because the rules that make the tab trustworthy live
 * here:
 *
 *   - **The server is the only filter.** Period, category and search text go
 *     to GET /admin/audit-logs, which filters the whole table. The tab used to
 *     filter the newest 300 rows in the browser, so "Letzte 90 Tage" reached
 *     back two weeks (production, 2026-10-20) and nothing said so.
 *   - **A cut-off list says it is cut off.** Each request asks for one row more
 *     than a page; when that row comes back, `hasMore` is set and the tab
 *     offers the older rows, fetched by `before_id` with the SAME filters the
 *     list on screen was loaded with.
 *   - **Only the newest request may paint.** A slow answer for the previous
 *     filter must not replace the current one; each request takes a ticket.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../api/client";
import { connectionErrorText } from "../../utils/connectionError";
import { createRequestSequence } from "../../utils/latestRequest";
import type { AuditLogEntry } from "../../types";
import { AUDIT_PAGE_SIZE, auditLogFilterQuery, auditLogPagePath, type AuditLogFilters } from "./auditLogQuery";

/** Typing pause before a search goes out. Without search text a change loads at once. */
export const AUDIT_SEARCH_DEBOUNCE_MS = 250;

export interface AuditLogFeedOptions {
  /** False while the tab is not shown: nothing is fetched. */
  active: boolean;
  token: string | null;
  filters: AuditLogFilters;
}

export interface AuditLogFeed {
  logs: AuditLogEntry[];
  /** True when rows older than the last one shown match the filters. */
  hasMore: boolean;
  loading: boolean;
  loadingOlder: boolean;
  /** Why the list could not be loaded; the list is empty then, not stale. */
  error: string | null;
  /** Why "Ältere anzeigen" failed; the rows already shown stay. */
  olderError: string | null;
  /** Every category in the table, from the server. */
  categories: string[];
  categoriesError: string | null;
  /** Reload the first page and the categories ("Aktualisieren"). */
  refresh: () => void;
  loadOlder: () => Promise<void>;
}

function messageOf(err: unknown): string {
  const connection = connectionErrorText(err);
  if (connection) return connection;
  return err instanceof Error && err.message ? err.message : String(err);
}

/** The first page's rows and whether more exist, from a limit+1 answer. */
function splitPage(rows: AuditLogEntry[]): { shown: AuditLogEntry[]; more: boolean } {
  return { shown: rows.slice(0, AUDIT_PAGE_SIZE), more: rows.length > AUDIT_PAGE_SIZE };
}

export function useAuditLogFeed({ active, token, filters }: AuditLogFeedOptions): AuditLogFeed {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  /** The filter query the rows on screen were loaded with; older pages reuse it. */
  const [shownQuery, setShownQuery] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const sequence = useMemo(() => createRequestSequence(), []);

  // A string, so the reload below keys on what is asked, not on the identity
  // of the filters object the page builds on every render. Rolling periods
  // only move at local midnight, so it is stable for the day.
  const filterQuery = auditLogFilterQuery(filters);
  const searching = filters.search.trim() !== "";

  const reload = useCallback(async () => {
    if (!active) return;
    const ticket = sequence.issue();
    setLoading(true);
    // A pending "Ältere anzeigen" belongs to the list being replaced.
    setLoadingOlder(false);
    setOlderError(null);
    try {
      const rows = await apiFetch<AuditLogEntry[]>(auditLogPagePath(filterQuery, null), token);
      if (!sequence.isCurrent(ticket)) return;
      const { shown, more } = splitPage(rows);
      setLogs(shown);
      setHasMore(more);
      setShownQuery(filterQuery);
      setError(null);
    } catch (err) {
      if (!sequence.isCurrent(ticket)) return;
      // An empty table must never be mistaken for "nothing happened".
      setLogs([]);
      setHasMore(false);
      setShownQuery(null);
      setError(messageOf(err));
    } finally {
      if (sequence.isCurrent(ticket)) setLoading(false);
    }
  }, [active, token, filterQuery, sequence]);

  const reloadCategories = useCallback(async () => {
    if (!active) return;
    try {
      setCategories(await apiFetch<string[]>("/admin/audit-logs/categories", token));
      setCategoriesError(null);
    } catch (err) {
      setCategoriesError(messageOf(err));
    }
  }, [active, token]);

  const loadOlder = useCallback(async () => {
    const oldest = logs[logs.length - 1];
    if (!active || !hasMore || loading || loadingOlder || !oldest || shownQuery === null) return;
    const ticket = sequence.issue();
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const rows = await apiFetch<AuditLogEntry[]>(auditLogPagePath(shownQuery, oldest.id), token);
      if (!sequence.isCurrent(ticket)) return;
      const { shown, more } = splitPage(rows);
      setLogs((current) => [...current, ...shown]);
      setHasMore(more);
    } catch (err) {
      if (!sequence.isCurrent(ticket)) return;
      setOlderError(messageOf(err));
    } finally {
      if (sequence.isCurrent(ticket)) setLoadingOlder(false);
    }
  }, [active, token, logs, hasMore, loading, loadingOlder, shownQuery, sequence]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), searching ? AUDIT_SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [reload, searching]);

  useEffect(() => {
    void reloadCategories();
  }, [reloadCategories]);

  const refresh = useCallback(() => {
    void reload();
    void reloadCategories();
  }, [reload, reloadCategories]);

  return {
    logs,
    hasMore,
    loading,
    loadingOlder,
    error,
    olderError,
    categories,
    categoriesError,
    refresh,
    loadOlder,
  };
}
