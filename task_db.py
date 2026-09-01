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

        # ── zależności ─────────────────────────────────────────────────────
        # WYŁĄCZNIE „skończ, zanim zaczniesz" (finish-to-start). Pozostałe trzy
        # typy z podręczników (SS, FF, SF) są w domu rzadkie, a mylące zawsze —
        # decyzja ze specyfikacji. Zadania bez powiązania są z definicji
        # równoległe, więc „mogą iść obok siebie" nie wymaga osobnego typu.
        #
        # Osobna tabela, nie kolumna: zadanie może czekać na KILKA innych
        # („wylewka" po „hydraulice" i po „elektryce").
        cur.execute("""CREATE TABLE IF NOT EXISTS task_zaleznosci (
            id            SERIAL PRIMARY KEY,
            household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            zadanie_id    INTEGER NOT NULL REFERENCES task_zadania(id) ON DELETE CASCADE,
            poprzednik_id INTEGER NOT NULL REFERENCES task_zadania(id) ON DELETE CASCADE,
            created_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (zadanie_id, poprzednik_id)
        )""")
        cur.execute("CREATE INDEX IF NOT EXISTS task_zaleznosci_zadanie "
                    "ON task_zaleznosci (zadanie_id)")
        cur.execute("CREATE INDEX IF NOT EXISTS task_zaleznosci_poprzednik "
                    "ON task_zaleznosci (poprzednik_id)")

        # ── komentarze ─────────────────────────────────────────────────────
        # DZIENNIK, NIE POLE. Opis zadania mówi, co jest do zrobienia; komentarze
        # mówią, co się po drodze wydarzyło („bank poprosił o dodatkowy dokument",
        # „właściciel przesunął spotkanie"). Nadpisywanie jednego pola gubiłoby
        # tę historię, a przy sprawach ciągnących się miesiącami to ona jest
        # najcenniejsza — po pół roku nikt nie pamięta, czemu termin się przesunął.
        cur.execute("""CREATE TABLE IF NOT EXISTS task_komentarze (
            id           SERIAL PRIMARY KEY,
            household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            zadanie_id   INTEGER NOT NULL REFERENCES task_zadania(id) ON DELETE CASCADE,
            tresc        TEXT NOT NULL,
            autor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )""")
        cur.execute("CREATE INDEX IF NOT EXISTS task_komentarze_zadanie "
                    "ON task_komentarze (zadanie_id, created_at)")

        # ── strefy ─────────────────────────────────────────────────────────
        # Poziom NAD projektami: „Praca", „Dom", „Własna działalność",
        # „Studia". Projekt należy do strefy, luźne wrzutki też.
        #
        # DLACZEGO NIE ZWYKŁY PROJEKT-KORZEŃ: strefy się nie kończą. „Praca"
        # nigdy nie będzie zrobiona, a jako projekt dostałaby licznik postępu
        # („3 z 40") i belkę na wykresie Gantta ciągnącą się w nieskończoność.
        # Projekt to praca z końcem, strefa to część życia.
        cur.execute("""CREATE TABLE IF NOT EXISTS task_strefy (
            id           SERIAL PRIMARY KEY,
            household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            nazwa        TEXT NOT NULL,
            kolejnosc    INTEGER NOT NULL DEFAULT 0,
            created_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )""")
        # Kto z której strefy korzysta. Nie każdy domownik studiuje i nie każdy
        # prowadzi firmę — bez tej tabeli cudze sprawy zawodowe zaśmiecałyby
        # widok osobie, której w ogóle nie dotyczą.
        cur.execute("""CREATE TABLE IF NOT EXISTS task_strefy_osob (
            strefa_id INTEGER NOT NULL REFERENCES task_strefy(id) ON DELETE CASCADE,
            user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            PRIMARY KEY (strefa_id, user_id)
        )""")
        cur.execute("CREATE INDEX IF NOT EXISTS task_strefy_osob_user "
                    "ON task_strefy_osob (user_id)")
        # NULL znaczy „bez strefy" i jest widoczne dla wszystkich. To jednocześnie
        # ścieżka migracji: wszystko, co powstało przed strefami, zostaje na
        # wierzchu, zamiast zniknąć komuś z oczu przy wdrożeniu.
        cur.execute("ALTER TABLE task_zadania ADD COLUMN IF NOT EXISTS "
                    "strefa_id INTEGER REFERENCES task_strefy(id) ON DELETE SET NULL")
        cur.execute("CREATE INDEX IF NOT EXISTS task_zadania_strefa "
                    "ON task_zadania (household_id, strefa_id)")


