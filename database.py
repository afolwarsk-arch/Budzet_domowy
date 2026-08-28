import json
import os
import re
import threading
from contextlib import contextmanager

import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ["DATABASE_URL"]

SCHEMA_STATEMENTS = [
    """CREATE TABLE IF NOT EXISTS households (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS users (
        id           SERIAL PRIMARY KEY,
        firebase_uid TEXT UNIQUE NOT NULL,
        email        TEXT NOT NULL,
        name         TEXT NOT NULL DEFAULT '',
        picture      TEXT DEFAULT '',
        display_name TEXT,
        last_login   TIMESTAMP,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS memberships (
        user_id      INTEGER NOT NULL REFERENCES users(id),
        household_id INTEGER NOT NULL REFERENCES households(id),
        role         TEXT NOT NULL DEFAULT 'member',
        PRIMARY KEY (user_id, household_id)
    )""",
    """CREATE TABLE IF NOT EXISTS invitations (
        id           SERIAL PRIMARY KEY,
        code         TEXT UNIQUE NOT NULL,
        household_id INTEGER NOT NULL REFERENCES households(id),
        created_by   INTEGER NOT NULL REFERENCES users(id),
        expires_at   TIMESTAMP NOT NULL,
        used         INTEGER NOT NULL DEFAULT 0,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS wydatki (
        id           SERIAL PRIMARY KEY,
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
    )""",
    """CREATE TABLE IF NOT EXISTS pozycje (
        id                SERIAL PRIMARY KEY,
        wydatek_id        INTEGER NOT NULL REFERENCES wydatki(id) ON DELETE CASCADE,
        nazwa             TEXT NOT NULL,
        cena              REAL NOT NULL,
        ilosc             REAL NOT NULL DEFAULT 1,
        kategoria_glowna  TEXT NOT NULL DEFAULT 'Inne',
        kategoria         TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS api_usage (
        id           SERIAL PRIMARY KEY,
        household_id INTEGER REFERENCES households(id),
        endpoint     TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS virtual_members (
        id           SERIAL PRIMARY KEY,
        household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS analiza_state (
        id           SERIAL PRIMARY KEY,
        household_id INTEGER NOT NULL UNIQUE REFERENCES households(id),
        groups_json  TEXT NOT NULL DEFAULT '[]',
        pool_json    TEXT NOT NULL DEFAULT '[]',
        updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS konta (
        id               SERIAL PRIMARY KEY,
        household_id     INTEGER NOT NULL REFERENCES households(id),
        nazwa            TEXT NOT NULL,
        typ              TEXT NOT NULL DEFAULT 'bank',
        osoba            TEXT,
        waluta           TEXT NOT NULL DEFAULT 'PLN',
        saldo_poczatkowe NUMERIC(12,2) NOT NULL DEFAULT 0,
        aktywne          BOOLEAN NOT NULL DEFAULT TRUE,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS wplywy (
        id           SERIAL PRIMARY KEY,
        household_id INTEGER NOT NULL REFERENCES households(id),
        data         DATE NOT NULL,
        kwota        NUMERIC(12,2) NOT NULL,
        osoba        TEXT,
        kategoria    TEXT NOT NULL DEFAULT 'Inne',
        opis         TEXT,
        konto_id     INTEGER REFERENCES konta(id) ON DELETE SET NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS inwentaryzacje (
        id                SERIAL PRIMARY KEY,
        konto_id          INTEGER NOT NULL REFERENCES konta(id) ON DELETE CASCADE,
        data              DATE NOT NULL,
        saldo_rzeczywiste NUMERIC(12,2) NOT NULL,
        saldo_obliczone   NUMERIC(12,2) NOT NULL,
        roznica           NUMERIC(12,2) NOT NULL,
        notatki           TEXT,
        created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS konto_domyslne (
        user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        konto_id INTEGER NOT NULL REFERENCES konta(id) ON DELETE CASCADE
    )""",
    """CREATE TABLE IF NOT EXISTS household_kategorie (
        household_id   INTEGER PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
        hierarchia_json TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS przelewy (
        id           SERIAL PRIMARY KEY,
        household_id INTEGER NOT NULL REFERENCES households(id),
        data         DATE NOT NULL,
        kwota        NUMERIC(12,2) NOT NULL,
        konto_z_id   INTEGER REFERENCES konta(id) ON DELETE SET NULL,
        konto_na_id  INTEGER REFERENCES konta(id) ON DELETE SET NULL,
        opis         TEXT,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE IF NOT EXISTS wydatki_cykliczne (
        id               SERIAL PRIMARY KEY,
        household_id     INTEGER NOT NULL REFERENCES households(id),
        nazwa            TEXT NOT NULL,
        kwota            NUMERIC(12,2) NOT NULL,
        dzien            INTEGER NOT NULL DEFAULT 1,
        kategoria_glowna TEXT NOT NULL DEFAULT 'Rozrywka i hobby',
        kategoria        TEXT NOT NULL DEFAULT 'Subskrypcje',
        osoba            TEXT NOT NULL,
        konto_id         INTEGER REFERENCES konta(id) ON DELETE SET NULL,
        od_miesiaca      DATE NOT NULL,
        limit_naliczen   INTEGER,
        aktywne          BOOLEAN NOT NULL DEFAULT TRUE,
        ostatnio_do      DATE,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""",
]

_MIGRACJA_MAP: dict[str, tuple[str, str]] = {
    "Jedzenie":                    ("Spożywcze", "Produkty sypkie i przetwory"),
    "Higiena i kosmetyki":         ("Higiena i kosmetyki", "Higiena osobista"),
    "Dom i gospodarstwo":          ("Dom i wyposażenie", "Artykuły do domu"),
    "Dom i wyposażenie":           ("Dom i wyposażenie", "Artykuły do domu"),
    "Transport":                   ("Transport i paliwo", "Paliwo"),
    "Transport i paliwo":          ("Transport i paliwo", "Paliwo"),
    "Zdrowie i leki":              ("Zdrowie", "Leki"),
    "Odzież i obuwie":             ("Odzież i obuwie", "Odzież dorosłych"),
    "Rozrywka":                    ("Rozrywka i hobby", "Kino, teatr i kultura"),
    "Rozrywka i hobby":            ("Rozrywka i hobby", "Kino, teatr i kultura"),
    "Edukacja":                    ("Edukacja", "Kursy i szkolenia"),
    "Elektronika":                 ("Elektronika", "Sprzęt elektroniczny"),
    "Owoce i warzywa":             ("Spożywcze", "Owoce"),
    "Nabiał i jaja":               ("Spożywcze", "Nabiał i jaja"),
    "Mięso i wędliny":             ("Spożywcze", "Wędliny i gotowe mięso"),
    "Pieczywo i wypieki":          ("Spożywcze", "Pieczywo i wypieki"),
    "Napoje":                      ("Spożywcze", "Napoje"),
    "Słodycze i przekąski":        ("Spożywcze", "Słodycze i przekąski"),
    "Produkty spożywcze":          ("Spożywcze", "Produkty sypkie i przetwory"),
    "Higiena osobista":            ("Higiena i kosmetyki", "Higiena osobista"),
    "Kosmetyki i pielęgnacja":     ("Higiena i kosmetyki", "Kosmetyki i pielęgnacja"),
    "Chemia domowa":               ("Higiena i kosmetyki", "Chemia domowa"),
    "AGD i RTV":                   ("Dom i wyposażenie", "AGD i RTV"),
    "Meble i dekoracje":           ("Dom i wyposażenie", "Meble i dekoracje"),
    "Narzędzia i majsterkowanie":  ("Dom i wyposażenie", "Narzędzia i majsterkowanie"),
    "Inne domowe":                 ("Dom i wyposażenie", "Artykuły do domu"),
    "Paliwo":                      ("Transport i paliwo", "Paliwo"),
    "Parking i autostrady":        ("Transport i paliwo", "Parking i autostrady"),
    "Transport publiczny":         ("Transport i paliwo", "Transport publiczny"),
    "Serwis i części":             ("Transport i paliwo", "Serwis i części"),
    "Leki":                        ("Zdrowie", "Leki"),
    "Suplementy i witaminy":       ("Zdrowie", "Suplementy i witaminy"),
    "Badania i wizyty":            ("Zdrowie", "Badania i wizyty"),
    "Odzież":                      ("Odzież i obuwie", "Odzież dorosłych"),
    "Obuwie":                      ("Odzież i obuwie", "Obuwie"),
    "Akcesoria":                   ("Odzież i obuwie", "Akcesoria"),
    "Sport i fitness":             ("Rozrywka i hobby", "Sport i fitness"),
    "Kultura i rozrywka":          ("Rozrywka i hobby", "Kino, teatr i kultura"),
    "Hobby":                       ("Rozrywka i hobby", "Hobby"),
    "Subskrypcje":                 ("Rozrywka i hobby", "Subskrypcje"),
    "Książki i prasa":             ("Edukacja", "Książki i prasa"),
    "Kursy i szkolenia":           ("Edukacja", "Kursy i szkolenia"),
    "Artykuły szkolne":            ("Edukacja", "Artykuły szkolne"),
    "Sprzęt elektroniczny":        ("Elektronika", "Sprzęt elektroniczny"),
    "Akcesoria elektroniczne":     ("Elektronika", "Akcesoria elektroniczne"),
    "Inne":                        ("Inne", "Inne"),
}


# ── Pula połączeń ─────────────────────────────────────────────────────────
# Bez puli każde get_db() nawiązywało świeże połączenie z Postgresem — pełny
# uścisk TCP, TLS i uwierzytelnienie. Jedno wejście na pulpit to ok. 50 takich
# wywołań, czyli sekunda narzutu, zanim baza w ogóle zacznie liczyć.
#
# ZASADA: każda awaria puli sprowadza się do dotychczasowego zachowania
# (świeże połączenie), nigdy do błędu żądania. Najgorszy przypadek po tej
# zmianie to dokładnie to, co działo się przed nią.
#
# keepalives: system operacyjny sam podtrzymuje i wykrywa zerwane połączenia,
# dzięki czemu nie musimy pingować bazy przed każdym użyciem (ping kosztowałby
# podróż do serwera, czyli połowę tego, co oszczędzamy).
_PULA = None
_PULA_LOCK = threading.Lock()
_PULA_ODPADA = False  # pula się nie udała — nie próbujemy w kółko przy każdym żądaniu

_KEEPALIVE = dict(
    keepalives=1, keepalives_idle=30, keepalives_interval=10,
    keepalives_count=5, connect_timeout=10,
)


def _pula():
    """Leniwie tworzy pulę. Zwraca None, gdy się nie da — wtedy get_db()
    łączy się po staremu."""
    global _PULA, _PULA_ODPADA
    if _PULA is not None or _PULA_ODPADA:
        return _PULA
    with _PULA_LOCK:
        if _PULA is None and not _PULA_ODPADA:
            try:
                from psycopg2 import pool as _pgpool
                _PULA = _pgpool.ThreadedConnectionPool(1, 10, DATABASE_URL, **_KEEPALIVE)
            except Exception:
                _PULA_ODPADA = True
    return _PULA


def _wez_polaczenie():
    """Zwraca (połączenie, czy_z_puli). Połączenie zamknięte po stronie
    serwera wyrzucamy i bierzemy następne — inaczej pierwsze żądanie po
    dłuższej przerwie wywracałoby się na trupie z puli."""
    pula = _pula()
    if pula is not None:
        for _ in range(3):
            try:
                conn = pula.getconn()
            except Exception:
                break  # pula wyczerpana albo uszkodzona — bierzemy własne
            if not conn.closed:
                return conn, True
            try:
                pula.putconn(conn, close=True)
            except Exception:
                pass
    return psycopg2.connect(DATABASE_URL, **_KEEPALIVE), False


@contextmanager
def get_db():
    conn, z_puli = _wez_polaczenie()
    cur = None
    zepsute = False
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        yield cur
        conn.commit()
    except Exception:
        # Dopóki rollback się powiedzie, połączenie jest zdrowe i może wrócić
        # do puli. Gdy i on padnie — połączenie jest do wyrzucenia.
        zepsute = True
        try:
            conn.rollback()
            zepsute = False
        except Exception:
            pass
        raise
    finally:
        try:
            if cur is not None:
                cur.close()
        except Exception:
            zepsute = True
        if z_puli:
            try:
                _PULA.putconn(conn, close=zepsute)
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass
        else:
            try:
                conn.close()
            except Exception:
                pass


