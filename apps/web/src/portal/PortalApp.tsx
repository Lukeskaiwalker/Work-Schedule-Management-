// The partner portal — the whole app a subcontractor's login sees.
//
// Booted instead of the office App (see main.tsx / shellChoice.ts) for any
// /partner URL and for any stored partner session. It owns the session, the
// URL and which screen shows; every screen loads its own data.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, setUnauthorizedHandler } from "../api/client";
import "../styles/portal.css";
import { PortalAccountPage } from "./PortalAccountPage";
import { PortalLoginPage, PortalSetPasswordPage, type PublicCompany } from "./PortalAuthPages";
import { LogoutIcon } from "./PortalIcons";
import { PortalProjectsPage, PortalTasksPage } from "./PortalListPages";
import { BottomNav, PortalBand, PortalTitle, Skeletons, type NavTarget } from "./PortalParts";
import { PortalProjectPage } from "./PortalProjectPage";
import { PortalTaskPage } from "./PortalTaskPage";
import { PORTAL_TOKEN_KEY, getPortalMe, portalLogout } from "./portalApi";
import { parsePortalRoute, portalPath, type PortalRoute } from "./portalRoutes";
import type { PortalMe } from "./portalTypes";
import { isPortalPath } from "./shellChoice";

type Phase = "checking" | "ready" | "closed" | "error";

const HOME: PortalRoute = { name: "tasks", scope: "open" };
const SESSION_ENDED = "Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.";