# Warunek widoczności dokładany do KAŻDEGO odczytu. Zadanie prywatne nie
# istnieje dla nikogo poza właścicielem — także w postępie zadania nadrzędnego.
# Zadanie ze strefy, której ktoś nie używa, też dla niego nie istnieje: to nie
# tajemnica, tylko cudza część życia, i ma nie zaśmiecać widoku. Włączenie
# strefy przywraca je natychmiast, więc nic nie ginie bezpowrotnie.
_WIDOCZNE = ("household_id = %s AND (prywatne_dla IS NULL OR prywatne_dla = %s) "
             "AND (strefa_id IS NULL OR strefa_id IN "
             "(SELECT strefa_id FROM task_strefy_osob WHERE user_id = %s))")


def _p(household_id, user_id, *reszta):
    """Parametry pod `_WIDOCZNE`, w jego kolejności.

    `user_id` wchodzi DWA razy — raz do prywatności, raz do stref — a psycopg2
    podstawia parametry pozycyjnie. Osobna funkcja zamiast powtarzania krotki
    przy każdym zapytaniu, bo pomyłka w liczbie parametrów wychodzi dopiero
    w czasie działania, i to komunikatem, który nie mówi, gdzie jej szukać.
    """
    return (household_id, user_id, user_id, *reszta)


_POLA = """id, parent_id, tytul, opis, termin, pora, data_start, projekt,
           powtarzaj, powtarzaj_co, strefa_id,
           wykonawca_user_id, wykonawca_virtual_id, prywatne_dla, kamien_milowy,
           status, zrobione_at, kolejnosc, utworzyl"""

OKRESY = ("dzien", "tydzien", "miesiac", "rok")


def zaleznosci(household_id: int) -> list[dict]:
    """Wszystkie powiązania gospodarstwa: (zadanie czeka na poprzednika)."""
    with get_db() as cur:
        cur.execute("SELECT zadanie_id, poprzednik_id FROM task_zaleznosci "
                    "WHERE household_id = %s", (household_id,))
        return [dict(r) for r in cur.fetchall()]


