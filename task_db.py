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

import calendar
from datetime import date, timedelta

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

        # ── etap 2: projekty i Gantt ────────────────────────────────────────
        # `termin` sam wystarcza zadaniu („zrób do piątku"), ale przedsięwzięcie
        # ciągnące się miesiącami ma ROZPIĘTOŚĆ: remont zaczyna się w marcu
        # i kończy w czerwcu. Bez daty początku belka na wykresie nie ma od
        # czego się zacząć, a zadanie bez niej rysuje się jako sam punkt końcowy.
        cur.execute("ALTER TABLE task_zadania ADD COLUMN IF NOT EXISTS data_start DATE")
        # Projekt to zadanie-korzeń oznaczone jawnie, a nie „takie, które ma
        # dzieci": inaczej dopisanie pierwszego kroku do zwykłego zadania
        # zamieniałoby je w projekt bez wiedzy użytkownika, a usunięcie
        # ostatniego kroku — z powrotem w zadanie.
        cur.execute("ALTER TABLE task_zadania ADD COLUMN IF NOT EXISTS "
                    "projekt BOOLEAN NOT NULL DEFAULT FALSE")
        # Wykres pyta o zadania z jakąkolwiek datą w zadanym oknie czasu.
        cur.execute("CREATE INDEX IF NOT EXISTS task_zadania_plan "
                    "ON task_zadania (household_id, data_start, termin)")

        # ── cykliczność ────────────────────────────────────────────────────
        # NIE generujemy wystąpień z góry. Zadanie powtarzalne to jeden wiersz;
        # kolejne pojawia się dopiero PO ODHACZENIU poprzedniego. Generowanie
        # z wyprzedzeniem zasypałoby listę pięćdziesięcioma wtorkami ze śmieciami
        # i zamieniło „co jest do zrobienia" w kalendarz.
        #
        # `powtarzaj`: NULL | 'dzien' | 'tydzien' | 'miesiac' | 'rok'
        # `powtarzaj_co`: co ile jednostek (2 + 'tydzien' = co dwa tygodnie)
        cur.execute("ALTER TABLE task_zadania ADD COLUMN IF NOT EXISTS powtarzaj TEXT")
        cur.execute("ALTER TABLE task_zadania ADD COLUMN IF NOT EXISTS "
                    "powtarzaj_co INTEGER NOT NULL DEFAULT 1")


# Warunek widoczności dokładany do KAŻDEGO odczytu. Zadanie prywatne nie
# istnieje dla nikogo poza właścicielem — także w postępie zadania nadrzędnego.
_WIDOCZNE = "household_id = %s AND (prywatne_dla IS NULL OR prywatne_dla = %s)"

_POLA = """id, parent_id, tytul, opis, termin, pora, data_start, projekt,
           powtarzaj, powtarzaj_co,
           wykonawca_user_id, wykonawca_virtual_id, prywatne_dla, kamien_milowy,
           status, zrobione_at, kolejnosc, utworzyl"""

OKRESY = ("dzien", "tydzien", "miesiac", "rok")


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