function readToken(): string | null {
  try {
    return localStorage.getItem(PORTAL_TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(PORTAL_TOKEN_KEY, token);
    else localStorage.removeItem(PORTAL_TOKEN_KEY);
  } catch {
    // Private mode without storage: the session lives for this page only.
  }
}

function currentRoute(): PortalRoute {
  return parsePortalRoute(window.location.pathname, window.location.search);
}

export function PortalApp() {
  const [token, setToken] = useState<string | null>(readToken);
  const [route, setRoute] = useState<PortalRoute>(currentRoute);
  const [me, setMe] = useState<PortalMe | null>(null);
  const [phase, setPhase] = useState<Phase>(token ? "checking" : "ready");
  const [notice, setNotice] = useState<string | null>(null);
  const [company, setCompany] = useState<PublicCompany>({ name: "", logo_url: "" });
  const [retry, setRetry] = useState(0);

  // How many portal screens deep the history is. "Zurück" only uses the
  // browser's back when it leads to a portal screen; a job opened from an
  // e-mail link or a bookmark goes to its list instead of leaving the portal.
  const depth = useRef(0);

  const navigate = useCallback((next: PortalRoute, replace = false) => {
    const path = portalPath(next);
    if (replace) window.history.replaceState({}, "", path);
    else {
      window.history.pushState({}, "", path);
      depth.current += 1;
    }
    setRoute(next);
    window.scrollTo(0, 0);
  }, []);

  const back = useCallback(
    (fallback: PortalRoute) => {
      if (depth.current > 0) window.history.back();
      else navigate(fallback, true);
    },
    [navigate],
  );

  const endSession = useCallback((message: string | null) => {
    writeToken(null);
    setToken(null);
    setMe(null);
    setNotice(message);
  }, []);

  // A partner session that landed on an office URL ("/") is shown the
  // portal's own address, so reloads and bookmarks stay in the portal.
  useEffect(() => {
    if (!isPortalPath(window.location.pathname)) window.history.replaceState({}, "", portalPath(currentRoute()));
    const onPop = () => {
      depth.current = Math.max(0, depth.current - 1);
      setRoute(currentRoute());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => endSession(SESSION_ENDED));
    return () => setUnauthorizedHandler(null);
  }, [endSession]);

  // Branding for the signed-out screens (public endpoint, no login needed).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/settings/company/public")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { company_name?: string; navigation_title?: string; logo_url?: string } | null) => {
        if (cancelled || !data) return;
        setCompany({ name: data.company_name || data.navigation_title || "SMPL", logo_url: data.logo_url || "" });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!token) {
      setMe(null);
      setPhase("ready");
      return undefined;
    }
    let cancelled = false;
    setPhase("checking");
    getPortalMe(token)
      .then((loaded) => {
        if (cancelled) return;
        setMe(loaded);
        setPhase("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 403) {
          // Office staff who opened /partner belong in the office app.
          if (/for partner logins/i.test(error.message)) {
            window.location.replace("/");
            return;
          }
          setPhase("closed");
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          endSession(SESSION_ENDED);
          return;
        }
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [token, retry, endSession]);

  function onSession(newToken: string, role: string) {
    writeToken(newToken);
    if (role !== "external") {
      // An office login typed into the partner page: hand over to the office app.
      window.location.replace("/");
      return;
    }
    setNotice(null);
    setToken(newToken);
    if (route.name === "invite" || route.name === "reset") navigate(HOME, true);
  }

  async function logout() {
    await portalLogout(token);
    endSession(null);
    navigate(HOME, true);
  }

  function onNavigate(target: NavTarget) {
    if (target === "tasks") navigate({ name: "tasks", scope: "open" });
    else if (target === "projects") navigate({ name: "projects", scope: "open" });
    else navigate({ name: "account" });
  }

  if (route.name === "invite" || route.name === "reset") {
    return (
      <PortalSetPasswordPage
        company={company}
        mode={route.name}
        token={route.token}
        onSession={onSession}
        onDone={(message) => {
          setNotice(message);
          navigate(HOME, true);
        }}
      />
    );
  }

  if (!token) {
    return <PortalLoginPage company={company} notice={notice} onSession={onSession} />;
  }

  if (phase === "closed" || phase === "error" || !me) {
    return (
      <div className="pp">
        <PortalBand me={null} active={null} onNavigate={() => undefined}>
          <PortalTitle title={phase === "closed" ? "Zugang gesperrt" : phase === "error" ? "Keine Verbindung" : "Partnerportal"} />
        </PortalBand>
        <main className="pp-main">
          <div className="pp-main-inner">
            {phase === "checking" ? (
              <Skeletons count={3} />
            ) : (
              <>
                <div className={phase === "closed" ? "pp-alert" : "pp-notice"} role="alert">
                  {phase === "closed"
                    ? "Ihr Zugang ist derzeit gesperrt. Bitte wenden Sie sich an das Büro."
                    : "Das Portal ist gerade nicht erreichbar. Bitte Netz prüfen und erneut versuchen."}
                </div>
                {phase === "error" && (
                  <button type="button" className="pp-btn pp-btn--soft" onClick={() => setRetry((n) => n + 1)}>
                    Erneut versuchen
                  </button>
                )}
                <button type="button" className="pp-btn pp-btn--danger" onClick={logout}>
                  <LogoutIcon size={18} />
                  Abmelden
                </button>
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  const activeNav: NavTarget | null =
    route.name === "tasks" ? "tasks" : route.name === "projects" || route.name === "project" ? "projects" : route.name === "account" ? "account" : null;

  return (
    <div className="pp">
      {route.name === "tasks" && (
        <PortalTasksPage
          token={token}
          me={me}
          scope={route.scope}
          onScope={(scope) => navigate({ name: "tasks", scope }, true)}
          onNavigate={onNavigate}
          onOpenTask={(id) => navigate({ name: "task", id })}
        />
      )}
      {route.name === "task" && (
        <PortalTaskPage
          token={token}
          me={me}
          taskId={route.id}
          onBack={() => back(HOME)}
          onNavigate={onNavigate}
          onOpenProject={(id) => navigate({ name: "project", id })}
        />
      )}
      {route.name === "projects" && (
        <PortalProjectsPage
          token={token}
          me={me}
          scope={route.scope}
          onScope={(scope) => navigate({ name: "projects", scope }, true)}
          onNavigate={onNavigate}
          onOpenProject={(id) => navigate({ name: "project", id })}
        />
      )}
      {route.name === "project" && (
        <PortalProjectPage
          token={token}
          me={me}
          projectId={route.id}
          onBack={() => back({ name: "projects", scope: "open" })}
          onNavigate={onNavigate}
          onOpenTask={(id) => navigate({ name: "task", id })}
        />
      )}
      {route.name === "account" && <PortalAccountPage token={token} me={me} onNavigate={onNavigate} onLogout={logout} />}
      {route.name !== "task" && <BottomNav active={activeNav} onNavigate={onNavigate} />}
    </div>
  );
}
