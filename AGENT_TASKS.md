# Agent Task File: In-App Notification System — SMPL
> **Agent:** GPT-5.3 Codex (or any capable coding model)
> **Working directory:** `/Users/luca/Documents/SMPL all/`
> **Goal:** Build a personal notification system for task assignments. When a user is assigned to a task they see a badge on the nav and can open a notification panel to review and dismiss them. Notifications arrive in real-time via the existing SSE system.

```
CURRENT_STEP: Task H — Completed (H1-H16)
```

---

## Completed Work

- **Tasks A–G:** All marked complete (model/router/schema splits, TypeScript fixes, test split, SSE live updates, SSE polish + commits)

---

## Architecture overview

```
Task assigned (workflow_tasks.py)
  → write Notification row(s) to DB
  → db.commit()
  → notify(db, "notification.created", {"user_id": X})  ← SSE fires only to user X

Client SSE stream (events.py)
  → _should_deliver(): notification.created filtered to exact user_id
  → browser receives event → adds to notifications[] state → badge lights up

User opens notification panel
  → GET /notifications  → list of NotificationOut
  → PATCH /notifications/read-all  → clears badge
```

**What triggers a notification:**

| Trigger | Recipient |
|---------|-----------|
| Task created with you as an assignee | Each assignee except the actor |
| Task updated and you were newly added as an assignee | Newly added assignees except the actor |

---

## Step-by-step instructions

### H1 — Read these files before starting

- [x] H1a. Read `apps/api/app/models/entities.py` — note the re-export shim pattern and which domain files it imports from
- [x] H1b. Read `apps/api/app/schemas/api.py` — note the re-export shim pattern for schemas
- [x] H1c. Read `apps/api/app/main.py` — note how routers are registered
- [x] H1d. Read `apps/api/app/core/events.py` — read the full `_should_deliver()` function
- [x] H1e. Read `apps/api/app/routers/workflow_tasks.py` — find the create-task and update-task endpoint functions. Note:
  - How `existing_assignee_ids` is built before the assignment sync
  - Where `_sync_task_assignments()` is called
  - Where `db.commit()` is called after assignment changes
- [x] H1f. Read `apps/web/src/App.tsx` — search for `hasTaskNotifications` to see how it is currently set and how it is used in the nav JSX

---

### H2 — Create the Notification model

- [x] H2. Create `apps/api/app/models/notification.py`:

```python
"""notification.py — Personal notification records for task assignments."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # The user who receives this notification
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # The user who triggered the event (may be null for system events)
    actor_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )

    # e.g. "task.assigned"
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    # e.g. "task"
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    # The primary key of the entity (task_id, etc.)
    entity_id: Mapped[int | None] = mapped_column(Integer)
    # Scoping — lets the frontend know which project context to navigate to
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )

    # Human-readable message, e.g. "Luca assigned you to 'Install scaffolding'"
    message: Mapped[str] = mapped_column(String(255), nullable=False)

    # Null = unread; set when the user dismisses the notification
    read_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, nullable=False, index=True
    )
```

---

### H3 — Register Notification in the entities re-export shim

- [x] H3. Open `apps/api/app/models/entities.py` and add:

```python
from app.models.notification import Notification  # noqa: F401
```

Place it with the other domain model imports, in alphabetical order.

---

### H4 — Create the Notification schema

- [x] H4. Create `apps/api/app/schemas/notification.py`:

```python
"""notification.py — Pydantic schemas for the notification system."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_type: str
    entity_type: str
    entity_id: int | None
    project_id: int | None
    message: str
    read_at: datetime | None
    created_at: datetime
    # Enriched display name of the actor — resolved at query time, not stored
    actor_name: str | None = None
```

---

### H5 — Register NotificationOut in the schemas re-export shim

- [x] H5. Open `apps/api/app/schemas/api.py` and add:

```python
from app.schemas.notification import NotificationOut  # noqa: F401
```

Add it to the `__all__` list as `"NotificationOut"`.

---

### H6 — Create the notifications router

- [x] H6. Create `apps/api/app/routers/workflow_notifications.py`:

```python
"""
workflow_notifications.py — Endpoints for the personal notification panel.

GET  /notifications          → list recent notifications for the current user
PATCH /notifications/read-all → mark all as read
PATCH /notifications/{id}/read → mark one as read
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.time import utcnow
from app.models.notification import Notification
from app.models.user import User
from app.schemas.notification import NotificationOut

router = APIRouter()


def _enrich(notif: Notification, db: Session) -> NotificationOut:
    """Resolve actor display name from the actor_user_id foreign key."""
    actor_name: str | None = None
    if notif.actor_user_id is not None:
        actor = db.get(User, notif.actor_user_id)
        if actor:
            actor_name = actor.preferred_name or actor.full_name or actor.username
    return NotificationOut(
        id=notif.id,
        event_type=notif.event_type,
        entity_type=notif.entity_type,
        entity_id=notif.entity_id,
        project_id=notif.project_id,
        message=notif.message,
        read_at=notif.read_at,
        created_at=notif.created_at,
        actor_name=actor_name,
    )


@router.get("/notifications", response_model=list[NotificationOut])
def list_notifications(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[NotificationOut]:
    """Return the 50 most recent notifications for the authenticated user."""
    rows = (
        db.execute(
            select(Notification)
            .where(Notification.user_id == current_user.id)
            .order_by(Notification.created_at.desc())
            .limit(50)
        )
        .scalars()
        .all()
    )
    return [_enrich(n, db) for n in rows]


@router.patch("/notifications/read-all", response_model=dict)
def mark_all_read(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Mark all of the current user's unread notifications as read."""
    now = utcnow()
    unread = (
        db.execute(
            select(Notification).where(
                Notification.user_id == current_user.id,
                Notification.read_at.is_(None),
            )
        )
        .scalars()
        .all()
    )
    for notif in unread:
        notif.read_at = now
    db.commit()
    return {"marked_read": len(unread)}


@router.patch("/notifications/{notif_id}/read", response_model=NotificationOut)
def mark_one_read(
    notif_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationOut:
    """Mark a single notification as read. Returns 404 if not found or not owned."""
    notif = db.get(Notification, notif_id)
    if notif is None or notif.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Notification not found")
    if notif.read_at is None:
        notif.read_at = utcnow()
        db.commit()
    return _enrich(notif, db)
```

---

### H7 — Register the notifications router in `main.py`

- [x] H7. Open `apps/api/app/main.py`. Import and register the new router alongside the others:

```python
from app.routers import workflow_notifications

# ... in the router registration section:
app.include_router(workflow_notifications.router, prefix="/api")
```

---

### H8 — Create notifications on task assignment (backend)

- [x] H8. Open `apps/api/app/routers/workflow_tasks.py`.

**Add this import at the top:**

```python
from app.models.notification import Notification
```

**Add this helper function** (place it near the other `_` helper functions in the file):

```python
def _create_assignment_notifications(
    db: Session,
    task: "Task",
    new_assignee_ids: list[int],
    actor: "User",
) -> None:
    """
    Write a Notification row for each newly added assignee.
    Skips the actor (no self-notifications).
    Call this BEFORE db.commit() so the notifications commit atomically
    with the task data, then call notify() for SSE after commit.
    """
    actor_display = actor.preferred_name or actor.full_name or actor.username
    for uid in new_assignee_ids:
        if uid == actor.id:
            continue
        db.add(
            Notification(
                user_id=uid,
                actor_user_id=actor.id,
                event_type="task.assigned",
                entity_type="task",
                entity_id=task.id,
                project_id=task.project_id,
                message=f"{actor_display} assigned you to \"{task.title}\"",
            )
        )
```

**Wire into the create-task endpoint:**

After `_sync_task_assignments()` is called (or wherever `existing_assignee_ids` is finalized), and BEFORE `db.commit()`, add:

```python
_create_assignment_notifications(db, task, existing_assignee_ids, current_user)
```

Then AFTER `db.commit()` and `db.refresh(task)`, add an SSE notify for each new assignee. Because SSE filtering is per `user_id`, fire one event per recipient:

```python
for uid in existing_assignee_ids:
    if uid != current_user.id:
        notify(db, "notification.created", {"user_id": uid})
```

**Wire into the update-task endpoint:**

Find where the assignees are changed (look for `_sync_task_assignments(db, task, next_assignee_ids)`). Before calling it, capture the previous set:

```python
# Read existing assignees BEFORE the sync:
prev_assignee_ids: set[int] = set(existing_assignee_ids)
```

After calling `_sync_task_assignments(db, task, next_assignee_ids)`:

```python
added_assignee_ids = list(set(next_assignee_ids) - prev_assignee_ids)
_create_assignment_notifications(db, task, added_assignee_ids, current_user)
```

Then AFTER `db.commit()` and `db.refresh(task)`:

```python
for uid in added_assignee_ids:
    if uid != current_user.id:
        notify(db, "notification.created", {"user_id": uid})
```

> **Important:** Read the actual function bodies before editing. Variable names like `existing_assignee_ids` and `next_assignee_ids` may differ slightly — use the real names from the code.

---

### H9 — Filter `notification.created` events in SSE

- [x] H9. Open `apps/api/app/core/events.py`. Find the `_should_deliver()` function.

Add a new condition at the top of `_should_deliver()` (before the project-scoped checks), so notification events are only delivered to the intended recipient:

```python
def _should_deliver(
    event_type: str,
    data: dict,
    user_id: int,
    project_ids: set[int],
    thread_ids: set[int],
    is_admin: bool,
) -> bool:
    # Personal notifications — always deliver only to the exact recipient,
    # even for admins (admin should see their own notifications, not everyone's)
    if event_type == "notification.created":
        return data.get("user_id") == user_id

    if is_admin:
        return True

    # ... rest of function unchanged ...
```

---

### H10 — Create the `NotificationPanel` frontend component

- [x] H10. Create `apps/web/src/components/NotificationPanel.tsx`:

```tsx
/**
 * NotificationPanel — slide-in panel showing recent personal notifications.
 *
 * Rendered inside the sidebar when the bell button is clicked.
 * Marks all as read when the panel is opened.
 */
import { useEffect } from "react";

export type AppNotification = {
  id: number;
  event_type: string;
  entity_type: string;
  entity_id: number | null;
  project_id: number | null;
  message: string;
  read_at: string | null;
  created_at: string;
  actor_name: string | null;
};

type Props = {
  notifications: AppNotification[];
  language: "de" | "en";
  onMarkAllRead: () => void;
  onDismiss: () => void;
  onNavigate: (notif: AppNotification) => void;
};

function formatAge(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationPanel({
  notifications,
  language,
  onMarkAllRead,
  onDismiss,
  onNavigate,
}: Props) {
  const unreadCount = notifications.filter((n) => n.read_at === null).length;

  // Auto-mark-all-read when panel opens
  useEffect(() => {
    if (unreadCount > 0) {
      onMarkAllRead();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run only on mount

  const title = language === "de" ? "Benachrichtigungen" : "Notifications";
  const emptyText =
    language === "de" ? "Keine Benachrichtigungen" : "No notifications";
  const closeLabel = language === "de" ? "Schließen" : "Close";

  return (
    <div className="notification-panel" role="dialog" aria-label={title}>
      <div className="notification-panel-header">
        <span className="notification-panel-title">{title}</span>
        <button
          type="button"
          className="notification-panel-close"
          onClick={onDismiss}
          aria-label={closeLabel}
        >
          ✕
        </button>
      </div>

      {notifications.length === 0 ? (
        <p className="notification-panel-empty">{emptyText}</p>
      ) : (
        <ul className="notification-list">
          {notifications.map((n) => (
            <li
              key={n.id}
              className={`notification-item${n.read_at === null ? " notification-item--unread" : ""}`}
              onClick={() => onNavigate(n)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && onNavigate(n)}
            >
              <span className="notification-message">{n.message}</span>
              <time
                className="notification-age"
                dateTime={n.created_at}
                title={new Date(n.created_at).toLocaleString()}
              >
                {formatAge(n.created_at)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

---

### H11 — Wire notifications into `App.tsx`

- [x] H11. Make the following changes to `apps/web/src/App.tsx`.

**Read App.tsx first.** Search for `hasTaskNotifications` to find all relevant locations.

**Change 1 — Import the component and type:**

Near the top of App.tsx where other components are imported:

```typescript
import { NotificationPanel, type AppNotification } from "./components/NotificationPanel";
```

**Change 2 — Add state variables** (near the existing `hasTaskNotifications` declaration):

```typescript
const [notifications, setNotifications] = useState<AppNotification[]>([]);
const [notifPanelOpen, setNotifPanelOpen] = useState(false);
```

**Change 3 — Add `loadNotifications` function** (near the other `load*` async functions):

```typescript
async function loadNotifications() {
  if (!token) return;
  try {
    const data = await apiFetch<AppNotification[]>("/notifications", token);
    setNotifications(data);
  } catch {
    // Silently ignore — notifications are non-critical
  }
}
```

**Change 4 — Drive `hasTaskNotifications` from the notifications state.**

Find the existing line that declares `hasTaskNotifications`:

```typescript
const [hasTaskNotifications, setHasTaskNotifications] = useState(false);
```

Replace it with a derived value (no longer a useState):

```typescript
const hasTaskNotifications = notifications.some((n) => n.read_at === null);
```

> If ESLint or TypeScript complains about `setHasTaskNotifications` being used elsewhere, search for all usages and remove them — the value is now computed, not set manually.

**Change 5 — Load notifications on login.**

Find the `useEffect` that runs when `token` and `user` are first available (there should be one that loads the initial data). Add a call to `loadNotifications()` inside it. If no single "on login" effect exists, add:

```typescript
useEffect(() => {
  if (!token || !user) return;
  void loadNotifications();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [token, user?.id]);
```

**Change 6 — Handle `notification.created` in the SSE event handler.**

Find the `handleServerEvent` `useCallback` (search for `"task.created"` to locate it). Add a new case:

```typescript
case "notification.created": {
  // Refresh the notifications list when a new one arrives for this user
  void loadNotifications();
  break;
}
```

Add `loadNotifications` to the `useCallback` dependency array.

**Change 7 — Add `markAllRead` function:**

```typescript
async function markAllNotificationsRead() {
  if (!token) return;
  try {
    await apiFetch<{ marked_read: number }>("/notifications/read-all", token, {
      method: "PATCH",
    });
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: new Date().toISOString() })));
  } catch {
    // Non-critical
  }
}
```

**Change 8 — Add the bell button and panel to the sidebar.**

Find the sidebar JSX (search for `className="sidebar"` or the existing `hasUnreadThreads` unread dot). Inside the sidebar, near the bottom (close to where the user profile/avatar is rendered), add:

```tsx
{/* ── Notification bell ────────────────────────────── */}
{token && (
  <div className="notif-bell-wrap">
    <button
      type="button"
      className="notif-bell-btn"
      onClick={() => setNotifPanelOpen((prev) => !prev)}
      aria-label={language === "de" ? "Benachrichtigungen" : "Notifications"}
    >
      {/* Bell icon — use an SVG or an emoji as placeholder */}
      🔔
      {hasTaskNotifications && (
        <span className="notif-bell-badge" aria-label="Unread notifications" />
      )}
    </button>

    {notifPanelOpen && (
      <NotificationPanel
        notifications={notifications}
        language={language}
        onMarkAllRead={markAllNotificationsRead}
        onDismiss={() => setNotifPanelOpen(false)}
        onNavigate={(notif) => {
          setNotifPanelOpen(false);
          // Navigate to the relevant view based on entity type
          if (notif.entity_type === "task") {
            setMainView("my_tasks");
            // If the app has a way to open a specific task modal, do it here.
            // Otherwise, navigating to my_tasks is sufficient for now.
          } else if (notif.project_id) {
            setMainView("project");
            // Set active project if the app supports it:
            // setActiveProjectId(notif.project_id);
          }
        }}
      />
    )}
  </div>
)}
```

> **Read the actual sidebar JSX** before inserting. Find a natural location — near the user avatar/profile button at the bottom of the sidebar works well. The `setMainView` and any project-navigation setter should use the actual function names from App.tsx.

---

### H12 — Add CSS for the notification UI

- [x] H12. In the same CSS file where `.nav-unread-dot` and `.sse-status-dot` are defined, add:

```css
/* ── Notification bell ─────────────────────────────────────────────────── */
.notif-bell-wrap {
  position: relative;
}

