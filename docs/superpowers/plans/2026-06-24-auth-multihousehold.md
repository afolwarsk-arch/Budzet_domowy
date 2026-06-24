# Auth + Multi-Household Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodać Google Login (Firebase Auth) i wielogospodarstwowość — każda rodzina widzi tylko swoje dane, Adam i Ola to jedno gospodarstwo, rodzice Adama to drugie.

**Architecture:** Frontend używa Firebase JS SDK do logowania Google i przechowuje JWT token. Backend (FastAPI) weryfikuje token przez Firebase Admin SDK i filtruje wszystkie zapytania DB po `household_id`. Zaproszenia działają jako jednorazowe linki z losowym kodem.

**Tech Stack:** `firebase-admin` (Python), Firebase JS SDK v10 (compat, CDN), FastAPI `Security` dependency, SQLite (nowe tabele), Railway (hosting).

## Global Constraints

- Python: `C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\python.exe`
- pip/uvicorn: z tego samego katalogu Python314
- Baza: `budget.db` — migracje przez `ALTER TABLE` i `CREATE TABLE IF NOT EXISTS`, nigdy DROP
- Frontend: vanilla JS, zero frameworków, zero build step
- Firebase JS SDK: wersja compat ładowana z CDN (`https://www.gstatic.com/firebasejs/10.14.1/`)
- Wszystkie dotychczasowe endpointy API muszą dalej działać (kompatybilność wsteczna niedozwolona do usunięcia)
- Admin email: `a.folwarsk@gmail.com` (hardcode w `auth.py`)
- `osoba` w `wydatki` zostaje jako imię osoby (Adam/Ola) — nie jest zastępowane przez `user_id`

---

## File Map

| Plik | Akcja | Odpowiedzialność |
|------|-------|-----------------|
| `Procfile` | Utwórz | Railway: uruchomienie serwera |
| `.env.example` | Utwórz | Dokumentacja zmiennych środowiskowych |
| `requirements.txt` | Modyfikuj | Dodaj `firebase-admin` |
| `auth.py` | Utwórz | Weryfikacja Firebase JWT, `get_current_user` dependency, admin check |
| `database.py` | Modyfikuj | Nowe tabele + migracja + `household_id` we wszystkich zapytaniach |
| `main.py` | Modyfikuj | Podpięcie auth do endpointów, nowe trasy household/invite |
| `static/login.html` | Utwórz | Strona logowania Google |
| `static/onboarding.html` | Utwórz | Tworzenie / dołączanie do gospodarstwa |
| `static/index.html` | Modyfikuj | Przycisk wylogowania, ukryty token |
| `static/upload.html` | Modyfikuj | Przycisk wylogowania, auto-fill osoba |
| `static/analiza.html` | Modyfikuj | Przycisk wylogowania |
| `static/app.js` | Modyfikuj | Auth state check, Bearer token we fetch, logout, onboarding redirect |
| `static/auth.js` | Utwórz | Wspólna logika Firebase (init, getToken, requireAuth, logout) |

---

## Task 1: Railway Deployment

**Files:**
- Create: `Procfile`
- Create: `.env.example`
- Modify: `requirements.txt`

**Interfaces:**
- Produces: działająca apka pod publicznym URL Railway

- [ ] **Krok 1: Dodaj `firebase-admin` do requirements.txt**

```
fastapi
uvicorn[standard]
anthropic
python-multipart
python-dotenv
pillow
firebase-admin
```

- [ ] **Krok 2: Utwórz `Procfile`**

```
web: uvicorn main:app --host 0.0.0.0 --port $PORT
```

- [ ] **Krok 3: Utwórz `.env.example`**

```
ANTHROPIC_API_KEY=sk-ant-...
FIREBASE_PROJECT_ID=twoj-projekt-id
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"firebase-adminsdk-...@....iam.gserviceaccount.com","client_id":"...","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token"}
```

- [ ] **Krok 4: Zarejestruj projekt w Firebase Console**

1. Wejdź na https://console.firebase.google.com/
2. Utwórz nowy projekt (np. `budzet-domowy`)
3. W projekcie: **Authentication → Sign-in method → Google → Enable**
4. W projekcie: **Project Settings → Service accounts → Generate new private key** — pobierz JSON
5. Zawartość JSON wklej jako `FIREBASE_SERVICE_ACCOUNT_JSON` w Railway env vars (wszystko w jednej linii)
6. `FIREBASE_PROJECT_ID` = ID projektu z Firebase Console (widoczne na górze strony)

- [ ] **Krok 5: Deploy na Railway**

1. Wejdź na https://railway.app/ → New Project → Deploy from GitHub repo
2. Wybierz repo `Budżet_domowy`
3. W Settings → Variables: dodaj `ANTHROPIC_API_KEY` i `FIREBASE_PROJECT_ID` i `FIREBASE_SERVICE_ACCOUNT_JSON`
4. Railway automatycznie wykryje Python i uruchomi `Procfile`

- [ ] **Krok 6: Sprawdź że apka działa**

Otwórz URL Railway → dashboard powinien się załadować (bez logowania na razie, auth dodajemy w kolejnych taskach).

- [ ] **Krok 7: W Firebase Console dodaj domenę Railway do Authorized domains**

Project Settings → Authentication → Authorized domains → Add domain: `twoja-apka.up.railway.app`

- [ ] **Krok 8: Commit**

```bash
git add Procfile .env.example requirements.txt
git commit -m "feat: railway deploy config + firebase-admin dependency"
```

---

## Task 2: DB — Nowe tabele i migracja

**Files:**
- Modify: `database.py`