def plan(household_id, user_id, pokaz_zrobione=False):
    """Zadania z rozpiętością w czasie — wejście dla wykresu Gantta.

    BIERZEMY WSZYSTKO, CO MA JAKĄKOLWIEK DATĘ, a nie tylko projekty: remont
    składa się z kroków, których terminy są sensem wykresu, a projekt bez
    rozrysowanych etapów to jedna belka i nic więcej. Zadania bez żadnej daty
    zostają poza wykresem — nie ma ich gdzie postawić na osi czasu.

    Dokładamy przodków bezdatowych, tak samo jak `lista`: krok z terminem musi
    mieć nad sobą swój projekt, inaczej belka wisi bez podpisu, do czego należy.
    """
    warunki = [_WIDOCZNE, "(data_start IS NOT NULL OR termin IS NOT NULL)"]
    p = [household_id, user_id]
    if not pokaz_zrobione:
        warunki.append("status = 'otwarte'")
    with get_db() as cur:
        cur.execute(f"SELECT {_POLA} FROM task_zadania WHERE " + " AND ".join(warunki)
                    + " ORDER BY COALESCE(data_start, termin), termin, kolejnosc, id", p)
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
            (household_id, parent_id, tytul, opis, termin, pora, data_start, projekt,
             powtarzaj, powtarzaj_co,
             wykonawca_user_id, wykonawca_virtual_id, prywatne_dla, kamien_milowy,
             utworzyl, kolejnosc)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                    COALESCE((SELECT MAX(kolejnosc) + 1 FROM task_zadania
                              WHERE household_id = %s AND parent_id IS NOT DISTINCT FROM %s), 0))
            RETURNING id""",
            (household_id, parent_id, d["tytul"], d.get("opis"), d.get("termin"),
             d.get("pora"), d.get("data_start"),
             # Projektem może być tylko korzeń — krok w środku drzewa nie jest
             # przedsięwzięciem, tylko jego częścią.
             bool(d.get("projekt")) and not parent_id,
             d.get("powtarzaj"), d.get("powtarzaj_co") or 1,
             d.get("wykonawca_user_id"), d.get("wykonawca_virtual_id"),
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
              data_start = %s, projekt = %s,
              powtarzaj = %s, powtarzaj_co = %s,
              wykonawca_user_id = %s, wykonawca_virtual_id = %s,
              kamien_milowy = %s, prywatne_dla = %s,
              przypomniano_at = CASE WHEN termin IS DISTINCT FROM %s
                                       OR pora IS DISTINCT FROM %s
                                     THEN NULL ELSE przypomniano_at END
            WHERE household_id = %s AND id = %s""",
            (d["tytul"], d.get("opis"), d.get("termin"), d.get("pora"), nowy_parent,
             d.get("data_start"),
             # Podpięcie zadania pod rodzica odbiera mu status projektu:
             # przedsięwzięcie w środku innego przedsięwzięcia to etap, nie projekt.
             bool(d.get("projekt")) and not nowy_parent,
             # Powtarzanie bez terminu nie ma od czego liczyć następnej daty,
             # więc zdejmujemy je razem z terminem zamiast zostawiać martwe.
             d.get("powtarzaj") if d.get("termin") else None,
             d.get("powtarzaj_co") or 1,
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


def nastepna_data(data, okres: str, co: int):
    """Przesuwa datę o `co` jednostek `okres`. Zwraca `date` albo None.

    Miesiące i lata liczymy kalendarzowo, nie w dniach: „co miesiąc 15." ma
    wypadać piętnastego, a nie dryfować o trzy dni przy każdym powtórzeniu.
    Gdy docelowy miesiąc jest krótszy (31 stycznia + miesiąc), cofamy się do
    ostatniego dnia miesiąca — 31 lutego nie istnieje, a przeskok na 3 marca
    byłby dla użytkownika niespodzianką.
    """
    if not data or okres not in OKRESY:
        return None
    d = data if isinstance(data, date) else date.fromisoformat(str(data)[:10])
    co = max(1, int(co or 1))
    if okres == "dzien":
        return d + timedelta(days=co)
    if okres == "tydzien":
        return d + timedelta(weeks=co)
    miesiace = co if okres == "miesiac" else co * 12
    rok = d.year + (d.month - 1 + miesiace) // 12
    miesiac = (d.month - 1 + miesiace) % 12 + 1
    ostatni = calendar.monthrange(rok, miesiac)[1]
    return date(rok, miesiac, min(d.day, ostatni))


def _powtorz(cur, household_id: int, z: dict) -> int | None:
    """Tworzy kolejne wystąpienie zadania cyklicznego. Zwraca jego id.

    Nowy termin liczymy od TERMINU poprzedniego, a nie od chwili odhaczenia:
    śmieci wystawiane co wtorek mają wypadać we wtorek także wtedy, gdy raz
    zdarzy się wynieść je w czwartek. Liczenie od wykonania powodowałoby
    dryf — po kilku spóźnieniach „co tydzień" wypadałoby w losowy dzień.

    Kroki poddrzewa NIE są kopiowane. Powtarzalne są sprawy proste („wynieść
    śmieci"); kopiowanie całych drzew przy każdym odhaczeniu mnożyłoby dane
    i wymagało decyzji, co zrobić z krokami już zrobionymi.
    """
    nowy_termin = nastepna_data(z.get("termin"), z.get("powtarzaj"), z.get("powtarzaj_co"))
    if not nowy_termin:
        return None
    # Początek przesuwamy o tyle samo dni, ile przesunął się termin, żeby
    # zachować długość zadania (np. „sprzątanie: piątek–niedziela").
    nowy_start = None
    if z.get("data_start") and z.get("termin"):
        stary_start = z["data_start"] if isinstance(z["data_start"], date) else date.fromisoformat(str(z["data_start"])[:10])
        stary_termin = z["termin"] if isinstance(z["termin"], date) else date.fromisoformat(str(z["termin"])[:10])
        nowy_start = nowy_termin - (stary_termin - stary_start)
    cur.execute("""INSERT INTO task_zadania
        (household_id, parent_id, tytul, opis, termin, pora, data_start, projekt,
         powtarzaj, powtarzaj_co, wykonawca_user_id, wykonawca_virtual_id,
         prywatne_dla, kamien_milowy, utworzyl, kolejnosc)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
        (household_id, z.get("parent_id"), z["tytul"], z.get("opis"), nowy_termin,
         z.get("pora"), nowy_start, bool(z.get("projekt")),
         z.get("powtarzaj"), z.get("powtarzaj_co") or 1,
         z.get("wykonawca_user_id"), z.get("wykonawca_virtual_id"),
         z.get("prywatne_dla"), bool(z.get("kamien_milowy")),
         z.get("utworzyl"), z.get("kolejnosc") or 0))
    return cur.fetchone()["id"]


def ustaw_status(household_id, user_id, zadanie_id, zrobione, kaskada=False) -> int:
    """Zwraca liczbę zmienionych zadań. Kaskada schodzi w dół poddrzewa —
    tu `WITH RECURSIVE` jest na miejscu, bo pytanie dotyczy całego poddrzewa.

    Odhaczenie zadania POWTARZALNEGO rodzi kolejne wystąpienie — patrz `_powtorz`.
    Odznaczenie (powrót do „otwarte") już go nie usuwa: nowe zadanie mogło
    zdążyć zmienić właściciela albo termin, a cichy `DELETE` skasowałby cudzą
    pracę. Zdublowane wystąpienie użytkownik po prostu usuwa ręcznie.
    """
    biezace = pobierz(household_id, user_id, zadanie_id)
    if not biezace:
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
        zmienione = cur.rowcount
        if zrobione and zmienione and biezace.get("powtarzaj"):
            _powtorz(cur, household_id, biezace)
        return zmienione


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
