# wiem.task etap 1 — plan wdrożenia

> **Dla agentów:** WYMAGANY SUB-SKILL: `superpowers:subagent-driven-development` (zalecany)
> albo `superpowers:executing-plans`. Kroki mają pola wyboru (`- [ ]`) do odhaczania.

**Cel:** Czwarty moduł aplikacji Wiem — zadania o dowolnym zagnieżdżeniu, z terminami,
wykonawcą, prywatnością i przypomnieniem push o wybranej godzinie.

**Architektura:** Jedna tabela `task_zadania` z `parent_id`; API zwraca płaską listę,
drzewo składa przeglądarka. Router `task.py` + warstwa bazy `task_db.py` (wzorzec
`health.py`/`health_db.py`). Przypomnienia jako jedno zadanie w istniejącym harmonogramie
APScheduler, tykające co minutę.

**Stos:** FastAPI, psycopg2 + Postgres (Railway), vanilla JS (bez budowania), APScheduler,
pywebpush.

**Specyfikacja:** `docs/superpowers/specs/2026-08-25-wiem-task-design.md` — przy każdej
wątpliwości ona rozstrzyga.

## Global Constraints

- **Wszystko po polsku** — nazwy funkcji, kolumn, zmiennych i komentarzy. Tak jest w całym repo.
- **Pliki zapisywane w UTF-8.** Polskie znaki w kodzie i w komunikatach są normą; zepsute
  kodowanie już raz kosztowało rundę poprawek.
- **Każde zapytanie odczytu filtruje po `household_id`** i po prywatności:
  `(prywatne_dla IS NULL OR prywatne_dla = :ja)`.
- **Żadnych `alert()` ani `confirm()`** — w apce są `toast(tekst, 'blad'|'ok')`
  i `await potwierdz({tytul, tresc, tak, groznie})` z `auth.js`.