**Interfaces:**
- Produces:
  - `create_household(name: str) -> int`
  - `get_household(household_id: int) -> dict | None`
  - `get_user_by_firebase_uid(firebase_uid: str) -> dict | None`
  - `create_or_update_user(firebase_uid: str, email: str, name: str, picture: str) -> int`
  - `get_user_household(user_id: int) -> dict | None`
  - `add_member(user_id: int, household_id: int, role: str) -> None`
  - `get_household_members(household_id: int) -> list[dict]`
  - `create_invitation(household_id: int, created_by: int) -> str`
  - `use_invitation(code: str) -> dict | None` — zwraca `{household_id, household_name}` lub None
  - wszystkie istniejące funkcje stats/wydatki dostają dodatkowy param `household_id: int`

- [ ] **Krok 1: Dodaj nowe tabele do SCHEMA w database.py**

Znajdź stałą `SCHEMA` w `database.py` (linia 7) i zamień na:

```python
SCHEMA = """
CREATE TABLE IF NOT EXISTS households (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    firebase_uid TEXT UNIQUE NOT NULL,
    email        TEXT NOT NULL,
    name         TEXT NOT NULL DEFAULT '',
    picture      TEXT DEFAULT '',
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memberships (
    user_id      INTEGER NOT NULL REFERENCES users(id),
    household_id INTEGER NOT NULL REFERENCES households(id),
    role         TEXT NOT NULL DEFAULT 'member',
    PRIMARY KEY (user_id, household_id)
);

CREATE TABLE IF NOT EXISTS invitations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT UNIQUE NOT NULL,
    household_id INTEGER NOT NULL REFERENCES households(id),
    created_by   INTEGER NOT NULL REFERENCES users(id),
    expires_at   TIMESTAMP NOT NULL,
    used         INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wydatki (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    data         DATE NOT NULL,
    sklep        TEXT,
    suma         REAL NOT NULL,
    osoba        TEXT NOT NULL DEFAULT 'Adam',
    notatki      TEXT,
    zdjecie      TEXT,
    waluta       TEXT NOT NULL DEFAULT 'PLN',
    kurs         REAL NOT NULL DEFAULT 1.0,
    household_id INTEGER REFERENCES households(id),
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pozycje (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    wydatek_id        INTEGER NOT NULL REFERENCES wydatki(id) ON DELETE CASCADE,
    nazwa             TEXT NOT NULL,
    cena              REAL NOT NULL,
    ilosc             REAL NOT NULL DEFAULT 1,
    kategoria_glowna  TEXT NOT NULL DEFAULT 'Inne',
    kategoria         TEXT NOT NULL
);

PRAGMA foreign_keys = ON;
"""
```

- [ ] **Krok 2: Dodaj migrację `household_id` w `init_db()`**

W `init_db()`, po istniejących migracjach (linia ~126), dodaj:

```python
        # Migracja: dodaj household_id do wydatki
        wcols = [r[1] for r in conn.execute("PRAGMA table_info(wydatki)").fetchall()]
        if "household_id" not in wcols:
            conn.execute("ALTER TABLE wydatki ADD COLUMN household_id INTEGER REFERENCES households(id)")
```

- [ ] **Krok 3: Dodaj nowe funkcje DB na końcu `database.py`**

```python
# --- households & users ---

def create_household(name: str) -> int:
    with get_db() as conn:
        cur = conn.execute("INSERT INTO households (name) VALUES (?)", (name,))
        return cur.lastrowid


def get_household(household_id: int) -> dict | None:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM households WHERE id = ?", (household_id,)).fetchone()
        return dict(row) if row else None


def create_or_update_user(firebase_uid: str, email: str, name: str, picture: str) -> int:
    with get_db() as conn:
        conn.execute(
            """INSERT INTO users (firebase_uid, email, name, picture) VALUES (?,?,?,?)
               ON CONFLICT(firebase_uid) DO UPDATE SET email=excluded.email, name=excluded.name, picture=excluded.picture""",
            (firebase_uid, email, name, picture),
        )
        row = conn.execute("SELECT id FROM users WHERE firebase_uid = ?", (firebase_uid,)).fetchone()
        return row["id"]


def get_user_by_firebase_uid(firebase_uid: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE firebase_uid = ?", (firebase_uid,)).fetchone()
        return dict(row) if row else None


def get_user_household(user_id: int) -> dict | None:
    with get_db() as conn:
        row = conn.execute(
            """SELECT h.id, h.name, m.role FROM households h
               JOIN memberships m ON m.household_id = h.id
               WHERE m.user_id = ? LIMIT 1""",
            (user_id,),
        ).fetchone()
        return dict(row) if row else None


def add_member(user_id: int, household_id: int, role: str = "member") -> None:
    with get_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO memberships (user_id, household_id, role) VALUES (?,?,?)",
            (user_id, household_id, role),
        )


def get_household_members(household_id: int) -> list[dict]:
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            """SELECT u.id, u.name, u.email, u.picture, m.role
               FROM users u JOIN memberships m ON m.user_id = u.id
               WHERE m.household_id = ?""",
            (household_id,),
        ).fetchall()]


def create_invitation(household_id: int, created_by: int) -> str:
    import secrets
    from datetime import datetime, timedelta
    code = secrets.token_urlsafe(8)
    expires = (datetime.utcnow() + timedelta(days=7)).isoformat()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO invitations (code, household_id, created_by, expires_at) VALUES (?,?,?,?)",
            (code, household_id, created_by, expires),
        )
    return code


def use_invitation(code: str) -> dict | None:
    from datetime import datetime
    with get_db() as conn:
        row = conn.execute(
            """SELECT i.household_id, h.name AS household_name
               FROM invitations i JOIN households h ON h.id = i.household_id
               WHERE i.code = ? AND i.used = 0 AND i.expires_at > ?""",
            (code, datetime.utcnow().isoformat()),
        ).fetchone()
        if not row:
            return None
        conn.execute("UPDATE invitations SET used = 1 WHERE code = ?", (code,))
        return dict(row)


def get_all_households() -> list[dict]:
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            """SELECT h.id, h.name, h.created_at, COUNT(m.user_id) AS members
               FROM households h LEFT JOIN memberships m ON m.household_id = h.id
               GROUP BY h.id ORDER BY h.created_at DESC"""
        ).fetchall()]
```