def dodaj_zaleznosc(household_id: int, user_id: int, zadanie_id: int,
                    poprzednik_id: int) -> bool:
    """Zadanie ma czekać na poprzednika. Odrzuca pętle.

    PĘTLA W ZALEŻNOŚCIACH JEST GORSZA NIŻ W DRZEWIE: drzewo tylko by się nie
    narysowało, a tu „A czeka na B, B czeka na A" znaczy, że żadne z zadań nie
    może się nigdy zacząć, a wykres w nieskończoność przesuwałby oba w przyszłość.
    """
    if zadanie_id == poprzednik_id:
        raise ValueError("Zadanie nie może czekać samo na siebie.")
    if not pobierz(household_id, user_id, zadanie_id):
        raise ValueError("Nie ma takiego zadania.")
    if not pobierz(household_id, user_id, poprzednik_id):
        raise ValueError("Nie ma takiego poprzednika.")

    # Czy poprzednik (pośrednio) już czeka na to zadanie?
    krawedzie = {}
    for z in zaleznosci(household_id):
        krawedzie.setdefault(z["zadanie_id"], []).append(z["poprzednik_id"])
    odwiedzone = set()
    stos = [poprzednik_id]
    while stos:
        biezacy = stos.pop()
        if biezacy == zadanie_id:
            raise ValueError("To zamknęłoby pętlę — te zadania czekałyby na siebie nawzajem.")
        if biezacy in odwiedzone:
            continue
        odwiedzone.add(biezacy)
        stos.extend(krawedzie.get(biezacy, []))

    with get_db() as cur:
        cur.execute("INSERT INTO task_zaleznosci (household_id, zadanie_id, poprzednik_id) "
                    "VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                    (household_id, zadanie_id, poprzednik_id))
        return cur.rowcount > 0


def usun_zaleznosc(household_id: int, zadanie_id: int, poprzednik_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM task_zaleznosci WHERE household_id = %s "
                    "AND zadanie_id = %s AND poprzednik_id = %s",
                    (household_id, zadanie_id, poprzednik_id))
        return cur.rowcount > 0


def komentarze(household_id: int, user_id: int, zadanie_id: int) -> list[dict]:
    """Dziennik zadania, od najstarszego wpisu. Kolejność ma znaczenie: to
    historia, a nie zbiór notatek."""
    if not pobierz(household_id, user_id, zadanie_id):
        return []
    with get_db() as cur:
        cur.execute(
            "SELECT k.id, k.tresc, k.created_at, "
            "       COALESCE(u.display_name, u.name) AS autor "
            "FROM task_komentarze k LEFT JOIN users u ON u.id = k.autor_id "
            "WHERE k.zadanie_id = %s AND k.household_id = %s "
            "ORDER BY k.created_at, k.id",
            (zadanie_id, household_id))
        return [dict(r) for r in cur.fetchall()]


def dodaj_komentarz(household_id: int, user_id: int, zadanie_id: int, tresc: str) -> dict | None:
    tresc = (tresc or "").strip()
    if not tresc:
        return None
    if not pobierz(household_id, user_id, zadanie_id):
        raise ValueError("Nie ma takiego zadania.")
    with get_db() as cur:
        cur.execute(
            "INSERT INTO task_komentarze (household_id, zadanie_id, tresc, autor_id) "
            "VALUES (%s,%s,%s,%s) RETURNING id, tresc, created_at",
            (household_id, zadanie_id, tresc[:2000], user_id))
        return dict(cur.fetchone())


def usun_komentarz(household_id: int, komentarz_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM task_komentarze WHERE id = %s AND household_id = %s",
                    (komentarz_id, household_id))
        return cur.rowcount > 0


def liczniki_komentarzy(household_id: int, user_id: int) -> dict:
    """Ile komentarzy ma każde zadanie — do znacznika na liście, żeby dziennik
    nie był niewidoczny, dopóki się go nie otworzy."""
    with get_db() as cur:
        cur.execute(
            "SELECT zadanie_id, COUNT(*) AS ile FROM task_komentarze "
            "WHERE household_id = %s GROUP BY zadanie_id", (household_id,))
        return {r["zadanie_id"]: r["ile"] for r in cur.fetchall()}


def postep_poddrzew(household_id: int, user_id: int) -> dict:
    """Dla każdego zadania: ile kroków ma w środku i ile z nich zamkniętych.

    LICZONE Z CAŁEJ BAZY, NIE Z WIDOCZNEJ LISTY. Postęp liczony po stronie
    przeglądarki brał pod uwagę tylko zadania z bieżącej zakładki, a zrobione
    kroki do „Nadchodzących" nie trafiają — więc projekt z dwoma zamkniętymi
    krokami pokazywał „0 z 12" zamiast „2 z 14". Licznik, który zaniża postęp,
    jest gorszy niż jego brak.

    Jedno zapytanie po płaską listę i zliczanie w Pythonie: gospodarstwo ma
    setki zadań, nie miliony, więc `WITH RECURSIVE` per wiersz byłby drogi
    bez powodu.
    """
    with get_db() as cur:
        cur.execute(
            f"SELECT id, parent_id, status FROM task_zadania WHERE {_WIDOCZNE}",
            _p(household_id, user_id))
        wiersze = [(r["id"], r["parent_id"], r["status"]) for r in cur.fetchall()]

    dzieci: dict[int, list[int]] = {}
    status = {}
    for zid, parent, st in wiersze:
        status[zid] = st
        dzieci.setdefault(parent, []).append(zid)

    wynik: dict[int, dict] = {}

    def policz(zid: int) -> tuple[int, int]:
        """(wszystkie potomki, zamknięte potomki) — bez samego zadania."""
        razem = gotowe = 0
        for d in dzieci.get(zid, []):
            pod_r, pod_g = policz(d)
            razem += 1 + pod_r
            gotowe += (1 if status[d] == "zrobione" else 0) + pod_g
        wynik[zid] = {"razem": razem, "gotowe": gotowe}
        return razem, gotowe

    for zid in status:
        if zid not in wynik:
            policz(zid)
    return wynik


def pary_gospodarstwa(household_id):
    """(id, parent_id) całego gospodarstwa — wejście dla `wykryj_cykl`."""
    with get_db() as cur:
        cur.execute("SELECT id, parent_id FROM task_zadania WHERE household_id = %s",
                    (household_id,))
        return [(r["id"], r["parent_id"]) for r in cur.fetchall()]


def lista(household_id, user_id, zakres="dzis", osoba_user_id=None, strefa=None):
    """Płaska lista zadań. Drzewo składa front — patrz nagłówek pliku.

    UWAGA: zwracamy też przodków zadań pasujących do zakresu, inaczej krok
    z terminem na dziś wisiałby na liście bez rodzica i bez kontekstu.

    `strefa`: None to wszystkie strefy, do których mam dostęp; liczba zawęża
    do jednej. Zadania „bez strefy" (NULL) przy zawężeniu NIE wchodzą — należą
    do wszystkiego i do niczego, a mieszanie ich w każdy widok odbierałoby
    strefom sens.
    """
    warunki = [_WIDOCZNE]
    p = list(_p(household_id, user_id))
    if strefa:
        warunki.append("strefa_id = %s")
        p.append(strefa)
    if zakres == "dzis":
        warunki.append("status = 'otwarte' AND termin IS NOT NULL AND termin <= CURRENT_DATE")
    elif zakres == "nadchodzace":
        warunki.append("status = 'otwarte' AND (termin IS NULL OR termin > CURRENT_DATE)")
    elif zakres == "wszystkie":
        # Wszystko otwarte, bez pytania o datę. „Dziś" i „Nadchodzące" dzielą
        # zadania po terminie, więc żeby zobaczyć całość, trzeba było przełączać
        # się tam i z powrotem i składać listę w głowie.
        warunki.append("status = 'otwarte'")
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
                        "AND id = ANY(%s)", _p(household_id, user_id, list(brakujacy)))
            dorzuc = [dict(r) for r in cur.fetchall()]
            if not dorzuc:
                break
            wiersze.extend(dorzuc)
            znane |= {w["id"] for w in dorzuc}
            brakujacy = {w["parent_id"] for w in dorzuc if w["parent_id"] and w["parent_id"] not in znane}
        return _z_postepem(wiersze, household_id, user_id)