- **Zero emoji.** Ikony to SVG ze zbioru `IKONY_SVG` w `auth.js`, wstawiane przez `ikonaSvg(nazwa)`.
- **Nie ma lokalnego uruchomienia** — brak `DATABASE_URL` na maszynie. Weryfikacja: składnia
  lokalnie, reszta na wdrożeniu (patrz „Jak w tym repo się weryfikuje").
- **Deploy = `git push`** na `main`; Railway wdraża 1–2 minuty. Push jest natychmiastowym
  wdrożeniem na apkę, z której ktoś korzysta — commituj małe, działające kawałki.
- Narzędzia nie są w PATH:
  - git: `C:\Users\adam.folwarski\AppData\Local\Programs\Git\cmd\git.exe`
  - python: `C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\python.exe`
  - node: `C:\Program Files\nodejs\node.exe`

## Jak w tym repo się weryfikuje

**Nie ma zestawu testów.** `pytest` jest zainstalowany lokalnie, ale nie ma katalogu `tests/`
ani `DATABASE_URL`, więc wszystko, co dotyka bazy, jest niesprawdzalne lokalnie. Stąd trzy
poziomy, każdy stosowany tam, gdzie ma sens:

1. **Czysta logika → pytest.** Funkcje bez bazy i bez sieci (wykrywanie cyklu w drzewie).
   Uruchamianie: `python -m pytest tests/ -v`.
2. **Składnia → zawsze przed commitem.** `python -m py_compile <plik.py>`,
   `node --check <plik.js>`. Dla kodu w `<script>` w HTML-u: wyciąć zawartość do pliku
   tymczasowego i sprawdzić `node --check` (HTML psuje się inaczej niż JS i kontrola
   składni JS tego nie łapie).
3. **Reszta → w przeglądarce na wdrożonej apce**, narzędziami `mcp__claude-in-chrome__*`.
   **Zawsze po pushu wyczyść service workera i cache**, inaczej zobaczysz stary kod:
   ```js
   for (const r of await navigator.serviceWorker.getRegistrations()) await r.update();
   for (const n of await caches.keys()) await caches.delete(n);
   ```
   a potem twarde odświeżenie (`ctrl+shift+r`).

---

## Struktura plików

| Plik | Odpowiedzialność |
|---|---|
| `task_db.py` (nowy) | Migracja tabeli, wszystkie zapytania, reguły spójności drzewa |
| `task.py` (nowy) | Router `/api/task/*`, walidacja wejścia, mapowanie na `task_db` |
| `static/task.html` (nowy) | Szkielet strony i style modułu |
| `static/task.js` (nowy) | Widoki, budowa drzewa, formularze |
| `tests/test_task_drzewo.py` (nowy) | Testy czystej logiki drzewa |
| `main.py` | Trasa `/task`, `include_router`, `init_task_db()`, zadanie w harmonogramie |
| `push.py` | `wyslij_przypomnienia_zadan()` |
| `static/auth.js` | Wpis w `MODULY`, ikona `zadania`, slajdy samouczka, kolor finansów |
| `static/style.css` | Style listy zadań |

---

## Task 1: Tabela i reguły drzewa

**Files:**
- Create: `task_db.py`
- Create: `tests/test_task_drzewo.py`
- Modify: `main.py` (wywołanie `init_task_db()` obok `health_db.init_health_db()`, ok. linii 38)

**Interfaces:**
- Produces: `init_task_db()`, `wykryj_cykl(pary, zadanie_id, nowy_parent_id) -> bool`
- Consumes: `database.get_db`

- [ ] **Step 1: Test wykrywania cyklu (napisz go pierwszy)**

Utwórz `tests/test_task_drzewo.py`:

```python
"""Testy czystej logiki drzewa zadań — bez bazy, bez sieci."""

from task_db import wykryj_cykl

# pary: [(id, parent_id), ...] — całe drzewo gospodarstwa
DRZEWO = [(1, None), (2, 1), (3, 2), (4, None)]


def test_przeniesienie_do_obcego_poddrzewa_jest_ok():
    assert wykryj_cykl(DRZEWO, 4, 3) is False


def test_bezposrednie_dziecko_jako_rodzic_to_cykl():
    assert wykryj_cykl(DRZEWO, 1, 2) is True


def test_dalszy_potomek_jako_rodzic_to_cykl():
    assert wykryj_cykl(DRZEWO, 1, 3) is True


def test_samo_na_siebie_to_cykl():
    assert wykryj_cykl(DRZEWO, 2, 2) is True


def test_odpiecie_do_korzenia_jest_ok():
    assert wykryj_cykl(DRZEWO, 3, None) is False
```

- [ ] **Step 2: Uruchom test i sprawdź, że pada**

```
C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\python.exe -m pytest tests/ -v
```
Oczekiwane: `ModuleNotFoundError` albo `ImportError: cannot import name 'wykryj_cykl'`.

- [ ] **Step 3: Napisz `task_db.py` — migracja i reguły**

```python
"""Warstwa bazy dla modułu wiem.task — zadania, kroki, przypomnienia.

JEDNA TABELA, NIE DWIE. Krok jest dzieckiem zadania, a nie osobnym bytem, bo
krok musi móc mieć własne kroki — Adam postawił na dowolną głębokość.
Konsekwencją jest `parent_id` wskazujący na tę samą tabelę.

DRZEWO SKŁADAMY W PRZEGLĄDARCE, NIE W SQL-u. Gospodarstwo ma setki zadań, nie
miliony, więc jedno płaskie zapytanie plus budowa drzewa w JS jest tańsza niż
`WITH RECURSIVE` przy każdym wyświetleniu listy. Rekurencja zostaje wyłącznie
tam, gdzie odpowiada na pytanie niemożliwe do zadania inaczej: czy nowy rodzic
nie leży w poddrzewie przenoszonego zadania.
"""

from database import get_db

STATUSY = ("otwarte", "zrobione")


def init_task_db() -> None:
    with get_db() as cur:
        cur.execute("""CREATE TABLE IF NOT EXISTS task_zadania (
            id                   SERIAL PRIMARY KEY,
            household_id         INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            parent_id            INTEGER REFERENCES task_zadania(id) ON DELETE CASCADE,
            tytul                TEXT NOT NULL,
            opis                 TEXT,
            termin               DATE,
            pora                 TIME,
            przypomniano_at      TIMESTAMPTZ,
            wykonawca_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
            wykonawca_virtual_id INTEGER REFERENCES virtual_members(id) ON DELETE SET NULL,
            prywatne_dla         INTEGER REFERENCES users(id) ON DELETE CASCADE,
            kamien_milowy        BOOLEAN NOT NULL DEFAULT FALSE,
            status               TEXT NOT NULL DEFAULT 'otwarte',
            zrobione_at          TIMESTAMPTZ,
            utworzyl             INTEGER REFERENCES users(id) ON DELETE SET NULL,
            kolejnosc            INTEGER NOT NULL DEFAULT 0,
            created_at           TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )""")
        cur.execute("CREATE INDEX IF NOT EXISTS task_zadania_dom "
                    "ON task_zadania (household_id, status, termin)")
        cur.execute("CREATE INDEX IF NOT EXISTS task_zadania_parent "
                    "ON task_zadania (parent_id)")
        # Indeks częściowy pod tik przypomnień: przegląda go co minutę, więc
        # ma obejmować wyłącznie zadania, które w ogóle mogą coś przypomnieć.
        cur.execute("CREATE INDEX IF NOT EXISTS task_zadania_przypomnienia "
                    "ON task_zadania (termin, pora) "
                    "WHERE status = 'otwarte' AND przypomniano_at IS NULL")


def wykryj_cykl(pary, zadanie_id, nowy_parent_id) -> bool:
    """Czy podpięcie `zadanie_id` pod `nowy_parent_id` zamknie pętlę?

    `pary` to lista (id, parent_id) całego gospodarstwa. Funkcja jest czysta —
    bez bazy — właśnie po to, żeby dała się przetestować lokalnie: błąd tutaj
    nie wywala się głośno, tylko cicho zapętla drzewo i wiesza ekran.
    """
    if nowy_parent_id is None:
        return False
    if nowy_parent_id == zadanie_id:
        return True
    rodzice = {i: p for i, p in pary}
    biezacy = rodzice.get(nowy_parent_id)
    # Licznik kroków chroni przed zawieszeniem, gdyby w bazie JUŻ był cykl.
    for _ in range(len(pary) + 1):
        if biezacy is None:
            return False
        if biezacy == zadanie_id:
            return True
        biezacy = rodzice.get(biezacy)
    return True
```

- [ ] **Step 4: Uruchom testy — mają przejść**

```
C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\python.exe -m pytest tests/ -v
```
Oczekiwane: `5 passed` (albo 4, jeśli usunąłeś nadmiarowy test — ważne, żeby żaden nie padł).

- [ ] **Step 5: Podepnij migrację w `main.py`**

Obok istniejącego `health_db.init_health_db()` (ok. linii 38) dodaj:

```python
import task_db
task_db.init_task_db()
```

Import umieść przy pozostałych importach modułów na górze pliku, wywołanie w tym samym
miejscu co pozostałe `init_*`.

- [ ] **Step 6: Sprawdź składnię i zacommituj**

```
python -m py_compile task_db.py main.py
git add task_db.py tests/test_task_drzewo.py main.py
git commit -m "wiem.task: tabela zadan i wykrywanie cyklu w drzewie"
git push origin main
```

Po wdrożeniu sprawdź w logach Railway, że aplikacja wstała — migracja wykonuje się przy
starcie i błąd w DDL zatrzymałby apkę dla wszystkich modułów.

---

## Task 2: Zapytania bazy

**Files:**
- Modify: `task_db.py`

**Interfaces:**
- Produces: `lista(household_id, user_id, zakres, osoba_user_id=None)`,
  `pobierz(household_id, user_id, zadanie_id)`,
  `dodaj(household_id, user_id, dane) -> int`,
  `edytuj(household_id, user_id, zadanie_id, dane) -> bool`,
  `ustaw_status(household_id, user_id, zadanie_id, zrobione, kaskada) -> int`,
  `usun(household_id, user_id, zadanie_id) -> bool`,
  `pary_gospodarstwa(household_id) -> list[tuple[int, int | None]]`

- [ ] **Step 1: Dopisz zapytania do `task_db.py`**

```python
# Warunek widoczności dokładany do KAŻDEGO odczytu. Zadanie prywatne nie
# istnieje dla nikogo poza właścicielem — także w postępie zadania nadrzędnego.
_WIDOCZNE = "household_id = %s AND (prywatne_dla IS NULL OR prywatne_dla = %s)"

_POLA = """id, parent_id, tytul, opis, termin, pora, wykonawca_user_id,
           wykonawca_virtual_id, prywatne_dla, kamien_milowy, status,
           zrobione_at, kolejnosc"""


def pary_gospodarstwa(household_id):
    """(id, parent_id) całego gospodarstwa — wejście dla `wykryj_cykl`."""
    with get_db() as cur:
        cur.execute("SELECT id, parent_id FROM task_zadania WHERE household_id = %s",
                    (household_id,))
        return [(r["id"], r["parent_id"]) for r in cur.fetchall()]


def lista(household_id, user_id, zakres="dzis", osoba_user_id=None):
    """Płaska lista zadań. Drzewo składa front — patrz nagłówek pliku.

    UWAGA: zwracamy też przodków zadań pasujących do zakresu, inaczej krok
    z terminem na dziś wisiałby na liście bez rodzica i bez kontekstu.
    """
    warunki = [_WIDOCZNE]
    p = [household_id, user_id]
    if zakres == "dzis":
        warunki.append("status = 'otwarte' AND termin IS NOT NULL AND termin <= CURRENT_DATE")
    elif zakres == "nadchodzace":
        warunki.append("status = 'otwarte' AND (termin IS NULL OR termin > CURRENT_DATE)")
    else:
        warunki.append("status = 'zrobione' AND zrobione_at > now() - INTERVAL '30 days'")
    if osoba_user_id:
        warunki.append("wykonawca_user_id = %s")
        p.append(osoba_user_id)
    with get_db() as cur:
        cur.execute(f"SELECT {_POLA} FROM task_zadania WHERE " + " AND ".join(warunki)
                    + " ORDER BY termin NULLS LAST, kolejnosc, id", p)
        wiersze = [dict(r) for r in cur.fetchall()]
        znane = {w["id"] for w in wiersze}
        brakujacy = {w["parent_id"] for w in wiersze if w["parent_id"] and w["parent_id"] not in znane}
        while brakujacy:
            cur.execute(f"SELECT {_POLA} FROM task_zadania WHERE {_WIDOCZNE} "
                        "AND id = ANY(%s)", (household_id, user_id, list(brakujacy)))
            dorzuc = [dict(r) for r in cur.fetchall()]
            if not dorzuc:
                break
            wiersze.extend(dorzuc)
            znane |= {w["id"] for w in dorzuc}
            brakujacy = {w["parent_id"] for w in dorzuc if w["parent_id"] and w["parent_id"] not in znane}
        return wiersze


def pobierz(household_id, user_id, zadanie_id):
    with get_db() as cur:
        cur.execute(f"SELECT {_POLA} FROM task_zadania WHERE {_WIDOCZNE} AND id = %s",
                    (household_id, user_id, zadanie_id))
        r = cur.fetchone()
        return dict(r) if r else None


def dodaj(household_id, user_id, d) -> int:
    """`d` to słownik z `task.py`; walidacja rodzica i prywatności JEST TUTAJ,
    bo to reguła danych, a nie reguła interfejsu."""
    parent_id = d.get("parent_id")
    prywatne = d.get("prywatne_dla")
    if parent_id:
        rodzic = pobierz(household_id, user_id, parent_id)
        if not rodzic:
            raise ValueError("Nie ma takiego zadania nadrzędnego.")
        # Dziecko dziedziczy prywatność rodzica — inaczej tytuły dzieci
        # zdradzają treść prywatnego rodzica.
        prywatne = rodzic["prywatne_dla"]
    with get_db() as cur:
        cur.execute("""INSERT INTO task_zadania
            (household_id, parent_id, tytul, opis, termin, pora, wykonawca_user_id,
             wykonawca_virtual_id, prywatne_dla, kamien_milowy, utworzyl, kolejnosc)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                    COALESCE((SELECT MAX(kolejnosc) + 1 FROM task_zadania
                              WHERE household_id = %s AND parent_id IS NOT DISTINCT FROM %s), 0))
            RETURNING id""",
            (household_id, parent_id, d["tytul"], d.get("opis"), d.get("termin"),
             d.get("pora"), d.get("wykonawca_user_id"), d.get("wykonawca_virtual_id"),
             prywatne, bool(d.get("kamien_milowy")), user_id, household_id, parent_id))
        return cur.fetchone()["id"]


def edytuj(household_id, user_id, zadanie_id, d) -> bool:
    """Zmiana terminu albo pory ZERUJE `przypomniano_at` — przesunięte zadanie
    ma przypomnieć o sobie ponownie.

    Zmiana rodzica przechodzi przez dwie bramki: nowy rodzic musi być widoczny
    dla tego użytkownika w tym gospodarstwie (to załatwia `pobierz`, bo ma
    w sobie filtr `_WIDOCZNE`), i nie może leżeć w poddrzewie przenoszonego
    zadania (`wykryj_cykl`).
    """
    stare = pobierz(household_id, user_id, zadanie_id)
    if not stare:
        return False

    zmiana_rodzica = "parent_id" in d
    nowy_parent = d.get("parent_id") if zmiana_rodzica else stare["parent_id"]
    if zmiana_rodzica and nowy_parent:
        if not pobierz(household_id, user_id, nowy_parent):
            raise ValueError("Nie ma takiego zadania nadrzędnego.")
        if wykryj_cykl(pary_gospodarstwa(household_id), zadanie_id, nowy_parent):
            raise ValueError("Zadanie nie może być własnym potomkiem.")

    # Prywatność ustawia się tylko na korzeniu; dziecko zawsze dziedziczy.
    prywatne = stare["prywatne_dla"]
    if nowy_parent:
        rodzic = pobierz(household_id, user_id, nowy_parent)
        prywatne = rodzic["prywatne_dla"]
    elif "prywatne" in d:
        prywatne = user_id if d["prywatne"] else None

    with get_db() as cur:
        cur.execute("""UPDATE task_zadania SET
              tytul = %s, opis = %s, termin = %s, pora = %s, parent_id = %s,
              wykonawca_user_id = %s, wykonawca_virtual_id = %s,
              kamien_milowy = %s, prywatne_dla = %s,
              przypomniano_at = CASE WHEN termin IS DISTINCT FROM %s
                                       OR pora IS DISTINCT FROM %s
                                     THEN NULL ELSE przypomniano_at END
            WHERE household_id = %s AND id = %s""",
            (d["tytul"], d.get("opis"), d.get("termin"), d.get("pora"), nowy_parent,
             d.get("wykonawca_user_id"), d.get("wykonawca_virtual_id"),
             bool(d.get("kamien_milowy")), prywatne, d.get("termin"), d.get("pora"),
             household_id, zadanie_id))
        zmienione = cur.rowcount > 0
        # Prywatność musi zejść na całe poddrzewo — inaczej dzieci zadania
        # oznaczonego jako prywatne zostają widoczne i zdradzają jego treść.
        if zmienione and prywatne is not stare["prywatne_dla"]:
            cur.execute("""WITH RECURSIVE poddrzewo AS (
                  SELECT id FROM task_zadania WHERE id = %s
                  UNION ALL
                  SELECT z.id FROM task_zadania z JOIN poddrzewo p ON z.parent_id = p.id)
                UPDATE task_zadania SET prywatne_dla = %s
                WHERE id IN (SELECT id FROM poddrzewo) AND household_id = %s""",
                (zadanie_id, prywatne, household_id))
        return zmienione


def ustaw_status(household_id, user_id, zadanie_id, zrobione, kaskada=False) -> int:
    """Zwraca liczbę zmienionych zadań. Kaskada schodzi w dół poddrzewa —
    tu `WITH RECURSIVE` jest na miejscu, bo pytanie dotyczy całego poddrzewa."""
    if not pobierz(household_id, user_id, zadanie_id):
        return 0
    status = "zrobione" if zrobione else "otwarte"
    with get_db() as cur:
        if kaskada:
            cur.execute("""WITH RECURSIVE poddrzewo AS (
                  SELECT id FROM task_zadania WHERE id = %s
                  UNION ALL
                  SELECT z.id FROM task_zadania z JOIN poddrzewo p ON z.parent_id = p.id)
                UPDATE task_zadania SET status = %s,
                       zrobione_at = CASE WHEN %s THEN now() ELSE NULL END
                WHERE id IN (SELECT id FROM poddrzewo) AND household_id = %s""",
                (zadanie_id, status, zrobione, household_id))
        else:
            cur.execute("""UPDATE task_zadania SET status = %s,
                       zrobione_at = CASE WHEN %s THEN now() ELSE NULL END
                WHERE id = %s AND household_id = %s""",
                (status, zrobione, zadanie_id, household_id))
        return cur.rowcount


def usun(household_id, user_id, zadanie_id) -> bool:
    if not pobierz(household_id, user_id, zadanie_id):
        return False
    with get_db() as cur:
        cur.execute("DELETE FROM task_zadania WHERE household_id = %s AND id = %s",
                    (household_id, zadanie_id))
        return cur.rowcount > 0
```

- [ ] **Step 2: Sprawdź składnię i zacommituj**

```
python -m py_compile task_db.py
python -m pytest tests/ -v
git add task_db.py
git commit -m "wiem.task: zapytania bazy z filtrem prywatnosci i kaskada statusu"
```

Nie pushuj jeszcze — bez routera nie ma czego sprawdzić. Push razem z Taskiem 3.

---

## Task 3: Router i wpięcie strony

**Files:**
- Create: `task.py`
- Create: `static/task.html` (na razie szkielet)
- Modify: `main.py`

**Interfaces:**
- Consumes: wszystko z `task_db` (Task 2)
- Produces: `task.router` z pięcioma wywołaniami opisanymi w specyfikacji

- [ ] **Step 1: Napisz `task.py`**

Wzoruj się na `health.py` — ta sama konstrukcja `_hid()` i `Depends(get_current_user)`.

```python
"""Trasy modułu wiem.task. Cienka warstwa: walidacja wejścia i przekazanie
do `task_db`. Reguły danych (prywatność, cykl w drzewie) siedzą w bazie danych,
nie tutaj — inaczej rozjechałyby się między wywołaniami."""

from fastapi import APIRouter, Depends, HTTPException

import task_db
from auth import get_current_user

router = APIRouter(prefix="/api/task", tags=["task"])


def _hid(u: dict) -> int:
    hid = u.get("household_id")
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    return hid


def _dane(d: dict) -> dict:
    tytul = (d.get("tytul") or "").strip()
    if not tytul:
        raise HTTPException(400, "Podaj treść zadania")
    return {
        "tytul": tytul[:300],
        "opis": (d.get("opis") or "").strip() or None,
        "termin": d.get("termin") or None,
        "pora": d.get("pora") or None,
        "parent_id": d.get("parent_id") or None,
        "wykonawca_user_id": d.get("wykonawca_user_id") or None,
        "wykonawca_virtual_id": d.get("wykonawca_virtual_id") or None,
        "prywatne_dla": d.get("prywatne_dla") or None,
        "kamien_milowy": bool(d.get("kamien_milowy")),
    }


@router.get("/zadania")
def lista_zadan(zakres: str = "dzis", osoba: int | None = None,
                current_user: dict = Depends(get_current_user)):
    if zakres not in ("dzis", "nadchodzace", "zrobione"):
        raise HTTPException(400, "Nieznany zakres")
    return {"zadania": task_db.lista(_hid(current_user), current_user["user_id"],
                                     zakres, osoba)}


@router.post("/zadania")
def nowe_zadanie(dane: dict, current_user: dict = Depends(get_current_user)):
    d = _dane(dane)
    # Prywatność ustawia się wyłącznie na sobie — przekazany identyfikator
    # innego użytkownika byłby cudzą skrzynką.
    if dane.get("prywatne"):
        d["prywatne_dla"] = current_user["user_id"]
    try:
        return {"id": task_db.dodaj(_hid(current_user), current_user["user_id"], d)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.put("/zadania/{zadanie_id}")
def edytuj_zadanie(zadanie_id: int, dane: dict,
                   current_user: dict = Depends(get_current_user)):
    try:
        ok = task_db.edytuj(_hid(current_user), current_user["user_id"], zadanie_id,
                            _dane(dane))
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not ok:
        raise HTTPException(404, "Nie ma takiego zadania")
    return {"ok": True}


@router.patch("/zadania/{zadanie_id}/status")
def status_zadania(zadanie_id: int, dane: dict,
                   current_user: dict = Depends(get_current_user)):
    ile = task_db.ustaw_status(_hid(current_user), current_user["user_id"], zadanie_id,
                               bool(dane.get("zrobione")), bool(dane.get("kaskada")))
    if not ile:
        raise HTTPException(404, "Nie ma takiego zadania")
    return {"zmienione": ile}


@router.delete("/zadania/{zadanie_id}")
def usun_zadanie(zadanie_id: int, current_user: dict = Depends(get_current_user)):
    if not task_db.usun(_hid(current_user), current_user["user_id"], zadanie_id):
        raise HTTPException(404, "Nie ma takiego zadania")
    return {"ok": True}
```

- [ ] **Step 2: Szkielet strony `static/task.html`**

Skopiuj `static/health.html` i zamień: `<title>Zadania — Wiem</title>`, skrypt na
`/static/task.js`, kontener treści zostaw jako `<main><div id="tresc"></div></main>`.
Style modułu dopiszesz w Tasku 5 — teraz ma się tylko otwierać.

- [ ] **Step 3: Wepnij w `main.py`**

Przy pozostałych routerach:

```python
app.include_router(task.router)
```

i trasa strony przy `/health`:

```python
@app.get("/task")
def task_page():
    return _html("task.html")
```

- [ ] **Step 4: Składnia, commit, push**

```
python -m py_compile task.py main.py
git add task.py static/task.html main.py
git commit -m "wiem.task: router i strona modulu"
git push origin main
```

- [ ] **Step 5: Sprawdź na wdrożeniu**

Po 1–2 minutach otwórz `https://budzetdomowy-production.up.railway.app/task`
(z czyszczeniem cache jak w sekcji „Jak w tym repo się weryfikuje") i w konsoli:

```js
await (await authFetch('/api/task/zadania?zakres=dzis')).json()
```
Oczekiwane: `{zadania: []}` — nie 404 i nie 500.

---

## Task 4: Lista i szybkie dodawanie

**Files:**
- Create: `static/task.js`
- Modify: `static/task.html` (style listy)

**Interfaces:**
- Consumes: `/api/task/zadania` (Task 3), `authFetch`, `toast`, `potwierdz`, `ikonaSvg`,
  `awatarHtml` — wszystkie globalne z `auth.js`
- Produces: `budujDrzewo(plaska)`, `postep(wezel)` — funkcje testowane w przeglądarce

- [ ] **Step 1: Napisz rdzeń `static/task.js`**

```javascript
// Ekran zadań — wiem.task.
//
// DRZEWO SKŁADAMY TUTAJ, nie w SQL-u (patrz nagłówek task_db.py). Serwer daje
// płaską listę, a `budujDrzewo` wiąże dzieci z rodzicami. Dzięki temu postęp
// poddrzewa liczy się bez dodatkowego zapytania.
//
// SZYBKIE DODAWANIE JEST GŁÓWNĄ DROGĄ, formularz drugą. Zadanie, którego
// dodanie wymaga sześciu pól, nie zostaje dodane wcale — a sprawa niezapisana
// jest gorsza niż zapisana bez terminu.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let zakres = 'dzis';        // dzis | nadchodzace | zrobione
let zadania = [];           // płasko, jak z serwera
let korzen = null;          // null = widok listy; liczba = wejście w zadanie

const box = () => document.getElementById('tresc');

function budujDrzewo(plaska) {
  const wg = new Map();
  for (const z of plaska) wg.set(z.id, Object.assign({ dzieci: [] }, z));
  const gora = [];
  for (const z of wg.values()) {
    const rodzic = z.parent_id != null ? wg.get(z.parent_id) : null;
    if (rodzic) rodzic.dzieci.push(z); else gora.push(z);
  }
  return gora;
}

// Postęp liczony z CAŁEGO poddrzewa, nie z bezpośrednich dzieci — inaczej
// zadanie z jednym krokiem, który ma pięć własnych kroków, pokazywałoby „0 z 1".
function postep(w) {
  let razem = 0, gotowe = 0;
  const zejdz = (x) => {
    for (const d of x.dzieci) {
      razem++;
      if (d.status === 'zrobione') gotowe++;
      zejdz(d);
    }
  };
  zejdz(w);
  return { razem, gotowe };
}

// Pierwszy nieskończony krok — to jego pokazujemy przy zwiniętym zadaniu.
// Schodzimy najgłębiej jak się da: „następne: zamówić płytki" jest instrukcją,
// „następne: łazienka" nie jest.
function nastepnyKrok(w) {
  for (const d of w.dzieci) {
    if (d.status === 'zrobione') continue;
    const glebiej = nastepnyKrok(d);
    return glebiej.tytul ? glebiej : d;
  }
  return {};
}

async function wczytaj() {
  try {
    const r = await authFetch('/api/task/zadania?zakres=' + zakres);
    zadania = (await r.json()).zadania || [];
  } catch { zadania = []; toast('Nie udało się wczytać zadań.', 'blad'); }
  rysuj();
}

async function szybkieDodanie(tytul) {
  if (!tytul.trim()) return;
  const r = await authFetch('/api/task/zadania', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tytul, parent_id: korzen }),
  });
  if (!r.ok) { toast('Nie udało się zapisać zadania.', 'blad'); return; }
  await wczytaj();
}

window.addEventListener('DOMContentLoaded', () => authRequireHousehold().then(wczytaj));
```

- [ ] **Step 2: Dopisz rysowanie listy**

```javascript
const ZAKRESY = [['dzis', 'Dziś'], ['nadchodzace', 'Nadchodzące'], ['zrobione', 'Zrobione']];

function rysuj() {
  const drzewo = budujDrzewo(zadania);
  box().innerHTML = `
    <div class="gora"><h1>Zadania</h1></div>
    <div class="filtry" id="f-zakres">
      ${ZAKRESY.map(([k, l]) => `<button class="chip" type="button" data-z="${k}"
          aria-pressed="${k === zakres}">${l}</button>`).join('')}
    </div>
    <form class="szybkie" id="szybkie">
      <input id="sz-tytul" placeholder="Co jest do zrobienia?" autocomplete="off">
      <button class="btn btn-primary" type="submit">Dodaj</button>
    </form>
    <div class="zadania">${drzewo.map((w) => wiersz(w, 0)).join('') ||
      '<p class="pusto">Nic tu nie ma. Wpisz pierwsze zadanie powyżej.</p>'}</div>`;

  document.getElementById('f-zakres').onclick = (ev) => {
    const b = ev.target.closest('[data-z]');
    if (!b) return;
    zakres = b.dataset.z;
    wczytaj();
  };
  document.getElementById('szybkie').onsubmit = (ev) => {
    ev.preventDefault();
    const pole = document.getElementById('sz-tytul');
    const t = pole.value;
    pole.value = '';
    szybkieDodanie(t);
  };
  podepnijPtaszki();
}

function wiersz(w, poziom) {
  const p = postep(w);
  const nast = p.razem && w.status !== 'zrobione' ? nastepnyKrok(w) : {};
  const spozniony = w.termin && w.status === 'otwarte' &&
    w.termin.slice(0, 10) < new Date().toISOString().slice(0, 10);
  // Wcięcia tylko do trzeciego poziomu — głębiej wchodzi się w zadanie.
  // Przy 412 px czwarty poziom zostawia na tytuł około 200 px.
  const wciecie = Math.min(poziom, 2) * 18;
  return `
    <div class="zad${w.status === 'zrobione' ? ' zrobione' : ''}" style="padding-left:${wciecie}px">
      <button class="ptaszek" type="button" data-ptaszek="${w.id}"
              aria-label="Odhacz zadanie">${w.status === 'zrobione' ? '✓' : ''}</button>
      <div class="zad-tresc">
        <div class="zad-tytul">${w.kamien_milowy ? '<span class="kamien"></span>' : ''}${esc(w.tytul)}</div>
        ${nast.tytul ? `<div class="zad-nast">następne: ${esc(nast.tytul)}</div>` : ''}
      </div>
      ${w.termin ? `<span class="zad-termin${spozniony ? ' po-czasie' : ''}">${dataPl(w.termin)}</span>` : ''}
      ${p.razem && !w.kamien_milowy ? `<span class="zad-postep">${p.gotowe} z ${p.razem}</span>` : ''}
    </div>
    ${w.dzieci.map((d) => wiersz(d, poziom + 1)).join('')}`;
}

function dataPl(iso) {
  const [r, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}.${m}.${r}`;
}
```

- [ ] **Step 3: Style w `static/task.html`**

W bloku `<style>`:

```css
.filtry { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.szybkie { display: flex; gap: 8px; margin-bottom: 16px; }
.szybkie input { flex: 1; min-height: 46px; }
.zad { display: flex; align-items: center; gap: 10px; padding: 12px;
       border-bottom: 1px solid var(--border-soft); }
.zad.zrobione .zad-tytul { text-decoration: line-through; color: var(--muted); }
.ptaszek { flex: none; width: 26px; height: 26px; border-radius: 50%;
           border: 1.5px solid var(--border); background: none; cursor: pointer;
           color: var(--marka); font-size: 15px; line-height: 1; }
.zad-tresc { flex: 1; min-width: 0; }
.zad-tytul { font-size: 14.5px; color: var(--text); }
.zad-nast { font-size: 12px; color: var(--muted); margin-top: 2px; }
.zad-termin { font-size: 12px; color: var(--muted); flex: none; }
.zad-termin.po-czasie { color: var(--danger); font-weight: 600; }
.zad-postep { font-size: 12px; color: var(--muted); flex: none; }
.kamien { display: inline-block; width: 9px; height: 9px; margin-right: 6px;
          background: var(--marka); transform: rotate(45deg); }
.pusto { color: var(--muted); font-size: 13px; text-align: center; padding: 28px 12px; }
```

- [ ] **Step 4: Składnia, commit, push, sprawdzenie**

```
node --check static/task.js
git add static/task.js static/task.html
git commit -m "wiem.task: lista zadan, drzewo i szybkie dodawanie"
git push origin main
```

W przeglądarce po wyczyszczeniu cache: dodaj zadanie przez pole u góry, sprawdź, że pojawia
się na liście. Potem w konsoli sprawdź samą logikę drzewa:

```js
JSON.stringify(budujDrzewo([{id:1,parent_id:null},{id:2,parent_id:1},{id:3,parent_id:2}])
  .map(w => w.dzieci.length))
```
Oczekiwane: `[1]` — jeden korzeń z jednym dzieckiem.

---

## Task 5: Odhaczanie z kaskadą

**Files:**
- Modify: `static/task.js`

**Interfaces:**
- Consumes: `PATCH /api/task/zadania/{id}/status` (Task 3), `potwierdz`, `toast`

- [ ] **Step 1: Dopisz obsługę ptaszka**

```javascript
function podepnijPtaszki() {
  const lista = document.querySelector('.zadania');
  if (!lista) return;
  lista.onclick = async (ev) => {
    const b = ev.target.closest('[data-ptaszek]');
    if (!b) return;
    const id = Number(b.dataset.ptaszek);
    const w = budujDrzewo(zadania).flatMap(splaszcz).find((x) => x.id === id);
    if (!w) return;
    const zrobione = w.status !== 'zrobione';
    let kaskada = false;
    const p = postep(w);
    // Zamykanie poddrzewa PYTAMY, nie robimy po cichu: użytkownik odhacza
    // rodzica często dlatego, że sprawa odpadła, a nie dlatego, że zrobił
    // wszystkie kroki — a cicho zamknięte kroki znikają bez śladu.
    if (zrobione && p.razem - p.gotowe > 0) {
      kaskada = await potwierdz({
        tytul: 'Zamknąć też kroki?',
        tresc: `To zadanie ma ${p.razem - p.gotowe} nieskończonych kroków.`,
        tak: 'Zamknij wszystko', nie: 'Tylko to zadanie',
      });
    }
    const r = await authFetch(`/api/task/zadania/${id}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zrobione, kaskada }),
    });
    if (!r.ok) { toast('Nie udało się zmienić zadania.', 'blad'); return; }
    wczytaj();
  };
}

function splaszcz(w) {
  return [w].concat(w.dzieci.flatMap(splaszcz));
}
```

Uwaga: `potwierdz` zwraca `true` dla przycisku po prawej (`tak`) i `false` dla lewego
(`nie`), więc „Tylko to zadanie" daje `kaskada = false` — dokładnie o to chodzi.

- [ ] **Step 2: Składnia, commit, push, sprawdzenie**

```
node --check static/task.js
git add static/task.js
git commit -m "wiem.task: odhaczanie z pytaniem o poddrzewo"
git push origin main
```

W przeglądarce: utwórz zadanie, dodaj mu krok (chwilowo przez konsolę:
`authFetch('/api/task/zadania', {method:'POST', headers:{'Content-Type':'application/json'},
body: JSON.stringify({tytul:'krok', parent_id: <id>})})`), odhacz rodzica i sprawdź,
że pojawia się pytanie, a wybór „Tylko to zadanie" zostawia krok otwarty.

---

## Task 6: Pełny formularz

**Files:**
- Modify: `static/task.js`, `static/task.html`

**Interfaces:**
- Consumes: `POST`/`PUT /api/task/zadania` (Task 3) oraz `GET /api/household`
  (`main.py:635`), które zwraca `{members: [...], virtual_members: [...]}` — to jest lista
  do wyboru wykonawcy. Członek z kontem daje `wykonawca_user_id`, osoba bez konta
  `wykonawca_virtual_id`.

- [ ] **Step 1: Wejście w zadanie (okruszki)**

`korzen` z Taska 4 przestaje być martwą zmienną: gdy jest ustawiony, lista pokazuje
wyłącznie poddrzewo tego zadania, a nad nią okruszki.

```javascript
function sciezkaDo(id) {
  const wg = new Map(zadania.map((z) => [z.id, z]));
  const droga = [];
  let x = wg.get(id);
  while (x) { droga.unshift(x); x = x.parent_id != null ? wg.get(x.parent_id) : null; }
  return droga;
}

function okruszki() {
  if (korzen == null) return '';
  const droga = sciezkaDo(korzen);
  return `<nav class="okruszki">
    <button type="button" data-okr="">Zadania</button>
    ${droga.map((z) => `<span>›</span><button type="button" data-okr="${z.id}">${esc(z.tytul)}</button>`).join('')}
  </nav>`;
}
```

W `rysuj()` wstaw `okruszki()` nad listą, a zamiast `drzewo` renderuj poddrzewo korzenia,
gdy `korzen != null`. Kliknięcie `[data-okr]` ustawia `korzen` (pusty ciąg = `null`)
i wywołuje `rysuj()`. Strzałka przy wierszu ustawia `korzen = w.id`.

Wcięcia liczą się od bieżącego korzenia, nie od korzenia całego drzewa — dzięki temu wejście
w głąb zawsze zaczyna od zera i przy 412 px nic się nie zwija.

- [ ] **Step 2: Formularz szczegółów**

Formularz otwiera się z wnętrza zadania (wejście strzałką) oraz przyciskiem „Szczegóły"
przy nowo dodanym zadaniu. Pola: tytuł, opis, termin (`<input type="date">`),
godzina przypomnienia (`<input type="time">`), wykonawca (`<select>` z domownikami),
kamień milowy (checkbox), „tylko dla mnie" (checkbox, wyłączony i wyszarzony,
gdy zadanie ma rodzica — prywatność dziedziczy się z rodzica).

Zapis:

```javascript
async function zapiszSzczegoly(id, dane) {
  const r = await authFetch(`/api/task/zadania/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dane),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    toast(e.detail || 'Nie udało się zapisać.', 'blad');
    return false;
  }
  toast('Zapisano.', 'ok');
  return true;
}
```

Usuwanie:

```javascript
async function usunZadanie(id, tytul, maDzieci) {
  if (!(await potwierdz({
    tytul: `Usunąć „${tytul}"?`,
    tresc: maDzieci ? 'Usunie też wszystkie kroki w środku.' : '',
    tak: 'Usuń', groznie: true,
  }))) return;
  const r = await authFetch(`/api/task/zadania/${id}`, { method: 'DELETE' });
  if (!r.ok) { toast('Nie udało się usunąć.', 'blad'); return; }
  wczytaj();
}
```

- [ ] **Step 3: Składnia, commit, push, sprawdzenie**

```
node --check static/task.js
git add static/task.js static/task.html
git commit -m "wiem.task: formularz szczegolow, wykonawca i prywatnosc"
git push origin main
```

Sprawdzenie na wdrożeniu: ustaw termin i godzinę, zapisz, przeładuj — wartości mają zostać.
Zaznacz „tylko dla mnie", wejdź na drugie konto (albo tryb incognito) i potwierdź, że zadania
nie widać.

---

## Task 7: Przypomnienia push

**Files:**
- Modify: `push.py`, `main.py`, `task_db.py`

**Interfaces:**
- Produces: `push.wyslij_przypomnienia_zadan()`, `task_db.do_przypomnienia()`,
  `task_db.oznacz_przypomniane(ids)`
- Consumes: `push.wyslij_do_uzytkownika`, `push.wyslij_do_gospodarstwa` (istnieją)

- [ ] **Step 1: Zapytanie w `task_db.py`**

```python
def do_przypomnienia():
    """Zadania, którym właśnie minęła godzina przypomnienia.

    Okno dwóch dni chroni przed lawiną: gdy ktoś wpisze zaległe zadanie
    z terminem sprzed miesiąca, nie ma sensu wysyłać powiadomienia w sekundę
    po zapisaniu — użytkownik właśnie na nie patrzy.
    """
    with get_db() as cur:
        cur.execute("""SELECT id, household_id, tytul, termin, wykonawca_user_id,
                              prywatne_dla
            FROM task_zadania
            WHERE status = 'otwarte' AND przypomniano_at IS NULL
              AND termin IS NOT NULL AND pora IS NOT NULL
              AND (termin + pora) <= (now() AT TIME ZONE 'Europe/Warsaw')
              AND termin >= CURRENT_DATE - INTERVAL '2 days'
            LIMIT 200""")
        return [dict(r) for r in cur.fetchall()]


def oznacz_przypomniane(ids) -> None:
    if not ids:
        return
    with get_db() as cur:
        cur.execute("UPDATE task_zadania SET przypomniano_at = now() WHERE id = ANY(%s)",
                    (list(ids),))
```

- [ ] **Step 2: Wysyłka w `push.py`**

```python
def wyslij_przypomnienia_zadan() -> None:
    """Tik przypomnień o zadaniach. Woła go harmonogram co minutę.

    Osobnych zadań w harmonogramie per przypomnienie NIE rejestrujemy —
    zniknęłyby przy każdym restarcie kontenera, a Railway restartuje przy
    każdym wdrożeniu. Stan trzyma baza, nie pamięć procesu.
    """
    import task_db
    zadania = task_db.do_przypomnienia()
    wyslane = []
    for z in zadania:
        tytul = "Zadanie na dziś"
        tresc = z["tytul"]
        try:
            if z["prywatne_dla"]:
                wyslij_do_uzytkownika(z["prywatne_dla"], tytul, tresc, url="/task")
            elif z["wykonawca_user_id"]:
                wyslij_do_uzytkownika(z["wykonawca_user_id"], tytul, tresc, url="/task")
            else:
                # Nikt nie przypisany albo wykonawcą jest osoba bez konta —
                # taka osoba nie ma gdzie odebrać powiadomienia.
                wyslij_do_gospodarstwa(z["household_id"], tytul, tresc, url="/task")
            wyslane.append(z["id"])
        except Exception as e:
            print(f"[task] przypomnienie {z['id']} nie poszlo: {e}")
    task_db.oznacz_przypomniane(wyslane)
```

Sprawdź w `push.py`, czy `wyslij_do_uzytkownika` i `wyslij_do_gospodarstwa` mają dokładnie
takie nazwy parametrów (`url`) — plan opiera się na sygnaturach z sierpnia 2026.

- [ ] **Step 3: Zadanie w harmonogramie (`main.py`, w `_start_scheduler`)**

```python
        _scheduler.add_job(
            push.wyslij_przypomnienia_zadan,
            CronTrigger(minute="*", timezone=ZoneInfo("Europe/Warsaw")),
            id="task_przypomnienia", replace_existing=True, misfire_grace_time=120,
        )
```

- [ ] **Step 4: Składnia, commit, push**

```
python -m py_compile push.py main.py task_db.py
git add push.py main.py task_db.py
git commit -m "wiem.task: przypomnienia push per zadanie"
git push origin main
```

- [ ] **Step 5: Sprawdź na wdrożeniu**

Utwórz zadanie z terminem „dziś" i godziną za dwie minuty. Poczekaj. Powiadomienie ma
przyjść **dokładnie raz** — po wysyłce sprawdź w konsoli, że kolejne tiki go nie powtarzają:

```js
(await (await authFetch('/api/task/zadania?zakres=dzis')).json()).zadania.length
```

Jeśli powiadomienie nie przyszło wcale, sprawdź w logach Railway, czy tik w ogóle się odpala —
to jest moment na rozstrzygnięcie ryzyka „usypianie kontenera" ze specyfikacji.

---

## Task 8: Moduł w nawigacji i kolory

**Files:**
- Modify: `static/auth.js` (`MODULY`, `IKONY_SVG`), `static/style.css`
- Modify: `static/icon-192.png`, `static/icon-512.png`, `static/icon-maskable-512.png`

- [ ] **Step 1: Ikona modułu w `IKONY_SVG`**

Dopisz do zbioru (kreska 1.6, ta sama konwencja co reszta):

```javascript
  zadania: '<rect x="3.6" y="4.4" width="16.8" height="15.6" rx="2.4"/><path class="akc" d="M8 12.4l2.6 2.6 5-5.2"/>',
```

- [ ] **Step 2: Wpis w `MODULY`**

```javascript
  {
    id: 'task',
    nazwa: 'task',
    kolor: '#ff6b6b',
    opis: 'Zadania i projekty',
    ikona: 'zadania',
    strony: [
      { href: '/task', ikona: 'zadania', label: 'Zadania', pelny: 'Zadania' },
    ],
  },
```

- [ ] **Step 3: Finanse na złoto**

W `MODULY` zmień `kolor` modułu `finance` na złoty i zaktualizuj wartość zapasową
`--marka` w `style.css`.

**Odcień dobierz pomiarem, nie na oko.** `--marka` jest kolorem pisma aktywnego linku
w dolnym pasku (`style.css:745`), więc jasne złoto zrobi tam etykietę nieczytelną.
Punkt wyjścia: `#a9791c`. Sprawdź w przeglądarce kontrast wobec tła paska:

```js
getComputedStyle(document.querySelector('.bottom-nav')).backgroundColor
```
i policz kontrast dla kandydata. Cel: co najmniej 4,5:1 dla tekstu.

- [ ] **Step 4: Kropki w ikonach PNG na złoto**

Trzy pliki: `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`. Bez tego ikona
na ekranie telefonu zostanie koralowa, czyli w kolorze zadań, choć `start_url` prowadzi
do finansów. `pillow` jest w `requirements.txt`.

Podmiana koloru piksel po pikselu, z tolerancją — kropki mają wygładzone krawędzie,
więc szukanie dokładnego `#ff6b6b` zostawiłoby koralową obwódkę:

```python
from PIL import Image

STARY = (255, 107, 107)
NOWY = (169, 121, 28)      # docelowe złoto z kroku 3


def przemaluj(sciezka):
    im = Image.open(sciezka).convert("RGBA")
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            # Odległość od korala w przestrzeni RGB. 90 łapie też półprzezroczyste
            # brzegi kropki, a nie rusza kości i atramentu.
            if (r - STARY[0]) ** 2 + (g - STARY[1]) ** 2 + (b - STARY[2]) ** 2 < 90 ** 2:
                # Zachowujemy jasność piksela, żeby wygładzenie zostało wygładzeniem.
                waga = (r + g + b) / (sum(STARY))
                px[x, y] = (min(255, int(NOWY[0] * waga)), min(255, int(NOWY[1] * waga)),
                            min(255, int(NOWY[2] * waga)), a)
    im.save(sciezka)


for p in ("static/icon-192.png", "static/icon-512.png", "static/icon-maskable-512.png"):
    przemaluj(p)
```

Po przemalowaniu **obejrzyj pliki**, nie tylko uruchom skrypt — jeśli zamiast kropek zmienił
się cały znak, tolerancja jest za duża i trzeba zacząć od nowa z `git checkout` na te trzy pliki.

- [ ] **Step 5: Pokaż Adamowi zrzuty przed pushem**

Dolny pasek w module finansowym (nowy złoty) i ikona. To jest zmiana widoczna na całej
apce — nie wypychaj jej bez akceptacji.

- [ ] **Step 6: Commit i push po akceptacji**

```
node --check static/auth.js
git add static/auth.js static/style.css static/icon-*.png
git commit -m "wiem.task: modul w nawigacji, finanse na zloto"
git push origin main
```

---

## Task 9: Samouczek modułu

**Files:**
- Modify: `static/auth.js` (`_SAMOUCZEK_SLAJDY`)

Samouczek jest per moduł od 2026-08-25 (`_SAMOUCZEK_SLAJDY` to obiekt z kluczami
`finance`, `eat`, `health`). Dopisz klucz `task`.

**Styl treści jest ustalony i był poprawiany:** slajd mówi, co użytkownik robi i co z tego
ma. Żadnych uzasadnień projektowych („bo inaczej…"), żadnego żargonu, żadnych emoji.

- [ ] **Step 1: Dopisz zestaw `task`**

```javascript
  task: [
  { znak: true, tytul: 'Witaj w <span class="logo">w<span class="lg-i">ı<i class="lg-kropka"></i></span>em<i class="lg-kropka"></i></span><span style="font-size:.62em;font-weight:600;letter-spacing:0">task</span>',
    opis: 'Miejsce na wszystko, co macie do zrobienia — od „oddać PIT" po remont łazienki. Zapisujesz sprawę w sekundę, a szczegóły dopisujesz, kiedy masz chwilę.' },
  { ikona: 'zadania', tytul: 'Wpisz i zapomnij',
    opis: 'Pole na górze listy przyjmuje samo zdanie — piszesz, naciskasz Enter i sprawa jest zapisana. Termin, wykonawcę i przypomnienie dodasz później, jeśli w ogóle będą potrzebne.' },
  { ikona: 'osoby', tytul: 'Kto się tym zajmie',
    opis: 'Zadanie możesz przypisać domownikowi — także takiemu, który nie ma konta w aplikacji. Sprawy, których nie chcesz nikomu pokazywać, oznacz jako „tylko dla mnie".' },
  { ikona: 'alerty', tytul: 'Przypomnienie o wybranej porze',
    opis: 'Ustaw termin i godzinę, a apka odezwie się powiadomieniem dokładnie wtedy. Przesuniesz termin — przypomni się ponownie.' },
  { ikona: 'lista', tytul: 'Duże sprawy dziel na kroki',
    opis: 'Do każdego zadania dopiszesz kroki, a do kroków kolejne — tak głęboko, jak potrzebujesz. Na liście widzisz postęp i to, co jest do zrobienia jako następne.' },
  { ikona: 'cele', tytul: 'Zaznacz to, co nieprzesuwalne',
    opis: 'Termin oddania dokumentów albo odbiór mieszkania oznacz jako kamień milowy. Takie punkty wyróżniają się na liście, żeby nie zginęły między drobiazgami.' },
  ],
```

- [ ] **Step 2: Składnia, commit, push, sprawdzenie**

```
node --check static/auth.js
git add static/auth.js
git commit -m "wiem.task: samouczek modulu"
git push origin main
```

Na `/task` kliknij „Samouczek" — ma pokazać sześć slajdów o zadaniach, nie czternaście
o paragonach.

---

## Task 10: Przegląd wobec kryteriów akceptacji

**Files:** brak zmian, chyba że coś nie przechodzi

- [ ] **Step 1: Przejdź całą listę ze specyfikacji**

Sekcja „Kryteria akceptacji", dwanaście punktów. Każdy sprawdź w przeglądarce na wdrożonej
apce i zapisz wynik. Szczególnie łatwe do przeoczenia:

- punkt 8 (prywatność) wymaga **drugiego konta**, nie wystarczy własne;
- punkt 9 (dokładnie jedno powiadomienie) wymaga odczekania kilku tików, nie jednego;
- punkt 11 (obce gospodarstwo) sprawdź wywołaniem z konsoli z cudzym `parent_id` —
  oczekiwane 400, nie 500 i nie zapis.

- [ ] **Step 2: Zgłoś Adamowi wynik**

Wypisz, co przeszło i co nie. Nie zamykaj etapu, dopóki wszystkie dwanaście nie przechodzi
albo nie zapadnie świadoma decyzja, że któryś zostaje na później.

---

## Czego ten plan świadomie nie robi

Projekty, wykres Gantta, zależności, cykliczność, przeciąganie zadań, synchronizacja na żywo
przez WebSocket. Wszystko to jest w specyfikacji jako etap 2 i ma własne ustalenia.