- [ ] **Krok 4: Zaktualizuj `_where_params` aby przyjmował `household_id`**

Znajdź `_where_params` (linia ~249) i zamień na:

```python
def _where_params(month, osoba, household_id: int | None = None):
    conditions, params = [], []
    if household_id is not None:
        conditions.append("w.household_id = ?"); params.append(household_id)
    if month:
        conditions.append("strftime('%Y-%m', w.data) = ?"); params.append(month)
    if osoba:
        conditions.append("w.osoba = ?"); params.append(osoba)
    return ("WHERE " + " AND ".join(conditions)) if conditions else "", params
```

- [ ] **Krok 5: Dodaj `household_id` do `create_wydatek` i `get_wydatki`**

W `create_wydatek` (linia ~130), zmień sygnaturę i INSERT:

```python
def create_wydatek(data: str, sklep: str | None, suma: float, osoba: str,
                   notatki: str | None, zdjecie: str | None,
                   pozycje: list[dict],
                   waluta: str = "PLN", kurs: float = 1.0,
                   household_id: int | None = None) -> int:
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO wydatki (data, sklep, suma, osoba, notatki, zdjecie, waluta, kurs, household_id) VALUES (?,?,?,?,?,?,?,?,?)",
            (data, sklep, suma, osoba, notatki, zdjecie, waluta, kurs, household_id),
        )
        wydatek_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO pozycje (wydatek_id, nazwa, cena, ilosc, kategoria_glowna, kategoria) VALUES (?,?,?,?,?,?)",
            [(wydatek_id, p["nazwa"], p["cena"], p.get("ilosc", 1),
              p.get("kategoria_glowna", "Inne"), p.get("kategoria", "Inne"))
             for p in pozycje],
        )
    return wydatek_id
```

W `get_wydatki` (linia ~149), zmień sygnaturę i WHERE:

```python
def get_wydatki(month: str | None = None, osoba: str | None = None,
                kategoria: str | None = None, household_id: int | None = None) -> list[dict]:
    conditions, params = [], []
    if household_id is not None:
        conditions.append("w.household_id = ?"); params.append(household_id)
    if month:
        conditions.append("strftime('%Y-%m', w.data) = ?"); params.append(month)
    if osoba:
        conditions.append("w.osoba = ?"); params.append(osoba)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    if kategoria:
        query = f"""
            SELECT DISTINCT w.id, w.data, w.sklep, w.suma, w.osoba, w.notatki, w.zdjecie, w.created_at
            FROM wydatki w JOIN pozycje p ON p.wydatek_id = w.id
            {where} {'AND' if where else 'WHERE'} p.kategoria_glowna = ?
            ORDER BY w.data DESC"""
        params.append(kategoria)
    else:
        query = f"""
            SELECT w.id, w.data, w.sklep, w.suma, w.osoba, w.notatki, w.zdjecie, w.created_at
            FROM wydatki w {where} ORDER BY w.data DESC"""

    with get_db() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]
```

- [ ] **Krok 6: Dodaj `household_id` do wszystkich funkcji stats**

Dla każdej z poniższych funkcji — zmień sygnaturę aby przyjmowała `household_id: int | None = None` i przekaż go do `_where_params`:

`stats_kategorie`, `stats_pozycje_subkat`, `stats_subkategorie`, `stats_subkategorie_all`, `stats_sklepy`, `stats_top_produkt`

Przykład dla `stats_kategorie`:
```python
def stats_kategorie(month=None, osoba=None, household_id: int | None = None) -> list[dict]:
    where, params = _where_params(month, osoba, household_id)
    # reszta bez zmian
```

Dla `stats_miesiace` (ma osobną logikę WHERE):
```python
def stats_miesiace(n=6, osoba=None, kategoria=None, household_id: int | None = None) -> list[dict]:
    params = []
    hid_cond = f"w.household_id = {household_id} AND " if household_id is not None else ""
    # ... reszta logiki z hid_cond wplecionym w WHERE
```

- [ ] **Krok 7: Dodaj `household_id` do `get_pozycje_do_rekat`**

```python
def get_pozycje_do_rekat(month=None, od=None, do=None, household_id: int | None = None) -> list[dict]:
    conditions, params = [], []
    if household_id is not None:
        conditions.append("w.household_id = ?"); params.append(household_id)
    # ... reszta bez zmian
```

- [ ] **Krok 8: Uruchom apkę lokalnie i sprawdź że baza się migruje bez błędów**

```powershell
C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\Scripts\uvicorn.exe main:app --reload
```

Sprawdź w logach że nie ma błędów SQL. Dashboard powinien działać jak przed zmianami.

- [ ] **Krok 9: Commit**

```bash
git add database.py
git commit -m "feat: add households/users/memberships/invitations tables + household_id in all queries"
```

---

## Task 3: Backend — Auth Middleware (`auth.py`)

**Files:**
- Create: `auth.py`
- Modify: `main.py` (tylko import i inicjalizacja)

**Interfaces:**
- Consumes: `FIREBASE_PROJECT_ID` env var, `FIREBASE_SERVICE_ACCOUNT_JSON` env var
- Produces:
  - `get_current_user(credentials) -> dict` — `{firebase_uid, email, name, picture, user_id, household_id, role}`
  - `require_admin(user) -> dict` — raises 403 jeśli nie admin
  - `ADMIN_EMAILS: set[str]`

- [ ] **Krok 1: Utwórz `auth.py`**

