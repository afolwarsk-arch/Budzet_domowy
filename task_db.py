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
from task_drzewo import wykryj_cykl  # re-eksport: używają go kolejne funkcje w tym pliku

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


def do_przypomnienia():
    """Zadania, którym właśnie minęła godzina przypomnienia.

    Zapytanie musi zostać tanie — woła je tik co minutę — dlatego trzyma się
    wyłącznie kolumn objętych indeksem częściowym `task_zadania_przypomnienia`
    (`termin`, `pora` przy `status = 'otwarte' AND przypomniano_at IS NULL`) i
    nie robi nic ponad wybór wierszy do wysyłki.

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
    """Znaczy zadania jako już przypomniane — po jednym locie wysyłki, żeby
    kolejny tik ich nie powtórzył."""
    if not ids:
        return
    with get_db() as cur:
        cur.execute("UPDATE task_zadania SET przypomniano_at = now() WHERE id = ANY(%s)",
                    (list(ids),))
