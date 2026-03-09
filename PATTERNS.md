# PATTERNS — SMPL Implementation Patterns
> Established patterns used throughout this codebase.
> Reference these by name in task descriptions instead of re-explaining them.
> Keep this file current as new patterns are established.

---

## Pattern: Re-export shim

**Used for:** `app/models/entities.py`, `app/schemas/api.py`

When a monolithic file is split into domain files, the original file becomes a thin shim that re-exports everything. All existing `from app.models.entities import X` imports continue to work without changes.

```python
# entities.py (shim — do not add logic here)
from app.models.user import User, UserActionToken         # noqa: F401
from app.models.project import Project, ProjectMember     # noqa: F401
# ... one import line per domain file ...

__all__ = ["User", "UserActionToken", "Project", ...]
```

**Rule:** New classes always go in the domain file, never in the shim.

---

## Pattern: Adding a new domain model

1. Create `app/models/<domain>.py` with the SQLAlchemy class
2. Add a re-export line to `app/models/entities.py`
3. Create `app/schemas/<domain>.py` with the Pydantic `*Out` / `*Create` / `*Update` classes
4. Add re-export lines to `app/schemas/api.py` and its `__all__`
5. Create `app/routers/workflow_<domain>.py` with the FastAPI endpoints
6. Register the router in `app/main.py`
7. Create an Alembic migration: `docker compose exec api alembic revision --autogenerate -m "<description>"`
8. Add tests in `tests/test_<domain>.py`

---

## Pattern: notify() + SSE live update

**Used for:** any mutating endpoint that should broadcast a change in real-time.

**Backend — fire the event (in any router, after `db.commit()`):**

```python
from app.core.events import notify

# After db.commit() and db.refresh(entity):
notify(db, "domain.event_type", {
    "id": entity.id,
    "project_id": entity.project_id,  # include for project-scoped filtering
    # ... other fields the frontend needs to update its state ...
})
# notify() commits the pg_notify in its own tiny transaction
```

**Backend — add delivery filter (in `app/core/events.py` `_should_deliver()`):**

If the event is personal (like `notification.created`), add a case before the `if is_admin` check:

```python
if event_type == "my.event":
    return data.get("user_id") == user_id
```

If it's project-scoped, the existing `task.*` / `project.*` check handles it automatically.

**Frontend — handle the event (in `App.tsx` `handleServerEvent` switch):**

```typescript
case "domain.event_type": {
  const item = data as MyType;
  setItems(prev =>
    prev.some(i => i.id === item.id)
      ? prev.map(i => i.id === item.id ? { ...i, ...item } : i)  // update
      : [...prev, item]                                            // insert
  );
  break;
}
```

**Frontend — add to event table in CODEMAP.md** after implementing.

---

## Pattern: React.lazy named-export adapter

**Used for:** every page in `apps/web/src/pages/`.

Pages use named exports (`export function MyPage`). `React.lazy` requires a default export.
The adapter wraps the named export without modifying the source file:

```typescript
// In App.tsx — one line per page:
const MyPage = lazy(() =>
  import("./pages/MyPage").then(m => ({ default: m.MyPage }))
);
```

Rendered conditionally so the chunk only loads on first navigation to that view:

```tsx
{mainView === "my_view" && <MyPage />}
```

All page renders are wrapped in a single `<Suspense fallback={<div className="page-loading-spinner" />}>`.

---

## Pattern: Adding a new page

1. Create `apps/web/src/pages/<Name>Page.tsx` as a named export: `export function NamePage() { ... }`
2. Add the `mainView` key to the `MainView` union type in `App.tsx`
3. Add a `lazy()` import in `App.tsx` (see React.lazy pattern above)
4. Add `{mainView === "name" && <NamePage />}` inside the `<Suspense>` block in App.tsx
5. Add a nav item in `Sidebar.tsx` if the page should be reachable from the nav

---

## Pattern: Notification type

**Used for:** any new event that should create a personal in-app notification.

1. In the router where the trigger happens, import and call `_create_assignment_notifications` (or write a similar helper) that adds `Notification` rows before `db.commit()`
2. After `db.commit()`, call `notify(db, "notification.created", {"user_id": uid})` for each recipient
3. The frontend `handleServerEvent` already handles `notification.created` by calling `loadNotifications()` — no frontend change needed for new notification types

---

## Pattern: pytest endpoint test

**All backend tests follow this structure:**

```python
from __future__ import annotations
import pytest
from fastapi.testclient import TestClient
from tests.conftest import auth_headers

def _create_user(client, admin_token, username, role="employee"):
    resp = client.post("/api/admin/users", json={
        "username": username, "email": f"{username}@example.com",
        "password": "Test1234!", "full_name": username.title(),
        "role": role, "language": "en",
    }, headers=auth_headers(admin_token))
    assert resp.status_code in (200, 201)
    return resp.json()

def _login(client, username):
    resp = client.post("/api/auth/login", json={"username": username, "password": "Test1234!"})
    assert resp.status_code == 200
    return resp.headers["X-Access-Token"]

def test_something(client: TestClient, admin_token: str) -> None:
    # arrange
    user = _create_user(client, admin_token, "alice")
    token = _login(client, "alice")
    # act
    resp = client.get("/api/some-endpoint", headers=auth_headers(token))
    # assert
    assert resp.status_code == 200
```

Available fixtures (from `conftest.py`, no import needed):
- `client: TestClient` — FastAPI test client with DB reset per test
- `admin_token: str` — valid JWT for the default admin user
- `reset_db` — autouse, drops and recreates all tables before each test

---

## Pattern: Optimistic state update (frontend)

All state updates from SSE events and API responses use immutable patterns (never mutate):

```typescript
// Insert or update
setItems(prev =>
  prev.some(i => i.id === item.id)
    ? prev.map(i => i.id === item.id ? { ...i, ...item } : i)
    : [...prev, item]
);

// Delete
setItems(prev => prev.filter(i => i.id !== id));

// Replace list
setItems(newItems);  // from full refetch
```

---

## Pattern: AppContext consumer

Pages and components never manage their own data-fetching state. They read from context:

```typescript
import { useContext } from "react";
import { AppContext } from "../context/AppContext";

export function MyPage() {
  const { tasks, projects, language, mainView } = useContext(AppContext);
  if (mainView !== "my_view") return null;
  // render using context data
}
```

The `if (mainView !== "my_view") return null` guard is the standard visibility check — React still mounts the component but it renders nothing until it's the active view. (With lazy loading the component isn't even mounted until first navigation.)