```python
import json
import os

import firebase_admin
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials

import database

ADMIN_EMAILS = {"a.folwarsk@gmail.com"}

_bearer = HTTPBearer(auto_error=False)


def _init_firebase():
    if firebase_admin._apps:
        return
    sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
    if sa_json:
        cred = credentials.Certificate(json.loads(sa_json))
    else:
        cred = credentials.ApplicationDefault()
    firebase_admin.initialize_app(cred)


_init_firebase()


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    if not creds:
        raise HTTPException(status_code=401, detail="Brak tokenu autoryzacji")
    try:
        decoded = firebase_auth.verify_id_token(creds.credentials)
    except Exception:
        raise HTTPException(status_code=401, detail="Nieprawidłowy token")

    firebase_uid = decoded["uid"]
    email = decoded.get("email", "")
    name = decoded.get("name", "") or email.split("@")[0]
    picture = decoded.get("picture", "")

    user_id = database.create_or_update_user(firebase_uid, email, name, picture)
    household = database.get_user_household(user_id)

    return {
        "firebase_uid": firebase_uid,
        "email": email,
        "name": name,
        "picture": picture,
        "user_id": user_id,
        "household_id": household["id"] if household else None,
        "role": household["role"] if household else None,
    }


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["email"] not in ADMIN_EMAILS:
        raise HTTPException(status_code=403, detail="Brak uprawnień administratora")
    return user
```

- [ ] **Krok 2: Dodaj import `auth` do `main.py`**

Na początku `main.py`, po istniejących importach, dodaj:

```python
import auth as auth_module
from auth import get_current_user, require_admin
```

- [ ] **Krok 3: Ręczny test weryfikacji tokenu**

Apkę możesz przetestować dopiero po ukończeniu Task 6 (login.html). Na razie tylko sprawdź że import działa:

```powershell
C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\Scripts\uvicorn.exe main:app --reload
```

Brak błędów importu = OK.

- [ ] **Krok 4: Commit**

```bash
git add auth.py main.py
git commit -m "feat: Firebase auth middleware with get_current_user dependency"
```

---

## Task 4: Backend — Household i Invitation Routes

**Files:**
- Modify: `main.py`

**Interfaces:**
- Consumes: `get_current_user`, wszystkie nowe funkcje z `database.py` (Task 2)
- Produces:
  - `GET /api/me` → `{user_id, email, name, picture, household_id, household_name, role}`
  - `POST /api/household` body `{name}` → `{household_id}`
  - `GET /api/household` → `{id, name, role, members: [...]}`
  - `POST /api/household/invite` → `{link}` (link = `https://.../join/{code}`)
  - `GET /join/{code}` → redirect do `/` lub `/onboarding`
  - `GET /api/admin/households` → lista wszystkich gospodarstw (tylko admin)

- [ ] **Krok 1: Dodaj nowe trasy do `main.py`**

Dodaj po istniejących trasach stron (po `analiza_page`), przed sekcją `# --- AI processing ---`:

```python
from fastapi.responses import RedirectResponse

# --- Auth & Household routes ---

@app.get("/login")
def login_page():
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/onboarding")
def onboarding_page():
    return FileResponse(STATIC_DIR / "onboarding.html")


@app.get("/api/me")
def get_me(current_user: dict = Depends(get_current_user)):
    household = None
    if current_user["household_id"]:
        h = database.get_household(current_user["household_id"])
        if h:
            household = {"id": h["id"], "name": h["name"], "role": current_user["role"]}
    return {**current_user, "household": household}


@app.post("/api/household", status_code=201)
def create_household(body: dict, current_user: dict = Depends(get_current_user)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Podaj nazwę gospodarstwa")
    if current_user["household_id"]:
        raise HTTPException(status_code=409, detail="Jesteś już w gospodarstwie")
    hid = database.create_household(name)
    database.add_member(current_user["user_id"], hid, role="owner")
    return {"household_id": hid}


@app.get("/api/household")
def get_household(current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(status_code=404, detail="Nie należysz do żadnego gospodarstwa")
    h = database.get_household(hid)
    members = database.get_household_members(hid)
    return {**h, "role": current_user["role"], "members": members}


@app.post("/api/household/invite")
def create_invite(current_user: dict = Depends(get_current_user), request: "Request | None" = None):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(status_code=400, detail="Najpierw utwórz gospodarstwo")
    code = database.create_invitation(hid, current_user["user_id"])
    base_url = str(request.base_url).rstrip("/") if request else ""
    return {"link": f"{base_url}/join/{code}", "code": code}


@app.get("/join/{code}")
def join_household(code: str, current_user: dict = Depends(get_current_user)):
    result = database.use_invitation(code)
    if not result:
        raise HTTPException(status_code=404, detail="Link wygasł lub jest nieprawidłowy")
    if current_user["household_id"]:
        raise HTTPException(status_code=409, detail="Jesteś już w gospodarstwie")
    database.add_member(current_user["user_id"], result["household_id"], role="member")
    return RedirectResponse(url="/", status_code=302)


@app.get("/api/admin/households")
def admin_list_households(admin: dict = Depends(require_admin)):
    return database.get_all_households()
```

- [ ] **Krok 2: Napraw import `Request` w `main.py`**

Dodaj `Request` do istniejącego importu FastAPI na górze pliku:

```python
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
```

- [ ] **Krok 3: Zaktualizuj endpoint `create_invite` — dodaj `Request`**

W endpoincie `/api/household/invite` zmień sygnaturę:

```python
@app.post("/api/household/invite")
def create_invite(request: Request, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(status_code=400, detail="Najpierw utwórz gospodarstwo")
    code = database.create_invitation(hid, current_user["user_id"])
    base_url = str(request.base_url).rstrip("/")
    return {"link": f"{base_url}/join/{code}", "code": code}
```

- [ ] **Krok 4: Sprawdź że trasy ładują się bez błędów**

```powershell
C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\Scripts\uvicorn.exe main:app --reload
```