def plan(household_id, user_id, pokaz_zrobione=False, strefa=None):
    """Zadania z rozpiętością w czasie — wejście dla wykresu Gantta.

    BIERZEMY WSZYSTKO, CO MA JAKĄKOLWIEK DATĘ, a nie tylko projekty: remont
    składa się z kroków, których terminy są sensem wykresu, a projekt bez
    rozrysowanych etapów to jedna belka i nic więcej. Zadania bez żadnej daty
    zostają poza wykresem — nie ma ich gdzie postawić na osi czasu.

    Dokładamy przodków bezdatowych, tak samo jak `lista`: krok z terminem musi
    mieć nad sobą swój projekt, inaczej belka wisi bez podpisu, do czego należy.
    """
    warunki = [_WIDOCZNE, "(data_start IS NOT NULL OR termin IS NOT NULL)"]
    p = list(_p(household_id, user_id))
    if strefa:
        warunki.append("strefa_id = %s")
        p.append(strefa)
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
                        "AND id = ANY(%s)", _p(household_id, user_id, list(brakujacy)))
            dorzuc = [dict(r) for r in cur.fetchall()]
            if not dorzuc:
                break
            wiersze.extend(dorzuc)
            znane |= {w["id"] for w in dorzuc}
            brakujacy = {w["parent_id"] for w in dorzuc if w["parent_id"] and w["parent_id"] not in znane}
        return _z_postepem(wiersze, household_id, user_id)


# ── strefy ──────────────────────────────────────────────────────────────────

# Nazwy zaproponowane przy pierwszym wejściu. Zakładamy je RAZ i tylko wtedy,
# gdy gospodarstwo nie ma jeszcze żadnej strefy — potem to już wyłącznie
# własność użytkownika: może je zmienić, skasować i dodać swoje.
STREFY_STARTOWE = ("Praca", "Dom", "Własna działalność", "Studia i nauka")


def strefy(household_id, user_id) -> list[dict]:
    """Strefy gospodarstwa ze znacznikiem, czy TA osoba z nich korzysta."""
    with get_db() as cur:
        cur.execute(
            "SELECT s.id, s.nazwa, s.kolejnosc, "
            "       (o.user_id IS NOT NULL) AS moja, "
            "       (SELECT COUNT(*) FROM task_zadania z "
            "        WHERE z.strefa_id = s.id AND z.status = 'otwarte') AS otwartych "
            "FROM task_strefy s "
            "LEFT JOIN task_strefy_osob o ON o.strefa_id = s.id AND o.user_id = %s "
            "WHERE s.household_id = %s ORDER BY s.kolejnosc, s.id",
            (user_id, household_id))
        return [dict(r) for r in cur.fetchall()]


