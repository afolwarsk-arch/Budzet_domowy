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
ZRODLA = ("off", "etykieta", "opis", "reczne", "baza")

# Na telefonie nikt nie pisze z ogonkami — „maslo" ma znaleźć „Masło", a „ryz"
# „Ryż". Robimy to własną tablicą zamiast rozszerzenia `unaccent`, bo jego
# instalacja wymaga uprawnień, których na hostingu możemy nie mieć.
_OGONKI = str.maketrans("ąćęłńóśźżĄĆĘŁŃÓŚŹŻ", "acelnoszzACELNOSZZ")


def bez_ogonkow(s: str) -> str:
    return (s or "").translate(_OGONKI).lower().strip()


def _do_like(fraza: str) -> str:
    """Znaki wieloznaczne LIKE trzeba unieszkodliwić — bez tego wpisanie
    samego „%" listowało całą bazę."""
    return bez_ogonkow(fraza).replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")


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
        cur.execute("ALTER TABLE eat_produkty ADD COLUMN IF NOT EXISTS nazwa_szukaj TEXT")
        # Ile sztuk w opakowaniu. Na pudełku pralinek kod kreskowy jest tylko na
        # zbiorczym opakowaniu, a pojedyncza czekoladka nie ma żadnego — więc
        # jedyny sposób, żeby zapisać „zjadłem jedną", to podzielić opakowanie.
        cur.execute("ALTER TABLE eat_produkty ADD COLUMN IF NOT EXISTS sztuk_w_opak INTEGER")
        # Waga JEDNEJ SZTUKI (albo garści, łyżki) i jej nazwa — dla surowców, które
        # nie mają opakowania. Pomidor waży ~120 g i to jest „sztuka", nie „opakowanie":
        # wcześniej ta liczba szła do opak_g i ekran dopisywał warzywu opakowanie,
        # którego nie ma, zamiast dać przycisk „1 sztuka".
        cur.execute("ALTER TABLE eat_produkty ADD COLUMN IF NOT EXISTS porcja_g NUMERIC(7,1)")
        cur.execute("ALTER TABLE eat_produkty ADD COLUMN IF NOT EXISTS opis_porcji TEXT")
        # Ulubione przypina się RĘCZNIE, w odróżnieniu od „ostatnio jadłeś", które
        # zgaduje po dacie. Owsianka jedzona co drugi dzień wypadała z tamtej listy
        # dokładnie w dni, kiedy była potrzebna — tu decyduje człowiek, nie sort.
        cur.execute("ALTER TABLE eat_produkty ADD COLUMN IF NOT EXISTS "
                    "ulubiony BOOLEAN NOT NULL DEFAULT FALSE")
        cur.execute("CREATE INDEX IF NOT EXISTS eat_produkty_szukaj "
                    "ON eat_produkty (household_id, nazwa_szukaj)")
        # Indeks częściowy: ulubionych są jednostki, więc nie ma po co trzymać
        # w indeksie całej bazy produktów gospodarstwa.
        cur.execute("CREATE INDEX IF NOT EXISTS eat_produkty_ulubione "
                    "ON eat_produkty (household_id) WHERE ulubiony")

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
        # Bez tego liczenie uzyc w przegladzie produktow robi pelny skan raz na
        # produkt, a sprawdzenie klucza obcego przy kasowaniu nie ma z czego
        # skorzystac.
        cur.execute("CREATE INDEX IF NOT EXISTS eat_wpisy_produkt "
                    "ON eat_wpisy (produkt_id)")

        # Grupowanie: „kanapka z serem" to pieczywo i ser jako OSOBNE wpisy —
        # każdy z własną gramaturą do poprawienia — ale w dzienniku pokazane
        # pod jedną nazwą. Wpisy bez grupy (zeskanowany produkt) mają tu NULL
        # i zachowują się dokładnie jak dotąd.
        cur.execute("ALTER TABLE eat_wpisy ADD COLUMN IF NOT EXISTS grupa_id TEXT")
        cur.execute("ALTER TABLE eat_wpisy ADD COLUMN IF NOT EXISTS grupa_nazwa TEXT")
        cur.execute("CREATE INDEX IF NOT EXISTS eat_wpisy_grupa "
                    "ON eat_wpisy (household_id, user_id, grupa_id)")
        # Przepis wchodzi do dnia jako JEDEN wpis o nazwie dania — rozbijanie
        # ćwiartki porcji na „31,3 g mięsa mielonego" byłoby szumem. Rozpiska
        # składników mieszka w przepisie, nie w dzienniku.
        #
        # Świadomie BEZ klucza obcego: skasowanie przepisu nie ma prawa ruszyć
        # tego, co już zjedzone. Wpis ma własne, zamrożone wartości i zostaje
        # nietknięty; `przepis_id` służy tylko do podpowiedzi „pokaż przepis",
        # a interfejs radzi sobie z tym, że przepisu już nie ma.
        cur.execute("ALTER TABLE eat_wpisy ADD COLUMN IF NOT EXISTS przepis_id INTEGER")
        cur.execute("ALTER TABLE eat_wpisy ADD COLUMN IF NOT EXISTS porcje_zjedzone NUMERIC(6,2)")
        # Rozpiska składników ZAMROŻONA w chwili zjedzenia — dokładnie tak, jak
        # kalorie i makro. Podglądając w dzienniku „bigos" masz zobaczyć, co
        # było w tym konkretnym talerzu, nawet jeśli przepis został potem
        # poprawiony albo skasowany. Odczytywanie ich z przepisu na żywo
        # pokazywałoby historię, której nigdy nie było.
        cur.execute("ALTER TABLE eat_wpisy ADD COLUMN IF NOT EXISTS skladniki_json TEXT")

        # Produkty podstawowe — WSPÓLNE dla wszystkich gospodarstw, zasiane
        # z listy w kodzie. Open Food Facts nie ma surowców (zapytanie o pomidor
        # zwraca sok, krakersy i chipsy o smaku pomidora) i do tego odbija
        # trzy czwarte anonimowych zapytań błędem 503. Ta tabela jest jedyną
        # drogą, która odpowiada zawsze.
        cur.execute("""CREATE TABLE IF NOT EXISTS eat_produkty_bazowe (
            id        SERIAL PRIMARY KEY,
            nazwa     TEXT NOT NULL UNIQUE,
            kategoria TEXT NOT NULL DEFAULT '',
            kcal      NUMERIC(7,1) NOT NULL,
            bialko    NUMERIC(7,1),
            tluszcz   NUMERIC(7,1),
            wegle     NUMERIC(7,1),
            porcja_g  NUMERIC(7,1),
            opis_porcji TEXT,
            nazwa_szukaj TEXT
        )""")
        cur.execute("ALTER TABLE eat_produkty_bazowe ADD COLUMN IF NOT EXISTS nazwa_szukaj TEXT")
        cur.execute("CREATE INDEX IF NOT EXISTS eat_bazowe_szukaj "
                    "ON eat_produkty_bazowe (nazwa_szukaj)")
        _zasiej_produkty_bazowe(cur)

        # Pamięć podręczna wyszukiwań w Open Food Facts. Ich serwer odbija
        # większość anonimowych zapytań, a skład produktu nie zmienia się z
        # godziny na godzinę — powtórzone wpisanie tej samej frazy nie ma
        # powodu tam wracać.
        cur.execute("""CREATE TABLE IF NOT EXISTS eat_off_cache (
            fraza   TEXT PRIMARY KEY,
            wynik   TEXT NOT NULL,
            pobrano TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")

        # Cel dzienny — per OSOBA, nie per gospodarstwo. Zapotrzebowanie Adama
        # i Oli to dwie różne liczby, nawet jeśli dziennik jest wspólny.
        cur.execute("""CREATE TABLE IF NOT EXISTS eat_cele (
            user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            kcal     INTEGER NOT NULL DEFAULT 2000,
            bialko   INTEGER NOT NULL DEFAULT 100,
            tluszcz  INTEGER NOT NULL DEFAULT 65,
            wegle    INTEGER NOT NULL DEFAULT 250
        )""")

        # Przepisy — WSPÓLNE dla gospodarstwa, tak jak reszta modułu.
        #
        # Wartości to sumy CAŁEGO dania z surowych składników. Kalorie się nie
        # gotują: woda nie dodaje energii, zmienia się tylko masa. Dlatego
        # „suma ÷ liczba porcji" jest dokładne i nie wymaga ważenia czegokolwiek
        # po ugotowaniu. `waga_gotowego_g` jest opcjonalna i służy wyłącznie
        # tym, którzy chcą odmierzać porcję na wadze zamiast na oko.
        cur.execute("""CREATE TABLE IF NOT EXISTS eat_przepisy (
            id              SERIAL PRIMARY KEY,
            household_id    INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            autor_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
            nazwa           TEXT NOT NULL,
            nazwa_szukaj    TEXT,
            opis            TEXT,
            porcje          NUMERIC(5,2) NOT NULL DEFAULT 1,
            waga_gotowego_g NUMERIC(8,1),
            kcal            NUMERIC(9,1) NOT NULL DEFAULT 0,
            bialko          NUMERIC(8,1) NOT NULL DEFAULT 0,
            tluszcz         NUMERIC(8,1) NOT NULL DEFAULT 0,
            wegle           NUMERIC(8,1) NOT NULL DEFAULT 0,
            uzyc            INTEGER NOT NULL DEFAULT 0,
            created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        cur.execute("CREATE INDEX IF NOT EXISTS eat_przepisy_dom "
                    "ON eat_przepisy (household_id, uzyc DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS eat_przepisy_szukaj "
                    "ON eat_przepisy (household_id, nazwa_szukaj)")

        # Składniki trzymamy osobno, żeby przepis dało się otworzyć i poprawić.
        # Wartości też są zamrożone — poprawienie produktu w bazie nie ma po
        # cichu zmieniać kaloryczności dania, które ktoś już zatwierdził.
        cur.execute("""CREATE TABLE IF NOT EXISTS eat_przepis_skladniki (
            id         SERIAL PRIMARY KEY,
            przepis_id INTEGER NOT NULL REFERENCES eat_przepisy(id) ON DELETE CASCADE,
            produkt_id INTEGER REFERENCES eat_produkty(id) ON DELETE SET NULL,
            nazwa      TEXT NOT NULL,
            ilosc_g    NUMERIC(8,1) NOT NULL,
            kcal       NUMERIC(8,1) NOT NULL DEFAULT 0,
            bialko     NUMERIC(7,1) NOT NULL DEFAULT 0,
            tluszcz    NUMERIC(7,1) NOT NULL DEFAULT 0,
            wegle      NUMERIC(7,1) NOT NULL DEFAULT 0,
            kolejnosc  INTEGER NOT NULL DEFAULT 0
        )""")
        cur.execute("CREATE INDEX IF NOT EXISTS eat_skladniki_przepis "
                    "ON eat_przepis_skladniki (przepis_id, kolejnosc)")


def _zasiej_produkty_bazowe(cur) -> None:
    """Dosypuje brakujące pozycje. Nie nadpisuje istniejących — gdyby ktoś
    kiedyś poprawił wartość w bazie, kolejne wdrożenie jej nie cofnie."""
    from eat_baza import PRODUKTY_BAZOWE
    for nazwa, kategoria, kcal, b, t, w, porcja, opis in PRODUKTY_BAZOWE:
        cur.execute("""
            INSERT INTO eat_produkty_bazowe
                (nazwa, kategoria, kcal, bialko, tluszcz, wegle, porcja_g, opis_porcji, nazwa_szukaj)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (nazwa) DO UPDATE SET nazwa_szukaj = EXCLUDED.nazwa_szukaj
        """, (nazwa, kategoria, kcal, b, t, w, porcja, opis, bez_ogonkow(nazwa)))


def cache_off_pobierz(fraza: str, wazne_dni: int = 14) -> list | None:
    """Wynik wyszukiwania w Open Food Facts sprzed najwyżej dwóch tygodni.

    Bez tego drugie wpisanie tej samej frazy znowu trafiało w limit zapytań —
    a skład produktu nie zmienia się z godziny na godzinę."""
    import json as _json
    with get_db() as cur:
        cur.execute("""SELECT wynik FROM eat_off_cache
                       WHERE fraza=%s AND pobrano > NOW() - make_interval(days => %s)""",
                    (fraza.lower(), int(wazne_dni)))
        row = cur.fetchone()
    if not row:
        return None
    try:
        return _json.loads(row["wynik"])
    except Exception:
        return None


def cache_off_zapisz(fraza: str, wynik: list) -> None:
    """Pustego wyniku NIE zapamietujemy. Open Food Facts potrafi oddac 200 z
    pusta lista przy swoim chwilowym problemie — zapisanie tego na dwa tygodnie
    ukrywaloby produkt, ktory istnieje."""
    if not wynik:
        return
    import json as _json
    with get_db() as cur:
        cur.execute("""
            INSERT INTO eat_off_cache (fraza, wynik, pobrano)
            VALUES (%s,%s,NOW())
            ON CONFLICT (fraza) DO UPDATE SET wynik=EXCLUDED.wynik, pobrano=NOW()
        """, (fraza.lower(), _json.dumps(wynik, ensure_ascii=False)))


def szukaj_bazowych(fraza: str, limit: int = 15) -> list[dict]:
    """Produkty zaczynające się od frazy idą przed tymi, które ją tylko zawierają
    — wpisanie „ser" ma pokazać ser, a nie „deser"."""
    szukana = _do_like(fraza)
    with get_db() as cur:
        cur.execute("""
            SELECT * FROM eat_produkty_bazowe
            WHERE nazwa_szukaj LIKE %s ESCAPE '\'
            ORDER BY (nazwa_szukaj LIKE %s ESCAPE '\') DESC, length(nazwa), nazwa
            LIMIT %s
        """, (f"%{szukana}%", f"{szukana}%", limit))
        return [dict(r) for r in cur.fetchall()]


def bazowy_po_id(bazowy_id: int) -> dict | None:
    with get_db() as cur:
        cur.execute("SELECT * FROM eat_produkty_bazowe WHERE id=%s", (bazowy_id,))
        row = cur.fetchone()
    return dict(row) if row else None


# ── cele ────────────────────────────────────────────────────────────────────

_CELE_DOMYSLNE = {"kcal": 2000, "bialko": 100, "tluszcz": 65, "wegle": 250}


def get_cele(user_id: int) -> dict:
    """Brak wiersza = wartości domyślne. Nie zakładamy rekordu na zapas, żeby
    nie udawać, że użytkownik coś ustawił."""
    with get_db() as cur:
        cur.execute("SELECT kcal, bialko, tluszcz, wegle FROM eat_cele WHERE user_id=%s", (user_id,))
        row = cur.fetchone()
    return dict(row) if row else dict(_CELE_DOMYSLNE)


def ma_wlasny_cel(user_id: int) -> bool:
    """Czy użytkownik cokolwiek ustawił. Bez tego interfejs nie odróżniał
    „wybrałem 2000" od „nikt nic nie ustawił", a paski pierwszego dnia udawały
    realny cel."""
    with get_db() as cur:
        cur.execute("SELECT 1 FROM eat_cele WHERE user_id=%s", (user_id,))
        return cur.fetchone() is not None


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
        cur.execute(r"""SELECT * FROM eat_produkty
                       WHERE household_id=%s
                         AND COALESCE(nazwa_szukaj, lower(nazwa)) LIKE %s ESCAPE '\'
                       ORDER BY nazwa LIMIT %s""",
                    (household_id, f"%{_do_like(fraza)}%", limit))
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


def produkt_po_id(produkt_id: int, household_id: int) -> dict | None:
    """Pojedynczy produkt. Potrzebny przy powtórce z „ostatnio jadłeś": wpis zna
    tylko zjedzoną gramaturę, a ekran porcji potrzebuje jeszcze wielkości
    opakowania i liczby sztuk, żeby zaproponować „całe opak." czy „1 szt."."""
    with get_db() as cur:
        cur.execute("SELECT * FROM eat_produkty WHERE id=%s AND household_id=%s",
                    (produkt_id, household_id))
        row = cur.fetchone()
        return dict(row) if row else None


def ustaw_ulubiony(produkt_id: int, household_id: int, wartosc: bool) -> dict | None:
    """Przypina albo odpina produkt. Zwraca cały wiersz, żeby ekran nie musiał
    zgadywać stanu po udanej odpowiedzi."""
    with get_db() as cur:
        cur.execute("UPDATE eat_produkty SET ulubiony=%s WHERE id=%s AND household_id=%s "
                    "RETURNING *", (bool(wartosc), produkt_id, household_id))
        row = cur.fetchone()
        return dict(row) if row else None


def ulubione(household_id: int, limit: int = 20) -> list[dict]:
    """Przypięte produkty gospodarstwa — wspólne, nie per użytkownik. Jedna baza
    produktów obsługuje cały dom, więc i przypięcia są wspólne."""
    with get_db() as cur:
        cur.execute("""SELECT * FROM eat_produkty
                       WHERE household_id=%s AND ulubiony
                       ORDER BY nazwa LIMIT %s""", (household_id, limit))
        return [dict(r) for r in cur.fetchall()]


def zapisz_produkt(household_id: int, dane: dict) -> dict:
    """Dokłada produkt do bazy gospodarstwa. Przy powtórzonym kodzie odświeża
    wartości zamiast tworzyć duplikat."""
    pola = ("kod", "nazwa", "marka", "opak_g", "kcal", "bialko", "tluszcz",
            "wegle", "blonnik", "cukry", "sol", "zrodlo", "sztuk_w_opak",
            "porcja_g", "opis_porcji")
    w = {p: dane.get(p) for p in pola}
    w["zrodlo"] = w["zrodlo"] if w["zrodlo"] in ZRODLA else "reczne"

    # Dane z Open Food Facts wpisują ludzie, a etykiety czyta model — w obu
    # źródłach trafiają się wartości bez sensu (kJ w polu kcal, wartości „na
    # opakowanie" podane jako „na 100 g", liczba jako tekst). Bez tego filtra
    # jeden taki rekord przekraczał zakres kolumny NUMERIC i zamieniał się w
    # błąd 500, a użytkownik widział tylko „nie udało się sprawdzić kodu".
    def _liczba(v, maks):
        if v is None:
            return None
        try:
            f = float(str(v).replace(",", ".").strip())
        except (TypeError, ValueError):
            return None
        if f != f or f in (float("inf"), float("-inf")) or f < 0:
            return None
        return round(min(f, maks), 2)

    for p, maks in (("opak_g", 99999), ("kcal", 9999), ("bialko", 999),
                    ("tluszcz", 999), ("wegle", 999), ("blonnik", 999),
                    ("cukry", 999), ("sol", 999), ("porcja_g", 5000)):
        w[p] = _liczba(w[p], maks)
    w["opis_porcji"] = (str(w["opis_porcji"]).strip()[:40] or None) if w["opis_porcji"] else None

    w["nazwa"] = (str(w["nazwa"]).strip() if w["nazwa"] else "")[:120] or "Produkt bez nazwy"
    w["marka"] = (str(w["marka"]).strip()[:80] or None) if w["marka"] else None
    w["kod"] = (str(w["kod"]).strip()[:20] or None) if w["kod"] else None
    if w["kcal"] is None:
        w["kcal"] = 0        # kolumna jest NOT NULL; zero to poprawna wartość dla wody
    # Liczba sztuk musi byc sensowna: 0 dzieliloby przez zero, a tysiac pralinek
    # w pudelku to blad odczytu, nie produkt.
    sztuk = w.get("sztuk_w_opak")
    try:
        sztuk = int(float(str(sztuk).replace(",", "."))) if sztuk not in (None, "") else None
    except (TypeError, ValueError):
        sztuk = None
    w["sztuk_w_opak"] = sztuk if sztuk and 2 <= sztuk <= 200 else None
    w["nazwa_szukaj"] = bez_ogonkow(w["nazwa"])
    with get_db() as cur:
        if w["kod"]:
            cur.execute("""
                INSERT INTO eat_produkty (household_id, kod, nazwa, marka, opak_g, kcal,
                                          bialko, tluszcz, wegle, blonnik, cukry, sol, zrodlo,
                                          nazwa_szukaj, sztuk_w_opak, porcja_g, opis_porcji)
                VALUES (%(h)s,%(kod)s,%(nazwa)s,%(marka)s,%(opak_g)s,%(kcal)s,
                        %(bialko)s,%(tluszcz)s,%(wegle)s,%(blonnik)s,%(cukry)s,%(sol)s,%(zrodlo)s,
                        %(nazwa_szukaj)s,%(sztuk_w_opak)s,%(porcja_g)s,%(opis_porcji)s)
                -- WHERE kod IS NOT NULL jest KONIECZNE: indeks unikalny jest
                -- częściowy (ten sam warunek), a Postgres bez powtórzenia
                -- predykatu nie potrafi go dopasować i przerywa błędem. Przez to
                -- każdy zapis produktu z kodem kreskowym kończył się błędem 500,
                -- a skanowanie zwracało „nie udało się sprawdzić kodu".
                ON CONFLICT (household_id, kod) WHERE kod IS NOT NULL DO UPDATE
                   SET nazwa=EXCLUDED.nazwa, nazwa_szukaj=EXCLUDED.nazwa_szukaj,
                       zrodlo=EXCLUDED.zrodlo, marka=EXCLUDED.marka, opak_g=EXCLUDED.opak_g,
                       kcal=EXCLUDED.kcal, bialko=EXCLUDED.bialko, tluszcz=EXCLUDED.tluszcz,
                       wegle=EXCLUDED.wegle, blonnik=EXCLUDED.blonnik, cukry=EXCLUDED.cukry,
                       sol=EXCLUDED.sol,
                       -- Liczby sztuk nie kasujemy, gdy nowy odczyt jej nie widzi:
                       -- tabela z tylu opakowania jej nie zawiera, a przod tak.
                       sztuk_w_opak=COALESCE(EXCLUDED.sztuk_w_opak, eat_produkty.sztuk_w_opak),
                       -- Ta sama zasada dla wagi sztuki: raz ustalona („pomidor ~120 g")
                       -- ma przetrwac ponowne zeskanowanie kodu.
                       porcja_g=COALESCE(EXCLUDED.porcja_g, eat_produkty.porcja_g),
                       opis_porcji=COALESCE(EXCLUDED.opis_porcji, eat_produkty.opis_porcji)
                RETURNING *
            """, {"h": household_id, **w})
        else:
            cur.execute("""
                INSERT INTO eat_produkty (household_id, nazwa, marka, opak_g, kcal,
                                          bialko, tluszcz, wegle, blonnik, cukry, sol, zrodlo,
                                          nazwa_szukaj, sztuk_w_opak, porcja_g, opis_porcji)
                VALUES (%(h)s,%(nazwa)s,%(marka)s,%(opak_g)s,%(kcal)s,
                        %(bialko)s,%(tluszcz)s,%(wegle)s,%(blonnik)s,%(cukry)s,%(sol)s,%(zrodlo)s,
                        %(nazwa_szukaj)s,%(sztuk_w_opak)s,%(porcja_g)s,%(opis_porcji)s)
                RETURNING *
            """, {"h": household_id, **w})
        return dict(cur.fetchone())


def ustaw_sztuk_w_opak(produkt_id: int, household_id: int, sztuk: int | None) -> dict | None:
    with get_db() as cur:
        cur.execute("""UPDATE eat_produkty SET sztuk_w_opak=%s
                       WHERE id=%s AND household_id=%s RETURNING *""",
                    (sztuk, produkt_id, household_id))
        row = cur.fetchone()
        return dict(row) if row else None


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


_POLA_WPISU = ("data", "posilek", "produkt_id", "nazwa", "opis_porcji", "ilosc_g",
               "kcal", "bialko", "tluszcz", "wegle",
               "grupa_id", "grupa_nazwa", "przepis_id", "porcje_zjedzone",
               "skladniki_json")


def dodaj_wpis(household_id: int, user_id: int, dane: dict) -> dict:
    # Pola nieobowiązkowe (grupa, przepis) uzupełniamy None-ami, żeby wywołania
    # sprzed grupowania działały bez zmian.
    d = {k: dane.get(k) for k in _POLA_WPISU}
    with get_db() as cur:
        cur.execute("""
            INSERT INTO eat_wpisy (household_id, user_id, data, posilek, produkt_id,
                                   nazwa, opis_porcji, ilosc_g, kcal, bialko, tluszcz, wegle,
                                   grupa_id, grupa_nazwa, przepis_id, porcje_zjedzone,
                                   skladniki_json)
            VALUES (%(h)s,%(u)s,%(data)s,%(posilek)s,%(produkt_id)s,
                    %(nazwa)s,%(opis_porcji)s,%(ilosc_g)s,%(kcal)s,%(bialko)s,%(tluszcz)s,%(wegle)s,
                    %(grupa_id)s,%(grupa_nazwa)s,%(przepis_id)s,%(porcje_zjedzone)s,
                    %(skladniki_json)s)
            RETURNING *
        """, {"h": household_id, "u": user_id, **d})
        return dict(cur.fetchone())


def usun_grupe(grupa_id: str, household_id: int, user_id: int) -> int:
    """Kasuje całą grupę naraz — po rozłożeniu „kanapki z serem" na składniki
    nikt nie chce usuwać ich pojedynczo."""
    with get_db() as cur:
        cur.execute("DELETE FROM eat_wpisy WHERE grupa_id=%s AND household_id=%s AND user_id=%s",
                    (grupa_id, household_id, user_id))
        return cur.rowcount


def get_grupe(grupa_id: str, household_id: int, user_id: int) -> list[dict]:
    with get_db() as cur:
        cur.execute("""SELECT * FROM eat_wpisy
                       WHERE grupa_id=%s AND household_id=%s AND user_id=%s
                       ORDER BY id""", (grupa_id, household_id, user_id))
        return [dict(r) for r in cur.fetchall()]


def get_wpis(wpis_id: int, household_id: int, user_id: int) -> dict | None:
    with get_db() as cur:
        cur.execute("SELECT * FROM eat_wpisy WHERE id=%s AND household_id=%s AND user_id=%s",
                    (wpis_id, household_id, user_id))
        row = cur.fetchone()
        return dict(row) if row else None


def aktualizuj_wpis(wpis_id: int, household_id: int, user_id: int, dane: dict) -> dict | None:
    """Poprawka istniejącego wpisu — najczęściej gramatury.

    `produkt_id` zostaje bez zmian: pozycja ma nadal wskazywać na ten sam
    produkt, nawet jeśli poprawiłeś jej wartości ręcznie. Ta sama zasada co
    przy kasowaniu — ruszać można wyłącznie własne wpisy."""
    # Wpis z przepisu niesie jeszcze liczbę zjedzonych porcji i ZAMROŻONĄ
    # rozpiskę składników. Gdy zmienia się ilość, muszą iść razem z resztą —
    # inaczej dziennik pokazywał dwie porcje, a rozpiska pod nimi dalej opisywała
    # jedną. Pola są opcjonalne, więc zwykła poprawka gramatury działa jak dotąd.
    extra, wartosci = "", {"id": wpis_id, "h": household_id, "u": user_id, **dane}
    if "porcje_zjedzone" in dane:
        extra += ", porcje_zjedzone=%(porcje_zjedzone)s"
    if "skladniki_json" in dane:
        extra += ", skladniki_json=%(skladniki_json)s"
    with get_db() as cur:
        cur.execute(f"""
            UPDATE eat_wpisy
               SET posilek=%(posilek)s, nazwa=%(nazwa)s, opis_porcji=%(opis_porcji)s,
                   ilosc_g=%(ilosc_g)s, kcal=%(kcal)s, bialko=%(bialko)s,
                   tluszcz=%(tluszcz)s, wegle=%(wegle)s{extra}
             WHERE id=%(id)s AND household_id=%(h)s AND user_id=%(u)s
            RETURNING *
        """, wartosci)
        row = cur.fetchone()
        return dict(row) if row else None


def usun_wpis(wpis_id: int, household_id: int, user_id: int) -> bool:
    """Kasować można tylko własne wpisy — dziennik jest wspólny do oglądania,
    ale nie do poprawiania po kimś."""
    with get_db() as cur:
        cur.execute("DELETE FROM eat_wpisy WHERE id=%s AND household_id=%s AND user_id=%s",
                    (wpis_id, household_id, user_id))
        return cur.rowcount > 0


def ostatnio_jadl(household_id: int, user_id: int, limit: int = 12) -> list[dict]:
    """Lista „ostatnio jadłeś" — to ona ma pokrywać większość wpisów.

    Wartości bierzemy z NAJNOWSZEGO wpisu w grupie, a nie z osobnych MAX() po
    każdej kolumnie. Wcześniej gramatura mogła pochodzić z jednego wpisu, a
    białko z innego — i jednym stuknięciem zapisywało się coś, czego nigdy nie
    było w dzienniku."""
    with get_db() as cur:
        cur.execute("""
            SELECT DISTINCT ON (nazwa, opis_porcji, produkt_id)
                   nazwa, opis_porcji, produkt_id, ilosc_g,
                   kcal, bialko, tluszcz, wegle, data AS ostatnio,
                   COUNT(*) OVER (PARTITION BY nazwa, opis_porcji, produkt_id) AS ile
            FROM eat_wpisy
            WHERE household_id=%s AND user_id=%s
              AND data > CURRENT_DATE - INTERVAL '60 days'
              -- Dania z przepisu mają własną zakładkę, posortowaną po liczbie
              -- użyć. Tutaj tylko zaśmiecałyby listę pozycją, która po
              -- stuknięciu straciłaby powiązanie z porcjami.
              AND przepis_id IS NULL
            ORDER BY nazwa, opis_porcji, produkt_id, data DESC, id DESC
        """, (household_id, user_id))
        wiersze = [dict(r) for r in cur.fetchall()]
    # najpierw najświeższe, przy remisie częściej powtarzane
    wiersze.sort(key=lambda w: (w["ostatnio"], w["ile"]), reverse=True)
    return wiersze[:limit]


# ── przepisy ────────────────────────────────────────────────────────────────

def lista_przepisow(household_id: int, fraza: str = "") -> list[dict]:
    """Najczęściej używane na górze. Po miesiącu kilka dań robi większość
    wpisów i mają być pod ręką, a nie w połowie alfabetu."""
    warunki, params = ["household_id=%s"], [household_id]
    if fraza and len(fraza.strip()) >= 2:
        warunki.append(r"nazwa_szukaj LIKE %s ESCAPE '\'")
        params.append(f"%{_do_like(fraza)}%")
    with get_db() as cur:
        cur.execute(f"""SELECT * FROM eat_przepisy WHERE {' AND '.join(warunki)}
                        ORDER BY uzyc DESC, nazwa LIMIT 200""", params)
        return [dict(r) for r in cur.fetchall()]


def get_przepis(przepis_id: int, household_id: int) -> dict | None:
    with get_db() as cur:
        cur.execute("SELECT * FROM eat_przepisy WHERE id=%s AND household_id=%s",
                    (przepis_id, household_id))
        row = cur.fetchone()
        if not row:
            return None
        przepis = dict(row)
        cur.execute("""SELECT * FROM eat_przepis_skladniki WHERE przepis_id=%s
                       ORDER BY kolejnosc, id""", (przepis_id,))
        przepis["skladniki"] = [dict(r) for r in cur.fetchall()]
        # Masa, względem której liczymy porcję odmierzoną na wadze. Przy sałatce
        # czy kanapce nic nie odparowuje, więc gotowe danie waży dokładnie tyle,
        # co suma składników — i to jest domyślna odpowiedź. Wagę wpisuje się
        # ręcznie tylko wtedy, gdy danie się gotuje i traci wodę.
        suma = round(sum(float(s["ilosc_g"] or 0) for s in przepis["skladniki"]), 1)
        przepis["suma_skladnikow_g"] = suma
        przepis["waga_odniesienia_g"] = (
            float(przepis["waga_gotowego_g"]) if przepis["waga_gotowego_g"] else suma)
        return przepis


def _zapisz_skladniki(cur, przepis_id: int, skladniki: list[dict]) -> dict:
    """Wymienia składniki w całości i zwraca przeliczone sumy dania."""
    cur.execute("DELETE FROM eat_przepis_skladniki WHERE przepis_id=%s", (przepis_id,))
    sumy = {"kcal": 0.0, "bialko": 0.0, "tluszcz": 0.0, "wegle": 0.0}
    for i, s in enumerate(skladniki):
        cur.execute("""
            INSERT INTO eat_przepis_skladniki
                (przepis_id, produkt_id, nazwa, ilosc_g, kcal, bialko, tluszcz, wegle, kolejnosc)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (przepis_id, s.get("produkt_id"), s["nazwa"], s["ilosc_g"],
              s["kcal"], s["bialko"], s["tluszcz"], s["wegle"], i))
        for k in sumy:
            sumy[k] += float(s.get(k) or 0)
    return {k: round(v, 1) for k, v in sumy.items()}


def zapisz_przepis(household_id: int, autor_id: int, dane: dict,
                   przepis_id: int | None = None) -> dict:
    """Tworzy albo nadpisuje przepis wraz ze składnikami.

    Sumy liczy SERWER ze składników — przeglądarka nie ma prawa podać własnej
    kaloryczności dania, tak samo jak przy wpisach do dziennika."""
    with get_db() as cur:
        pola = {
            "nazwa": dane["nazwa"], "nazwa_szukaj": bez_ogonkow(dane["nazwa"]),
            "opis": dane.get("opis"), "porcje": dane["porcje"],
            "waga": dane.get("waga_gotowego_g"),
        }
        if przepis_id:
            cur.execute("""UPDATE eat_przepisy SET nazwa=%(nazwa)s, nazwa_szukaj=%(nazwa_szukaj)s,
                                  opis=%(opis)s, porcje=%(porcje)s, waga_gotowego_g=%(waga)s
                           WHERE id=%(id)s AND household_id=%(h)s RETURNING id""",
                        {**pola, "id": przepis_id, "h": household_id})
            if not cur.fetchone():
                return None
        else:
            cur.execute("""INSERT INTO eat_przepisy
                               (household_id, autor_id, nazwa, nazwa_szukaj, opis, porcje, waga_gotowego_g)
                           VALUES (%(h)s,%(a)s,%(nazwa)s,%(nazwa_szukaj)s,%(opis)s,%(porcje)s,%(waga)s)
                           RETURNING id""",
                        {**pola, "h": household_id, "a": autor_id})
            przepis_id = cur.fetchone()["id"]

        sumy = _zapisz_skladniki(cur, przepis_id, dane.get("skladniki") or [])
        cur.execute("""UPDATE eat_przepisy SET kcal=%s, bialko=%s, tluszcz=%s, wegle=%s
                       WHERE id=%s""",
                    (sumy["kcal"], sumy["bialko"], sumy["tluszcz"], sumy["wegle"], przepis_id))
    return get_przepis(przepis_id, household_id)


def usun_przepis(przepis_id: int, household_id: int) -> bool:
    """Skasowanie przepisu NIE rusza tego, co już zjedzone — wpisy w dzienniku
    mają własne, zamrożone wartości i nie ma na nich klucza obcego."""
    with get_db() as cur:
        cur.execute("DELETE FROM eat_przepisy WHERE id=%s AND household_id=%s",
                    (przepis_id, household_id))
        return cur.rowcount > 0


def policz_uzycie(przepis_id: int, household_id: int) -> None:
    with get_db() as cur:
        cur.execute("UPDATE eat_przepisy SET uzyc = uzyc + 1 WHERE id=%s AND household_id=%s",
                    (przepis_id, household_id))