def init_db():
    with get_db() as cur:
        for stmt in SCHEMA_STATEMENTS:
            cur.execute(stmt)
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT")
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS samouczek BOOLEAN NOT NULL DEFAULT FALSE")
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP")
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'aktywny'")
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_zablokowane BOOLEAN NOT NULL DEFAULT FALSE")
        # numer awatara (indeks w stałym zestawie po stronie frontu); NULL = jeszcze
        # nie wybrany, wtedy front dobiera go deterministycznie z id użytkownika,
        # żeby domownicy nie wyglądali identycznie zanim ktokolwiek coś ustawi
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS awatar INTEGER")
        # kto wywołał AI — wcześniej dziennik kosztów wiedział tylko, które
        # gospodarstwo. Stare wiersze zostają z NULL i pokazują się jako nieznane.
        cur.execute("ALTER TABLE api_usage ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)")
        # gospodarstwo bez członków czeka 30 dni na skasowanie — data startu karencji
        cur.execute("ALTER TABLE households ADD COLUMN IF NOT EXISTS usuwane_od TIMESTAMP")
        cur.execute("ALTER TABLE wydatki ADD COLUMN IF NOT EXISTS okazja TEXT")
        cur.execute("ALTER TABLE wydatki ADD COLUMN IF NOT EXISTS kontekst_kategoria TEXT")
        cur.execute("ALTER TABLE wydatki ADD COLUMN IF NOT EXISTS kontekst_podkategoria TEXT")
        cur.execute("ALTER TABLE pozycje ADD COLUMN IF NOT EXISTS poza_kontekstem BOOLEAN NOT NULL DEFAULT FALSE")
        cur.execute("ALTER TABLE wydatki ADD COLUMN IF NOT EXISTS konto_id INTEGER REFERENCES konta(id) ON DELETE SET NULL")
        cur.execute("ALTER TABLE wydatki_cykliczne ADD COLUMN IF NOT EXISTS limit_naliczen INTEGER")
        cur.execute("ALTER TABLE wydatki_cykliczne ADD COLUMN IF NOT EXISTS automatyczny BOOLEAN NOT NULL DEFAULT TRUE")
        cur.execute("ALTER TABLE wydatki_cykliczne ADD COLUMN IF NOT EXISTS typ TEXT NOT NULL DEFAULT 'wydatek'")
        cur.execute("ALTER TABLE wydatki_cykliczne ADD COLUMN IF NOT EXISTS do_miesiaca DATE")
        cur.execute("ALTER TABLE wydatki_cykliczne ADD COLUMN IF NOT EXISTS konto_na_id INTEGER REFERENCES konta(id) ON DELETE SET NULL")
        # --- moduł Cele ---
        cur.execute("""CREATE TABLE IF NOT EXISTS cele (
            id             SERIAL PRIMARY KEY,
            household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            nazwa          TEXT NOT NULL,
            kwota_docelowa NUMERIC(12,2) NOT NULL,
            konto_id       INTEGER REFERENCES konta(id) ON DELETE SET NULL,
            termin         DATE,
            aktywny        BOOLEAN NOT NULL DEFAULT TRUE,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        cur.execute("""CREATE TABLE IF NOT EXISTS cele_wplaty (
            id         SERIAL PRIMARY KEY,
            cel_id     INTEGER NOT NULL REFERENCES cele(id) ON DELETE CASCADE,
            data       DATE NOT NULL,
            kwota      NUMERIC(12,2) NOT NULL,
            opis       TEXT,
            zrodlo     TEXT NOT NULL DEFAULT 'reczna',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        cur.execute("""CREATE TABLE IF NOT EXISTS limity (
            id               SERIAL PRIMARY KEY,
            household_id     INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            kategoria_glowna TEXT NOT NULL,
            kwota_miesieczna NUMERIC(12,2) NOT NULL,
            created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (household_id, kategoria_glowna)
        )""")
        # limit może dotyczyć podkategorii (NULL = cała kategoria główna).
        # Stary unique (household, kategoria_glowna) blokowałby limit główny + podkategorie
        # tej samej kategorii — zamieniamy na złożony indeks z COALESCE (NULL→'').
        cur.execute("ALTER TABLE limity ADD COLUMN IF NOT EXISTS podkategoria TEXT")
        cur.execute("ALTER TABLE limity DROP CONSTRAINT IF EXISTS limity_household_id_kategoria_glowna_key")
        cur.execute("""CREATE UNIQUE INDEX IF NOT EXISTS limity_uniq
                       ON limity (household_id, kategoria_glowna, COALESCE(podkategoria, ''))""")
        # cykliczny przelew może zasilać konkretną kopertę (cel)
        cur.execute("ALTER TABLE wydatki_cykliczne ADD COLUMN IF NOT EXISTS cel_id INTEGER REFERENCES cele(id) ON DELETE SET NULL")
        # wpłata na cel utworzona przez przelew jest z nim powiązana — usunięcie
        # przelewu kasuje wpłatę (CASCADE), żeby cel/saldo się nie rozjechały
        cur.execute("ALTER TABLE cele_wplaty ADD COLUMN IF NOT EXISTS przelew_id INTEGER REFERENCES przelewy(id) ON DELETE CASCADE")
        cur.execute("""CREATE TABLE IF NOT EXISTS platnosci_oczekujace (
            id           SERIAL PRIMARY KEY,
            household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            cykliczny_id INTEGER NOT NULL REFERENCES wydatki_cykliczne(id) ON DELETE CASCADE,
            termin       DATE NOT NULL,
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (cykliczny_id, termin)
        )""")
        cur.execute("""CREATE TABLE IF NOT EXISTS ustawienia (
            klucz   TEXT PRIMARY KEY,
            wartosc TEXT NOT NULL
        )""")
        # statusy płatności: 'oczekuje' | 'potwierdzona' (ręczna) | 'naliczona' (automatyczna)
        # — wpisy nie-oczekujące pełnią rolę archiwum powiadomień
        cur.execute("ALTER TABLE platnosci_oczekujace ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'oczekuje'")
        cur.execute("ALTER TABLE platnosci_oczekujace ADD COLUMN IF NOT EXISTS potwierdzona_at TIMESTAMP")
        cur.execute("""CREATE TABLE IF NOT EXISTS raporty_ai (
            id             SERIAL PRIMARY KEY,
            household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            miesiace       INTEGER NOT NULL DEFAULT 3,
            kontekst       TEXT,
            raport_json    TEXT NOT NULL,
            model          TEXT,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        cur.execute("""CREATE TABLE IF NOT EXISTS profil_ai (
            id             SERIAL PRIMARY KEY,
            household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            tresc          TEXT NOT NULL,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        cur.execute("""CREATE TABLE IF NOT EXISTS lista_zakupow (
            id           SERIAL PRIMARY KEY,
            household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            nazwa        TEXT NOT NULL,
            kupione      BOOLEAN NOT NULL DEFAULT FALSE,
            dodane_przez TEXT,
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        cur.execute("ALTER TABLE lista_zakupow ADD COLUMN IF NOT EXISTS pozycja INTEGER NOT NULL DEFAULT 0")
        cur.execute("""CREATE TABLE IF NOT EXISTS listy_zakupow (
            id           SERIAL PRIMARY KEY,
            household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            nazwa        TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'aktywna',
            pozycja      INTEGER NOT NULL DEFAULT 0,
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        cur.execute("ALTER TABLE lista_zakupow ADD COLUMN IF NOT EXISTS lista_id INTEGER REFERENCES listy_zakupow(id) ON DELETE CASCADE")
        # migracja z pojedynczej listy: osierocone pozycje -> domyślna lista "Zakupy"
        cur.execute("""INSERT INTO listy_zakupow (household_id, nazwa, status)
            SELECT DISTINCT household_id, 'Zakupy', 'aktywna'
            FROM lista_zakupow WHERE lista_id IS NULL""")
        cur.execute("""UPDATE lista_zakupow li SET lista_id = (
                SELECT l.id FROM listy_zakupow l
                WHERE l.household_id = li.household_id AND l.nazwa = 'Zakupy'
                ORDER BY l.id LIMIT 1)
            WHERE li.lista_id IS NULL""")
        cur.execute("ALTER TABLE listy_zakupow ADD COLUMN IF NOT EXISTS sklep TEXT")
        # nauczona kolejność obchodu sklepu (per gospodarstwo + sklep + produkt);
        # ranga 0..1 = wzgledna pozycja na liscie, srednia kroczaca z reczych ulozen
        cur.execute("""CREATE TABLE IF NOT EXISTS kolejnosc_produktow (
            household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            sklep        TEXT NOT NULL,
            nazwa_znorm  TEXT NOT NULL,
            ranga        REAL NOT NULL,
            licznik      INTEGER NOT NULL DEFAULT 1,
            updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (household_id, sklep, nazwa_znorm)
        )""")
        # globalna, wzorcowa baza dzialow sklepowych (zarzadzana w panelu admina)
        cur.execute("""CREATE TABLE IF NOT EXISTS dzialy (
            id       SERIAL PRIMARY KEY,
            strefa   TEXT NOT NULL DEFAULT '',
            nazwa    TEXT NOT NULL,
            slowa    TEXT NOT NULL DEFAULT '',
            pozycja  INTEGER NOT NULL DEFAULT 0
        )""")
        cur.execute("SELECT COUNT(*) AS n FROM dzialy")
        if cur.fetchone()["n"] == 0:
            for i, (strefa, nazwa, slowa) in enumerate(_DZIALY_SEED):
                cur.execute(
                    "INSERT INTO dzialy (strefa, nazwa, slowa, pozycja) VALUES (%s,%s,%s,%s)",
                    (strefa, nazwa, slowa, i),
                )
        else:
            # dosyp ulepszenia słownika z seedu do istniejących działów (union — bez kasowania edycji admina)
            for _strefa, _nazwa, _slowa in _DZIALY_SEED:
                cur.execute("SELECT id, slowa FROM dzialy WHERE nazwa=%s", (_nazwa,))
                row = cur.fetchone()
                if not row:
                    continue
                istn = {s.strip().lower() for s in (row["slowa"] or "").split(",") if s.strip()}
                nowe = [s.strip() for s in _slowa.split(",") if s.strip() and s.strip().lower() not in istn]
                if nowe:
                    baza = (row["slowa"] or "").strip().rstrip(",")
                    cur.execute("UPDATE dzialy SET slowa=%s WHERE id=%s",
                                ((baza + ", " + ", ".join(nowe)) if baza else ", ".join(nowe), row["id"]))
        # subskrypcje Web Push — jeden wiersz na URZĄDZENIE, nie na użytkownika
        # (telefon i laptop to dwa osobne zapisy). `endpoint` jest unikalny, bo
        # to on identyfikuje urządzenie po stronie usługi dostarczającej.
        cur.execute("""CREATE TABLE IF NOT EXISTS push_subskrypcje (
            id         SERIAL PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            endpoint   TEXT NOT NULL UNIQUE,
            p256dh     TEXT NOT NULL,
            auth       TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        # Wyciszone rodzaje powiadomień — OBECNOŚĆ wiersza znaczy „wyłączone".
        # Odwrotnie niż intuicyjnie, ale dzięki temu domyślnie wszystko jest
        # włączone i dołożenie nowego rodzaju nie wymaga migracji ani dopisywania
        # wierszy istniejącym użytkownikom.
        cur.execute("""CREATE TABLE IF NOT EXISTS push_wylaczone (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            rodzaj  TEXT NOT NULL,
            PRIMARY KEY (user_id, rodzaj)
        )""")
        # dziennik wysłanych powiadomień — chroni przed wysłaniem tego samego
        # przypomnienia drugi raz (scheduler może odpalić ponownie po restarcie).
        cur.execute("""CREATE TABLE IF NOT EXISTS push_wyslane (
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            klucz      TEXT NOT NULL,
            wyslane_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, klucz)
        )""")
        # migracja starego kształtu (jeden raport na gospodarstwo, PK na household_id)
        cur.execute("ALTER TABLE raporty_ai ADD COLUMN IF NOT EXISTS id SERIAL")
        cur.execute("""DO $$
        DECLARE pk_nazwa text;
        BEGIN
            SELECT tc.constraint_name INTO pk_nazwa
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage k
              ON k.constraint_name = tc.constraint_name AND k.table_name = tc.table_name
            WHERE tc.table_name='raporty_ai' AND tc.constraint_type='PRIMARY KEY'
              AND k.column_name='household_id';
            IF pk_nazwa IS NOT NULL THEN
                EXECUTE format('ALTER TABLE raporty_ai DROP CONSTRAINT %I', pk_nazwa);
                ALTER TABLE raporty_ai ADD PRIMARY KEY (id);
            END IF;
        END $$""")
        # znacznik raportu wygenerowanego automatycznie (miesięczny, na koniec miesiąca)
        cur.execute("ALTER TABLE raporty_ai ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT FALSE")
        for stara, (glowna, sub) in _MIGRACJA_MAP.items():
            cur.execute(
                "UPDATE pozycje SET kategoria_glowna=%s, kategoria=%s WHERE kategoria=%s",
                (glowna, sub, stara),
            )
        cur.execute("UPDATE pozycje SET kategoria_glowna='Zdrowie' WHERE kategoria_glowna='Zdrowie i leki'")


# --- wydatki ---

def create_wydatek(data: str, sklep: str | None, suma: float, osoba: str,
                   notatki: str | None, zdjecie: str | None,
                   pozycje: list[dict],
                   waluta: str = "PLN", kurs: float = 1.0,
                   household_id: int | None = None,
                   okazja: str | None = None,
                   kontekst_kategoria: str | None = None,
                   kontekst_podkategoria: str | None = None,
                   konto_id: int | None = None) -> int:
    with get_db() as cur:
        cur.execute(
            "INSERT INTO wydatki (data,sklep,suma,osoba,notatki,zdjecie,waluta,kurs,household_id,okazja,kontekst_kategoria,kontekst_podkategoria,konto_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
            (data, sklep, suma, osoba, notatki, zdjecie, waluta, kurs, household_id, okazja or None, kontekst_kategoria or None, kontekst_podkategoria or None, konto_id or None),
        )
        wydatek_id = cur.fetchone()["id"]
        if pozycje:
            cur.executemany(
                "INSERT INTO pozycje (wydatek_id,nazwa,cena,ilosc,kategoria_glowna,kategoria,poza_kontekstem) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                [(wydatek_id, p["nazwa"], p["cena"], p.get("ilosc", 1),
                  p.get("kategoria_glowna", "Inne"), p.get("kategoria", "Inne"),
                  bool(p.get("poza_kontekstem", False)))
                 for p in pozycje],
            )
    return wydatek_id


# Wyrażenia SQL dla trybu kontekstowego z uwzględnieniem flagi poza_kontekstem
_KAT = "CASE WHEN p.poza_kontekstem THEN p.kategoria_glowna ELSE COALESCE(w.kontekst_kategoria, p.kategoria_glowna) END"
_SUB = "CASE WHEN p.poza_kontekstem THEN p.kategoria ELSE COALESCE(w.kontekst_podkategoria, p.kategoria) END"


def get_wydatki(month: str | None = None, osoba: str | None = None,
                kategoria: str | None = None, household_id: int | None = None,
                od: str | None = None, do: str | None = None,
                okazja: str | None = None, kontekst: bool = False,
                wyklucz: list[str] | None = None) -> list[dict]:
    conditions, params = [], []
    if household_id is not None:
        conditions.append("w.household_id = %s"); params.append(household_id)
    if month:
        conditions.append("TO_CHAR(w.data, 'YYYY-MM') = %s"); params.append(month)
    if od:
        conditions.append("w.data >= %s"); params.append(od)
    if do:
        conditions.append("w.data <= %s"); params.append(do)
    if osoba:
        conditions.append("w.osoba = %s"); params.append(osoba)
    if okazja:
        conditions.append("w.okazja = %s"); params.append(okazja)
    if wyklucz:
        conditions.append(_WYKLUCZ_SQL); params.append(list(wyklucz))
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    if kategoria:
        kat_col = _KAT if kontekst else "p.kategoria_glowna"
        query = f"""
            SELECT DISTINCT w.id, w.data, w.sklep, w.suma, w.osoba, w.notatki, w.zdjecie, w.created_at, w.okazja, w.kontekst_kategoria, w.kontekst_podkategoria, w.konto_id
            FROM wydatki w JOIN pozycje p ON p.wydatek_id = w.id
            {where} {'AND' if where else 'WHERE'} {kat_col} = %s
            ORDER BY w.data DESC"""
        params.append(kategoria)
    else:
        query = f"""
            SELECT w.id, w.data, w.sklep, w.suma, w.osoba, w.notatki, w.zdjecie, w.created_at, w.okazja, w.kontekst_kategoria, w.kontekst_podkategoria, w.konto_id
            FROM wydatki w {where} ORDER BY w.data DESC"""

    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def get_wydatek(wydatek_id: int) -> dict | None:
    with get_db() as cur:
        cur.execute("SELECT * FROM wydatki WHERE id = %s", (wydatek_id,))
        row = cur.fetchone()
        if not row:
            return None
        result = dict(row)
        cur.execute("SELECT * FROM pozycje WHERE wydatek_id = %s", (wydatek_id,))
        result["pozycje"] = [dict(p) for p in cur.fetchall()]
        return result


def szukaj_wydatki(q: str, household_id: int | None, limit: int = 300) -> dict:
    """Wyszukiwanie (ILIKE) po nazwach produktów, sklepie i notatkach.
    Zwraca pasujące wydatki (z listą trafionych nazw pozycji) + podsumowanie
    kwotowe wszystkich trafionych pozycji (np. ile łącznie na 'kawa')."""
    like = f"%{q}%"
    with get_db() as cur:
        cur.execute(
            """
            SELECT w.id, w.data, w.sklep, w.suma, w.osoba, w.notatki,
                   (SELECT string_agg(p.nazwa, ' • ' ORDER BY p.id)
                      FROM pozycje p
                     WHERE p.wydatek_id = w.id AND p.nazwa ILIKE %s) AS trafienia
              FROM wydatki w
             WHERE w.household_id = %s
               AND ( w.sklep ILIKE %s
                  OR w.notatki ILIKE %s
                  OR EXISTS (SELECT 1 FROM pozycje p2
                              WHERE p2.wydatek_id = w.id AND p2.nazwa ILIKE %s) )
             ORDER BY w.data DESC, w.id DESC
             LIMIT %s
            """,
            (like, household_id, like, like, like, limit),
        )
        wydatki = [dict(r) for r in cur.fetchall()]
        cur.execute(
            """
            SELECT COALESCE(SUM(p.cena * p.ilosc), 0) AS suma_pozycji,
                   COUNT(*) AS liczba_pozycji
              FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
             WHERE w.household_id = %s AND p.nazwa ILIKE %s
            """,
            (household_id, like),
        )
        agg = dict(cur.fetchone())
    return {
        "wydatki": wydatki,
        "suma_pozycji": float(agg["suma_pozycji"] or 0),
        "liczba_pozycji": int(agg["liczba_pozycji"] or 0),
    }


def historia_cen(q: str, household_id: int | None, kategoria_glowna: str | None = None,
                 kategoria: str | None = None, limit: int = 500) -> dict:
    """Historia cen JEDNOSTKOWYCH (pozycje.cena = cena za 1 szt/kg) produktów
    pasujących do zapytania (ILIKE po nazwie). Zwraca punkty w czasie, porównanie
    średniej ceny per sklep (gdzie taniej), podsumowanie zmiany, listę kategorii
    obecnych w trafieniach (do zawężenia) oraz liczbę pominiętych pomiarów odstających.
    Opcjonalnie zawęża do wybranej kategorii głównej / podkategorii."""
    like = f"%{q}%"
    with get_db() as cur:
        cur.execute(
            """
            SELECT p.nazwa, p.cena, p.ilosc, p.kategoria_glowna, p.kategoria, w.data, w.sklep
              FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
             WHERE w.household_id = %s AND p.nazwa ILIKE %s AND p.cena > 0
             ORDER BY w.data ASC, p.id ASC
             LIMIT %s
            """,
            (household_id, like, limit),
        )
        trafienia = [dict(r) for r in cur.fetchall()]

    # lista kategorii/podkategorii obecnych w trafieniach — do zawężenia wykresu,
    # gdy jedno hasło łapie różne rzeczy (np. "LPG" = paliwo, ale i przegląd instalacji)
    kat_licz: dict[tuple, int] = {}
    for p in trafienia:
        klucz = (p["kategoria_glowna"], p["kategoria"])
        kat_licz[klucz] = kat_licz.get(klucz, 0) + 1
    kategorie = [{"kategoria_glowna": kg, "kategoria": k, "liczba": n}
                 for (kg, k), n in kat_licz.items()]
    kategorie.sort(key=lambda x: -x["liczba"])

    # zawężenie do wybranej kategorii / podkategorii
    wszystkie = trafienia
    if kategoria_glowna:
        wszystkie = [p for p in wszystkie if p["kategoria_glowna"] == kategoria_glowna]
    if kategoria:
        wszystkie = [p for p in wszystkie if p["kategoria"] == kategoria]

    # Odrzuć pomiary rażąco odstające od reszty (np. wpis „z pamięci" jako cała kwota
    # — ziemniaki 10 zł — gdy reszta to realna cena jednostkowa). Metoda IQR: liczy
    # rozrzut typowych cen i odcina skrajne. Działa dopiero gdy jest dość danych.
    punkty = wszystkie
    odrzucone = 0
    ceny_sort = sorted(float(p["cena"]) for p in wszystkie)
    if len(ceny_sort) >= 5:
        def _kwantyl(s: list[float], qtl: float) -> float:
            i = qtl * (len(s) - 1)
            lo = int(i)
            hi = min(lo + 1, len(s) - 1)
            return s[lo] + (s[hi] - s[lo]) * (i - lo)
        q1 = _kwantyl(ceny_sort, 0.25)
        q3 = _kwantyl(ceny_sort, 0.75)
        iqr = q3 - q1
        dol = q1 - 1.5 * iqr
        gora = q3 + 1.5 * iqr
        punkty = [p for p in wszystkie if dol <= float(p["cena"]) <= gora]
        odrzucone = len(wszystkie) - len(punkty)

    grp: dict[str, list[float]] = {}
    for p in punkty:
        grp.setdefault(p["sklep"] or "—", []).append(float(p["cena"]))
    sklepy = [
        {"sklep": s, "srednia": round(sum(v) / len(v), 2),
         "min": round(min(v), 2), "max": round(max(v), 2), "liczba": len(v)}
        for s, v in grp.items()
    ]
    sklepy.sort(key=lambda x: x["srednia"])

    podsum: dict = {}
    if punkty:
        pmin = min(punkty, key=lambda p: float(p["cena"]))
        pmax = max(punkty, key=lambda p: float(p["cena"]))
        pierwsza = float(punkty[0]["cena"])
        ostatnia = float(punkty[-1]["cena"])
        podsum = {
            "min": {"cena": round(float(pmin["cena"]), 2), "sklep": pmin["sklep"], "data": pmin["data"]},
            "max": {"cena": round(float(pmax["cena"]), 2), "sklep": pmax["sklep"], "data": pmax["data"]},
            "pierwsza": round(pierwsza, 2),
            "ostatnia": round(ostatnia, 2),
            "zmiana_proc": round((ostatnia - pierwsza) / pierwsza * 100, 1) if pierwsza else 0,
        }
    return {"punkty": punkty, "sklepy": sklepy, "podsumowanie": podsum,
            "liczba": len(punkty), "odrzucone": odrzucone, "kategorie": kategorie}


def update_wydatek(wydatek_id: int, data: str, sklep: str | None, suma: float,
                   osoba: str, notatki: str | None, pozycje: list[dict],
                   okazja: str | None = None, kontekst_kategoria: str | None = None,
                   kontekst_podkategoria: str | None = None,
                   konto_id: int | None = None,
                   household_id: int | None = None) -> bool:
    with get_db() as cur:
        if household_id is not None:
            cur.execute(
                "UPDATE wydatki SET data=%s,sklep=%s,suma=%s,osoba=%s,notatki=%s,okazja=%s,kontekst_kategoria=%s,kontekst_podkategoria=%s,konto_id=%s WHERE id=%s AND household_id=%s",
                (data, sklep, suma, osoba, notatki, okazja or None, kontekst_kategoria or None, kontekst_podkategoria or None, konto_id or None, wydatek_id, household_id),
            )
        else:
            cur.execute(
                "UPDATE wydatki SET data=%s,sklep=%s,suma=%s,osoba=%s,notatki=%s,okazja=%s,kontekst_kategoria=%s,kontekst_podkategoria=%s,konto_id=%s WHERE id=%s",
                (data, sklep, suma, osoba, notatki, okazja or None, kontekst_kategoria or None, kontekst_podkategoria or None, konto_id or None, wydatek_id),
            )
        if cur.rowcount == 0:
            return False
        cur.execute("DELETE FROM pozycje WHERE wydatek_id = %s", (wydatek_id,))
        if pozycje:
            cur.executemany(
                "INSERT INTO pozycje (wydatek_id,nazwa,cena,ilosc,kategoria_glowna,kategoria,poza_kontekstem) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                [(wydatek_id, p["nazwa"], p["cena"], p.get("ilosc", 1),
                  p.get("kategoria_glowna", "Inne"), p.get("kategoria", "Inne"),
                  bool(p.get("poza_kontekstem", False)))
                 for p in pozycje],
            )
    return True


def get_pozycje_do_rekat(month: str | None = None, od: str | None = None, do: str | None = None,
                         household_id: int | None = None) -> list[dict]:
    conditions, params = [], []
    if household_id is not None:
        conditions.append("w.household_id = %s"); params.append(household_id)
    if month:
        conditions.append("TO_CHAR(w.data, 'YYYY-MM') = %s"); params.append(month)
    if od:
        conditions.append("w.data >= %s"); params.append(od)
    if do:
        conditions.append("w.data <= %s"); params.append(do)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    query = f"""
        SELECT p.id, p.nazwa, p.kategoria_glowna, p.kategoria, w.sklep
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} ORDER BY w.data DESC"""
    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def update_pozycje_kategorie(aktualizacje: list[dict], household_id: int | None = None) -> int:
    with get_db() as cur:
        if household_id is None:
            cur.executemany(
                "UPDATE pozycje SET kategoria_glowna=%s, kategoria=%s WHERE id=%s",
                [(a["kategoria_glowna"], a["kategoria"], a["id"]) for a in aktualizacje],
            )
        else:
            # przynależność sprawdzana w samym UPDATE — pozycja spoza gospodarstwa
            # nie zostanie ruszona, nawet gdyby jej id trafiło na listę
            cur.executemany(
                """UPDATE pozycje p SET kategoria_glowna=%s, kategoria=%s
                   FROM wydatki w
                   WHERE p.id=%s AND w.id = p.wydatek_id AND w.household_id=%s""",
                [(a["kategoria_glowna"], a["kategoria"], a["id"], household_id)
                 for a in aktualizacje],
            )
        return cur.rowcount


def update_notatki(wydatek_id: int, notatki: str, household_id: int | None = None) -> bool:
    with get_db() as cur:
        if household_id is not None:
            cur.execute("UPDATE wydatki SET notatki=%s WHERE id=%s AND household_id=%s", (notatki or None, wydatek_id, household_id))
        else:
            cur.execute("UPDATE wydatki SET notatki=%s WHERE id=%s", (notatki or None, wydatek_id))
        return cur.rowcount > 0


def delete_wydatek(wydatek_id: int, household_id: int | None = None) -> bool:
    with get_db() as cur:
        if household_id is not None:
            cur.execute("DELETE FROM wydatki WHERE id = %s AND household_id=%s", (wydatek_id, household_id))
        else:
            cur.execute("DELETE FROM wydatki WHERE id = %s", (wydatek_id,))
        return cur.rowcount > 0


# --- statystyki ---

# Klauzula wykluczająca całe paragony należące do wskazanych kategorii głównych
# (koszty przelotowe/zwracane pomijane w analizie na dashboardzie). Działa na
# poziomie paragonu — czynsz/opłaty za lokal to osobne paragony, więc znikają
# w całości i suma pozostaje spójna z sumą słupków.
_WYKLUCZ_SQL = "w.id NOT IN (SELECT wydatek_id FROM pozycje WHERE kategoria_glowna = ANY(%s))"


def _where_params(month, osoba, household_id=None, od=None, do=None, okazja=None):
    conditions, params = [], []
    if household_id is not None:
        conditions.append("w.household_id = %s"); params.append(household_id)
    if month:
        conditions.append("TO_CHAR(w.data, 'YYYY-MM') = %s"); params.append(month)
    if od:
        conditions.append("w.data >= %s"); params.append(od)
    if do:
        conditions.append("w.data <= %s"); params.append(do)
    if osoba:
        conditions.append("w.osoba = %s"); params.append(osoba)
    if okazja:
        conditions.append("w.okazja = %s"); params.append(okazja)
    return ("WHERE " + " AND ".join(conditions)) if conditions else "", params


def stats_kategorie(month=None, osoba=None, household_id=None, od=None, do=None, kontekst=False) -> list[dict]:
    where, params = _where_params(month, osoba, household_id, od=od, do=do)
    kat_col = _KAT if kontekst else "p.kategoria_glowna"
    query = f"""
        SELECT {kat_col} AS kategoria_glowna,
               ROUND(CAST(SUM(p.cena * p.ilosc) AS numeric), 2) AS suma
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} GROUP BY {kat_col} ORDER BY suma DESC"""
    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def stats_pozycje_subkat(kategoria: str, month=None, osoba=None, kategoria_glowna=None, household_id=None, od=None, do=None, kontekst=False) -> list[dict]:
    where, params = _where_params(month, osoba, household_id, od=od, do=do)
    if kontekst:
        sub_col = _SUB
        kat_col = _KAT
    else:
        sub_col = "p.kategoria"
        kat_col = "p.kategoria_glowna"
    extra = f"{'AND' if where else 'WHERE'} {sub_col} = %s"
    params.append(kategoria)
    if kategoria_glowna:
        extra += f" AND {kat_col} = %s"; params.append(kategoria_glowna)
    query = f"""
        SELECT p.id, p.nazwa, p.cena, p.ilosc,
               ROUND(CAST(p.cena * p.ilosc AS numeric), 2) AS suma,
               w.sklep, w.data, p.kategoria AS oryg_subkat, w.kontekst_podkategoria
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} {extra}
        ORDER BY suma DESC"""
    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def stats_subkategorie(kategoria_glowna: str, month=None, osoba=None, household_id=None, od=None, do=None, kontekst=False) -> list[dict]:
    where, params = _where_params(month, osoba, household_id, od=od, do=do)
    params.append(kategoria_glowna)
    if kontekst:
        kat_filter = _KAT
        sub_col = _SUB
    else:
        kat_filter = "p.kategoria_glowna"
        sub_col = "p.kategoria"
    query = f"""
        SELECT {sub_col} AS kategoria, ROUND(CAST(SUM(p.cena * p.ilosc) AS numeric), 2) AS suma
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} {'AND' if where else 'WHERE'} {kat_filter} = %s
        GROUP BY {sub_col} ORDER BY suma DESC"""
    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def stats_subkategorie_all(month=None, osoba=None, household_id=None, od=None, do=None, kontekst=False) -> list[dict]:
    where, params = _where_params(month, osoba, household_id, od=od, do=do)
    if kontekst:
        kat_col, sub_col = _KAT, _SUB
    else:
        kat_col, sub_col = "p.kategoria_glowna", "p.kategoria"
    query = f"""
        SELECT {kat_col} AS kategoria_glowna, {sub_col} AS kategoria,
               ROUND(CAST(SUM(p.cena * p.ilosc) AS numeric), 2) AS suma
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} GROUP BY {kat_col}, {sub_col} ORDER BY {kat_col}, suma DESC"""
    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def stats_miesiace(n=6, osoba=None, kategoria=None, household_id=None, wyklucz=None) -> list[dict]:
    params = []
    hid_cond = f"w.household_id = {int(household_id)} AND " if household_id is not None else ""
    if kategoria:
        conditions = [f"w.data >= NOW() - INTERVAL '{n} months'", "p.kategoria_glowna = %s"]
        if household_id is not None:
            conditions.insert(0, f"w.household_id = {int(household_id)}")
        if osoba:
            conditions.append("w.osoba = %s")
            params.append(kategoria); params.append(osoba)
        else:
            params.append(kategoria)
        where = "WHERE " + " AND ".join(conditions)
        query = f"""
            SELECT TO_CHAR(w.data, 'YYYY-MM') AS miesiac, w.osoba,
                   ROUND(CAST(SUM(p.cena * p.ilosc) AS numeric), 2) AS suma
            FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
            {where} GROUP BY miesiac, w.osoba ORDER BY miesiac"""
    else:
        extra = []
        if household_id is not None:
            extra.append(f"w.household_id = {int(household_id)}")
        if osoba:
            extra.append("w.osoba = %s"); params.append(osoba)
        if wyklucz:
            extra.append(_WYKLUCZ_SQL); params.append(list(wyklucz))
        extra_sql = ("AND " + " AND ".join(extra)) if extra else ""
        query = f"""
            SELECT TO_CHAR(w.data, 'YYYY-MM') AS miesiac, w.osoba,
                   ROUND(CAST(SUM(w.suma) AS numeric), 2) AS suma
            FROM wydatki w
            WHERE w.data >= NOW() - INTERVAL '{n} months' {extra_sql}
            GROUP BY miesiac, w.osoba ORDER BY miesiac"""
    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def stats_sklepy(month=None, osoba=None, limit=10, kategoria=None, household_id=None, od=None, do=None, wyklucz=None) -> list[dict]:
    def _date_conds(conditions, params):
        if month:
            conditions.append("TO_CHAR(w.data, 'YYYY-MM') = %s"); params.append(month)
        if od:
            conditions.append("w.data >= %s"); params.append(od)
        if do:
            conditions.append("w.data <= %s"); params.append(do)

    params = []
    if kategoria:
        conditions = ["w.sklep IS NOT NULL", "p.kategoria_glowna = %s"]
        params.append(kategoria)
        if household_id is not None:
            conditions.append("w.household_id = %s"); params.append(household_id)
        _date_conds(conditions, params)
        if osoba:
            conditions.append("w.osoba = %s"); params.append(osoba)
        where = "WHERE " + " AND ".join(conditions)
        params.append(limit)
        query = f"""
            SELECT w.sklep, ROUND(CAST(SUM(p.cena * p.ilosc) AS numeric), 2) AS suma,
                   COUNT(DISTINCT w.id) AS liczba
            FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
            {where} GROUP BY w.sklep ORDER BY suma DESC LIMIT %s"""
    else:
        conditions = ["w.sklep IS NOT NULL"]
        if household_id is not None:
            conditions.append("w.household_id = %s"); params.append(household_id)
        _date_conds(conditions, params)
        if osoba:
            conditions.append("w.osoba = %s"); params.append(osoba)
        if wyklucz:
            conditions.append(_WYKLUCZ_SQL); params.append(list(wyklucz))
        where = "WHERE " + " AND ".join(conditions)
        params.append(limit)
        query = f"""
            SELECT w.sklep, ROUND(CAST(SUM(w.suma) AS numeric), 2) AS suma, COUNT(*) AS liczba
            FROM wydatki w {where}
            GROUP BY w.sklep ORDER BY suma DESC LIMIT %s"""
    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def stats_dziennie(month=None, osoba=None, kategoria=None, household_id=None,
                   od=None, do=None, wyklucz=None) -> list[dict]:
    """Suma wydatków dzień po dniu (do dziennego wykresu słupkowego na dashboardzie).
    Zwraca tylko dni, w których coś wydano (dzien=YYYY-MM-DD, suma); brakujące dni
    dopełnia zerami front, żeby oś była ciągła."""
    def _date_conds(conditions, params):
        if month:
            conditions.append("TO_CHAR(w.data, 'YYYY-MM') = %s"); params.append(month)
        if od:
            conditions.append("w.data >= %s"); params.append(od)
        if do:
            conditions.append("w.data <= %s"); params.append(do)

    params = []
    if kategoria:
        conditions = ["p.kategoria_glowna = %s"]; params.append(kategoria)
        if household_id is not None:
            conditions.append("w.household_id = %s"); params.append(household_id)
        _date_conds(conditions, params)
        if osoba:
            conditions.append("w.osoba = %s"); params.append(osoba)
        where = "WHERE " + " AND ".join(conditions)
        query = f"""
            SELECT TO_CHAR(w.data, 'YYYY-MM-DD') AS dzien,
                   ROUND(CAST(SUM(p.cena * p.ilosc) AS numeric), 2) AS suma
            FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
            {where} GROUP BY dzien ORDER BY dzien"""
    else:
        conditions = []
        if household_id is not None:
            conditions.append("w.household_id = %s"); params.append(household_id)
        _date_conds(conditions, params)
        if osoba:
            conditions.append("w.osoba = %s"); params.append(osoba)
        if wyklucz:
            conditions.append(_WYKLUCZ_SQL); params.append(list(wyklucz))
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        query = f"""
            SELECT TO_CHAR(w.data, 'YYYY-MM-DD') AS dzien,
                   ROUND(CAST(SUM(w.suma) AS numeric), 2) AS suma
            FROM wydatki w {where}
            GROUP BY dzien ORDER BY dzien"""
    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def stats_bilans(household_id: int, month=None, od=None, do=None) -> dict:
    """Bilans okresu: pełne wpływy − pełne wydatki. Liczy WSZYSTKO — nie stosuje
    'pomijanych kategorii', bo koszt lokalu i czynsz od najemcy mają się znosić,
    dając realny plus/minus gospodarstwa. Warunek okresu wspólny dla obu tabel
    (kolumny household_id i data występują i w wydatki, i w wplywy)."""
    conds, params = ["household_id = %s"], [household_id]
    if month:
        conds.append("TO_CHAR(data, 'YYYY-MM') = %s"); params.append(month)
    if od:
        conds.append("data >= %s"); params.append(od)
    if do:
        conds.append("data <= %s"); params.append(do)
    where = "WHERE " + " AND ".join(conds)
    with get_db() as cur:
        cur.execute(f"SELECT COALESCE(SUM(suma), 0) AS s FROM wydatki {where}", params)
        wydatki = float(cur.fetchone()["s"])
        cur.execute(f"SELECT COALESCE(SUM(kwota), 0) AS s FROM wplywy {where}", params)
        wplywy = float(cur.fetchone()["s"])
    return {"wplywy": round(wplywy, 2), "wydatki": round(wydatki, 2),
            "bilans": round(wplywy - wydatki, 2)}


def stats_top_produkt(kategoria: str, month=None, osoba=None, household_id=None, od=None, do=None) -> dict | None:
    where, params = _where_params(month, osoba, household_id, od=od, do=do)
    params.append(kategoria)
    query = f"""
        SELECT p.nazwa, COUNT(*) AS ile_razy,
               ROUND(CAST(SUM(p.cena * p.ilosc) AS numeric), 2) AS suma_total
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} {'AND' if where else 'WHERE'} p.kategoria_glowna = %s
        GROUP BY p.nazwa ORDER BY suma_total DESC LIMIT 1"""
    with get_db() as cur:
        cur.execute(query, params)
        row = cur.fetchone()
        return dict(row) if row else None


# --- doradca budżetowy (analiza AI) ---

def zbierz_dane_budzet(household_id: int, miesiace: int = 3, miesiac_pelny: bool = False) -> dict:
    """Zbiera bogaty, skompresowany zestaw danych do analizy AI za ostatnie `miesiace` miesięcy.
    Grupowanie produktów po nazwie zbija liczbę tokenów przy zachowaniu konkretów.

    miesiac_pelny=True — dla raportu odpalanego w OSTATNI dzień miesiąca: bieżący miesiąc
    jest już domknięty, więc wchodzi do średnich jak zamknięty i limity liczą się dla niego."""
    from datetime import date as _date
    today = _date.today()
    # początek okna: pierwszy dzień miesiąca sprzed (miesiace-1)
    m0 = today.year * 12 + (today.month - 1) - (miesiace - 1)
    rok0, mies0 = divmod(m0, 12)
    od = _date(rok0, mies0 + 1, 1).isoformat()
    do = today.isoformat()

    with get_db() as cur:
        # wydatki i pozycje per miesiąc + kategoria (kontekstowa — imprezy/okazje
        # lądują we właściwej kategorii, nie w np. Spożywczych)
        cur.execute(f"""
            SELECT TO_CHAR(w.data,'YYYY-MM') AS miesiac, {_KAT} AS kategoria,
                   ROUND(CAST(SUM(p.cena*p.ilosc) AS numeric),2) AS suma
            FROM pozycje p JOIN wydatki w ON w.id=p.wydatek_id
            WHERE w.household_id=%s AND w.data>=%s
            GROUP BY TO_CHAR(w.data,'YYYY-MM'), {_KAT}
            ORDER BY miesiac, suma DESC
        """, (household_id, od))
        kat_miesiace = [dict(r) for r in cur.fetchall()]

        # suma wydatków per miesiąc
        cur.execute("""
            SELECT TO_CHAR(w.data,'YYYY-MM') AS miesiac,
                   ROUND(CAST(SUM(w.suma) AS numeric),2) AS suma
            FROM wydatki w WHERE w.household_id=%s AND w.data>=%s
            GROUP BY TO_CHAR(w.data,'YYYY-MM') ORDER BY miesiac
        """, (household_id, od))
        wydatki_miesiace = [dict(r) for r in cur.fetchall()]

        # wpływy per miesiąc
        cur.execute("""
            SELECT TO_CHAR(w.data,'YYYY-MM') AS miesiac,
                   ROUND(CAST(SUM(w.kwota) AS numeric),2) AS suma
            FROM wplywy w WHERE w.household_id=%s AND w.data>=%s
            GROUP BY TO_CHAR(w.data,'YYYY-MM') ORDER BY miesiac
        """, (household_id, od))
        wplywy_miesiace = [dict(r) for r in cur.fetchall()]

        # KAŻDY wpływ z osobna (po opisie/źródle) w rozbiciu na miesiące — doradca ma wiedzieć,
        # ZA CO jest dany wpływ (np. czynsz z najmu, świadczenie, pensja, zwroty), a nie tylko sumę.
        # Wpływów jest mało, więc lista pełna (grupujemy tylko identyczne opisy w tym samym miesiącu).
        cur.execute("""
            SELECT TO_CHAR(w.data,'YYYY-MM') AS miesiac,
                   COALESCE(NULLIF(w.opis,''), NULLIF(w.kategoria,''), 'wpływ') AS zrodlo,
                   COALESCE(NULLIF(w.kategoria,''),'Inne') AS kategoria, w.osoba,
                   ROUND(CAST(SUM(w.kwota) AS numeric),2) AS suma, COUNT(*) AS ile
            FROM wplywy w WHERE w.household_id=%s AND w.data>=%s
            GROUP BY TO_CHAR(w.data,'YYYY-MM'),
                     COALESCE(NULLIF(w.opis,''), NULLIF(w.kategoria,''), 'wpływ'),
                     COALESCE(NULLIF(w.kategoria,''),'Inne'), w.osoba
            ORDER BY miesiac, suma DESC
        """, (household_id, od))
        wplywy_zrodla = [dict(r) for r in cur.fetchall()]

        # top produkty grupowane po nazwie — tu siedzą realne odkrycia;
        # bez paragonów okazjonalnych (roczek, święta) — to nie nawyki,
        # ich suma trafia do modelu przez agregat wydatki_okazjonalne
        cur.execute(f"""
            SELECT MIN(p.nazwa) AS nazwa, {_KAT} AS kategoria,
                   COUNT(*) AS ile, ROUND(CAST(SUM(p.cena*p.ilosc) AS numeric),2) AS suma,
                   ROUND(CAST(AVG(p.cena) AS numeric),2) AS srednia_cena
            FROM pozycje p JOIN wydatki w ON w.id=p.wydatek_id
            WHERE w.household_id=%s AND w.data>=%s AND (w.okazja IS NULL OR w.okazja = '')
            GROUP BY LOWER(p.nazwa), {_KAT}
            HAVING SUM(p.cena*p.ilosc) > 0
            ORDER BY suma DESC LIMIT 50
        """, (household_id, od))
        produkty = [dict(r) for r in cur.fetchall()]

        # wydatki okazjonalne (urodziny, święta itp.) — jawnie jako jednorazowe
        cur.execute("""
            SELECT w.okazja, COUNT(*) AS paragony,
                   ROUND(CAST(SUM(w.suma) AS numeric),2) AS suma
            FROM wydatki w
            WHERE w.household_id=%s AND w.data>=%s AND w.okazja IS NOT NULL AND w.okazja <> ''
            GROUP BY w.okazja ORDER BY suma DESC
        """, (household_id, od))
        okazje = [dict(r) for r in cur.fetchall()]

        # top sklepy
        cur.execute("""
            SELECT w.sklep, COUNT(*) AS wizyty,
                   ROUND(CAST(SUM(w.suma) AS numeric),2) AS suma
            FROM wydatki w WHERE w.household_id=%s AND w.data>=%s AND w.sklep IS NOT NULL
            GROUP BY w.sklep ORDER BY suma DESC LIMIT 15
        """, (household_id, od))
        sklepy = [dict(r) for r in cur.fetchall()]

        # aktywne wydatki cykliczne (subskrypcje/abonamenty)
        cur.execute("""
            SELECT nazwa, kwota, kategoria_glowna AS kategoria, limit_naliczen
            FROM wydatki_cykliczne WHERE household_id=%s AND aktywne=TRUE ORDER BY kwota DESC
        """, (household_id,))
        cykliczne = [dict(r) for r in cur.fetchall()]

    # kondycja liczona przez system, nie przez model (LLM myli się w arytmetyce).
    # Każda metryka: średnia z zamkniętych miesięcy, w których MA dane; gdy takich brak —
    # z miesięcy z danymi (także bieżącego, np. pensja księgowana na początku miesiąca).
    biezacy = today.strftime("%Y-%m")

    def _srednia(wiersze) -> tuple[float, str]:
        mies_z_danymi = sorted({r["miesiac"] for r in wiersze})
        # w trybie miesiac_pelny bieżący miesiąc jest domknięty → traktuj go jak zamknięty
        zamkniete = mies_z_danymi if miesiac_pelny else [m for m in mies_z_danymi if m != biezacy]
        baza = zamkniete or mies_z_danymi
        if not baza:
            return 0.0, "brak danych"
        suma = sum(float(r["suma"]) for r in wiersze if r["miesiac"] in baza)
        opis = ", ".join(baza) + ("" if zamkniete else " (niepełny miesiąc — orientacyjnie)")
        return round(suma / len(baza), 2), opis

    wyd_mies, wyd_opis = _srednia(wydatki_miesiace)
    wpl_mies, wpl_opis = _srednia(wplywy_miesiace)
    kondycja_wyliczona = {
        "wydatki_mies": wyd_mies,
        "wplywy_mies": wpl_mies,
        "bilans_mies": round(wpl_mies - wyd_mies, 2),
        "metoda": f"wydatki: średnia z [{wyd_opis}]; wpływy: średnia z [{wpl_opis}]",
    }

    import calendar as _cal
    dni_w_mies = _cal.monthrange(today.year, today.month)[1]
    if miesiac_pelny:
        uwaga = (f"Miesiąc {biezacy} jest KOMPLETNY — to raport na koniec miesiąca. "
                 f"Traktuj {biezacy} jak pełny, zamknięty miesiąc; możesz porównywać go wprost "
                 f"z wcześniejszymi i liczyć z niego trendy.")
    else:
        uwaga = (f"UWAGA: miesiąc {biezacy} jest NIEPEŁNY — dane obejmują tylko "
                 f"{today.day} z {dni_w_mies} dni ({round(100*today.day/dni_w_mies)}% miesiąca)")

    # --- warstwa planów: limity, cele (koperty), cel przepływowy, poduszka na kontach ---
    # dla raportu miesięcznego limity liczymy dla właśnie domkniętego miesiąca
    limity_raw = get_limity(household_id, biezacy if miesiac_pelny else None)
    limity = [{
        "kategoria": l["kategoria_glowna"] + (f" / {l['podkategoria']}" if l.get("podkategoria") else ""),
        "limit": l["kwota_miesieczna"], "wydane": l["wydane"],
        "pozostalo": l["pozostalo"], "procent": l["procent"],
    } for l in limity_raw]

    _pola_cel = ("nazwa", "kwota_docelowa", "odlozone", "brakuje", "postep",
                 "tempo_miesieczne", "prognoza_miesiecy", "termin",
                 "wymagane_miesieczne", "na_czas")
    cele = [{k: c.get(k) for k in _pola_cel} for c in get_cele(household_id, aktywne=True)]

    cel_przeplywowy = get_cel_przeplywowy(household_id)

    konta = get_konta(household_id)
    oszcz = round(sum(float(k["saldo_biezace"]) for k in konta if k.get("typ") == "oszczędności"), 2)
    biezace = round(sum(float(k["saldo_biezace"]) for k in konta if k.get("typ") != "oszczędności"), 2)
    konta_agregat = {
        "oszczednosci": oszcz,
        "biezace": biezace,
        "razem": round(oszcz + biezace, 2),
        # poduszka bezpieczeństwa: ile miesięcy średnich wydatków pokrywają oszczędności
        "poduszka_miesiecy": round(oszcz / wyd_mies, 1) if wyd_mies > 0 else None,
    }

    return {
        "okres": {"od": od, "do": do, "miesiace": miesiace, "uwaga": uwaga},
        "kondycja_wyliczona": kondycja_wyliczona,
        "wydatki_per_miesiac": wydatki_miesiace,
        "wplywy_per_miesiac": wplywy_miesiace,
        "wplywy_zrodla_per_miesiac": wplywy_zrodla,
        "kategorie_per_miesiac": kat_miesiace,
        "top_produkty": produkty,
        "top_sklepy": sklepy,
        "wydatki_cykliczne": cykliczne,
        "wydatki_okazjonalne": okazje,
        "limity": limity,
        "cele": cele,
        "cel_przeplywowy": cel_przeplywowy,
        "konta_agregat": konta_agregat,
    }


def save_raport_ai(household_id: int, miesiace: int, kontekst: str | None,
                   raport_json: str, model: str, auto: bool = False) -> int:
    with get_db() as cur:
        cur.execute("""
            INSERT INTO raporty_ai (household_id, miesiace, kontekst, raport_json, model, auto)
            VALUES (%s,%s,%s,%s,%s,%s) RETURNING id
        """, (household_id, miesiace, kontekst, raport_json, model, auto))
        return cur.fetchone()["id"]


def get_all_household_ids() -> list[int]:
    """Wszystkie gospodarstwa — do zadań cyklicznych (auto-raport miesięczny)."""
    with get_db() as cur:
        cur.execute("SELECT id FROM households ORDER BY id")
        return [r["id"] for r in cur.fetchall()]


def auto_raport_istnieje(household_id: int, miesiac: str) -> bool:
    """Czy dla gospodarstwa jest już automatyczny raport z danego miesiąca (YYYY-MM).
    Chroni przed dublem przy restarcie serwisu / wielokrotnym odpaleniu joba."""
    with get_db() as cur:
        cur.execute("""SELECT 1 FROM raporty_ai
                       WHERE household_id=%s AND auto=TRUE
                         AND TO_CHAR(created_at,'YYYY-MM')=%s LIMIT 1""",
                    (household_id, miesiac))
        return cur.fetchone() is not None


def get_raport_ai(household_id: int, raport_id: int | None = None) -> dict | None:
    """Konkretny raport (raport_id) albo najnowszy."""
    with get_db() as cur:
        if raport_id is not None:
            cur.execute("SELECT * FROM raporty_ai WHERE id=%s AND household_id=%s",
                        (raport_id, household_id))
        else:
            cur.execute("""SELECT * FROM raporty_ai WHERE household_id=%s
                           ORDER BY created_at DESC, id DESC LIMIT 1""", (household_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def list_raporty_ai(household_id: int) -> list[dict]:
    with get_db() as cur:
        cur.execute("""SELECT id, miesiace, kontekst, model, created_at
                       FROM raporty_ai WHERE household_id=%s
                       ORDER BY created_at DESC, id DESC""", (household_id,))
        return [dict(r) for r in cur.fetchall()]


def delete_raport_ai(raport_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM raporty_ai WHERE id=%s AND household_id=%s",
                    (raport_id, household_id))
        return cur.rowcount > 0


def get_profil_ai(household_id: int) -> list[dict]:
    with get_db() as cur:
        cur.execute("""SELECT id, tresc, created_at FROM profil_ai
                       WHERE household_id=%s ORDER BY id""", (household_id,))
        return [dict(r) for r in cur.fetchall()]


def add_profil_ai(household_id: int, tresc: str) -> int:
    with get_db() as cur:
        cur.execute("INSERT INTO profil_ai (household_id, tresc) VALUES (%s,%s) RETURNING id",
                    (household_id, tresc))
        return cur.fetchone()["id"]


def delete_profil_ai(wpis_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM profil_ai WHERE id=%s AND household_id=%s",
                    (wpis_id, household_id))
        return cur.rowcount > 0


# --- households & users ---

def create_household(name: str) -> int:
    with get_db() as cur:
        cur.execute("INSERT INTO households (name) VALUES (%s) RETURNING id", (name,))
        return cur.fetchone()["id"]


def get_household(household_id: int) -> dict | None:
    with get_db() as cur:
        cur.execute("SELECT * FROM households WHERE id = %s", (household_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def create_or_update_user(firebase_uid: str, email: str, name: str, picture: str) -> tuple[int, str]:
    default_display = name.split()[0] if name and name.strip() else email.split("@")[0]
    with get_db() as cur:
        cur.execute(
            """INSERT INTO users (firebase_uid, email, name, picture, display_name, last_login) VALUES (%s,%s,%s,%s,%s,CURRENT_TIMESTAMP)
               ON CONFLICT (firebase_uid) DO UPDATE SET
               email=EXCLUDED.email, name=EXCLUDED.name, picture=EXCLUDED.picture,
               display_name=COALESCE(users.display_name, EXCLUDED.display_name),
               last_login=CURRENT_TIMESTAMP
               RETURNING id, display_name""",
            (firebase_uid, email, name, picture, default_display),
        )
        # RETURNING oddaje wiersz od razu — osobny SELECT był dodatkową podróżą
        # do bazy przy KAŻDYM żądaniu API (logowanie sprawdzane jest za każdym razem).
        row = cur.fetchone()
        return row["id"], row["display_name"] or default_display


def update_user_display_name(user_id: int, display_name: str) -> None:
    with get_db() as cur:
        cur.execute("UPDATE users SET display_name=%s WHERE id=%s", (display_name, user_id))


# ── Zarządzanie kontami (status + blokada AI + usuwanie) ──
_STATUSY_USERA = {"aktywny", "zawieszony"}


def get_user_flags(user_id: int) -> dict:
    with get_db() as cur:
        cur.execute("SELECT status, ai_zablokowane, awatar FROM users WHERE id=%s", (user_id,))
        row = cur.fetchone()
    if not row:
        return {"status": "aktywny", "ai_zablokowane": False, "awatar": None}
    return {"status": row["status"], "ai_zablokowane": bool(row["ai_zablokowane"]),
            "awatar": row["awatar"]}


def set_awatar(user_id: int, numer: int | None) -> None:
    with get_db() as cur:
        cur.execute("UPDATE users SET awatar=%s WHERE id=%s", (numer, user_id))


def set_user_status(user_id: int, status: str) -> bool:
    if status not in _STATUSY_USERA:
        return False
    with get_db() as cur:
        cur.execute("UPDATE users SET status=%s WHERE id=%s", (status, user_id))
        return cur.rowcount > 0


def set_user_ai(user_id: int, zablokowane: bool) -> bool:
    with get_db() as cur:
        cur.execute("UPDATE users SET ai_zablokowane=%s WHERE id=%s", (zablokowane, user_id))
        return cur.rowcount > 0


def get_all_users() -> list[dict]:
    with get_db() as cur:
        cur.execute("""
            SELECT u.id, u.email, u.display_name, u.status, u.ai_zablokowane, u.last_login,
                   h.name AS household_name, m.role
            FROM users u
            LEFT JOIN memberships m ON m.user_id = u.id
            LEFT JOIN households h ON h.id = m.household_id
            ORDER BY u.last_login DESC NULLS LAST, u.id
        """)
        return [dict(r) for r in cur.fetchall()]


def konwertuj_na_wirtualnego(household_id: int, nazwa: str) -> None:
    """Przy usuwaniu konta: zachowaj osobę jako „członka bez konta", żeby jej
    wydatki nie osierociły i dalej była widoczna na liście osób gospodarstwa."""
    if not nazwa:
        return
    with get_db() as cur:
        cur.execute("SELECT 1 FROM virtual_members WHERE household_id=%s AND name=%s", (household_id, nazwa))
        if cur.fetchone():
            return
        cur.execute("INSERT INTO virtual_members (household_id, name) VALUES (%s, %s)", (household_id, nazwa))


def delete_user(user_id: int) -> str | None:
    """Usuwa użytkownika i jego powiązania. Zwraca firebase_uid (do skasowania
    konta w Firebase) albo None. Dane gospodarstwa (wydatki) zostają — są wspólne."""
    with get_db() as cur:
        cur.execute("SELECT firebase_uid FROM users WHERE id=%s", (user_id,))
        row = cur.fetchone()
        if not row:
            return None
        fuid = row["firebase_uid"]
        cur.execute("DELETE FROM invitations WHERE created_by=%s", (user_id,))
        cur.execute("DELETE FROM konto_domyslne WHERE user_id=%s", (user_id,))
        cur.execute("DELETE FROM memberships WHERE user_id=%s", (user_id,))
        cur.execute("DELETE FROM users WHERE id=%s", (user_id,))
        return fuid


def leave_household(user_id: int, household_id: int, display_name: str | None) -> dict:
    """Wypisuje użytkownika z gospodarstwa. Konto logowania ZOSTAJE — po wyjściu
    można od razu założyć własne gospodarstwo na tym samym mailu.
    Wspólne dane zostają u pozostałych, a pseudonim odchodzącego jest zachowany
    jako „osoba bez konta", żeby jego wydatki nie osierociły.
    Zwraca {'pozostalo': liczba członków po wyjściu, 'osierocone': bool};
    'pozostalo' = -1 oznacza, że użytkownik wcale nie należał do gospodarstwa."""
    with get_db() as cur:
        cur.execute(
            "SELECT role FROM memberships WHERE user_id=%s AND household_id=%s",
            (user_id, household_id),
        )
        row = cur.fetchone()
        if not row:
            return {"pozostalo": -1, "osierocone": False}
        byl_wlascicielem = row["role"] == "owner"

        if display_name:
            cur.execute(
                "SELECT 1 FROM virtual_members WHERE household_id=%s AND name=%s",
                (household_id, display_name),
            )
            if not cur.fetchone():
                cur.execute(
                    "INSERT INTO virtual_members (household_id, name) VALUES (%s,%s)",
                    (household_id, display_name),
                )

        cur.execute("DELETE FROM konto_domyslne WHERE user_id=%s", (user_id,))
        cur.execute(
            "DELETE FROM invitations WHERE created_by=%s AND household_id=%s",
            (user_id, household_id),
        )
        cur.execute(
            "DELETE FROM memberships WHERE user_id=%s AND household_id=%s",
            (user_id, household_id),
        )

        cur.execute(
            "SELECT user_id, role FROM memberships WHERE household_id=%s ORDER BY user_id",
            (household_id,),
        )
        pozostali = cur.fetchall()
        # bez właściciela nikt nie pobierze kopii danych (/api/export jest owner-only),
        # więc po odejściu właściciela promujemy pierwszego z pozostałych
        if byl_wlascicielem and pozostali and not any(r["role"] == "owner" for r in pozostali):
            cur.execute(
                "UPDATE memberships SET role='owner' WHERE user_id=%s AND household_id=%s",
                (pozostali[0]["user_id"], household_id),
            )

        return {"pozostalo": len(pozostali), "osierocone": not pozostali}


def oznacz_gospodarstwo_do_usuniecia(household_id: int) -> None:
    """Start 30-dniowej karencji. Nie nadpisuje już trwającej."""
    with get_db() as cur:
        cur.execute(
            "UPDATE households SET usuwane_od=CURRENT_TIMESTAMP WHERE id=%s AND usuwane_od IS NULL",
            (household_id,),
        )


def anuluj_usuwanie_gospodarstwa(household_id: int) -> None:
    """Ktoś dołączył — gospodarstwo znów ma członka, karencja przestaje biec."""
    with get_db() as cur:
        cur.execute("UPDATE households SET usuwane_od=NULL WHERE id=%s", (household_id,))


# Tabele z household_id BEZ ON DELETE CASCADE — trzeba je wyczyścić ręcznie.
# Kolejność: dzieci przed rodzicami (konta na końcu, bo odwołują się do nich
# przelewy, wpływy, wydatki i cykliczne). Reszta tabel gospodarstwa ma kaskadę
# i zniknie sama przy DELETE FROM households.
_TABELE_BEZ_KASKADY = (
    "przelewy", "wydatki_cykliczne", "wplywy", "wydatki",
    "api_usage", "analiza_state", "invitations", "memberships", "konta",
)


def usun_gospodarstwo(household_id: int) -> None:
    """Nieodwracalnie kasuje gospodarstwo wraz ze wszystkimi danymi.

    Całość leci w jednej transakcji get_db() — jeśli w przyszłości dojdzie nowa
    tabela z household_id bez kaskady, końcowe DELETE FROM households wywali się
    na kluczu obcym i cała operacja się wycofa. Lepiej głośny błąd niż połowicznie
    skasowane gospodarstwo."""
    with get_db() as cur:
        for tabela in _TABELE_BEZ_KASKADY:
            cur.execute(f"DELETE FROM {tabela} WHERE household_id=%s", (household_id,))
        # część ustawień gospodarstwa (analiza_wyklucz, cel_przeplywowy) siedzi
        # w globalnej tabeli ustawien pod kluczem z sufiksem ":<household_id>"
        cur.execute("DELETE FROM ustawienia WHERE klucz LIKE %s", (f"%:{household_id}",))
        cur.execute("DELETE FROM households WHERE id=%s", (household_id,))


def purge_gospodarstwa(dni: int = 30) -> list[int]:
    """Kasuje gospodarstwa, którym minęła karencja. Warunek „zero członków" jest
    sprawdzany ponownie tutaj — gdyby ktoś w międzyczasie dołączył, gospodarstwo
    zostaje nietknięte. Zwraca listę usuniętych id."""
    with get_db() as cur:
        cur.execute(
            """SELECT h.id FROM households h
               WHERE h.usuwane_od IS NOT NULL
                 AND h.usuwane_od < CURRENT_TIMESTAMP - make_interval(days => %s)
                 AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.household_id = h.id)""",
            (dni,),
        )
        ids = [r["id"] for r in cur.fetchall()]
    for hid in ids:
        usun_gospodarstwo(hid)
    return ids


def rename_osoba_in_household(stara: str, nowa: str, household_id: int) -> int:
    with get_db() as cur:
        cur.execute(
            "UPDATE wydatki SET osoba=%s WHERE osoba=%s AND household_id=%s",
            (nowa, stara, household_id),
        )
        return cur.rowcount


def get_user_household(user_id: int) -> dict | None:
    with get_db() as cur:
        cur.execute(
            """SELECT h.id, h.name, m.role FROM households h
               JOIN memberships m ON m.household_id = h.id
               WHERE m.user_id = %s LIMIT 1""",
            (user_id,),
        )
        row = cur.fetchone()
        return dict(row) if row else None


def add_member(user_id: int, household_id: int, role: str = "member") -> None:
    with get_db() as cur:
        cur.execute(
            "INSERT INTO memberships (user_id, household_id, role) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
            (user_id, household_id, role),
        )
        # gospodarstwo znów ma członka — jeśli biegła karencja, zatrzymujemy ją
        cur.execute("UPDATE households SET usuwane_od=NULL WHERE id=%s", (household_id,))


def get_household_members(household_id: int) -> list[dict]:
    with get_db() as cur:
        cur.execute(
            """SELECT u.id, u.name, u.display_name, u.email, u.picture, u.awatar, m.role
               FROM users u JOIN memberships m ON m.user_id = u.id
               WHERE m.household_id = %s""",
            (household_id,),
        )
        return [dict(r) for r in cur.fetchall()]


def create_invitation(household_id: int, created_by: int) -> str:
    import secrets
    from datetime import datetime, timedelta
    code = secrets.token_urlsafe(8)
    expires = (datetime.utcnow() + timedelta(days=7)).isoformat()
    with get_db() as cur:
        cur.execute(
            "INSERT INTO invitations (code, household_id, created_by, expires_at) VALUES (%s,%s,%s,%s)",
            (code, household_id, created_by, expires),
        )
    return code


def use_invitation(code: str) -> dict | None:
    from datetime import datetime
    with get_db() as cur:
        cur.execute(
            """SELECT i.household_id, h.name AS household_name
               FROM invitations i JOIN households h ON h.id = i.household_id
               WHERE i.code = %s AND i.used = 0 AND i.expires_at > %s""",
            (code, datetime.utcnow().isoformat()),
        )
        row = cur.fetchone()
        if not row:
            return None
        cur.execute("UPDATE invitations SET used = 1 WHERE code = %s", (code,))
        return dict(row)


def get_all_households() -> list[dict]:
    with get_db() as cur:
        cur.execute(
            """SELECT h.id, h.name, h.created_at, COUNT(m.user_id) AS members
               FROM households h LEFT JOIN memberships m ON m.household_id = h.id
               GROUP BY h.id ORDER BY h.created_at DESC"""
        )
        return [dict(r) for r in cur.fetchall()]


_INPUT_PRICE  = 3.0 / 1_000_000   # USD per token
_OUTPUT_PRICE = 15.0 / 1_000_000  # USD per token


def log_api_usage(household_id: int | None, endpoint: str, input_tokens: int, output_tokens: int,
                  user_id: int | None = None) -> None:
    """`user_id` jest opcjonalny, bo zadania w tle (auto-raport) nie mają
    użytkownika — tam koszt należy do gospodarstwa, nie do osoby."""
    with get_db() as cur:
        cur.execute(
            "INSERT INTO api_usage (household_id, endpoint, input_tokens, output_tokens, user_id) "
            "VALUES (%s,%s,%s,%s,%s)",
            (household_id, endpoint, input_tokens, output_tokens, user_id),
        )


def get_usage_stats() -> list[dict]:
    with get_db() as cur:
        cur.execute("""
            SELECT
                COALESCE(h.name, '(brak)') AS household_name,
                u.household_id,
                COUNT(*) AS calls,
                SUM(u.input_tokens) AS input_tokens,
                SUM(u.output_tokens) AS output_tokens,
                ROUND(CAST(SUM(u.input_tokens * 3.0 + u.output_tokens * 15.0) / 1000000 AS numeric), 4) AS cost_usd,
                MAX(u.created_at) AS last_call
            FROM api_usage u
            LEFT JOIN households h ON h.id = u.household_id
            GROUP BY u.household_id, h.name
            ORDER BY cost_usd DESC
        """)
        return [dict(r) for r in cur.fetchall()]


# Przypisanie wywołania AI do modułu. JEDNO MIEJSCE, bo ta sama reguła jest
# potrzebna w kilku zestawieniach i rozjechanie się ich znaczyłoby, że koszty
# w dwóch tabelach tego samego panelu się nie zgadzają. `{t}` to alias tabeli
# `api_usage` w konkretnym zapytaniu.
#
# UWAGA: pojedynczy znak `%`, nie podwojony — oba zapytania, które tego używają,
# nie przekazują parametrów, więc psycopg2 nie interpretuje tu `%` w żaden
# sposób. Gdyby kiedyś doszedł parametr, znaki trzeba będzie podwoić.
_MODUL_SQL = """CASE
                    WHEN {t}.endpoint LIKE 'eat-%'    THEN 'eat'
                    WHEN {t}.endpoint LIKE 'health-%' THEN 'health'
                    WHEN {t}.endpoint LIKE 'task-%'   THEN 'task'
                    ELSE 'finance'
                END"""


def get_usage_wg_modulu() -> list[dict]:
    """Koszty AI rozbite na moduły aplikacji.

    Moduł rozpoznajemy po przedrostku etykiety endpointu — patrz `_MODUL_SQL`.
    Dołożenie kolejnego modułu nie wymaga migracji: wystarczy nazywać jego
    wywołania z własnym przedrostkiem i dopisać go do tej jednej reguły."""
    with get_db() as cur:
        cur.execute(f"""
            SELECT
                {_MODUL_SQL.format(t='u')} AS modul,
                u.endpoint,
                COUNT(*) AS calls,
                SUM(u.input_tokens)  AS input_tokens,
                SUM(u.output_tokens) AS output_tokens,
                ROUND(CAST(SUM(u.input_tokens * 3.0 + u.output_tokens * 15.0) / 1000000 AS numeric), 4) AS cost_usd,
                MAX(u.created_at) AS last_call
            FROM api_usage u
            GROUP BY modul, u.endpoint
            ORDER BY modul, cost_usd DESC
        """)
        return [dict(r) for r in cur.fetchall()]


def get_usage_wg_uzytkownika() -> list[dict]:
    """Koszty AI per osoba, z podziałem na moduł. Wiersze sprzed dodania kolumny
    `user_id` mają NULL i pokazują się jako „(przed rejestrowaniem osoby)" —
    kasowanie ich zabrałoby historię kosztów gospodarstwa."""
    with get_db() as cur:
        cur.execute(f"""
            SELECT
                COALESCE(u.display_name, u.name, '(przed rejestrowaniem osoby)') AS osoba,
                COALESCE(h.name, '(brak)') AS household_name,
                {_MODUL_SQL.format(t='a')} AS modul,
                COUNT(*) AS calls,
                ROUND(CAST(SUM(a.input_tokens * 3.0 + a.output_tokens * 15.0) / 1000000 AS numeric), 4) AS cost_usd,
                MAX(a.created_at) AS last_call
            FROM api_usage a
            LEFT JOIN users u ON u.id = a.user_id
            LEFT JOIN households h ON h.id = a.household_id
            GROUP BY osoba, household_name, modul
            ORDER BY cost_usd DESC
        """)
        return [dict(r) for r in cur.fetchall()]


def get_admin_stats() -> list[dict]:
    with get_db() as cur:
        cur.execute("""
            SELECT
                h.id,
                h.name AS household_name,
                h.created_at AS household_created,
                COUNT(DISTINCT m.user_id) AS members_count,
                MAX(u.last_login) AS last_login,
                STRING_AGG(DISTINCT u.display_name || ' <' || u.email || '>', ', ') AS members_info,
                COUNT(DISTINCT w.id) AS wydatki_count,
                MAX(w.created_at) AS last_wydatek,
                COALESCE(MAX(au.calls), 0) AS api_calls,
                COALESCE(MAX(au.cost_usd), 0) AS cost_usd,
                COALESCE(MAX(au.analiza_calls), 0) AS analiza_calls,
                COALESCE(MAX(au.analiza_cost_usd), 0) AS analiza_cost_usd,
                COALESCE(MAX(au.last_call), NULL) AS last_api_call
            FROM households h
            LEFT JOIN memberships m ON m.household_id = h.id
            LEFT JOIN users u ON u.id = m.user_id
            LEFT JOIN wydatki w ON w.household_id = h.id
            LEFT JOIN (
                SELECT household_id,
                       COUNT(*) AS calls,
                       ROUND(CAST(SUM(input_tokens * 3.0 + output_tokens * 15.0) / 1000000 AS numeric), 4) AS cost_usd,
                       COUNT(*) FILTER (WHERE endpoint = 'analiza-raport') AS analiza_calls,
                       ROUND(CAST(SUM(CASE WHEN endpoint = 'analiza-raport'
                                           THEN input_tokens * 3.0 + output_tokens * 15.0
                                           ELSE 0 END) / 1000000 AS numeric), 4) AS analiza_cost_usd,
                       MAX(created_at) AS last_call
                FROM api_usage GROUP BY household_id
            ) au ON au.household_id = h.id
            GROUP BY h.id, h.name, h.created_at
            ORDER BY last_login DESC NULLS LAST
        """)
        return [dict(r) for r in cur.fetchall()]


def get_virtual_members(household_id: int) -> list[dict]:
    with get_db() as cur:
        cur.execute("SELECT id, name FROM virtual_members WHERE household_id=%s ORDER BY name", (household_id,))
        return [dict(r) for r in cur.fetchall()]


def add_virtual_member(household_id: int, name: str) -> int:
    with get_db() as cur:
        cur.execute(
            "INSERT INTO virtual_members (household_id, name) VALUES (%s,%s) RETURNING id",
            (household_id, name),
        )
        return cur.fetchone()["id"]


def delete_virtual_member(vm_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM virtual_members WHERE id=%s AND household_id=%s", (vm_id, household_id))
        return cur.rowcount > 0


def claim_virtual_member(vm_id: int, household_id: int, user_id: int, display_name: str) -> bool:
    with get_db() as cur:
        cur.execute("SELECT name FROM virtual_members WHERE id=%s AND household_id=%s", (vm_id, household_id))
        row = cur.fetchone()
        if not row:
            return False
        old_name = row["name"]
        cur.execute("UPDATE users SET display_name=%s WHERE id=%s", (display_name or old_name, user_id))
        cur.execute(
            "UPDATE wydatki SET osoba=%s WHERE osoba=%s AND household_id=%s",
            (display_name or old_name, old_name, household_id),
        )
        cur.execute("DELETE FROM virtual_members WHERE id=%s", (vm_id,))
        return True


def get_analiza_state(household_id: int) -> dict:
    import json as _json
    with get_db() as cur:
        cur.execute(
            "SELECT groups_json, pool_json FROM analiza_state WHERE household_id = %s",
            (household_id,)
        )
        row = cur.fetchone()
        if not row:
            return {"groups": [], "pool": []}
        return {"groups": _json.loads(row["groups_json"]), "pool": _json.loads(row["pool_json"])}


def save_analiza_state(household_id: int, groups_json: str, pool_json: str) -> None:
    with get_db() as cur:
        cur.execute(
            """INSERT INTO analiza_state (household_id, groups_json, pool_json)
               VALUES (%s, %s, %s)
               ON CONFLICT (household_id) DO UPDATE SET
               groups_json=EXCLUDED.groups_json, pool_json=EXCLUDED.pool_json,
               updated_at=CURRENT_TIMESTAMP""",
            (household_id, groups_json, pool_json),
        )


# --- konta ---

def get_konta(household_id: int) -> list[dict]:
    with get_db() as cur:
        cur.execute("""
            SELECT k.*,
                ROUND(CAST(
                    k.saldo_poczatkowe
                    + COALESCE((SELECT SUM(w.kwota) FROM wplywy w WHERE w.konto_id = k.id), 0)
                    - COALESCE((SELECT SUM(wy.suma) FROM wydatki wy WHERE wy.konto_id = k.id), 0)
                    - COALESCE((SELECT SUM(p.kwota) FROM przelewy p WHERE p.konto_z_id = k.id), 0)
                    + COALESCE((SELECT SUM(p.kwota) FROM przelewy p WHERE p.konto_na_id = k.id), 0)
                AS numeric), 2) AS saldo_biezace
            FROM konta k
            WHERE k.household_id = %s AND k.aktywne = TRUE
            ORDER BY k.created_at
        """, (household_id,))
        return [dict(r) for r in cur.fetchall()]


def create_konto(household_id: int, nazwa: str, typ: str, osoba: str | None,
                 waluta: str, saldo_poczatkowe: float) -> dict:
    with get_db() as cur:
        cur.execute(
            "INSERT INTO konta (household_id, nazwa, typ, osoba, waluta, saldo_poczatkowe) VALUES (%s,%s,%s,%s,%s,%s) RETURNING *",
            (household_id, nazwa, typ, osoba or None, waluta, saldo_poczatkowe),
        )
        row = dict(cur.fetchone())
        row["saldo_biezace"] = float(saldo_poczatkowe)
        return row


def update_konto(konto_id: int, household_id: int, nazwa: str, typ: str,
                 osoba: str | None, waluta: str, saldo_poczatkowe: float) -> bool:
    with get_db() as cur:
        cur.execute(
            "UPDATE konta SET nazwa=%s, typ=%s, osoba=%s, waluta=%s, saldo_poczatkowe=%s WHERE id=%s AND household_id=%s AND aktywne=TRUE",
            (nazwa, typ, osoba or None, waluta, saldo_poczatkowe, konto_id, household_id),
        )
        return cur.rowcount > 0


def delete_konto(konto_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute("SELECT id FROM konta WHERE id=%s AND household_id=%s AND aktywne=TRUE", (konto_id, household_id))
        if not cur.fetchone():
            return False
        cur.execute("UPDATE wydatki SET konto_id=NULL WHERE konto_id=%s", (konto_id,))
        cur.execute("UPDATE wplywy SET konto_id=NULL WHERE konto_id=%s", (konto_id,))
        cur.execute("UPDATE przelewy SET konto_z_id=NULL WHERE konto_z_id=%s", (konto_id,))
        cur.execute("UPDATE przelewy SET konto_na_id=NULL WHERE konto_na_id=%s", (konto_id,))
        # Przelew, któremu zniknęły OBIE nogi, nie znaczy już nic — kasujemy.
        # Warunek `household_id` jest tu konieczny, a nie kosmetyczny: bez niego
        # usunięcie jednego konta czyściło osierocone przelewy WSZYSTKICH
        # gospodarstw, nie tylko swojego.
        cur.execute("DELETE FROM przelewy WHERE household_id=%s "
                    "AND konto_z_id IS NULL AND konto_na_id IS NULL", (household_id,))
        cur.execute("UPDATE wydatki_cykliczne SET konto_id=NULL WHERE konto_id=%s", (konto_id,))
        cur.execute("DELETE FROM konta WHERE id=%s", (konto_id,))
        return True


def _saldo_konta_na_date(cur, konto_id: int, data: str) -> float:
    cur.execute("SELECT saldo_poczatkowe FROM konta WHERE id=%s", (konto_id,))
    row = cur.fetchone()
    if not row:
        return 0.0
    sp = float(row["saldo_poczatkowe"])
    cur.execute("SELECT COALESCE(SUM(kwota), 0) AS s FROM wplywy WHERE konto_id=%s AND data <= %s", (konto_id, data))
    wp = float(cur.fetchone()["s"])
    cur.execute("SELECT COALESCE(SUM(suma), 0) AS s FROM wydatki WHERE konto_id=%s AND data <= %s", (konto_id, data))
    wy = float(cur.fetchone()["s"])
    cur.execute("SELECT COALESCE(SUM(kwota), 0) AS s FROM przelewy WHERE konto_z_id=%s AND data <= %s", (konto_id, data))
    p_out = float(cur.fetchone()["s"])
    cur.execute("SELECT COALESCE(SUM(kwota), 0) AS s FROM przelewy WHERE konto_na_id=%s AND data <= %s", (konto_id, data))
    p_in = float(cur.fetchone()["s"])
    return round(sp + wp - wy - p_out + p_in, 2)


# --- wplywy ---

def get_wplywy(household_id: int, month: str | None = None, konto_id: int | None = None) -> list[dict]:
    conditions = ["w.household_id = %s"]
    params: list = [household_id]
    if month:
        conditions.append("TO_CHAR(w.data, 'YYYY-MM') = %s"); params.append(month)
    if konto_id is not None:
        conditions.append("w.konto_id = %s"); params.append(konto_id)
    where = "WHERE " + " AND ".join(conditions)
    with get_db() as cur:
        cur.execute(f"""
            SELECT w.*, k.nazwa AS konto_nazwa
            FROM wplywy w LEFT JOIN konta k ON k.id = w.konto_id
            {where} ORDER BY w.data DESC, w.created_at DESC
        """, params)
        return [dict(r) for r in cur.fetchall()]


def create_wplyw(household_id: int, data: str, kwota: float, osoba: str | None,
                 kategoria: str, opis: str | None, konto_id: int | None) -> dict:
    with get_db() as cur:
        cur.execute(
            "INSERT INTO wplywy (household_id, data, kwota, osoba, kategoria, opis, konto_id) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *",
            (household_id, data, kwota, osoba or None, kategoria, opis or None, konto_id or None),
        )
        return dict(cur.fetchone())


def update_wplyw(wplyw_id: int, household_id: int, data: str, kwota: float,
                 osoba: str | None, kategoria: str, opis: str | None,
                 konto_id: int | None) -> bool:
    with get_db() as cur:
        cur.execute(
            """UPDATE wplywy SET data=%s, kwota=%s, osoba=%s, kategoria=%s, opis=%s, konto_id=%s
               WHERE id=%s AND household_id=%s""",
            (data, kwota, osoba or None, kategoria, opis or None, konto_id or None,
             wplyw_id, household_id),
        )
        return cur.rowcount > 0


def delete_wplyw(wplyw_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM wplywy WHERE id=%s AND household_id=%s", (wplyw_id, household_id))
        return cur.rowcount > 0


def wplyw_do_salda_poczatkowego(wplyw_id: int, household_id: int) -> bool:
    """Przenosi wpływ do salda początkowego jego konta: dodaje kwotę do
    saldo_poczatkowe i usuwa wpis wpływu. Saldo konta zostaje bez zmian, ale
    kwota przestaje być liczona jako przychód (bilans). Dla błędnie wpisanych
    kwot startowych („stan konta na dzień X" wpisany jako wpływ). Atomowo w
    jednej transakcji."""
    with get_db() as cur:
        cur.execute("SELECT kwota, konto_id FROM wplywy WHERE id=%s AND household_id=%s",
                    (wplyw_id, household_id))
        row = cur.fetchone()
        if not row:
            raise ValueError("Wpływ nie istnieje")
        if row["konto_id"] is None:
            raise ValueError("Wpływ nie jest przypisany do konta — nie można przenieść do salda początkowego")
        cur.execute("UPDATE konta SET saldo_poczatkowe = saldo_poczatkowe + %s WHERE id=%s AND household_id=%s",
                    (row["kwota"], row["konto_id"], household_id))
        if cur.rowcount == 0:
            raise ValueError("Konto nie istnieje")
        cur.execute("DELETE FROM wplywy WHERE id=%s AND household_id=%s", (wplyw_id, household_id))
        return True


# --- historia konta ---

def get_historia_konta(konto_id: int, household_id: int, month: str | None = None) -> list[dict]:
    conds_w = ["wy.konto_id = %s", "wy.household_id = %s"]
    conds_wp = ["wp.konto_id = %s", "wp.household_id = %s"]
    conds_pz = ["pz.konto_z_id = %s", "pz.household_id = %s"]
    conds_pn = ["pn.konto_na_id = %s", "pn.household_id = %s"]
    p_w: list = [konto_id, household_id]
    p_wp: list = [konto_id, household_id]
    p_pz: list = [konto_id, household_id]
    p_pn: list = [konto_id, household_id]
    if month:
        conds_w.append("TO_CHAR(wy.data,'YYYY-MM') = %s"); p_w.append(month)
        conds_wp.append("TO_CHAR(wp.data,'YYYY-MM') = %s"); p_wp.append(month)
        conds_pz.append("TO_CHAR(pz.data,'YYYY-MM') = %s"); p_pz.append(month)
        conds_pn.append("TO_CHAR(pn.data,'YYYY-MM') = %s"); p_pn.append(month)
    where_w = "WHERE " + " AND ".join(conds_w)
    where_wp = "WHERE " + " AND ".join(conds_wp)
    where_pz = "WHERE " + " AND ".join(conds_pz)
    where_pn = "WHERE " + " AND ".join(conds_pn)
    with get_db() as cur:
        cur.execute(f"""
            SELECT 'wydatek' AS typ, wy.id, wy.data,
                   ROUND(CAST(-wy.suma AS numeric), 2) AS kwota,
                   COALESCE(wy.sklep, wy.notatki, 'Wydatek') AS opis, wy.osoba
            FROM wydatki wy {where_w}
            UNION ALL
            SELECT 'wplyw' AS typ, wp.id, wp.data,
                   ROUND(CAST(wp.kwota AS numeric), 2) AS kwota,
                   COALESCE(wp.opis, wp.kategoria) AS opis, wp.osoba
            FROM wplywy wp {where_wp}
            UNION ALL
            SELECT 'przelew' AS typ, pz.id, pz.data,
                   ROUND(CAST(-pz.kwota AS numeric), 2) AS kwota,
                   'Przelew → ' || COALESCE((SELECT nazwa FROM konta WHERE id = pz.konto_na_id), 'konto usunięte')
                       || COALESCE(' — ' || pz.opis, '') AS opis,
                   NULL AS osoba
            FROM przelewy pz {where_pz}
            UNION ALL
            SELECT 'przelew' AS typ, pn.id, pn.data,
                   ROUND(CAST(pn.kwota AS numeric), 2) AS kwota,
                   'Przelew ← ' || COALESCE((SELECT nazwa FROM konta WHERE id = pn.konto_z_id), 'konto usunięte')
                       || COALESCE(' — ' || pn.opis, '') AS opis,
                   NULL AS osoba
            FROM przelewy pn {where_pn}
            ORDER BY data DESC, opis
        """, p_w + p_wp + p_pz + p_pn)
        return [dict(r) for r in cur.fetchall()]


# --- inwentaryzacje ---

def get_inwentaryzacje(konto_id: int, household_id: int) -> list[dict]:
    with get_db() as cur:
        cur.execute("""
            SELECT i.* FROM inwentaryzacje i
            JOIN konta k ON k.id = i.konto_id
            WHERE i.konto_id = %s AND k.household_id = %s
            ORDER BY i.data DESC, i.created_at DESC
        """, (konto_id, household_id))
        return [dict(r) for r in cur.fetchall()]


# --- przelewy między kontami ---

def create_przelew(household_id: int, data: str, kwota: float,
                   konto_z_id: int, konto_na_id: int, opis: str | None,
                   cel_id: int | None = None, zrodlo_wplaty: str = "przelew") -> dict:
    with get_db() as cur:
        cur.execute("SELECT id, waluta FROM konta WHERE id IN (%s,%s) AND household_id=%s AND aktywne=TRUE",
                    (konto_z_id, konto_na_id, household_id))
        rows = {r["id"]: r for r in cur.fetchall()}
        if konto_z_id not in rows or konto_na_id not in rows:
            raise ValueError("Konto nie istnieje")
        if rows[konto_z_id]["waluta"] != rows[konto_na_id]["waluta"]:
            raise ValueError("Przelewy możliwe tylko między kontami w tej samej walucie")
        cur.execute(
            "INSERT INTO przelewy (household_id, data, kwota, konto_z_id, konto_na_id, opis) VALUES (%s,%s,%s,%s,%s,%s) RETURNING *",
            (household_id, data, kwota, konto_z_id, konto_na_id, opis or None),
        )
        przelew = dict(cur.fetchone())
        # przelew powiązany z subkontem (celem): znak wpłaty zależy od strony przelewu —
        # NA konto celu = wpłata dodatnia (zasilenie), Z konta celu = ujemna (wypłata z celu).
        if cel_id:
            cur.execute("SELECT konto_id FROM cele WHERE id=%s AND household_id=%s AND aktywny=TRUE", (cel_id, household_id))
            row = cur.fetchone()
            if row:
                if row["konto_id"] == konto_na_id:
                    znak, tekst = 1, opis or "Przelew na cel"
                elif row["konto_id"] == konto_z_id:
                    znak, tekst = -1, opis or "Wypłata z celu"
                else:
                    znak = 0
                if znak:
                    cur.execute(
                        "INSERT INTO cele_wplaty (cel_id, data, kwota, opis, zrodlo, przelew_id) VALUES (%s,%s,%s,%s,%s,%s)",
                        (cel_id, data, znak * kwota, tekst, zrodlo_wplaty, przelew["id"]),
                    )
        return przelew


def get_przelew(przelew_id: int, household_id: int) -> dict | None:
    with get_db() as cur:
        cur.execute("SELECT * FROM przelewy WHERE id=%s AND household_id=%s",
                    (przelew_id, household_id))
        row = cur.fetchone()
        return dict(row) if row else None


def update_przelew(przelew_id: int, household_id: int, data: str, kwota: float,
                   konto_z_id: int, konto_na_id: int, opis: str | None) -> bool:
    with get_db() as cur:
        cur.execute("SELECT id, waluta FROM konta WHERE id IN (%s,%s) AND household_id=%s AND aktywne=TRUE",
                    (konto_z_id, konto_na_id, household_id))
        rows = {r["id"]: r for r in cur.fetchall()}
        if konto_z_id not in rows or konto_na_id not in rows:
            raise ValueError("Konto nie istnieje")
        if rows[konto_z_id]["waluta"] != rows[konto_na_id]["waluta"]:
            raise ValueError("Przelewy możliwe tylko między kontami w tej samej walucie")
        cur.execute(
            """UPDATE przelewy SET data=%s, kwota=%s, konto_z_id=%s, konto_na_id=%s, opis=%s
               WHERE id=%s AND household_id=%s""",
            (data, kwota, konto_z_id, konto_na_id, opis or None, przelew_id, household_id),
        )
        if cur.rowcount == 0:
            return False
        # przelicz powiązane wpłaty na cel: nowa kwota/znak wg nowych kont, albo skasuj
        cur.execute("""SELECT wp.id, c.konto_id FROM cele_wplaty wp
                       JOIN cele c ON c.id = wp.cel_id WHERE wp.przelew_id=%s""", (przelew_id,))
        for wp in cur.fetchall():
            if wp["konto_id"] == konto_na_id:
                cur.execute("UPDATE cele_wplaty SET kwota=%s, data=%s WHERE id=%s", (kwota, data, wp["id"]))
            elif wp["konto_id"] == konto_z_id:
                cur.execute("UPDATE cele_wplaty SET kwota=%s, data=%s WHERE id=%s", (-kwota, data, wp["id"]))
            else:
                cur.execute("DELETE FROM cele_wplaty WHERE id=%s", (wp["id"],))
        return True


def delete_przelew(przelew_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM przelewy WHERE id=%s AND household_id=%s", (przelew_id, household_id))
        return cur.rowcount > 0


def get_samouczek(user_id: int) -> bool:
    with get_db() as cur:
        cur.execute("SELECT samouczek FROM users WHERE id=%s", (user_id,))
        row = cur.fetchone()
        return bool(row and row["samouczek"])


def set_samouczek(user_id: int) -> None:
    with get_db() as cur:
        cur.execute("UPDATE users SET samouczek=TRUE WHERE id=%s", (user_id,))


# --- ustawienia globalne ---

def get_ustawienie(klucz: str, domyslna: str) -> str:
    with get_db() as cur:
        cur.execute("SELECT wartosc FROM ustawienia WHERE klucz=%s", (klucz,))
        row = cur.fetchone()
        return row["wartosc"] if row else domyslna


def set_ustawienie(klucz: str, wartosc: str) -> None:
    with get_db() as cur:
        cur.execute("""INSERT INTO ustawienia (klucz, wartosc) VALUES (%s,%s)
                       ON CONFLICT (klucz) DO UPDATE SET wartosc=EXCLUDED.wartosc""",
                    (klucz, wartosc))


# --- kategorie pomijane w analizie (per gospodarstwo) ---
# Klucz namespace'owany household_id, bo tabela ustawienia jest globalna (klucz PK).

def get_analiza_wyklucz(household_id: int) -> list[str]:
    raw = get_ustawienie(f"analiza_wyklucz:{household_id}", "[]")
    try:
        val = json.loads(raw)
        return [str(x) for x in val] if isinstance(val, list) else []
    except (ValueError, TypeError):
        return []


def set_analiza_wyklucz(household_id: int, kategorie: list[str]) -> None:
    set_ustawienie(f"analiza_wyklucz:{household_id}",
                   json.dumps(list(kategorie), ensure_ascii=False))


# --- wydatki cykliczne ---

def get_cykliczne(household_id: int) -> list[dict]:
    with get_db() as cur:
        cur.execute("""
            SELECT c.*, k.nazwa AS konto_nazwa, kn.nazwa AS konto_na_nazwa
            FROM wydatki_cykliczne c
            LEFT JOIN konta k ON k.id = c.konto_id
            LEFT JOIN konta kn ON kn.id = c.konto_na_id
            WHERE c.household_id = %s ORDER BY c.aktywne DESC, c.nazwa
        """, (household_id,))
        return [dict(r) for r in cur.fetchall()]


def create_cykliczny(household_id: int, nazwa: str, kwota: float, dzien: int,
                     kategoria_glowna: str, kategoria: str, osoba: str,
                     konto_id: int | None, od_miesiaca: str,
                     limit_naliczen: int | None = None,
                     automatyczny: bool = True, typ: str = "wydatek",
                     konto_na_id: int | None = None,
                     do_miesiaca: str | None = None,
                     cel_id: int | None = None) -> dict:
    with get_db() as cur:
        cur.execute(
            """INSERT INTO wydatki_cykliczne
               (household_id, nazwa, kwota, dzien, kategoria_glowna, kategoria, osoba, konto_id, od_miesiaca, limit_naliczen, automatyczny, typ, konto_na_id, do_miesiaca, cel_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (household_id, nazwa, kwota, dzien, kategoria_glowna, kategoria, osoba, konto_id or None,
             od_miesiaca, limit_naliczen, automatyczny, typ, konto_na_id or None, do_miesiaca, cel_id or None),
        )
        return dict(cur.fetchone())


def update_cykliczny(cykliczny_id: int, household_id: int, nazwa: str, kwota: float,
                     dzien: int, kategoria_glowna: str, kategoria: str, osoba: str,
                     konto_id: int | None, aktywne: bool,
                     limit_naliczen: int | None = None,
                     automatyczny: bool = True, typ: str = "wydatek",
                     konto_na_id: int | None = None,
                     do_miesiaca: str | None = None,
                     cel_id: int | None = None) -> bool:
    with get_db() as cur:
        cur.execute(
            """UPDATE wydatki_cykliczne SET nazwa=%s, kwota=%s, dzien=%s, kategoria_glowna=%s,
               kategoria=%s, osoba=%s, konto_id=%s, aktywne=%s, limit_naliczen=%s, automatyczny=%s,
               typ=%s, konto_na_id=%s, do_miesiaca=%s, cel_id=%s
               WHERE id=%s AND household_id=%s""",
            (nazwa, kwota, dzien, kategoria_glowna, kategoria, osoba, konto_id or None,
             aktywne, limit_naliczen, automatyczny, typ, konto_na_id or None, do_miesiaca, cel_id or None,
             cykliczny_id, household_id),
        )
        return cur.rowcount > 0


def delete_cykliczny(cykliczny_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM wydatki_cykliczne WHERE id=%s AND household_id=%s", (cykliczny_id, household_id))
        return cur.rowcount > 0


# ══════════════════ MODUŁ CELE ══════════════════

# --- cele oszczędnościowe (koperty) ---

def _analiza_celu(cur, c: dict) -> dict:
    """Dolicza do celu: odłożone, brakuje, postęp %, tempo miesięczne (śr. z 3 mies.),
    prognozę i — przy terminie — wymagane tempo oraz czy na czas."""
    from datetime import date as _date
    c["kwota_docelowa"] = float(c["kwota_docelowa"])
    cur.execute("SELECT COALESCE(SUM(kwota), 0) AS s FROM cele_wplaty WHERE cel_id=%s", (c["id"],))
    c["odlozone"] = round(float(cur.fetchone()["s"]), 2)
    c["brakuje"] = round(max(c["kwota_docelowa"] - c["odlozone"], 0), 2)
    c["postep"] = round(min(c["odlozone"] / c["kwota_docelowa"], 1) * 100, 1) if c["kwota_docelowa"] > 0 else 0
    # tempo: suma wpłat z ostatnich 3 miesięcy / 3
    cur.execute("SELECT COALESCE(SUM(kwota), 0) AS s FROM cele_wplaty WHERE cel_id=%s AND data >= CURRENT_DATE - INTERVAL '3 months'", (c["id"],))
    tempo = round(float(cur.fetchone()["s"]) / 3.0, 2)
    c["tempo_miesieczne"] = tempo
    c["prognoza_miesiecy"] = round(c["brakuje"] / tempo, 1) if (c["brakuje"] > 0 and tempo > 0) else (0 if c["brakuje"] <= 0 else None)
    # termin → wymagane tempo i status
    c["wymagane_miesieczne"] = None
    c["na_czas"] = None
    if c.get("termin") and c["brakuje"] > 0:
        termin = c["termin"] if isinstance(c["termin"], _date) else _date.fromisoformat(str(c["termin"])[:10])
        dni = (termin - _date.today()).days
        mies = max(dni / 30.44, 0.1)
        c["wymagane_miesieczne"] = round(c["brakuje"] / mies, 2)
        c["na_czas"] = tempo >= c["wymagane_miesieczne"]
    return c


def get_cele(household_id: int, aktywne: bool = True) -> list[dict]:
    with get_db() as cur:
        cur.execute("""
            SELECT c.*, k.nazwa AS konto_nazwa,
                   ROUND(CAST(COALESCE(k.saldo_poczatkowe, 0)
                       + COALESCE((SELECT SUM(wp.kwota) FROM wplywy wp WHERE wp.konto_id = k.id), 0)
                       - COALESCE((SELECT SUM(w2.suma) FROM wydatki w2 WHERE w2.konto_id = k.id), 0)
                       + COALESCE((SELECT SUM(pn.kwota) FROM przelewy pn WHERE pn.konto_na_id = k.id), 0)
                       - COALESCE((SELECT SUM(pz.kwota) FROM przelewy pz WHERE pz.konto_z_id = k.id), 0)
                   AS numeric), 2) AS saldo_konta
            FROM cele c LEFT JOIN konta k ON k.id = c.konto_id
            WHERE c.household_id = %s AND c.aktywny = %s
            ORDER BY c.created_at
        """, (household_id, aktywne))
        cele = [dict(r) for r in cur.fetchall()]
        for c in cele:
            if c.get("saldo_konta") is not None:
                c["saldo_konta"] = float(c["saldo_konta"])
            _analiza_celu(cur, c)
        return cele


def create_cel(household_id: int, nazwa: str, kwota_docelowa: float,
               konto_id: int | None, termin: str | None) -> dict:
    with get_db() as cur:
        cur.execute(
            "INSERT INTO cele (household_id, nazwa, kwota_docelowa, konto_id, termin) VALUES (%s,%s,%s,%s,%s) RETURNING *",
            (household_id, nazwa, kwota_docelowa, konto_id or None, termin or None),
        )
        return dict(cur.fetchone())


def update_cel(cel_id: int, household_id: int, nazwa: str, kwota_docelowa: float,
               konto_id: int | None, termin: str | None) -> bool:
    with get_db() as cur:
        cur.execute(
            "UPDATE cele SET nazwa=%s, kwota_docelowa=%s, konto_id=%s, termin=%s WHERE id=%s AND household_id=%s",
            (nazwa, kwota_docelowa, konto_id or None, termin or None, cel_id, household_id),
        )
        return cur.rowcount > 0


def delete_cel(cel_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM cele WHERE id=%s AND household_id=%s", (cel_id, household_id))
        return cur.rowcount > 0


def set_cel_aktywny(cel_id: int, household_id: int, aktywny: bool) -> bool:
    with get_db() as cur:
        cur.execute("UPDATE cele SET aktywny=%s WHERE id=%s AND household_id=%s",
                    (aktywny, cel_id, household_id))
        return cur.rowcount > 0


def get_cel_wplaty(cel_id: int, household_id: int) -> list[dict]:
    with get_db() as cur:
        cur.execute("""SELECT wp.* FROM cele_wplaty wp JOIN cele c ON c.id = wp.cel_id
                       WHERE wp.cel_id=%s AND c.household_id=%s ORDER BY wp.data DESC, wp.id DESC""",
                    (cel_id, household_id))
        return [dict(r) for r in cur.fetchall()]


def add_cel_wplata(cel_id: int, household_id: int, data: str, kwota: float,
                   opis: str | None, zrodlo: str = "reczna") -> dict:
    with get_db() as cur:
        cur.execute("SELECT id FROM cele WHERE id=%s AND household_id=%s", (cel_id, household_id))
        if not cur.fetchone():
            raise ValueError("Cel nie istnieje")
        cur.execute(
            "INSERT INTO cele_wplaty (cel_id, data, kwota, opis, zrodlo) VALUES (%s,%s,%s,%s,%s) RETURNING *",
            (cel_id, data, kwota, opis or None, zrodlo),
        )
        return dict(cur.fetchone())


def przesun_miedzy_celami(household_id: int, cel_z_id: int, cel_na_id: int,
                          kwota: float, data: str, opis: str | None) -> bool:
    """Przesuwa kwotę z jednego subkonta (celu) na drugie. Ten sam rachunek =
    tylko dwie wpłaty (bez ruchu pieniędzy). Różne rachunki = realny przelew
    między nimi + dwie wpłaty. Atomowo."""
    if cel_z_id == cel_na_id:
        raise ValueError("Wybierz dwa różne cele")
    with get_db() as cur:
        cur.execute("SELECT id, konto_id, nazwa FROM cele WHERE id IN (%s,%s) AND household_id=%s AND aktywny=TRUE",
                    (cel_z_id, cel_na_id, household_id))
        rows = {r["id"]: r for r in cur.fetchall()}
        if cel_z_id not in rows or cel_na_id not in rows:
            raise ValueError("Cel nie istnieje")
        kz, kn = rows[cel_z_id]["konto_id"], rows[cel_na_id]["konto_id"]
        tekst = opis or f"Przesunięcie: {rows[cel_z_id]['nazwa']} → {rows[cel_na_id]['nazwa']}"
        przelew_id = None
        if kz != kn:
            cur.execute("SELECT id, waluta FROM konta WHERE id IN (%s,%s) AND household_id=%s AND aktywne=TRUE",
                        (kz, kn, household_id))
            kk = {r["id"]: r for r in cur.fetchall()}
            if kz not in kk or kn not in kk:
                raise ValueError("Konto celu nie istnieje")
            if kk[kz]["waluta"] != kk[kn]["waluta"]:
                raise ValueError("Cele są na kontach w różnych walutach")
            cur.execute(
                "INSERT INTO przelewy (household_id, data, kwota, konto_z_id, konto_na_id, opis) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                (household_id, data, kwota, kz, kn, tekst),
            )
            przelew_id = cur.fetchone()["id"]
        cur.execute("INSERT INTO cele_wplaty (cel_id, data, kwota, opis, zrodlo, przelew_id) VALUES (%s,%s,%s,%s,'przesuniecie',%s)",
                    (cel_z_id, data, -kwota, tekst, przelew_id))
        cur.execute("INSERT INTO cele_wplaty (cel_id, data, kwota, opis, zrodlo, przelew_id) VALUES (%s,%s,%s,%s,'przesuniecie',%s)",
                    (cel_na_id, data, kwota, tekst, przelew_id))
        return True


def delete_cel_wplata(wplata_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute("""DELETE FROM cele_wplaty wp USING cele c
                       WHERE wp.id=%s AND wp.cel_id=c.id AND c.household_id=%s""",
                    (wplata_id, household_id))
        return cur.rowcount > 0


# --- limity wydatków ---

def get_limity(household_id: int, month: str | None = None) -> list[dict]:
    from datetime import date as _date
    month = month or _date.today().strftime("%Y-%m")
    with get_db() as cur:
        cur.execute("""SELECT * FROM limity WHERE household_id=%s
                       ORDER BY kategoria_glowna, podkategoria NULLS FIRST""", (household_id,))
        limity = [dict(r) for r in cur.fetchall()]
        for l in limity:
            # limit na podkategorię liczy tylko tę podkategorię; na całą kategorię — wszystko w niej
            if l.get("podkategoria"):
                cur.execute("""SELECT COALESCE(SUM(p.cena * p.ilosc), 0) AS s
                               FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
                               WHERE w.household_id=%s AND p.kategoria_glowna=%s AND p.kategoria=%s
                                 AND TO_CHAR(w.data,'YYYY-MM')=%s""",
                            (household_id, l["kategoria_glowna"], l["podkategoria"], month))
            else:
                cur.execute("""SELECT COALESCE(SUM(p.cena * p.ilosc), 0) AS s
                               FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
                               WHERE w.household_id=%s AND p.kategoria_glowna=%s AND TO_CHAR(w.data,'YYYY-MM')=%s""",
                            (household_id, l["kategoria_glowna"], month))
            l["kwota_miesieczna"] = float(l["kwota_miesieczna"])
            l["wydane"] = round(float(cur.fetchone()["s"]), 2)
            l["pozostalo"] = round(l["kwota_miesieczna"] - l["wydane"], 2)
            l["procent"] = round(l["wydane"] / l["kwota_miesieczna"] * 100, 1) if l["kwota_miesieczna"] > 0 else 0
        return limity


def upsert_limit(household_id: int, kategoria_glowna: str, kwota_miesieczna: float,
                 podkategoria: str | None = None) -> dict:
    podkategoria = podkategoria or None
    with get_db() as cur:
        cur.execute("""UPDATE limity SET kwota_miesieczna=%s
                       WHERE household_id=%s AND kategoria_glowna=%s
                         AND COALESCE(podkategoria,'')=COALESCE(%s,'') RETURNING *""",
                    (kwota_miesieczna, household_id, kategoria_glowna, podkategoria))
        row = cur.fetchone()
        if row:
            return dict(row)
        cur.execute(
            "INSERT INTO limity (household_id, kategoria_glowna, podkategoria, kwota_miesieczna) VALUES (%s,%s,%s,%s) RETURNING *",
            (household_id, kategoria_glowna, podkategoria, kwota_miesieczna),
        )
        return dict(cur.fetchone())


def delete_limit(limit_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM limity WHERE id=%s AND household_id=%s", (limit_id, household_id))
        return cur.rowcount > 0


# --- cel przepływowy (jeden na gospodarstwo, w ustawieniach) ---

def get_cel_przeplywowy(household_id: int) -> dict | None:
    raw = get_ustawienie(f"cel_przeplywowy:{household_id}", "")
    if not raw:
        return None
    try:
        val = json.loads(raw)
        return val if isinstance(val, dict) and val.get("typ") in ("kwota", "procent") else None
    except (ValueError, TypeError):
        return None


def set_cel_przeplywowy(household_id: int, typ: str, wartosc: float) -> None:
    set_ustawienie(f"cel_przeplywowy:{household_id}",
                   json.dumps({"typ": typ, "wartosc": float(wartosc)}))


def delete_cel_przeplywowy(household_id: int) -> None:
    set_ustawienie(f"cel_przeplywowy:{household_id}", "")


def _terminy_cykliczne(od_miesiaca, dzien: int, po, do_dnia) -> list:
    """Daty naliczenia: co miesiąc w dniu `dzien` (przycięty do końca miesiąca),
    począwszy od miesiąca `od_miesiaca`, tylko daty > `po` i <= `do_dnia`."""
    import calendar
    from datetime import date as _date
    terminy = []
    rok, mies = od_miesiaca.year, od_miesiaca.month
    while True:
        ostatni = calendar.monthrange(rok, mies)[1]
        d = _date(rok, mies, min(dzien, ostatni))
        if d > do_dnia:
            break
        if po is None or d > po:
            terminy.append(d)
        mies += 1
        if mies > 12:
            mies = 1; rok += 1
    return terminy


def _ostatni_termin(od_miesiaca, dzien: int, limit_naliczen, do_miesiaca=None) -> "date | None":
    """Data ostatniego naliczenia: z liczby naliczeń (limit_naliczen) i/lub miesiąca
    końcowego (do_miesiaca) — gdy oba podane, wygrywa wcześniejszy. None = bezterminowo."""
    import calendar
    from datetime import date as _date
    kandydaci = []
    if limit_naliczen:
        mies0 = od_miesiaca.year * 12 + (od_miesiaca.month - 1) + limit_naliczen - 1
        rok, mies = divmod(mies0, 12)
        mies += 1
        ostatni = calendar.monthrange(rok, mies)[1]
        kandydaci.append(_date(rok, mies, min(dzien, ostatni)))
    if do_miesiaca:
        ostatni = calendar.monthrange(do_miesiaca.year, do_miesiaca.month)[1]
        kandydaci.append(_date(do_miesiaca.year, do_miesiaca.month, min(dzien, ostatni)))
    return min(kandydaci) if kandydaci else None


def naliczaj_cykliczne(household_id: int) -> int:
    """Automatyczne wydatki cykliczne: tworzy wydatki za zaległe terminy.
    Ręczne: tworzy oczekujące płatności (z wyprzedzeniem przyp_reczne_dni),
    które użytkownik potwierdza. Zwraca liczbę utworzonych wydatków.
    Bezpieczne przy równoległych wywołaniach (claim przez UPDATE ostatnio_do)."""
    from datetime import date as _date, timedelta as _td
    today = _date.today()
    wyprzedzenie = _td(days=int(get_ustawienie("przyp_reczne_dni", "7")))
    utworzone = 0
    with get_db() as cur:
        cur.execute("SELECT * FROM wydatki_cykliczne WHERE household_id=%s AND aktywne=TRUE", (household_id,))
        cykliczne = [dict(r) for r in cur.fetchall()]

    for c in cykliczne:
        auto = c.get("automatyczny", True)
        # ręczne planujemy z wyprzedzeniem, żeby przypomnienie wyszło przed terminem
        horyzont = today if auto else today + wyprzedzenie
        ostatni_termin = _ostatni_termin(c["od_miesiaca"], c["dzien"], c.get("limit_naliczen"),
                                         c.get("do_miesiaca"))
        do_dnia = min(horyzont, ostatni_termin) if ostatni_termin else horyzont
        terminy = _terminy_cykliczne(c["od_miesiaca"], c["dzien"], c["ostatnio_do"], do_dnia)
        if not terminy:
            # limit osiągnięty już wcześniej (np. zmniejszony w edycji) — zakończ
            if ostatni_termin and c["ostatnio_do"] and c["ostatnio_do"] >= ostatni_termin:
                with get_db() as cur:
                    cur.execute("UPDATE wydatki_cykliczne SET aktywne=FALSE WHERE id=%s", (c["id"],))
            continue
        zakonczony = ostatni_termin is not None and terminy[-1] >= ostatni_termin
        with get_db() as cur:
            # claim: tylko jeden proces naliczy ten zakres
            cur.execute(
                "UPDATE wydatki_cykliczne SET ostatnio_do=%s, aktywne=%s WHERE id=%s AND ostatnio_do IS NOT DISTINCT FROM %s",
                (terminy[-1], not zakonczony, c["id"], c["ostatnio_do"]),
            )
            if cur.rowcount == 0:
                continue
        if auto:
            for t in terminy:
                try:
                    _wykonaj_cykliczny(c, t.isoformat(), household_id, "Wydatek cykliczny")
                except Exception:
                    continue  # np. konto przelewu usunięte — pomiń termin, nie blokuj reszty
                utworzone += 1
                with get_db() as cur:
                    cur.execute(
                        """INSERT INTO platnosci_oczekujace (household_id, cykliczny_id, termin, status, potwierdzona_at)
                           VALUES (%s,%s,%s,'naliczona',CURRENT_TIMESTAMP)
                           ON CONFLICT (cykliczny_id, termin) DO NOTHING""",
                        (household_id, c["id"], t),
                    )
        else:
            with get_db() as cur:
                for t in terminy:
                    cur.execute(
                        """INSERT INTO platnosci_oczekujace (household_id, cykliczny_id, termin)
                           VALUES (%s,%s,%s) ON CONFLICT (cykliczny_id, termin) DO NOTHING""",
                        (household_id, c["id"], t),
                    )
    return utworzone


def _wykonaj_cykliczny(c: dict, data_str: str, household_id: int, notatka: str) -> int:
    """Realizuje pojedyncze naliczenie cyklicznego: wydatek albo przelew między kontami."""
    if c.get("typ") == "przelew":
        if not c.get("konto_id") or not c.get("konto_na_id"):
            raise ValueError("Przelew cykliczny wymaga konta źródłowego i docelowego")
        wynik = create_przelew(household_id, data_str, float(c["kwota"]),
                               c["konto_id"], c["konto_na_id"], f"Cykliczny: {c['nazwa']}",
                               cel_id=c.get("cel_id"), zrodlo_wplaty="cykliczny")
        return wynik["id"]
    return create_wydatek(
        data=data_str, sklep=c["nazwa"], suma=float(c["kwota"]),
        osoba=c["osoba"], notatki=notatka, zdjecie=None,
        pozycje=[{"nazwa": c["nazwa"], "cena": float(c["kwota"]), "ilosc": 1,
                  "kategoria_glowna": c["kategoria_glowna"], "kategoria": c["kategoria"]}],
        household_id=household_id, konto_id=c["konto_id"],
    )


def get_przypomnienia(household_id: int) -> list[dict]:
    """Przypomnienia: oczekujące płatności ręczne + nadchodzące obciążenia automatyczne."""
    from datetime import date as _date, timedelta as _td
    today = _date.today()
    auto_dni = int(get_ustawienie("przyp_auto_dni", "3"))
    zolte = int(get_ustawienie("przyp_zolte_dni", "3"))
    czerwone = int(get_ustawienie("przyp_czerwone_dni", "1"))

    def poziom(dni: int) -> str:
        return "czerwony" if dni <= czerwone else ("zolty" if dni <= zolte else "info")

    wynik: list[dict] = []
    with get_db() as cur:
        cur.execute("""
            SELECT p.id, p.termin, c.nazwa, c.kwota, c.typ AS cel,
                   k.nazwa AS konto_nazwa, kn.nazwa AS konto_na_nazwa
            FROM platnosci_oczekujace p
            JOIN wydatki_cykliczne c ON c.id = p.cykliczny_id
            LEFT JOIN konta k ON k.id = c.konto_id
            LEFT JOIN konta kn ON kn.id = c.konto_na_id
            WHERE p.household_id=%s AND p.status='oczekuje' ORDER BY p.termin
        """, (household_id,))
        for r in cur.fetchall():
            r = dict(r)
            dni = (r["termin"] - today).days
            r.update(typ="reczny", dni_do=dni, poziom=poziom(dni))
            wynik.append(r)

        cur.execute("""
            SELECT c.*, k.nazwa AS konto_nazwa, kn.nazwa AS konto_na_nazwa
            FROM wydatki_cykliczne c
            LEFT JOIN konta k ON k.id = c.konto_id
            LEFT JOIN konta kn ON kn.id = c.konto_na_id
            WHERE c.household_id=%s AND c.aktywne=TRUE AND c.automatyczny=TRUE
        """, (household_id,))
        autos = [dict(r) for r in cur.fetchall()]

    for c in autos:
        ot = _ostatni_termin(c["od_miesiaca"], c["dzien"], c.get("limit_naliczen"),
                             c.get("do_miesiaca"))
        do = today + _td(days=auto_dni)
        if ot and ot < do:
            do = ot
        for t in _terminy_cykliczne(c["od_miesiaca"], c["dzien"], c["ostatnio_do"], do):
            dni = (t - today).days
            wynik.append({"id": None, "typ": "auto", "cel": c.get("typ") or "wydatek",
                          "nazwa": c["nazwa"], "kwota": c["kwota"],
                          "termin": t, "konto_nazwa": c["konto_nazwa"],
                          "konto_na_nazwa": c["konto_na_nazwa"],
                          "dni_do": dni, "poziom": poziom(dni)})

    wynik.sort(key=lambda x: x["termin"])
    return wynik


def get_archiwum_powiadomien(household_id: int, limit: int = 100) -> list[dict]:
    """Zamknięte zdarzenia cykliczne: potwierdzone przelewy ręczne i automatyczne naliczenia."""
    with get_db() as cur:
        cur.execute("""
            SELECT p.termin, p.status, p.potwierdzona_at, c.nazwa, c.kwota, c.typ AS cel,
                   c.automatyczny, k.nazwa AS konto_nazwa, kn.nazwa AS konto_na_nazwa
            FROM platnosci_oczekujace p
            JOIN wydatki_cykliczne c ON c.id = p.cykliczny_id
            LEFT JOIN konta k ON k.id = c.konto_id
            LEFT JOIN konta kn ON kn.id = c.konto_na_id
            WHERE p.household_id=%s AND p.status <> 'oczekuje'
            ORDER BY COALESCE(p.potwierdzona_at, p.created_at) DESC, p.termin DESC
            LIMIT %s
        """, (household_id, limit))
        return [dict(r) for r in cur.fetchall()]


# ── Web Push: subskrypcje urządzeń i dziennik wysyłek ───────────────────────

def zapisz_push_subskrypcje(user_id: int, endpoint: str, p256dh: str, auth: str) -> None:
    """Zapisuje zgodę urządzenia. Ten sam endpoint może wrócić po ponownym
    włączeniu powiadomień — wtedy tylko przepinamy go na bieżącego użytkownika
    (wspólny telefon, dwa konta) i odświeżamy klucze."""
    with get_db() as cur:
        cur.execute("""
            INSERT INTO push_subskrypcje (user_id, endpoint, p256dh, auth)
            VALUES (%s,%s,%s,%s)
            ON CONFLICT (endpoint) DO UPDATE
               SET user_id = EXCLUDED.user_id,
                   p256dh  = EXCLUDED.p256dh,
                   auth    = EXCLUDED.auth
        """, (user_id, endpoint, p256dh, auth))


def usun_push_subskrypcje(endpoint: str) -> None:
    with get_db() as cur:
        cur.execute("DELETE FROM push_subskrypcje WHERE endpoint=%s", (endpoint,))


def usun_push_subskrypcje_usera(user_id: int) -> int:
    """Wyłączenie powiadomień na wszystkich urządzeniach naraz."""
    with get_db() as cur:
        cur.execute("DELETE FROM push_subskrypcje WHERE user_id=%s", (user_id,))
        return cur.rowcount


def get_push_subskrypcje(user_id: int) -> list[dict]:
    with get_db() as cur:
        cur.execute("SELECT endpoint, p256dh, auth FROM push_subskrypcje WHERE user_id=%s",
                    (user_id,))
        return [dict(r) for r in cur.fetchall()]


def ma_push_subskrypcje(user_id: int) -> bool:
    with get_db() as cur:
        cur.execute("SELECT 1 FROM push_subskrypcje WHERE user_id=%s LIMIT 1", (user_id,))
        return cur.fetchone() is not None


def get_push_wylaczone(user_id: int) -> set[str]:
    """Rodzaje, które użytkownik wyciszył. Pusty zbiór = chce wszystkiego."""
    with get_db() as cur:
        cur.execute("SELECT rodzaj FROM push_wylaczone WHERE user_id=%s", (user_id,))
        return {r["rodzaj"] for r in cur.fetchall()}


def ustaw_push_rodzaj(user_id: int, rodzaj: str, wlaczone: bool) -> None:
    with get_db() as cur:
        if wlaczone:
            cur.execute("DELETE FROM push_wylaczone WHERE user_id=%s AND rodzaj=%s",
                        (user_id, rodzaj))
        else:
            cur.execute("INSERT INTO push_wylaczone (user_id, rodzaj) VALUES (%s,%s) "
                        "ON CONFLICT DO NOTHING", (user_id, rodzaj))


def push_juz_wyslany(user_id: int, klucz: str) -> bool:
    with get_db() as cur:
        cur.execute("SELECT 1 FROM push_wyslane WHERE user_id=%s AND klucz=%s", (user_id, klucz))
        return cur.fetchone() is not None


def oznacz_push_wyslany(user_id: int, klucz: str) -> None:
    with get_db() as cur:
        cur.execute("INSERT INTO push_wyslane (user_id, klucz) VALUES (%s,%s) "
                    "ON CONFLICT DO NOTHING", (user_id, klucz))


def sprzataj_push_wyslane(dni: int = 90) -> int:
    """Dziennik rośnie w nieskończoność, a wpis starszy niż kwartał niczego już
    nie chroni — termin dawno minął i nie wróci."""
    with get_db() as cur:
        cur.execute("DELETE FROM push_wyslane WHERE wyslane_at < NOW() - INTERVAL '%s days'"
                    % int(dni))
        return cur.rowcount


def potwierdz_platnosc(platnosc_id: int, household_id: int) -> int | None:
    """Potwierdzenie płatności ręcznej: tworzy wydatek albo przelew z DZISIEJSZĄ datą
    (data faktycznej płatności) i oznacza wpis jako potwierdzony (archiwum).
    Zwraca id utworzonego rekordu."""
    from datetime import date as _date
    with get_db() as cur:
        cur.execute("""UPDATE platnosci_oczekujace
                       SET status='potwierdzona', potwierdzona_at=CURRENT_TIMESTAMP
                       WHERE id=%s AND household_id=%s AND status='oczekuje'
                       RETURNING cykliczny_id, termin""", (platnosc_id, household_id))
        row = cur.fetchone()
        if not row:
            return None
        cur.execute("SELECT * FROM wydatki_cykliczne WHERE id=%s", (row["cykliczny_id"],))
        c = dict(cur.fetchone())
    try:
        return _wykonaj_cykliczny(c, _date.today().isoformat(), household_id,
                                  f"Wydatek cykliczny (przelew potwierdzony, termin {row['termin']})")
    except Exception:
        # nie udało się utworzyć rekordu — cofnij potwierdzenie, żeby nie zgubić płatności
        with get_db() as cur:
            cur.execute("""UPDATE platnosci_oczekujace SET status='oczekuje', potwierdzona_at=NULL
                           WHERE id=%s""", (platnosc_id,))
        raise


def export_household_data(household_id: int) -> dict:
    import json as _json
    with get_db() as cur:
        cur.execute("""
            SELECT w.*, array_agg(row_to_json(p.*)) FILTER (WHERE p.id IS NOT NULL) AS pozycje
            FROM wydatki w
            LEFT JOIN pozycje p ON p.wydatek_id = w.id
            WHERE w.household_id = %s
            GROUP BY w.id ORDER BY w.data DESC, w.created_at DESC
        """, (household_id,))
        wydatki = []
        for row in cur.fetchall():
            r = dict(row)
            r["pozycje"] = [p if isinstance(p, dict) else _json.loads(p) for p in (r.get("pozycje") or [])]
            wydatki.append(r)

        cur.execute("SELECT * FROM konta WHERE household_id=%s ORDER BY id", (household_id,))
        konta = [dict(r) for r in cur.fetchall()]

        # po household_id, nie po konto_id — wpływy bez przypisanego konta mają
        # konto_id NULL i przy filtrowaniu po kontach wypadały z eksportu
        cur.execute("SELECT * FROM wplywy WHERE household_id=%s ORDER BY data DESC", (household_id,))
        wplywy = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM cele WHERE household_id=%s ORDER BY id", (household_id,))
        cele = [dict(r) for r in cur.fetchall()]

        cur.execute(
            """SELECT cw.* FROM cele_wplaty cw JOIN cele c ON c.id = cw.cel_id
               WHERE c.household_id=%s ORDER BY cw.id""",
            (household_id,),
        )
        cele_wplaty = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM przelewy WHERE household_id=%s ORDER BY id", (household_id,))
        przelewy = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM wydatki_cykliczne WHERE household_id=%s ORDER BY id", (household_id,))
        cykliczne = [dict(r) for r in cur.fetchall()]

        cur.execute(
            """SELECT i.* FROM inwentaryzacje i JOIN konta k ON k.id = i.konto_id
               WHERE k.household_id=%s ORDER BY i.id""",
            (household_id,),
        )
        inwentaryzacje = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM limity WHERE household_id=%s ORDER BY id", (household_id,))
        limity = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM virtual_members WHERE household_id=%s ORDER BY id", (household_id,))
        virtual_members = [dict(r) for r in cur.fetchall()]

        hier = get_household_hierarchia(household_id)
    return {
        # wersja formatu — import odmawia wczytania pliku, którego nie rozumie
        "wersja": 2,
        "wydatki": wydatki, "konta": konta, "wplywy": wplywy,
        "cele": cele, "cele_wplaty": cele_wplaty, "przelewy": przelewy,
        "wydatki_cykliczne": cykliczne, "inwentaryzacje": inwentaryzacje,
        "limity": limity, "virtual_members": virtual_members,
        "hierarchia": hier,
    }


def _remap(mapa: dict, stare_id) -> int | None:
    """Stare id z pliku -> nowe id w bazie. Nieznane/puste -> NULL."""
    return mapa.get(stare_id) if stare_id is not None else None


def import_household_data(household_id: int, dane: dict) -> dict:
    """Wczytuje plik z eksportu do PUSTEGO gospodarstwa, przemapowując klucze obce
    (konta, cele, przelewy dostają nowe id). Wszystko w jednej transakcji — przy
    błędzie nie zostaje połowicznie wczytane gospodarstwo.

    Nie używa create_wydatek, bo tamta funkcja otwiera własną transakcję na każdy
    wydatek — import kilku tysięcy pozycji nie byłby ani szybki, ani atomowy."""
    if dane.get("wersja") != 2:
        raise ValueError("Nieobsługiwany format pliku — oczekiwano eksportu w wersji 2.")

    liczniki: dict[str, int] = {}
    with get_db() as cur:
        for tabela in ("wydatki", "konta", "wplywy", "cele", "przelewy"):
            cur.execute(f"SELECT 1 FROM {tabela} WHERE household_id=%s LIMIT 1", (household_id,))
            if cur.fetchone():
                raise ValueError(
                    "Import możliwy tylko do pustego gospodarstwa, a to już zawiera dane. "
                    "Załóż nowe gospodarstwo albo najpierw usuń istniejące wpisy."
                )

        mapa_kont: dict = {}
        for k in dane.get("konta", []):
            cur.execute(
                """INSERT INTO konta (household_id,nazwa,typ,osoba,waluta,saldo_poczatkowe,aktywne)
                   VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                (household_id, k["nazwa"], k.get("typ", "bank"), k.get("osoba"),
                 k.get("waluta", "PLN"), k.get("saldo_poczatkowe", 0), k.get("aktywne", True)),
            )
            mapa_kont[k["id"]] = cur.fetchone()["id"]
        liczniki["konta"] = len(mapa_kont)

        mapa_celow: dict = {}
        for c in dane.get("cele", []):
            cur.execute(
                """INSERT INTO cele (household_id,nazwa,kwota_docelowa,konto_id,termin,aktywny)
                   VALUES (%s,%s,%s,%s,%s,%s) RETURNING id""",
                (household_id, c["nazwa"], c["kwota_docelowa"], _remap(mapa_kont, c.get("konto_id")),
                 c.get("termin"), c.get("aktywny", True)),
            )
            mapa_celow[c["id"]] = cur.fetchone()["id"]
        liczniki["cele"] = len(mapa_celow)

        mapa_przelewow: dict = {}
        for p in dane.get("przelewy", []):
            cur.execute(
                """INSERT INTO przelewy (household_id,data,kwota,konto_z_id,konto_na_id,opis)
                   VALUES (%s,%s,%s,%s,%s,%s) RETURNING id""",
                (household_id, p["data"], p["kwota"], _remap(mapa_kont, p.get("konto_z_id")),
                 _remap(mapa_kont, p.get("konto_na_id")), p.get("opis")),
            )
            mapa_przelewow[p["id"]] = cur.fetchone()["id"]
        liczniki["przelewy"] = len(mapa_przelewow)

        wplaty = [w for w in dane.get("cele_wplaty", []) if w.get("cel_id") in mapa_celow]
        for w in wplaty:
            cur.execute(
                """INSERT INTO cele_wplaty (cel_id,data,kwota,opis,zrodlo,przelew_id)
                   VALUES (%s,%s,%s,%s,%s,%s)""",
                (mapa_celow[w["cel_id"]], w["data"], w["kwota"], w.get("opis"),
                 w.get("zrodlo", "reczna"), _remap(mapa_przelewow, w.get("przelew_id"))),
            )
        liczniki["cele_wplaty"] = len(wplaty)

        cykliczne = dane.get("wydatki_cykliczne", [])
        for c in cykliczne:
            cur.execute(
                """INSERT INTO wydatki_cykliczne
                   (household_id,nazwa,kwota,dzien,kategoria_glowna,kategoria,osoba,konto_id,
                    od_miesiaca,limit_naliczen,aktywne,ostatnio_do,automatyczny,typ,do_miesiaca,
                    konto_na_id,cel_id)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (household_id, c["nazwa"], c["kwota"], c.get("dzien", 1),
                 c.get("kategoria_glowna", "Rozrywka i hobby"), c.get("kategoria", "Subskrypcje"),
                 c.get("osoba"), _remap(mapa_kont, c.get("konto_id")), c["od_miesiaca"],
                 c.get("limit_naliczen"), c.get("aktywne", True), c.get("ostatnio_do"),
                 c.get("automatyczny", True), c.get("typ", "wydatek"), c.get("do_miesiaca"),
                 _remap(mapa_kont, c.get("konto_na_id")), _remap(mapa_celow, c.get("cel_id"))),
            )
        liczniki["wydatki_cykliczne"] = len(cykliczne)

        wydatki = dane.get("wydatki", [])
        poz_total = 0
        for w in wydatki:
            cur.execute(
                """INSERT INTO wydatki (data,sklep,suma,osoba,notatki,zdjecie,waluta,kurs,
                       household_id,okazja,kontekst_kategoria,kontekst_podkategoria,konto_id)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                (w["data"], w.get("sklep"), w["suma"], w.get("osoba", "Adam"), w.get("notatki"),
                 None, w.get("waluta", "PLN"), w.get("kurs", 1.0), household_id, w.get("okazja"),
                 w.get("kontekst_kategoria"), w.get("kontekst_podkategoria"),
                 _remap(mapa_kont, w.get("konto_id"))),
            )
            wid = cur.fetchone()["id"]
            pozycje = w.get("pozycje") or []
            if pozycje:
                cur.executemany(
                    """INSERT INTO pozycje (wydatek_id,nazwa,cena,ilosc,kategoria_glowna,kategoria,poza_kontekstem)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    [(wid, p["nazwa"], p["cena"], p.get("ilosc", 1),
                      p.get("kategoria_glowna", "Inne"), p.get("kategoria", "Inne"),
                      bool(p.get("poza_kontekstem", False))) for p in pozycje],
                )
                poz_total += len(pozycje)
        liczniki["wydatki"] = len(wydatki)
        liczniki["pozycje"] = poz_total

        wplywy = dane.get("wplywy", [])
        for w in wplywy:
            cur.execute(
                """INSERT INTO wplywy (household_id,data,kwota,osoba,kategoria,opis,konto_id)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                (household_id, w["data"], w["kwota"], w.get("osoba"), w.get("kategoria", "Inne"),
                 w.get("opis"), _remap(mapa_kont, w.get("konto_id"))),
            )
        liczniki["wplywy"] = len(wplywy)

        inw = [i for i in dane.get("inwentaryzacje", []) if i.get("konto_id") in mapa_kont]
        for i in inw:
            cur.execute(
                """INSERT INTO inwentaryzacje (konto_id,data,saldo_rzeczywiste,saldo_obliczone,roznica,notatki)
                   VALUES (%s,%s,%s,%s,%s,%s)""",
                (mapa_kont[i["konto_id"]], i["data"], i["saldo_rzeczywiste"],
                 i["saldo_obliczone"], i["roznica"], i.get("notatki")),
            )
        liczniki["inwentaryzacje"] = len(inw)

        limity = dane.get("limity", [])
        for l in limity:
            cur.execute(
                """INSERT INTO limity (household_id,kategoria_glowna,kwota_miesieczna,podkategoria)
                   VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (household_id, l["kategoria_glowna"], l["kwota_miesieczna"], l.get("podkategoria")),
            )
        liczniki["limity"] = len(limity)

        vm = dane.get("virtual_members", [])
        for v in vm:
            cur.execute(
                "INSERT INTO virtual_members (household_id,name) VALUES (%s,%s)",
                (household_id, v["name"]),
            )
        liczniki["virtual_members"] = len(vm)

        hier = dane.get("hierarchia")
        if hier:
            cur.execute(
                """INSERT INTO household_kategorie (household_id,hierarchia_json) VALUES (%s,%s)
                   ON CONFLICT (household_id) DO UPDATE SET hierarchia_json=EXCLUDED.hierarchia_json""",
                (household_id, json.dumps(hier, ensure_ascii=False)),
            )

    return liczniki


def get_household_hierarchia(household_id: int) -> dict | None:
    import json as _json
    with get_db() as cur:
        cur.execute("SELECT hierarchia_json FROM household_kategorie WHERE household_id = %s", (household_id,))
        row = cur.fetchone()
        return _json.loads(row["hierarchia_json"]) if row else None


def save_household_hierarchia(household_id: int, hierarchia: dict) -> None:
    import json as _json
    with get_db() as cur:
        cur.execute(
            """INSERT INTO household_kategorie (household_id, hierarchia_json)
               VALUES (%s, %s)
               ON CONFLICT (household_id) DO UPDATE SET hierarchia_json = EXCLUDED.hierarchia_json""",
            (household_id, _json.dumps(hierarchia, ensure_ascii=False)),
        )


def get_konto_domyslne(user_id: int) -> int | None:
    with get_db() as cur:
        cur.execute("SELECT konto_id FROM konto_domyslne WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
        return row["konto_id"] if row else None


def set_konto_domyslne(user_id: int, konto_id: int | None) -> None:
    with get_db() as cur:
        if konto_id is None:
            cur.execute("DELETE FROM konto_domyslne WHERE user_id = %s", (user_id,))
        else:
            cur.execute(
                "INSERT INTO konto_domyslne (user_id, konto_id) VALUES (%s,%s) ON CONFLICT (user_id) DO UPDATE SET konto_id=EXCLUDED.konto_id",
                (user_id, konto_id),
            )


KATEGORIA_KOREKTY = "Korekta salda"


def create_inwentaryzacja(konto_id: int, household_id: int, data: str,
                           saldo_rzeczywiste: float, notatki: str | None,
                           tryb: str = "saldo", osoba: str | None = None) -> dict:
    """Spis rzeczywistego stanu konta. `tryb` decyduje, CO ZROBIĆ Z RÓŻNICĄ.

    Spis MUSI domknąć saldo, inaczej jest tylko notatką: wcześniej zapisywał
    różnicę i zostawiał konto rozjechane, więc jedyne narzędzie do uzgodnienia
    z bankiem niczego nie uzgadniało. Domknąć da się na dwa sposoby i wybór
    zależy od tego, skąd różnica się wzięła:

    `saldo` (domyślny) — przesuwamy `saldo_poczatkowe` konta. Dla statystyk
    i bilansu okresu korekta jest niewidoczna, bo nie jest ani wydatkiem, ani
    wpływem. Właściwe, gdy różnica to szum: zaokrąglenia, stara pomyłka,
    czegoś nie da się przypisać.

    `transakcja` — dopisujemy prawdziwy wydatek (różnica ujemna) albo wpływ
    (dodatnia) w kategorii „Korekta salda". Właściwe, gdy różnica ma realną
    przyczynę: zapomniany zakup, odsetki, opłata banku. Wtedy MA się pokazać
    w statystykach, bo to naprawdę wydane albo otrzymane pieniądze.

    W trybie `transakcja` NIE ruszamy salda początkowego — sama transakcja
    domyka saldo. Zrobienie obu naraz policzyłoby różnicę dwa razy.
    """
    if tryb not in ("saldo", "transakcja"):
        raise ValueError("Nieznany tryb rozliczenia różnicy.")
    with get_db() as cur:
        cur.execute("SELECT id, nazwa FROM konta WHERE id=%s AND household_id=%s",
                    (konto_id, household_id))
        konto = cur.fetchone()
        if not konto:
            raise ValueError("Konto nie istnieje")
        saldo_obl = _saldo_konta_na_date(cur, konto_id, data)
        roznica = round(saldo_rzeczywiste - saldo_obl, 2)
        cur.execute(
            "INSERT INTO inwentaryzacje (konto_id, data, saldo_rzeczywiste, saldo_obliczone, roznica, notatki) VALUES (%s,%s,%s,%s,%s,%s) RETURNING *",
            (konto_id, data, saldo_rzeczywiste, saldo_obl, roznica, notatki or None),
        )
        wynik = dict(cur.fetchone())
        wynik["tryb"] = tryb

        # Różnica bierze się z transakcji, których w apce nie ma — niewpisany
        # przelew, zapomniany zakup, opłata banku. Domknięcie na dziś nie cofa
        # historii: dawne salda pozostają takie, jakie wynikały z zapisów.
        if not roznica:
            return wynik

        opis = f"Korekta po spisie stanu konta {konto['nazwa']}"
        if notatki:
            opis += f" — {notatki}"

        if tryb == "saldo":
            cur.execute(
                "UPDATE konta SET saldo_poczatkowe = saldo_poczatkowe + %s "
                "WHERE id=%s AND household_id=%s",
                (roznica, konto_id, household_id),
            )
            return wynik

        if roznica < 0:
            # Wydatek z jedną pozycją, a nie sam nagłówek: rozbicie na pozycje
            # jest w tej apce podstawą statystyk kategorii, więc wydatek bez
            # pozycji byłby niewidoczny dokładnie tam, gdzie ma być widoczny.
            kwota = abs(roznica)
            cur.execute(
                "INSERT INTO wydatki (data, sklep, suma, osoba, notatki, household_id, konto_id) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                (data, KATEGORIA_KOREKTY, kwota, osoba, opis, household_id, konto_id),
            )
            wydatek_id = cur.fetchone()["id"]
            cur.execute(
                "INSERT INTO pozycje (wydatek_id, nazwa, cena, ilosc, kategoria_glowna, kategoria) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (wydatek_id, "Różnica ze spisu stanu konta", kwota, 1,
                 KATEGORIA_KOREKTY, KATEGORIA_KOREKTY),
            )
            wynik["wydatek_id"] = wydatek_id
        else:
            cur.execute(
                "INSERT INTO wplywy (household_id, data, kwota, osoba, kategoria, opis, konto_id) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                (household_id, data, roznica, osoba, KATEGORIA_KOREKTY, opis, konto_id),
            )
            wynik["wplyw_id"] = cur.fetchone()["id"]
        return wynik


# ── Listy zakupów (wiele nazwanych list per gospodarstwo, sync na żywo) ──
# status listy: 'aktywna' | 'wstrzymana' | 'zamknieta'
_STATUSY_LISTY = {"aktywna", "wstrzymana", "zamknieta"}


def get_stan_list(household_id: int) -> list[dict]:
    """Pełny stan: wszystkie listy gospodarstwa (każdego statusu) z zagnieżdżonymi
    pozycjami. Klient wybiera i renderuje aktualnie oglądaną listę."""
    with get_db() as cur:
        cur.execute(
            "SELECT id, nazwa, status, pozycja, sklep FROM listy_zakupow "
            "WHERE household_id = %s ORDER BY pozycja ASC, id ASC",
            (household_id,),
        )
        listy = [dict(r) for r in cur.fetchall()]
        cur.execute(
            "SELECT id, lista_id, nazwa, kupione, dodane_przez FROM lista_zakupow "
            "WHERE household_id = %s ORDER BY kupione ASC, pozycja ASC, id ASC",
            (household_id,),
        )
        pozycje = [dict(r) for r in cur.fetchall()]
    wg_listy: dict[int, list[dict]] = {}
    for p in pozycje:
        wg_listy.setdefault(p["lista_id"], []).append(p)
    for l in listy:
        l["pozycje"] = wg_listy.get(l["id"], [])
    return listy


def get_lista_meta(lista_id: int, household_id: int) -> dict | None:
    with get_db() as cur:
        cur.execute(
            "SELECT id, nazwa, status FROM listy_zakupow WHERE id = %s AND household_id = %s",
            (lista_id, household_id),
        )
        row = cur.fetchone()
        return dict(row) if row else None


def create_lista(household_id: int, nazwa: str) -> dict:
    with get_db() as cur:
        cur.execute(
            "INSERT INTO listy_zakupow (household_id, nazwa, pozycja) "
            "VALUES (%s, %s, COALESCE((SELECT MAX(pozycja) FROM listy_zakupow WHERE household_id=%s), 0) + 1) "
            "RETURNING id, nazwa, status, pozycja",
            (household_id, nazwa, household_id),
        )
        r = dict(cur.fetchone())
    r["pozycje"] = []
    return r


def rename_lista(lista_id: int, household_id: int, nazwa: str) -> bool:
    with get_db() as cur:
        cur.execute(
            "UPDATE listy_zakupow SET nazwa = %s WHERE id = %s AND household_id = %s",
            (nazwa, lista_id, household_id),
        )
        return cur.rowcount > 0


def set_lista_status(lista_id: int, household_id: int, status: str) -> bool:
    if status not in _STATUSY_LISTY:
        return False
    with get_db() as cur:
        if status == "zamknieta":
            _naucz_kolejnosci_z_listy(cur, household_id, lista_id)
        cur.execute(
            "UPDATE listy_zakupow SET status = %s WHERE id = %s AND household_id = %s",
            (status, lista_id, household_id),
        )
        return cur.rowcount > 0


def delete_lista(lista_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute(
            "DELETE FROM listy_zakupow WHERE id = %s AND household_id = %s",
            (lista_id, household_id),
        )
        return cur.rowcount > 0


def add_pozycja_listy(household_id: int, lista_id: int, nazwa: str, dodane_przez: str | None) -> dict | None:
    with get_db() as cur:
        # nazwa listy przy okazji sprawdzenia właściciela — potrzebna do treści
        # powiadomienia push, a to i tak jedno zapytanie, które już tu było
        cur.execute("SELECT nazwa FROM listy_zakupow WHERE id = %s AND household_id = %s", (lista_id, household_id))
        naglowek = cur.fetchone()
        if not naglowek:
            return None
        cur.execute(
            "INSERT INTO lista_zakupow (household_id, lista_id, nazwa, dodane_przez, pozycja) "
            "VALUES (%s, %s, %s, %s, COALESCE((SELECT MAX(pozycja) FROM lista_zakupow WHERE lista_id=%s), 0) + 1) "
            "RETURNING id, lista_id, nazwa, kupione, dodane_przez",
            (household_id, lista_id, nazwa, dodane_przez, lista_id),
        )
        item = dict(cur.fetchone())
        item["lista_nazwa"] = naglowek["nazwa"]
        return item


def reorder_lista(household_id: int, lista_id: int, ids: list[int]) -> None:
    """Ustawia kolejność pozycji w obrębie jednej listy (pozycja = indeks)."""
    with get_db() as cur:
        for i, item_id in enumerate(ids):
            cur.execute(
                "UPDATE lista_zakupow SET pozycja = %s WHERE id = %s AND lista_id = %s AND household_id = %s",
                (i, item_id, lista_id, household_id),
            )


def set_pozycja_kupione(item_id: int, household_id: int, kupione: bool) -> bool:
    with get_db() as cur:
        cur.execute(
            "UPDATE lista_zakupow SET kupione = %s WHERE id = %s AND household_id = %s",
            (kupione, item_id, household_id),
        )
        return cur.rowcount > 0


def delete_pozycja_listy(item_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute(
            "DELETE FROM lista_zakupow WHERE id = %s AND household_id = %s",
            (item_id, household_id),
        )
        return cur.rowcount > 0


def clear_kupione_listy(household_id: int, lista_id: int) -> int:
    with get_db() as cur:
        # doucz kolejność obchodu z finalnego ułożenia, zanim pozycje znikną
        _naucz_kolejnosci_z_listy(cur, household_id, lista_id)
        cur.execute(
            "DELETE FROM lista_zakupow WHERE household_id = %s AND lista_id = %s AND kupione = TRUE",
            (household_id, lista_id),
        )
        return cur.rowcount


# ── Nauczona kolejność obchodu sklepu (bez AI) ──

def _norm_nazwa(s: str | None) -> str:
    """Normalizacja do klastra rodziny produktu: pierwsze słowo, małe litery.
    „Mleko Łaciate 3.2%", „mleko" → „mleko" (żeby lista i historia się sklejały)."""
    s = (s or "").strip().lower()
    if not s:
        return ""
    czesci = [c for c in re.split(r"[\s,.;/()]+", s) if c]
    return czesci[0] if czesci else s


def _naucz_kolejnosci(cur, household_id: int, sklep: str, nazwy: list[str]) -> None:
    """Aktualizuje nauczoną rangę (0..1) produktów wg podanej kolejności — średnia
    krocząca po kolejnych ułożeniach. `nazwy` w kolejności od początku obchodu."""
    if not sklep or len(nazwy) < 2:
        return
    n = len(nazwy)
    for idx, nazwa in enumerate(nazwy):
        norm = _norm_nazwa(nazwa)
        if not norm:
            continue
        poz = idx / (n - 1)  # 0..1
        cur.execute(
            "SELECT ranga, licznik FROM kolejnosc_produktow "
            "WHERE household_id=%s AND sklep=%s AND nazwa_znorm=%s",
            (household_id, sklep, norm),
        )
        row = cur.fetchone()
        if row:
            nowa = (row["ranga"] * row["licznik"] + poz) / (row["licznik"] + 1)
            cur.execute(
                "UPDATE kolejnosc_produktow SET ranga=%s, licznik=%s, updated_at=CURRENT_TIMESTAMP "
                "WHERE household_id=%s AND sklep=%s AND nazwa_znorm=%s",
                (nowa, row["licznik"] + 1, household_id, sklep, norm),
            )
        else:
            cur.execute(
                "INSERT INTO kolejnosc_produktow (household_id, sklep, nazwa_znorm, ranga) "
                "VALUES (%s,%s,%s,%s)",
                (household_id, sklep, norm, poz),
            )


def _naucz_kolejnosci_z_listy(cur, household_id: int, lista_id: int) -> None:
    """Douczanie z finalnego ułożenia listy — jeśli lista ma przypisany sklep."""
    cur.execute("SELECT sklep FROM listy_zakupow WHERE id=%s AND household_id=%s", (lista_id, household_id))
    row = cur.fetchone()
    sklep = (row and row["sklep"]) or None
    if not sklep:
        return
    cur.execute(
        "SELECT nazwa FROM lista_zakupow WHERE lista_id=%s AND household_id=%s ORDER BY pozycja ASC, id ASC",
        (lista_id, household_id),
    )
    nazwy = [r["nazwa"] for r in cur.fetchall()]
    _naucz_kolejnosci(cur, household_id, sklep, nazwy)


def get_sklepy(household_id: int) -> list[str]:
    with get_db() as cur:
        cur.execute(
            "SELECT DISTINCT sklep FROM wydatki "
            "WHERE household_id=%s AND sklep IS NOT NULL AND sklep <> '' ORDER BY sklep",
            (household_id,),
        )
        return [r["sklep"] for r in cur.fetchall()]


_KALIBRACJA_STOP = {
    "rabat", "opust", "kaucja", "karta", "paragon", "promocja", "zwrot", "suma",
    "razem", "gratis", "punkt", "punkty", "vat", "ptu", "sztuka", "sztuk", "szt",
    "opak", "bon", "kupon", "zaliczka", "dopłata", "dopłaty", "kg", "szt.",
}


def top_produkty_kalibracja(household_id: int, sklep: str | None = None, limit: int = 18) -> list[str]:
    """Najczęściej kupowane produkty (znormalizowane) — do prefill kalibracji.
    Odfiltrowuje śmieci (rabaty/kaucje/liczby), preferuje kupowane ≥2 razy,
    preferuje produkty z danego sklepu; dobiera z całości gdy za mało."""
    def _licz(where_sklep: bool) -> dict[str, int]:
        with get_db() as cur:
            if where_sklep and sklep:
                cur.execute(
                    "SELECT p.nazwa FROM pozycje p JOIN wydatki w ON w.id=p.wydatek_id "
                    "WHERE w.household_id=%s AND w.sklep=%s",
                    (household_id, sklep),
                )
            else:
                cur.execute(
                    "SELECT p.nazwa FROM pozycje p JOIN wydatki w ON w.id=p.wydatek_id "
                    "WHERE w.household_id=%s",
                    (household_id,),
                )
            freq: dict[str, int] = {}
            for r in cur.fetchall():
                norm = _norm_nazwa(r["nazwa"])
                if len(norm) < 3 or norm[0].isdigit() or norm in _KALIBRACJA_STOP:
                    continue
                freq[norm] = freq.get(norm, 0) + 1
            return freq

    def _wybierz(freq: dict[str, int]) -> dict[str, int]:
        czeste = {k: v for k, v in freq.items() if v >= 2}
        return czeste if len(czeste) >= 8 else freq

    freq = _licz(True) if sklep else _licz(False)
    produkty = [k for k, _ in sorted(_wybierz(freq).items(), key=lambda x: -x[1])[:limit]]
    if sklep and len(produkty) < 10:
        glob = sorted(_wybierz(_licz(False)).items(), key=lambda x: -x[1])
        for k, _ in glob:
            if k not in produkty:
                produkty.append(k)
            if len(produkty) >= limit:
                break
    return produkty


def zapisz_kalibracje(household_id: int, sklep: str, nazwy: list[str]) -> None:
    with get_db() as cur:
        _naucz_kolejnosci(cur, household_id, sklep, nazwy)


def uloz_liste(household_id: int, lista_id: int, sklep: str) -> bool:
    """Ustawia kolejność pozycji „do kupienia" wg nauczonej rangi dla sklepu.
    Zapisuje sklep na liście. Zwraca False gdy brak bazy (potrzebna kalibracja)."""
    with get_db() as cur:
        cur.execute("UPDATE listy_zakupow SET sklep=%s WHERE id=%s AND household_id=%s",
                    (sklep, lista_id, household_id))
        cur.execute("SELECT nazwa_znorm, ranga FROM kolejnosc_produktow WHERE household_id=%s AND sklep=%s",
                    (household_id, sklep))
        ranks = {r["nazwa_znorm"]: float(r["ranga"]) for r in cur.fetchall()}
        if not ranks:
            return False
        cur.execute(
            "SELECT id, nazwa FROM lista_zakupow "
            "WHERE lista_id=%s AND household_id=%s AND kupione=FALSE",
            (lista_id, household_id),
        )
        items = [dict(r) for r in cur.fetchall()]
        items.sort(key=lambda it: ranks.get(_norm_nazwa(it["nazwa"]), 1.5))
        for i, it in enumerate(items):
            cur.execute("UPDATE lista_zakupow SET pozycja=%s WHERE id=%s", (i, it["id"]))
    return True


# ── Wzorcowa baza działów sklepowych (globalna, zarządzana w adminie) ──

_DZIALY_SEED = [
    ("Świeża żywność", "Warzywa korzeniowe i kapustne", "ziemniaki, marchew, pietruszka korzeń, seler, burak, rzodkiew, cebula, czosnek, por, kapusta biała, kapusta czerwona, kapusta pekińska, brokuł, kalafior, brukselka, kalarepa, chrzan, batat, pomidor, pomidory, pomidorki, ogórek, ogórki, papryka, cukinia, bakłażan, dynia, kabaczek"),
    ("Świeża żywność", "Warzywa liściaste i zioła świeże", "sałata, roszponka, rukola, szpinak, jarmuż, botwinka, natka pietruszki, koperek, szczypiorek, bazylia, mięta, kolendra, tymianek, rozmaryn, seler naciowy, cykoria, mangold"),
    ("Świeża żywność", "Owoce krajowe i sezonowe", "jabłka, gruszki, śliwki, truskawki, maliny, borówki, porzeczki, agrest, wiśnie, czereśnie, morele, brzoskwinie, nektarynki, arbuz, melon, winogrona, rabarbar, aronia"),
    ("Świeża żywność", "Owoce egzotyczne", "banany, pomarańcze, mandarynki, cytryny, limonki, grejpfrut, kiwi, ananas, mango, awokado, granat, papaja, liczi, kokos, figi, marakuja, pitaja"),
    ("Świeża żywność", "Mięso czerwone (wołowina/wieprzowina)", "schab, karkówka, łopatka, boczek, żeberka, szynka surowa, wołowina, antrykot, rostbef, mielone wieprzowe, mielone wołowe, gulaszowe, polędwica wieprzowa, golonka, podgardle, wątróbka"),
    ("Świeża żywność", "Drób", "kurczak, filet z kurczaka, pierś z kurczaka, udka, podudzia, skrzydełka, ćwiartki, indyk, filet z indyka, wątróbka drobiowa, żołądki, korpusy, kaczka, mielone drobiowe, porcje rosołowe"),
    ("Świeża żywność", "Wędliny (krojone i na wagę)", "szynka, kiełbasa, parówki, kabanosy, salami, mortadela, polędwica, boczek wędzony, baleron, pasztetowa, kaszanka, salceson, metka, kiełbasa krakowska, kiełbasa śląska, frankfurterki"),
    ("Świeża żywność", "Ryby świeże i owoce morza", "łosoś, dorsz, pstrąg, karp, śledź, makrela, tuńczyk świeży, sandacz, panga, tilapia, mintaj, krewetki, małże, kalmary, ośmiornica, filet rybny, ryba wędzona"),
    ("Świeża żywność", "Nabiał (mleko, kefiry, jogurty)", "mleko, kefir, jogurt naturalny, jogurt owocowy, maślanka, śmietana, śmietanka, serek wiejski, skyr, jogurt pitny, jogurt grecki, budyń, deser mleczny, twaróg, masło, margaryna"),
    ("Świeża żywność", "Sery żółte i pleśniowe", "ser żółty, gouda, edamski, cheddar, mozzarella, parmezan, camembert, brie, ser pleśniowy, feta, ser kozi, oscypek, ser wędzony, ser topiony, plastry sera, mascarpone"),
    ("Pieczywo i cukiernia", "Pieczywo chrupiące (świeże)", "chleb, bułki, kajzerka, bagietka, ciabatta, chleb żytni, chleb razowy, chleb pszenny, chleb wieloziarnisty, rogal, chałka, grahamka, bułka maślana, chleb na zakwasie, bułka kukurydziana"),
    ("Pieczywo i cukiernia", "Pieczywo paczkowane i tostowe", "chleb tostowy, pieczywo pakowane, bułka tarta, tortille, pity, wrapy, pieczywo chrupkie, sucharki, grzanki, wafle ryżowe, pieczywo bezglutenowe, pumpernikiel, maca"),
    ("Pieczywo i cukiernia", "Cukiernia i słodkie wypieki", "drożdżówka, pączek, jagodzianka, sernik, ciasto, babka, muffin, rogalik, croissant, tarta, brownie, eklerka, napoleonka, wuzetka, biszkopt, strucla"),
    ("Pieczywo i cukiernia", "Przekąski słone (pizzerki, zapiekanki)", "pizzerka, zapiekanka, paluch, bułka z pieczarkami, roladka, mini pizza, precel, bułka drożdżowa z serem, ptysie, tartaletki"),
    ("Spiżarnia (suche)", "Kasze, ryże i rośliny strączkowe", "ryż, kasza gryczana, kasza jaglana, kasza jęczmienna, kasza manna, bulgur, kuskus, płatki owsiane, komosa, fasola, groch, soczewica, ciecierzyca, ryż basmati, ryż jaśminowy, ryż brązowy"),
    ("Spiżarnia (suche)", "Makarony", "makaron, spaghetti, penne, świderki, kokardki, nitki, łazanki, tagliatelle, makaron ryżowy, makaron pełnoziarnisty, lasagne, makaron jajeczny, muszelki, rurki, gniazda"),
    ("Spiżarnia (suche)", "Mąki, cukry i dodatki do pieczenia", "mąka pszenna, mąka razowa, mąka ziemniaczana, mąka kukurydziana, cukier, cukier puder, cukier waniliowy, drożdże, proszek do pieczenia, soda, budyń, kisiel, żelatyna, kakao, wiórki kokosowe, mak, polewa, aromat"),
    ("Spiżarnia (suche)", "Przetwory warzywne (słoiki/puszki)", "kukurydza, groszek konserwowy, fasola konserwowa, pomidory w puszce, passata, przecier pomidorowy, koncentrat pomidorowy, ogórki konserwowe, ogórki kiszone, kapusta kiszona, buraczki, ćwikła, pieczarki marynowane, papryka konserwowa, oliwki, sałatka warzywna"),
    ("Spiżarnia (suche)", "Przetwory owocowe i dżemy", "dżem, konfitura, powidła, marmolada, miód, brzoskwinie w syropie, ananas w puszce, mus jabłkowy, kompot, owoce w syropie, nutella, masło orzechowe, krem czekoladowy, syrop klonowy"),
    ("Spiżarnia (suche)", "Przyprawy, zioła i octy", "sól, pieprz, papryka mielona, przyprawa do kurczaka, zioła prowansalskie, majeranek, cynamon, curry, kurkuma, liść laurowy, ziele angielskie, kminek, oregano, bazylia suszona, ocet, ocet balsamiczny, vegeta, maggi, kostki rosołowe"),
    ("Spiżarnia (suche)", "Oliwy, oleje i sosy sałatkowe", "olej rzepakowy, olej słonecznikowy, oliwa z oliwek, olej lniany, olej kokosowy, sos vinegret, sos sałatkowy, dressing, sos czosnkowy, sos jogurtowy, oliwa smakowa"),
    ("Spiżarnia (suche)", "Sosy do dań gorących (ketchup, musztarda)", "ketchup, keczup, keczup pikantny, musztarda, majonez, majonezik, sos sojowy, sos barbecue, sos słodko-kwaśny, sos teriyaki, chrzan, sos tatarski, sos grzybowy, sos pieczeniowy, fix, sos do spaghetti, sos meksykański"),
    ("Napoje i alkohole", "Woda mineralna i źródlana", "woda niegazowana, woda gazowana, woda mineralna, woda źródlana, woda smakowa, woda kokosowa"),
    ("Napoje i alkohole", "Soki, nektary i napoje owocowe", "sok pomarańczowy, sok jabłkowy, sok multiwitamina, nektar, sok pomidorowy, sok z marchwi, napój owocowy, sok grejpfrutowy, sok winogronowy, kubuś, sok wyciskany, lemoniada"),
    ("Napoje i alkohole", "Napoje gazowane i energetyki", "cola, pepsi, sprite, fanta, tonik, oranżada, napój gazowany, energetyk, red bull, tiger, monster, izotonik"),
    ("Napoje i alkohole", "Alkohole słabe (piwa, cydry)", "piwo, piwo bezalkoholowe, cydr, piwo smakowe, radler, kraft, lager, pszeniczne, porter"),
    ("Napoje i alkohole", "Wina (białe, czerwone, musujące)", "wino czerwone, wino białe, wino różowe, wino musujące, prosecco, szampan, wino wytrawne, wino półsłodkie"),
    ("Napoje i alkohole", "Alkohole mocne (wódki, whisky, giny)", "wódka, whisky, gin, rum, likier, koniak, brandy, tequila, nalewka, jägermeister, martini"),
    ("Przekąski i słodycze", "Czekolady i batony", "czekolada, czekolada mleczna, czekolada gorzka, baton, snickers, mars, twix, kitkat, prince polo, milky way, delicje, baton zbożowy, tabliczka"),
    ("Przekąski i słodycze", "Bombonierki i praliny", "bombonierka, praliny, merci, ferrero rocher, michałki, śliwka w czekoladzie, wiśnie w likierze, toffi, trufle"),
    ("Przekąski i słodycze", "Cukierki, żelki i pianki", "cukierki, żelki, landrynki, krówki, ptasie mleczko, pianki, guma do żucia, lizak, draże, mentos, galaretki, marshmallow, cukierki miętowe"),
    ("Przekąski i słodycze", "Chipsy i przekąski smażone", "chipsy, lays, pringles, chrupki kukurydziane, chipsy ziemniaczane, nachos, tortilla chips, chrupki, cheetos, chipsy pieczone"),
    ("Przekąski i słodycze", "Paluszki, krakersy i słone wypieki", "paluszki, krakersy, precelki, tuc, krakersy serowe, grissini, snacki, słone ciasteczka, chrupki solone"),
    ("Przekąski i słodycze", "Orzechy i pestki", "orzechy włoskie, orzechy laskowe, nerkowce, migdały, orzeszki ziemne, pistacje, orzechy solone, pestki dyni, pestki słonecznika, mix orzechów"),
    ("Przekąski i słodycze", "Bakalie i owoce suszone", "rodzynki, żurawina suszona, morele suszone, śliwki suszone, daktyle, figi suszone, wiórki kokosowe, banany suszone, mango suszone, mix bakalii, sezam, siemię lniane"),
    ("Mrożonki", "Warzywa i owoce mrożone", "warzywa mrożone, mieszanka warzywna, groszek mrożony, fasolka szparagowa, brokuł mrożony, szpinak mrożony, truskawki mrożone, maliny mrożone, owoce mrożone, włoszczyzna mrożona, kukurydza mrożona"),
    ("Mrożonki", "Dania gotowe mrożone (pizza, frytki)", "pizza mrożona, frytki, talarki, krążki cebulowe, nuggetsy, dania gotowe mrożone, zapiekanka mrożona, placki ziemniaczane, lasagne mrożona"),
    ("Mrożonki", "Ryby i owoce morza mrożone", "ryba mrożona, filet rybny mrożony, paluszki rybne, krewetki mrożone, mintaj mrożony, dorsz mrożony, łosoś mrożony, owoce morza mrożone"),
    ("Mrożonki", "Garmażeria mrożona (pierogi, krokiety)", "pierogi mrożone, krokiety, uszka, kopytka, naleśniki mrożone, gołąbki, klopsiki, knedle, pyzy"),
    ("Mrożonki", "Lody i desery mrożone", "lody, lód, lody familijne, rożek, ekierka, lody na patyku, sorbet, deser lodowy"),
    ("Higiena i uroda", "Pielęgnacja włosów (szampony, odżywki)", "szampon, odżywka do włosów, maska do włosów, lakier do włosów, żel do włosów, farba do włosów, pianka do włosów, szampon suchy, spray do włosów"),
    ("Higiena i uroda", "Higiena jamy ustnej i golenie", "pasta do zębów, szczoteczka, nić dentystyczna, płyn do płukania ust, maszynki do golenia, pianka do golenia, żel do golenia, płyn po goleniu, wkłady do maszynek"),
    ("Higiena i uroda", "Dezodoranty i zapachy", "dezodorant, antyperspirant, perfumy, woda toaletowa, spray zapachowy, dezodorant w kulce, mgiełka"),
    ("Higiena i uroda", "Pielęgnacja ciała i kąpiel", "żel pod prysznic, mydło, płyn do kąpieli, balsam do ciała, krem, peeling, mydło w płynie, chusteczki nawilżane, wata, patyczki higieniczne, płatki kosmetyczne, krem do rąk"),
    ("Higiena i uroda", "Artykuły dla dzieci i niemowląt", "pieluchy, pieluszki, pampers, pampersy, mokre chusteczki, kaszka, mleko modyfikowane, słoiczki, deserek, oliwka dla dzieci, krem pielęgnacyjny, butelka, smoczek"),
    ("Dom i przemysł", "Chemia do prania i płukania", "proszek do prania, kapsułki do prania, żel do prania, płyn do płukania, płyn do prania, odplamiacz, wybielacz, płyn do tkanin, perełki zapachowe"),
    ("Dom i przemysł", "Chemia do sprzątania powierzchni", "płyn uniwersalny, mleczko czyszczące, płyn do podłóg, spray do kuchni, odtłuszczacz, płyn do szyb, cif, ajax, płyn do mebli, płyn do naczyń, tabletki do zmywarki, sól do zmywarki, nabłyszczacz"),
    ("Dom i przemysł", "Chemia do łazienki i toalety", "płyn do wc, kostka wc, domestos, żel do toalety, płyn do łazienki, odkamieniacz, spray do kabin, odświeżacz powietrza, kostka zapachowa"),
    ("Dom i przemysł", "Artykuły papierowe i higieniczne", "papier toaletowy, ręcznik papierowy, chusteczki higieniczne, serwetki, ręczniki kuchenne, worki na śmieci, folia aluminiowa, folia spożywcza, papier do pieczenia, torebki śniadaniowe, rękaw do pieczenia"),
    ("Dom i przemysł", "Akcesoria kuchenne (gotowanie)", "gąbki, zmywak, ścierka, druciak, rękawice kuchenne, foremki, pojemniki, słoiki, deska do krojenia, tarka, obieraczka, łyżki drewniane"),
    ("Dom i przemysł", "Zastawa stołowa i szkło", "talerze, kubki, szklanki, sztućce, miski, kieliszki, filiżanki, dzbanek, salaterka, garnek, patelnia"),
    ("Dom i przemysł", "Tekstylia domowe", "ręcznik, ścierki, pościel, obrus, poszewka, koc, dywanik, firana, prześcieradło, mata"),
    ("Dom i przemysł", "Oświetlenie i elektryka", "żarówka, bateria, przedłużacz, świeczka, znicz, zapalniczka, zapałki, taśma, żarówka led, listwa"),
    ("Dom i przemysł", "Ogród i narzędzia", "nasiona, ziemia, doniczka, nawóz, rękawice ogrodowe, sekator, wąż ogrodowy, konewka, taśma malarska, śruby"),
    ("Dom i przemysł", "Kultura i rozrywka", "gazeta, czasopismo, książka, gra, karty, puzzle, płyta, bilet, krzyżówki"),
    ("Dom i przemysł", "Przybory szkolne i biurowe", "zeszyt, długopis, ołówek, kredki, blok, klej, nożyczki, taśma klejąca, plastelina, gumka, temperówka, marker, koperty, papier ksero"),
    ("Dom i przemysł", "Zabawki i akcesoria dla dzieci", "zabawka, klocki, lalka, samochodzik, pluszak, gra dla dzieci, bańki, malowanka, piłka"),
]


def get_dzialy() -> list[dict]:
    with get_db() as cur:
        cur.execute("SELECT id, strefa, nazwa, slowa, pozycja FROM dzialy ORDER BY pozycja ASC, id ASC")
        return [dict(r) for r in cur.fetchall()]


def add_dzial(strefa: str, nazwa: str, slowa: str) -> dict:
    with get_db() as cur:
        cur.execute(
            "INSERT INTO dzialy (strefa, nazwa, slowa, pozycja) "
            "VALUES (%s,%s,%s, COALESCE((SELECT MAX(pozycja) FROM dzialy),0)+1) "
            "RETURNING id, strefa, nazwa, slowa, pozycja",
            (strefa, nazwa, slowa),
        )
        return dict(cur.fetchone())


def update_dzial(dzial_id: int, strefa: str, nazwa: str, slowa: str) -> bool:
    with get_db() as cur:
        cur.execute(
            "UPDATE dzialy SET strefa=%s, nazwa=%s, slowa=%s WHERE id=%s",
            (strefa, nazwa, slowa, dzial_id),
        )
        return cur.rowcount > 0


def delete_dzial(dzial_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM dzialy WHERE id=%s", (dzial_id,))
        return cur.rowcount > 0


def reorder_dzialy(ids: list[int]) -> None:
    with get_db() as cur:
        for i, dzial_id in enumerate(ids):
            cur.execute("UPDATE dzialy SET pozycja=%s WHERE id=%s", (i, dzial_id))


# ── Układanie listy wg kolejności działów (z bazy admina) ──

_STOP_SLOWA = {"do", "na", "dla", "bez", "the", "typu", "duze", "male"}


def _slowa(txt: str) -> list[str]:
    return [w for w in re.split(r"[\s,./()%-]+", (txt or "").lower())
            if len(w) >= 3 and w not in _STOP_SLOWA]


def _buduj_indeks_dzialow(dz_list: list[dict]) -> tuple[list, dict, list]:
    """Z listy działów buduje: (pełne klucze wieloczłonowe [set słów, pozycja, dł.],
    indeks pojedynczych słów {słowo: pozycja}, lista słów posortowana wg długości
    malejąco — do dopasowania po rdzeniu)."""
    pelne = []
    slowo_poz: dict[str, int] = {}
    for d in dz_list:
        poz = d["pozycja"]
        for kw in (d["slowa"] or "").split(","):
            ws = _slowa(kw)
            if not ws:
                continue
            pelne.append((set(ws), poz, len(ws)))
            for w in ws:
                slowo_poz.setdefault(w, poz)
    pelne.sort(key=lambda x: -x[2])  # dłuższe (bardziej specyficzne) klucze pierwsze
    slowo_lista = sorted(slowo_poz.items(), key=lambda x: -len(x[0]))
    return pelne, slowo_poz, slowo_lista


def _rdzen_pasuje(a: str, b: str) -> bool:
    """Dopasowanie po wspólnym rdzeniu — łapie polskie odmiany/liczbę mnogą/zdrobnienia:
    marchew↔marchewka, ziemniak↔ziemniaki, jabłko↔jabłka, bułka↔bułki."""
    if a == b:
        return True
    n = 0
    m = min(len(a), len(b))
    while n < m and a[n] == b[n]:
        n += 1
    return n >= 4 and n >= m - 2  # długi wspólny początek pokrywający prawie całe krótsze słowo


def _dzial_pozycja(nazwa: str, pelne: list, slowo_poz: dict, slowo_lista: list) -> int | None:
    ws = _slowa(nazwa)
    if not ws:
        return None
    zb = set(ws)
    for kwset, poz, _ in pelne:          # 1) pełne dopasowanie klucza wieloczłonowego
        if kwset.issubset(zb):
            return poz
    for w in ws:                         # 2) dokładne trafienie słowa w indeksie
        if w in slowo_poz:
            return slowo_poz[w]
    for w in ws:                         # 3) dopasowanie po rdzeniu (odmiany) — dopiero gdy dokładne zawiodło
        for kw, poz in slowo_lista:
            if _rdzen_pasuje(w, kw):
                return poz
    return None


def uloz_liste_wg_dzialow(household_id: int, lista_id: int) -> dict:
    """Układa pozycje „do kupienia" wg globalnej kolejności działów (panel admina).
    Produkt → dział: słowa-klucze z bazy, a gdy brak — podkategoria z historii paragonów."""
    pelne, slowo_poz, slowo_lista = _buduj_indeks_dzialow(get_dzialy())
    with get_db() as cur:
        cur.execute(
            "SELECT id, nazwa FROM lista_zakupow "
            "WHERE lista_id=%s AND household_id=%s AND kupione=FALSE",
            (lista_id, household_id),
        )
        items = [dict(r) for r in cur.fetchall()]
        rozpoznane = 0
        for it in items:
            poz = _dzial_pozycja(it["nazwa"], pelne, slowo_poz, slowo_lista)
            if poz is None:  # fallback: historia zakupów → podkategoria → dział
                cur.execute(
                    "SELECT kategoria FROM pozycje p JOIN wydatki w ON w.id=p.wydatek_id "
                    "WHERE w.household_id=%s AND p.nazwa ILIKE %s LIMIT 5",
                    (household_id, f"%{it['nazwa']}%"),
                )
                for r in cur.fetchall():
                    poz = _dzial_pozycja(r["kategoria"], pelne, slowo_poz, slowo_lista)
                    if poz is not None:
                        break
            it["_poz"] = poz if poz is not None else 99999
            if poz is not None:
                rozpoznane += 1
        items.sort(key=lambda it: (it["_poz"], (it["nazwa"] or "").lower()))
        for i, it in enumerate(items):
            cur.execute("UPDATE lista_zakupow SET pozycja=%s WHERE id=%s", (i, it["id"]))
    return {"rozpoznane": rozpoznane, "wszystkich": len(items)}