Otwórz http://localhost:8000/docs — powinny być widoczne nowe endpointy.

- [ ] **Krok 5: Commit**

```bash
git add main.py
git commit -m "feat: household and invitation routes"
```

---

## Task 5: Backend — Podepnij Auth do Istniejących Endpointów

**Files:**
- Modify: `main.py`

**Interfaces:**
- Consumes: `get_current_user` → `household_id` przekazywane do wszystkich funkcji DB

- [ ] **Krok 1: Podepnij `get_current_user` do `list_wydatki`**

```python
@app.get("/api/wydatki")
def list_wydatki(month: str | None = None, osoba: str | None = None,
                 kategoria: str | None = None,
                 current_user: dict = Depends(get_current_user)):
    return database.get_wydatki(month=month, osoba=osoba, kategoria=kategoria,
                                household_id=current_user["household_id"])
```

- [ ] **Krok 2: Podepnij auth do `create_wydatek`**

```python
@app.post("/api/wydatki", status_code=201)
def create_wydatek(body: WydatekIn, current_user: dict = Depends(get_current_user)):
    wid = database.create_wydatek(
        data=body.data,
        sklep=body.sklep,
        suma=body.suma,
        osoba=body.osoba,
        notatki=body.notatki,
        zdjecie=None,
        pozycje=[p.model_dump() for p in body.pozycje],
        waluta=body.waluta,
        kurs=body.kurs,
        household_id=current_user["household_id"],
    )
    return {"id": wid}
```

- [ ] **Krok 3: Podepnij auth do `create_wydatek_z_plikiem`**

Dodaj `current_user: dict = Depends(get_current_user)` do parametrów i przekaż `household_id=current_user["household_id"]` do `database.create_wydatek`.

- [ ] **Krok 4: Podepnij auth do endpointów stats**

Dla każdego z poniższych — dodaj `current_user: dict = Depends(get_current_user)` i przekaż `household_id=current_user["household_id"]`:

```python
@app.get("/api/stats/kategorie")
def stats_kategorie(month: str | None = None, osoba: str | None = None,
                    current_user: dict = Depends(get_current_user)):
    return database.stats_kategorie(month=month, osoba=osoba,
                                    household_id=current_user["household_id"])

@app.get("/api/stats/miesiace")
def stats_miesiace(n: int = 6, osoba: str | None = None, kategoria: str | None = None,
                   current_user: dict = Depends(get_current_user)):
    return database.stats_miesiace(n=n, osoba=osoba, kategoria=kategoria,
                                   household_id=current_user["household_id"])

@app.get("/api/stats/sklepy")
def stats_sklepy(month: str | None = None, osoba: str | None = None,
                 limit: int = 10, kategoria: str | None = None,
                 current_user: dict = Depends(get_current_user)):
    return database.stats_sklepy(month=month, osoba=osoba, limit=limit, kategoria=kategoria,
                                 household_id=current_user["household_id"])
```

Analogicznie dla: `stats_pozycje_subkat`, `stats_subkategorie`, `stats_subkategorie_all`, `stats_top_produkt`.

- [ ] **Krok 5: Podepnij auth do admin endpoints rekategoryzacji**

```python
@app.get("/api/admin/rekat-preview")
def rekat_preview(month: str | None = None, od: str | None = None, do: str | None = None,
                  admin: dict = Depends(require_admin)):
    pozycje = database.get_pozycje_do_rekat(month=month, od=od, do=do,
                                            household_id=admin["household_id"])
    return {"liczba": len(pozycje), "szacowane_paczki": -(-len(pozycje) // 25)}

@app.post("/api/admin/rekategoryzuj")
async def rekategoryzuj(body: dict, admin: dict = Depends(require_admin)):
    # ... istniejąca logika + household_id=admin["household_id"] w get_pozycje_do_rekat
```

- [ ] **Krok 6: Sprawdź że apka startuje**

```powershell
C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\Scripts\uvicorn.exe main:app --reload
```

- [ ] **Krok 7: Commit**

```bash
git add main.py
git commit -m "feat: inject household_id auth into all wydatki and stats endpoints"
```

---

## Task 6: Frontend — Strona Logowania i Onboardingu

**Files:**
- Create: `static/login.html`
- Create: `static/onboarding.html`
- Create: `static/auth.js`

**Interfaces:**
- Produces:
  - `window.authGetToken() -> Promise<string>` — zwraca aktualny Firebase ID token
  - `window.authLogout() -> Promise<void>`
  - `window.authRequireHousehold() -> Promise<void>` — przekierowuje jeśli nie zalogowany lub brak household

- [ ] **Krok 1: Utwórz `static/auth.js`**

```javascript
// Wspólna logika Firebase Auth dla wszystkich stron
// Wymaga że strona załadowała firebase-app-compat i firebase-auth-compat

// Konfigurację wypełnij po stworzeniu projektu Firebase
// Project Settings → Your apps → Add app (Web) → skopiuj firebaseConfig
const FIREBASE_CONFIG = {
  apiKey: "WSTAW_API_KEY",
  authDomain: "WSTAW_AUTH_DOMAIN",
  projectId: "WSTAW_PROJECT_ID",
};

firebase.initializeApp(FIREBASE_CONFIG);
const _auth = firebase.auth();

async function authGetToken() {
  const user = _auth.currentUser;
  if (!user) throw new Error("Nie zalogowany");
  return user.getIdToken();
}

async function authLogout() {
  await _auth.signOut();
  window.location.href = "/login";
}

async function authRequireHousehold() {
  return new Promise((resolve, reject) => {
    _auth.onAuthStateChanged(async (user) => {
      if (!user) {
        window.location.href = "/login";
        return reject();
      }
      try {
        const token = await user.getIdToken();
        const res = await fetch("/api/me", {
          headers: { Authorization: "Bearer " + token },
        });
        if (!res.ok) { window.location.href = "/login"; return reject(); }
        const me = await res.json();
        if (!me.household_id) {
          window.location.href = "/onboarding";
          return reject();
        }
        window._currentUser = me;
        resolve(me);
      } catch {
        window.location.href = "/login";
        reject();
      }
    });
  });
}

window.authGetToken = authGetToken;
window.authLogout = authLogout;
window.authRequireHousehold = authRequireHousehold;
```