def zaloz_strefy_startowe(household_id, user_id) -> bool:
    """Zakłada strefy startowe, jeśli gospodarstwo nie ma jeszcze żadnej.

    Wszystkie włączone dla zakładającego — łatwiej wyłączyć niepotrzebną niż
    domyślić się, że przełącznik jest pusty, bo nikt niczego nie zaznaczył.
    """
    with get_db() as cur:
        cur.execute("SELECT 1 FROM task_strefy WHERE household_id = %s LIMIT 1",
                    (household_id,))
        if cur.fetchone():
            return False
        for i, nazwa in enumerate(STREFY_STARTOWE):
            cur.execute("INSERT INTO task_strefy (household_id, nazwa, kolejnosc) "
                        "VALUES (%s,%s,%s) RETURNING id", (household_id, nazwa, i))
            cur.execute("INSERT INTO task_strefy_osob (strefa_id, user_id) VALUES (%s,%s)",
                        (cur.fetchone()["id"], user_id))
        return True


def dodaj_strefe(household_id, user_id, nazwa: str) -> dict | None:
    nazwa = (nazwa or "").strip()
    if not nazwa:
        return None
    with get_db() as cur:
        cur.execute("SELECT COALESCE(MAX(kolejnosc), -1) + 1 AS n FROM task_strefy "
                    "WHERE household_id = %s", (household_id,))
        cur.execute("INSERT INTO task_strefy (household_id, nazwa, kolejnosc) "
                    "VALUES (%s,%s,(SELECT COALESCE(MAX(kolejnosc), -1) + 1 "
                    "FROM task_strefy WHERE household_id = %s)) RETURNING id, nazwa",
                    (household_id, nazwa[:60], household_id))
        s = dict(cur.fetchone())
        # Kto zakłada strefę, ten jej używa — inaczej znikałaby mu z oczu
        # w chwili utworzenia.
        cur.execute("INSERT INTO task_strefy_osob (strefa_id, user_id) VALUES (%s,%s) "
                    "ON CONFLICT DO NOTHING", (s["id"], user_id))
        s["moja"] = True
        return s


def zmien_nazwe_strefy(household_id, strefa_id, nazwa: str) -> bool:
    nazwa = (nazwa or "").strip()
    if not nazwa:
        return False
    with get_db() as cur:
        cur.execute("UPDATE task_strefy SET nazwa = %s WHERE id = %s AND household_id = %s",
                    (nazwa[:60], strefa_id, household_id))
        return cur.rowcount > 0


def usun_strefe(household_id, strefa_id) -> bool:
    """Kasuje strefę. Zadania NIE giną — wracają do „bez strefy".

    `ON DELETE SET NULL` przy `strefa_id` robi to samo, ale zapisane wprost,
    bo to jest właśnie ta obietnica: skasowanie szuflady nie kasuje jej
    zawartości.
    """
    with get_db() as cur:
        cur.execute("DELETE FROM task_strefy WHERE id = %s AND household_id = %s",
                    (strefa_id, household_id))
        return cur.rowcount > 0


def ustaw_moja_strefe(household_id, user_id, strefa_id, moja: bool) -> bool:
    with get_db() as cur:
        cur.execute("SELECT 1 FROM task_strefy WHERE id = %s AND household_id = %s",
                    (strefa_id, household_id))
        if not cur.fetchone():
            return False
        if moja:
            cur.execute("INSERT INTO task_strefy_osob (strefa_id, user_id) VALUES (%s,%s) "
                        "ON CONFLICT DO NOTHING", (strefa_id, user_id))
        else:
            cur.execute("DELETE FROM task_strefy_osob WHERE strefa_id = %s AND user_id = %s",
                        (strefa_id, user_id))
        return True