.notif-bell-btn {
  position: relative;
  background: none;
  border: none;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 18px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s;
}

.notif-bell-btn:hover {
  background-color: var(--color-hover, rgba(0, 0, 0, 0.06));
}

.notif-bell-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #ef4444; /* red-500 */
  border: 2px solid var(--color-sidebar-bg, #fff);
}

/* ── Notification panel ────────────────────────────────────────────────── */
.notification-panel {
  position: absolute;
  bottom: 48px;
  left: calc(100% + 8px);
  width: 320px;
  max-height: 420px;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 200;
}

.notification-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border, #e5e7eb);
  flex-shrink: 0;
}

.notification-panel-title {
  font-weight: 600;
  font-size: 14px;
}

.notification-panel-close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--color-muted, #6b7280);
  padding: 2px 6px;
  border-radius: 4px;
}

.notification-panel-close:hover {
  background-color: var(--color-hover, rgba(0, 0, 0, 0.06));
}

.notification-panel-empty {
  padding: 24px 16px;
  color: var(--color-muted, #6b7280);
  font-size: 14px;
  text-align: center;
}

.notification-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}

.notification-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 16px;
  cursor: pointer;
  border-bottom: 1px solid var(--color-border, #f3f4f6);
  transition: background-color 0.12s;
}

.notification-item:hover {
  background-color: var(--color-hover, rgba(0, 0, 0, 0.04));
}