- [ ] **Krok 2: Wypełnij `FIREBASE_CONFIG` w `auth.js`**

1. W Firebase Console → Project Settings → Your apps
2. Kliknij "Add app" → Web → zarejestruj (bez Firebase Hosting)
3. Skopiuj obiekt `firebaseConfig` i wklej do `auth.js`

- [ ] **Krok 3: Utwórz `static/login.html`**

```html
<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Logowanie — Budżet domowy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f8fafc;
    }
    .card {
      background: white;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,.08);
      padding: 48px 40px;
      text-align: center;
      max-width: 360px;
      width: 100%;
    }
    h1 { font-size: 1.6rem; margin-bottom: 8px; color: #1a1a1a; }
    p { color: #666; margin-bottom: 32px; font-size: 0.95rem; }
    button {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 12px 20px;
      border: 1px solid #dadce0;
      border-radius: 8px;
      background: white;
      cursor: pointer;
      font-size: 0.95rem;
      font-weight: 500;
      color: #3c4043;
      justify-content: center;
    }
    button:hover { background: #f8f9fa; }
    button img { width: 20px; height: 20px; }
    #error { color: #d32f2f; margin-top: 16px; font-size: 0.875rem; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Budżet domowy</h1>
    <p>Zaloguj się aby zarządzać wydatkami swojego gospodarstwa</p>
    <button id="btn-google">
      <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google">
      Zaloguj przez Google
    </button>
    <div id="error"></div>
  </div>

  <script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js"></script>
  <script src="/static/auth.js"></script>
  <script>
    firebase.auth().onAuthStateChanged(async (user) => {
      if (user) {
        const token = await user.getIdToken();
        const res = await fetch("/api/me", { headers: { Authorization: "Bearer " + token } });
        if (res.ok) {
          const me = await res.json();
          window.location.href = me.household_id ? "/" : "/onboarding";
        }
      }
    });

    document.getElementById("btn-google").addEventListener("click", async () => {
      const errEl = document.getElementById("error");
      errEl.style.display = "none";
      try {
        const provider = new firebase.auth.GoogleAuthProvider();
        await firebase.auth().signInWithPopup(provider);
        // onAuthStateChanged wyżej przekieruje
      } catch (e) {
        errEl.textContent = "Błąd logowania: " + e.message;
        errEl.style.display = "block";
      }
    });
  </script>
</body>
</html>
```

- [ ] **Krok 4: Utwórz `static/onboarding.html`**

```html
<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Konfiguracja — Budżet domowy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f8fafc;
    }
    .card {
      background: white;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,.08);
      padding: 48px 40px;
      max-width: 420px;
      width: 100%;
    }
    h1 { font-size: 1.4rem; margin-bottom: 8px; color: #1a1a1a; }
    .subtitle { color: #666; margin-bottom: 32px; font-size: 0.9rem; }
    .section { margin-bottom: 28px; }
    h2 { font-size: 1rem; font-weight: 600; margin-bottom: 12px; color: #333; }
    input {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #dadce0;
      border-radius: 8px;
      font-size: 0.95rem;
      margin-bottom: 10px;
    }
    input:focus { outline: none; border-color: #4285f4; }
    button.primary {
      width: 100%;
      padding: 11px;
      background: #4285f4;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 500;
      cursor: pointer;
    }
    button.primary:hover { background: #3367d6; }
    .divider { text-align: center; color: #999; margin: 20px 0; font-size: 0.85rem; }
    .error { color: #d32f2f; font-size: 0.85rem; margin-top: 8px; display: none; }
    .user-info { font-size: 0.85rem; color: #666; margin-bottom: 24px; }
    a.logout { color: #4285f4; cursor: pointer; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Witaj w Budżecie domowym!</h1>
    <div class="subtitle">Jeden krok dzieli Cię od śledzenia wydatków.</div>
    <div class="user-info" id="user-info"></div>

    <div class="section">
      <h2>Utwórz nowe gospodarstwo</h2>
      <input id="inp-name" type="text" placeholder="np. Dom Kowalskich">
      <button class="primary" id="btn-create">Utwórz gospodarstwo</button>
      <div class="error" id="err-create"></div>
    </div>

    <div class="divider">— lub —</div>

    <div class="section">
      <h2>Dołącz przez kod zaproszenia</h2>
      <input id="inp-code" type="text" placeholder="Wklej link lub kod zaproszenia">
      <button class="primary" id="btn-join">Dołącz</button>
      <div class="error" id="err-join"></div>
    </div>
  </div>

  <script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js"></script>
  <script src="/static/auth.js"></script>
  <script>
    let _token = null;

    firebase.auth().onAuthStateChanged(async (user) => {
      if (!user) { window.location.href = "/login"; return; }
      _token = await user.getIdToken();
      const res = await fetch("/api/me", { headers: { Authorization: "Bearer " + _token } });
      if (!res.ok) { window.location.href = "/login"; return; }
      const me = await res.json();
      if (me.household_id) { window.location.href = "/"; return; }
      document.getElementById("user-info").textContent = "Zalogowany jako: " + me.name + " (" + me.email + ")";
    });

    document.getElementById("btn-create").addEventListener("click", async () => {
      const name = document.getElementById("inp-name").value.trim();
      const errEl = document.getElementById("err-create");
      errEl.style.display = "none";
      if (!name) { errEl.textContent = "Podaj nazwę"; errEl.style.display = "block"; return; }
      const res = await fetch("/api/household", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + _token },
        body: JSON.stringify({ name }),
      });
      if (res.ok) { window.location.href = "/"; }
      else { const e = await res.json(); errEl.textContent = e.detail; errEl.style.display = "block"; }
    });

    document.getElementById("btn-join").addEventListener("click", async () => {
      let code = document.getElementById("inp-code").value.trim();
      const errEl = document.getElementById("err-join");
      errEl.style.display = "none";
      // obsłuż pełny link lub sam kod
      const match = code.match(/\/join\/([^/?#]+)/);
      if (match) code = match[1];
      if (!code) { errEl.textContent = "Podaj kod zaproszenia"; errEl.style.display = "block"; return; }
      // GET /join/{code} — backend doda do gospodarstwa i przekieruje
      const res = await fetch("/join/" + encodeURIComponent(code), {
        headers: { Authorization: "Bearer " + _token },
        redirect: "follow",
      });
      if (res.ok || res.redirected) { window.location.href = "/"; }
      else { const e = await res.json(); errEl.textContent = e.detail; errEl.style.display = "block"; }
    });
  </script>
</body>
</html>
```