def przypisz_strefe(household_id, user_id, zadanie_id, strefa_id) -> bool:
    """Ustawia strefę zadania RAZEM Z CAŁYM PODDRZEWEM.

    Bez kaskady przeniesienie projektu do innej strefy zostawiałoby jego kroki
    w starej — a że lista filtruje po strefie, projekt pokazywałby się pusty
    w nowym miejscu i osierocone kroki w starym. Strefa jest cechą całej
    gałęzi, nie pojedynczego wiersza.
    """
    if not pobierz(household_id, user_id, zadanie_id):
        return False
    with get_db() as cur:
        if strefa_id:
            cur.execute("SELECT 1 FROM task_strefy WHERE id = %s AND household_id = %s",
                        (strefa_id, household_id))
            if not cur.fetchone():
                return False
        cur.execute("""
            WITH RECURSIVE galaz AS (
                SELECT id FROM task_zadania WHERE id = %s AND household_id = %s
                UNION ALL
                SELECT z.id FROM task_zadania z JOIN galaz g ON z.parent_id = g.id
            )
            UPDATE task_zadania SET strefa_id = %s WHERE id IN (SELECT id FROM galaz)
        """, (zadanie_id, household_id, strefa_id or None))
        return True


def drzewo_do_wyboru(household_id, user_id, strefa=None) -> list[dict]:
    """Płaska lista otwartych zadań — wejście dla wybieraka miejsca w szybkim
    dodawaniu.

    ŚWIADOMIE CHUDA: id, tytuł, rodzic, znacznik projektu i nic więcej. Wybierak
    otwiera się w trakcie łapania zadania, więc liczy się czas odpowiedzi, a nie
    komplet danych. Postępu ani komentarzy tu nie ma, bo w kafelku wyboru i tak
    nie byłoby ich gdzie pokazać.

    Zrobione pomijamy: dokładanie kroku do zamkniętej sprawy to pomyłka, a nie
    zamiar, i nie ma powodu zaśmiecać nimi listy wyboru.
    """
    with get_db() as cur:
        cur.execute(
            f"SELECT id, tytul, parent_id, projekt, strefa_id FROM task_zadania "
            f"WHERE {_WIDOCZNE} AND status = 'otwarte'"
            + (" AND strefa_id = %s" if strefa else "")
            + " ORDER BY projekt DESC, kolejnosc, id",
            _p(household_id, user_id, strefa) if strefa else _p(household_id, user_id))
        return [dict(r) for r in cur.fetchall()]


def _z_postepem(wiersze: list, household_id: int, user_id: int) -> list:
    """Dokłada do każdego zadania licznik kroków policzony z całej bazy."""
    if not wiersze:
        return wiersze
    postep = postep_poddrzew(household_id, user_id)
    komentarzy = liczniki_komentarzy(household_id, user_id)
    for w in wiersze:
        p = postep.get(w["id"], {"razem": 0, "gotowe": 0})
        w["krokow_razem"] = p["razem"]
        w["krokow_gotowych"] = p["gotowe"]
        w["ile_komentarzy"] = komentarzy.get(w["id"], 0)
    return wiersze


def pobierz(household_id, user_id, zadanie_id):
    with get_db() as cur:
        cur.execute(f"SELECT {_POLA} FROM task_zadania WHERE {_WIDOCZNE} AND id = %s",
                    _p(household_id, user_id, zadanie_id))
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
        # Strefę też. Krok nie należy do innej części życia niż sprawa, której
        # jest częścią, a gdyby należał, zniknąłby z listy razem z projektem
        # przy zawężeniu do strefy.
        strefa = rodzic.get("strefa_id")
    else:
        strefa = d.get("strefa_id") or None
    with get_db() as cur:
        cur.execute("""INSERT INTO task_zadania
            (household_id, parent_id, tytul, opis, termin, pora, data_start, projekt,
             powtarzaj, powtarzaj_co, strefa_id,
             wykonawca_user_id, wykonawca_virtual_id, prywatne_dla, kamien_milowy,
             utworzyl, kolejnosc)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                    COALESCE((SELECT MAX(kolejnosc) + 1 FROM task_zadania
                              WHERE household_id = %s AND parent_id IS NOT DISTINCT FROM %s), 0))
            RETURNING id""",
            (household_id, parent_id, d["tytul"], d.get("opis"), d.get("termin"),
             d.get("pora"), d.get("data_start"),
             # Projektem może być tylko korzeń — krok w środku drzewa nie jest
             # przedsięwzięciem, tylko jego częścią.
             bool(d.get("projekt")) and not parent_id,
             d.get("powtarzaj"), d.get("powtarzaj_co") or 1, strefa,
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
