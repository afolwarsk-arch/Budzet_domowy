"""Warstwa bazy dla sekcji wiem.eat — dziennik jedzenia.

CELOWO osobny plik. `database.py` ma już 3000 linii i 30 tabel; dokładanie do
niego drugiej dziedziny zabetonowałoby jedno i drugie. Korzystamy tylko z
`get_db` — reszta jest niezależna, więc finanse można ruszać bez oglądania się
na jedzenie i odwrotnie.

Wszystkie wartości odżywcze produktów są **na 100 g**. Wpisy w dzienniku mają
je już przeliczone na zjedzoną ilość — patrz komentarz przy `eat_wpisy`.
"""

from database import get_db

POSILKI = ("sniadanie", "obiad", "kolacja", "przekaska")
ZRODLA = ("off", "etykieta", "opis", "reczne")


def init_eat_db() -> None:
    with get_db() as cur:
        # Własna baza produktów gospodarstwa. Rośnie sama: każdy zeskanowany
        # produkt zostaje tutaj, więc po kilku tygodniach większość zakupów
        # rozpoznaje się lokalnie — bez internetu i bez limitów Open Food Facts.
        cur.execute("""CREATE TABLE IF NOT EXISTS eat_produkty (
            id           SERIAL PRIMARY KEY,
            household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            kod          TEXT,
            nazwa        TEXT NOT NULL,
            marka        TEXT,
            opak_g       NUMERIC(8,1),
            kcal         NUMERIC(7,1) NOT NULL,
            bialko       NUMERIC(7,1),
            tluszcz      NUMERIC(7,1),
            wegle        NUMERIC(7,1),
            blonnik      NUMERIC(7,1),
            cukry        NUMERIC(7,1),
            sol          NUMERIC(7,2),
            zrodlo       TEXT NOT NULL DEFAULT 'off',
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS eat_produkty_kod "
                    "ON eat_produkty (household_id, kod) WHERE kod IS NOT NULL")
        cur.execute("CREATE INDEX IF NOT EXISTS eat_produkty_nazwa "
                    "ON eat_produkty (household_id, lower(nazwa))")

        # Wpisy dziennika. Wartości odżywcze są tu PRZELICZONE i zapisane na
        # stałe, a nie liczone w locie z produktu — inaczej poprawienie literówki
        # w bazie produktów zmieniłoby wstecz wczorajszy bilans. Historia ma być
        # nieruchoma.
        cur.execute("""CREATE TABLE IF NOT EXISTS eat_wpisy (
            id           SERIAL PRIMARY KEY,
            household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            data         DATE NOT NULL,
            posilek      TEXT NOT NULL,
            produkt_id   INTEGER REFERENCES eat_produkty(id) ON DELETE SET NULL,
            nazwa        TEXT NOT NULL,
            opis_porcji  TEXT,
            ilosc_g      NUMERIC(8,1) NOT NULL,
            kcal         NUMERIC(8,1) NOT NULL,
            bialko       NUMERIC(7,1),
            tluszcz      NUMERIC(7,1),
            wegle        NUMERIC(7,1),
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        cur.execute("CREATE INDEX IF NOT EXISTS eat_wpisy_dzien "
                    "ON eat_wpisy (household_id, user_id, data)")

        # Cel dzienny — per OSOBA, nie per gospodarstwo. Zapotrzebowanie Adama
        # i Oli to dwie różne liczby, nawet jeśli dziennik jest wspólny.
        cur.execute("""CREATE TABLE IF NOT EXISTS eat_cele (
            user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            kcal     INTEGER NOT NULL DEFAULT 2000,
            bialko   INTEGER NOT NULL DEFAULT 100,
            tluszcz  INTEGER NOT NULL DEFAULT 65,
            wegle    INTEGER NOT NULL DEFAULT 250
        )""")


# ── cele ────────────────────────────────────────────────────────────────────

_CELE_DOMYSLNE = {"kcal": 2000, "bialko": 100, "tluszcz": 65, "wegle": 250}


def get_cele(user_id: int) -> dict:
    """Brak wiersza = wartości domyślne. Nie zakładamy rekordu na zapas, żeby
    nie udawać, że użytkownik coś ustawił."""
    with get_db() as cur:
        cur.execute("SELECT kcal, bialko, tluszcz, wegle FROM eat_cele WHERE user_id=%s", (user_id,))
        row = cur.fetchone()
    return dict(row) if row else dict(_CELE_DOMYSLNE)


def set_cele(user_id: int, kcal: int, bialko: int, tluszcz: int, wegle: int) -> None:
    with get_db() as cur:
        cur.execute("""
            INSERT INTO eat_cele (user_id, kcal, bialko, tluszcz, wegle)
            VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT (user_id) DO UPDATE
               SET kcal=EXCLUDED.kcal, bialko=EXCLUDED.bialko,
                   tluszcz=EXCLUDED.tluszcz, wegle=EXCLUDED.wegle
        """, (user_id, kcal, bialko, tluszcz, wegle))


# ── produkty ────────────────────────────────────────────────────────────────

def produkt_po_kodzie(household_id: int, kod: str) -> dict | None:
    with get_db() as cur:
        cur.execute("SELECT * FROM eat_produkty WHERE household_id=%s AND kod=%s",
                    (household_id, kod))
        row = cur.fetchone()
    return dict(row) if row else None


def szukaj_produktow(household_id: int, fraza: str, limit: int = 20) -> list[dict]:
    with get_db() as cur:
        cur.execute("""SELECT * FROM eat_produkty
                       WHERE household_id=%s AND nazwa ILIKE %s
                       ORDER BY nazwa LIMIT %s""",
                    (household_id, f"%{fraza}%", limit))
        return [dict(r) for r in cur.fetchall()]


def lista_produktow(household_id: int, limit: int = 500) -> list[dict]:
    """Cała baza gospodarstwa, do przeglądu w panelu. Dokładamy licznik użyć —
    produkt, którego nikt nigdy nie zjadł, kasuje się bez wahania."""
    with get_db() as cur:
        cur.execute("""
            SELECT p.*, (SELECT COUNT(*) FROM eat_wpisy w WHERE w.produkt_id = p.id) AS uzyc
            FROM eat_produkty p
            WHERE p.household_id = %s
            ORDER BY p.created_at DESC
            LIMIT %s
        """, (household_id, limit))
        return [dict(r) for r in cur.fetchall()]


def usun_produkt(produkt_id: int, household_id: int) -> bool:
    """Kasuje produkt z bazy. Wpisy w dzienniku ZOSTAJĄ — mają własną kopię
    nazwy i wartości, więc historia się nie zmienia (FK jest ON DELETE SET NULL)."""
    with get_db() as cur:
        cur.execute("DELETE FROM eat_produkty WHERE id=%s AND household_id=%s",
                    (produkt_id, household_id))
        return cur.rowcount > 0


def zapisz_produkt(household_id: int, dane: dict) -> dict:
    """Dokłada produkt do bazy gospodarstwa. Przy powtórzonym kodzie odświeża
    wartości zamiast tworzyć duplikat."""
    pola = ("kod", "nazwa", "marka", "opak_g", "kcal", "bialko", "tluszcz",
            "wegle", "blonnik", "cukry", "sol", "zrodlo")
    w = {p: dane.get(p) for p in pola}
    w["zrodlo"] = w["zrodlo"] if w["zrodlo"] in ZRODLA else "reczne"
    with get_db() as cur:
        if w["kod"]:
            cur.execute("""
                INSERT INTO eat_produkty (household_id, kod, nazwa, marka, opak_g, kcal,
                                          bialko, tluszcz, wegle, blonnik, cukry, sol, zrodlo)
                VALUES (%(h)s,%(kod)s,%(nazwa)s,%(marka)s,%(opak_g)s,%(kcal)s,
                        %(bialko)s,%(tluszcz)s,%(wegle)s,%(blonnik)s,%(cukry)s,%(sol)s,%(zrodlo)s)
                ON CONFLICT (household_id, kod) DO UPDATE
                   SET nazwa=EXCLUDED.nazwa, marka=EXCLUDED.marka, opak_g=EXCLUDED.opak_g,
                       kcal=EXCLUDED.kcal, bialko=EXCLUDED.bialko, tluszcz=EXCLUDED.tluszcz,
                       wegle=EXCLUDED.wegle, blonnik=EXCLUDED.blonnik, cukry=EXCLUDED.cukry,
                       sol=EXCLUDED.sol
                RETURNING *
            """, {"h": household_id, **w})
        else:
            cur.execute("""
                INSERT INTO eat_produkty (household_id, nazwa, marka, opak_g, kcal,
                                          bialko, tluszcz, wegle, blonnik, cukry, sol, zrodlo)
                VALUES (%(h)s,%(nazwa)s,%(marka)s,%(opak_g)s,%(kcal)s,
                        %(bialko)s,%(tluszcz)s,%(wegle)s,%(blonnik)s,%(cukry)s,%(sol)s,%(zrodlo)s)
                RETURNING *
            """, {"h": household_id, **w})
        return dict(cur.fetchone())


# ── dziennik ────────────────────────────────────────────────────────────────

def get_dzien(household_id: int, user_id: int, data: str) -> dict:
    """Wpisy z jednego dnia pogrupowane po posiłkach plus suma dnia."""
    with get_db() as cur:
        cur.execute("""SELECT * FROM eat_wpisy
                       WHERE household_id=%s AND user_id=%s AND data=%s
                       ORDER BY id""", (household_id, user_id, data))
        wpisy = [dict(r) for r in cur.fetchall()]

    posilki = {p: [] for p in POSILKI}
    suma = {"kcal": 0.0, "bialko": 0.0, "tluszcz": 0.0, "wegle": 0.0}
    for w in wpisy:
        posilki.setdefault(w["posilek"], []).append(w)
        for k in suma:
            suma[k] += float(w.get(k) or 0)
    return {"data": data, "posilki": posilki, "suma": {k: round(v, 1) for k, v in suma.items()}}


def dodaj_wpis(household_id: int, user_id: int, dane: dict) -> dict:
    with get_db() as cur:
        cur.execute("""
            INSERT INTO eat_wpisy (household_id, user_id, data, posilek, produkt_id,
                                   nazwa, opis_porcji, ilosc_g, kcal, bialko, tluszcz, wegle)
            VALUES (%(h)s,%(u)s,%(data)s,%(posilek)s,%(produkt_id)s,
                    %(nazwa)s,%(opis_porcji)s,%(ilosc_g)s,%(kcal)s,%(bialko)s,%(tluszcz)s,%(wegle)s)
            RETURNING *
        """, {"h": household_id, "u": user_id, **dane})
        return dict(cur.fetchone())


def usun_wpis(wpis_id: int, household_id: int, user_id: int) -> bool:
    """Kasować można tylko własne wpisy — dziennik jest wspólny do oglądania,
    ale nie do poprawiania po kimś."""
    with get_db() as cur:
        cur.execute("DELETE FROM eat_wpisy WHERE id=%s AND household_id=%s AND user_id=%s",
                    (wpis_id, household_id, user_id))
        return cur.rowcount > 0


def ostatnio_jadl(household_id: int, user_id: int, limit: int = 12) -> list[dict]:
    """Lista „ostatnio jadłeś" — to ona ma pokrywać większość wpisów, więc
    liczy się i świeżość, i częstotliwość. Grupujemy po nazwie i porcji, żeby
    ta sama kanapka nie zajęła całej listy."""
    with get_db() as cur:
        cur.execute("""
            SELECT nazwa, opis_porcji, produkt_id,
                   MAX(ilosc_g) AS ilosc_g,
                   MAX(kcal) AS kcal, MAX(bialko) AS bialko,
                   MAX(tluszcz) AS tluszcz, MAX(wegle) AS wegle,
                   COUNT(*) AS ile, MAX(data) AS ostatnio
            FROM eat_wpisy
            WHERE household_id=%s AND user_id=%s
              AND data > CURRENT_DATE - INTERVAL '60 days'
            GROUP BY nazwa, opis_porcji, produkt_id
            ORDER BY MAX(data) DESC, COUNT(*) DESC
            LIMIT %s
        """, (household_id, user_id, limit))
        return [dict(r) for r in cur.fetchall()]