- [ ] **Krok 5: Sprawdź strony ręcznie**

```powershell
C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\Scripts\uvicorn.exe main:app --reload
```

- Otwórz http://localhost:8000/login — przycisk Google powinien być widoczny
- Otwórz http://localhost:8000/onboarding — oba formularze powinny być widoczne

- [ ] **Krok 6: Commit**

```bash
git add static/login.html static/onboarding.html static/auth.js
git commit -m "feat: login and onboarding pages with Firebase Google Auth"
```

---

## Task 7: Frontend — Aktualizacja `app.js` i istniejących stron

**Files:**
- Modify: `static/app.js`
- Modify: `static/index.html`
- Modify: `static/upload.html`
- Modify: `static/analiza.html`

**Interfaces:**
- Consumes: `window.authRequireHousehold()`, `window.authGetToken()`, `window.authLogout()`
- Produces: wszystkie fetch w app.js mają `Authorization: Bearer <token>`, przycisk wylogowania działa

- [ ] **Krok 1: Dodaj Firebase SDK i `auth.js` do `index.html`**

W `index.html` przed `</head>` dodaj:

```html
<script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js"></script>
<script src="/static/auth.js"></script>
```

W `index.html` znajdź nawigację/header i dodaj przycisk wylogowania:

```html
<button id="btn-logout" onclick="authLogout()" style="float:right;padding:6px 14px;cursor:pointer;border:1px solid #ccc;border-radius:6px;background:white;font-size:0.85rem;">Wyloguj</button>
```

Dokładne miejsce zależy od struktury HTML — dodaj w widocznym miejscu na górze strony.

- [ ] **Krok 2: Dodaj Firebase SDK i `auth.js` do `upload.html` i `analiza.html`**

Tak samo jak w kroku 1 — dodaj te same 3 tagi `<script>` i przycisk wylogowania.

- [ ] **Krok 3: Dodaj helper `authFetch` na początku `app.js`**

Na początku `app.js`, przed istniejącym kodem, dodaj:

```javascript
// Wrapper fetch z automatycznym tokenem Bearer
async function authFetch(url, options = {}) {
  const token = await authGetToken();
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: "Bearer " + token,
    },
  });
}
```

- [ ] **Krok 4: Zamień wszystkie `fetch(` na `authFetch(` w `app.js`**

Użyj search & replace: zamień każde `fetch('/api/` na `authFetch('/api/`.

Sprawdź ręcznie że nie ma żadnych `fetch(` odwołujących się do `/api/` — powinny być tylko `authFetch(`.

- [ ] **Krok 5: Dodaj `authRequireHousehold()` na początku każdego bloku init w `app.js`**

W bloku DASHBOARD (sprawdza `document.getElementById('chart-kategorie')`), na początku:

```javascript
if (document.getElementById('chart-kategorie')) {
  authRequireHousehold().then(() => {
    // ... cały istniejący kod dashboardu
  });
}
```

Analogicznie dla bloku UPLOAD i ANALIZA.

- [ ] **Krok 6: Dodaj imię zalogowanego użytkownika do nagłówka (opcjonalne ulepszenie)**

W bloku init dashboardu, po `authRequireHousehold()`:

```javascript
authRequireHousehold().then((me) => {
  const nameEl = document.getElementById('user-name');
  if (nameEl && me) nameEl.textContent = me.name;
  // ... reszta kodu
});
```

W `index.html` dodaj `<span id="user-name"></span>` obok przycisku wylogowania.

- [ ] **Krok 7: Pełny test end-to-end**

```powershell
C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\Scripts\uvicorn.exe main:app --reload
```

1. Otwórz http://localhost:8000/ — powinien przekierować do `/login`
2. Zaloguj przez Google
3. Powinno przekierować do `/onboarding` (pierwsze logowanie)
4. Utwórz gospodarstwo "Dom Kowalskich"
5. Powinno przekierować do `/` — dashboard ładuje dane
6. Sprawdź zakładkę upload — wgraj wydatek
7. Sprawdź że wydatek pojawia się na dashboardzie
8. Wyloguj — powinno przekierować do `/login`

- [ ] **Krok 8: Commit**

```bash
git add static/app.js static/index.html static/upload.html static/analiza.html
git commit -m "feat: wire Firebase auth into frontend - authFetch, requireHousehold, logout"
```

---

## Task 8: Admin Panel

**Files:**
- Create: `static/admin.html`

**Interfaces:**
- Consumes: `GET /api/admin/households`, `authRequireHousehold()`, `authFetch()`

- [ ] **Krok 1: Dodaj trasę `/admin` do `main.py`**

```python
@app.get("/admin")
def admin_page():
    return FileResponse(STATIC_DIR / "admin.html")
```