.notification-item--unread {
  background-color: var(--color-unread-bg, #eff6ff);
}

.notification-item--unread:hover {
  background-color: var(--color-unread-hover, #dbeafe);
}

.notification-message {
  font-size: 13px;
  line-height: 1.4;
  color: var(--color-text, #111827);
}

.notification-age {
  font-size: 11px;
  color: var(--color-muted, #6b7280);
}
```

---

### H13 — TypeScript check

- [x] H13. Run `cd apps/web && npx tsc --noEmit` — must report **0 errors**.

Fix any type errors before continuing.

---

### H14 — Backend verification

- [x] H14a. Rebuild the Docker image to pick up the new model:

```bash
docker compose build api && docker compose up -d
```

- [x] H14b. Verify the new table was created (the app uses SQLAlchemy `create_all` at startup):

```bash
docker compose exec db psql -U postgres -d smpl -c "\dt notifications"
```

Should show the `notifications` table.

- [x] H14c. Verify the endpoints are registered:

```bash
curl -s http://localhost:8000/api/notifications \
  -H "Authorization: Bearer INVALID" | python3 -m json.tool
# Should return {"detail": "..."} 401
```

- [x] H14d. Run the full test suite:

```bash
docker compose exec api pytest tests/ -x -q
```

---

### H15 — Write tests for the notifications endpoints

- [x] H15. Create `apps/api/tests/test_notifications.py`:

```python
"""
test_notifications.py — Tests for the /api/notifications endpoints.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tests.conftest import auth_headers


def _create_employee(client: TestClient, admin_token: str, username: str) -> dict:
    resp = client.post(
        "/api/admin/users",
        json={
            "username": username,
            "email": f"{username}@example.com",
            "password": "Test1234!",
            "full_name": username.title(),
            "role": "employee",
            "language": "en",
        },
        headers=auth_headers(admin_token),
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


def _login(client: TestClient, username: str) -> str:
    resp = client.post(
        "/api/auth/login",
        json={"username": username, "password": "Test1234!"},
    )
    assert resp.status_code == 200
    token = resp.headers.get("X-Access-Token")
    assert token
    return token


def test_notifications_empty_for_new_user(
    client: TestClient, admin_token: str
) -> None:
    """A freshly created user has no notifications."""
    _create_employee(client, admin_token, "alice_notif")
    token = _login(client, "alice_notif")
    resp = client.get("/api/notifications", headers=auth_headers(token))
    assert resp.status_code == 200
    assert resp.json() == []


def test_assignment_creates_notification(
    client: TestClient, admin_token: str
) -> None:
    """Assigning a user to a task creates a notification for that user."""
    # Create a project
    proj = client.post(
        "/api/projects",
        json={"title": "Notif Test Project", "status": "active"},
        headers=auth_headers(admin_token),
    ).json()
    project_id = proj["id"]

    # Create the assignee
    employee = _create_employee(client, admin_token, "bob_notif")
    emp_token = _login(client, "bob_notif")

    # Admin creates a task assigned to the employee
    task_resp = client.post(
        "/api/tasks",
        json={
            "title": "Do the thing",
            "project_id": project_id,
            "assignee_ids": [employee["id"]],
        },
        headers=auth_headers(admin_token),
    )
    assert task_resp.status_code in (200, 201), task_resp.text

    # Employee should now have 1 unread notification
    notif_resp = client.get("/api/notifications", headers=auth_headers(emp_token))
    assert notif_resp.status_code == 200
    notifs = notif_resp.json()
    assert len(notifs) == 1
    assert notifs[0]["event_type"] == "task.assigned"
    assert notifs[0]["read_at"] is None


def test_mark_all_read_clears_unread(
    client: TestClient, admin_token: str
) -> None:
    """PATCH /notifications/read-all sets read_at on all unread notifications."""
    proj = client.post(
        "/api/projects",
        json={"title": "Read Test Project", "status": "active"},
        headers=auth_headers(admin_token),
    ).json()

    employee = _create_employee(client, admin_token, "carol_notif")
    emp_token = _login(client, "carol_notif")

    client.post(
        "/api/tasks",
        json={
            "title": "Task for Carol",
            "project_id": proj["id"],
            "assignee_ids": [employee["id"]],
        },
        headers=auth_headers(admin_token),
    )

    # Mark all read
    mark_resp = client.patch(
        "/api/notifications/read-all", headers=auth_headers(emp_token)
    )
    assert mark_resp.status_code == 200
    assert mark_resp.json()["marked_read"] == 1

    # Now all notifications are read
    notifs = client.get(
        "/api/notifications", headers=auth_headers(emp_token)
    ).json()
    assert all(n["read_at"] is not None for n in notifs)


def test_self_assignment_does_not_create_notification(
    client: TestClient, admin_token: str
) -> None:
    """When the actor assigns themselves, no self-notification is created."""
    proj = client.post(
        "/api/projects",
        json={"title": "Self Assign Project", "status": "active"},
        headers=auth_headers(admin_token),
    ).json()

    # Get admin user id
    me_resp = client.get("/api/auth/me", headers=auth_headers(admin_token))
    admin_id = me_resp.json()["id"]

    client.post(
        "/api/tasks",
        json={
            "title": "Admin self-task",
            "project_id": proj["id"],
            "assignee_ids": [admin_id],
        },
        headers=auth_headers(admin_token),
    )

    notifs = client.get(
        "/api/notifications", headers=auth_headers(admin_token)
    ).json()
    # Admin assigned themselves — should produce no notification
    assert all(n["event_type"] != "task.assigned" for n in notifs)
```

- [x] H15b. Run `docker compose exec api pytest tests/test_notifications.py -v`

---

### H16 — Final verification

- [x] H16-1. `docker compose exec api pytest tests/ -x -q` — all tests pass
- [x] H16-2. `cd apps/web && npx tsc --noEmit` — 0 TypeScript errors
- [x] H16-3. Open the app in browser. Assign a task to a user while logged in as that user in another tab. Confirm the bell badge appears without a page reload.
- [x] H16-4. Click the bell. Confirm the notification panel slides open, shows the assignment message, and the badge disappears after the panel auto-marks all as read.

**TASK H STATUS:** ☑ COMPLETE