- [ ] **Krok 2: Utwórz `static/admin.html`**

```html
<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin — Budżet domowy</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
    h1 { margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 14px; border-bottom: 1px solid #eee; text-align: left; }
    th { background: #f8f9fa; font-weight: 600; }
    .actions { margin-bottom: 20px; display: flex; gap: 12px; align-items: center; }
    button { padding: 8px 16px; border: 1px solid #dadce0; border-radius: 6px; background: white; cursor: pointer; }
    button:hover { background: #f8f9fa; }
    #error { color: #d32f2f; }
    .invite-result { background: #e8f5e9; padding: 12px; border-radius: 8px; margin-top: 12px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="actions">
    <h1 style="margin:0">Panel Admina</h1>
    <button onclick="authLogout()">Wyloguj</button>
    <a href="/">← Dashboard</a>
  </div>

  <h2>Wszystkie gospodarstwa</h2>
  <table>
    <thead><tr><th>ID</th><th>Nazwa</th><th>Członkowie</th><th>Utworzone</th><th>Akcja</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
  <div id="error"></div>
  <div id="invite-result" class="invite-result" style="display:none"></div>

  <script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js"></script>
  <script src="/static/auth.js"></script>
  <script>
    authRequireHousehold().then(async () => {
      const res = await authFetch("/api/admin/households");
      if (res.status === 403) {
        document.getElementById("error").textContent = "Brak uprawnień administratora.";
        return;
      }
      const data = await res.json();
      const tbody = document.getElementById("tbody");
      tbody.innerHTML = data.map(h => `
        <tr>
          <td>${h.id}</td>
          <td>${h.name}</td>
          <td>${h.members}</td>
          <td>${h.created_at ? h.created_at.slice(0,10) : "—"}</td>
          <td><button onclick="genInvite(${h.id})">Generuj zaproszenie</button></td>
        </tr>
      `).join("");
    });

    async function genInvite(householdId) {
      // Admin generuje zaproszenie do dowolnego gospodarstwa — wymaga endpointu z householdId w body
      const res = await authFetch("/api/admin/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ household_id: householdId }),
      });
      const data = await res.json();
      const el = document.getElementById("invite-result");
      el.style.display = "block";
      el.textContent = "Link zaproszenia: " + data.link;
    }
  </script>
</body>
</html>
```

- [ ] **Krok 3: Dodaj endpoint admin invite do `main.py`**

```python
@app.post("/api/admin/invite")
def admin_create_invite(request: Request, body: dict, admin: dict = Depends(require_admin)):
    hid = body.get("household_id")
    if not hid:
        raise HTTPException(status_code=400, detail="Podaj household_id")
    code = database.create_invitation(hid, admin["user_id"])
    base_url = str(request.base_url).rstrip("/")
    return {"link": f"{base_url}/join/{code}", "code": code}
```

- [ ] **Krok 4: Przetestuj panel admina**

1. Zaloguj jako `a.folwarsk@gmail.com`
2. Wejdź na http://localhost:8000/admin
3. Powinna pojawić się lista gospodarstw
4. Kliknij "Generuj zaproszenie" — powinien pojawić się link

- [ ] **Krok 5: Commit**

```bash
git add static/admin.html main.py
git commit -m "feat: admin panel with household list and invite generation"
```

---

## Task 9: Deploy finalny i testy end-to-end

**Files:**
- Brak nowych plików

- [ ] **Krok 1: Push na GitHub i czekaj na Railway redeploy**

```bash
git push origin master
```

- [ ] **Krok 2: Test end-to-end na produkcji (Railway URL)**

1. Otwórz publiczny URL Railway
2. Zaloguj się jako Adam (a.folwarsk@gmail.com) przez Google
3. Utwórz gospodarstwo "Adam i Ola"
4. Dodaj kilka wydatków — sprawdź że dashboard się odświeża
5. Wygeneruj link zaproszenia (przez admin panel lub `/api/household/invite`)
6. Otwórz link w nowej prywatnej zakładce / innym komputerze
7. Zaloguj jako Ola (inny Google account) → dołącz do "Adam i Ola"
8. Sprawdź że Ola widzi te same wydatki co Adam

- [ ] **Krok 3: Test izolacji**

1. Zaloguj się jako trzecia osoba (np. rodzic)
2. Utwórz nowe gospodarstwo "Dom Rodziców"
3. Dodaj wydatek
4. Sprawdź że Adam NIE widzi tego wydatku w swoim dashboardzie

- [ ] **Krok 4: Commit jeśli były poprawki**

```bash
git add -A
git commit -m "fix: e2e corrections after production testing"
git push origin master
```

---

## Self-Review

**Spec coverage check:**
- [x] Google Login → Task 3 (auth.py) + Task 6 (login.html)
- [x] Wielogospodarstwowość → Task 2 (DB) + Task 5 (API filtrowanie)
- [x] Zaproszenia przez link → Task 4 (`/join/{code}`)
- [x] Tworzenie własnego gospodarstwa → Task 4 (`POST /api/household`)
- [x] Admin panel → Task 8
- [x] Railway deploy → Task 1
- [x] Izolacja danych między gospodarstwami → Task 5 (`household_id` we wszystkich queries)
- [x] Onboarding (pierwsze logowanie) → Task 6 (onboarding.html)
- [x] Wylogowanie → Task 7 (logout button)

**Potencjalne pułapki:**
- `stats_miesiace` ma własną logikę WHERE (nie używa `_where_params`) — wymaga osobnej uwagi przy dodawaniu `household_id`
- `authFetch` musi być zdefiniowany PRZED blokami kodu które go używają w `app.js`
- Firebase Console: domena Railway musi być w "Authorized domains" — inaczej Google Login nie zadziała
- `FIREBASE_SERVICE_ACCOUNT_JSON` w Railway musi być całym JSON w jednej linii (bez nowych linii)
