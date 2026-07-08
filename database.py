import os
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


@contextmanager
def get_db():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


def init_db():
    with get_db() as cur:
        for stmt in SCHEMA_STATEMENTS:
            cur.execute(stmt)
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT")
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP")
        cur.execute("ALTER TABLE wydatki ADD COLUMN IF NOT EXISTS okazja TEXT")
        cur.execute("ALTER TABLE wydatki ADD COLUMN IF NOT EXISTS kontekst_kategoria TEXT")
        cur.execute("ALTER TABLE wydatki ADD COLUMN IF NOT EXISTS kontekst_podkategoria TEXT")
        cur.execute("ALTER TABLE pozycje ADD COLUMN IF NOT EXISTS poza_kontekstem BOOLEAN NOT NULL DEFAULT FALSE")
        cur.execute("ALTER TABLE wydatki ADD COLUMN IF NOT EXISTS konto_id INTEGER REFERENCES konta(id) ON DELETE SET NULL")
        cur.execute("ALTER TABLE wydatki_cykliczne ADD COLUMN IF NOT EXISTS limit_naliczen INTEGER")
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
        # migracja starego kształtu (jeden raport na gospodarstwo, PK na household_id)
        cur.execute("ALTER TABLE raporty_ai ADD COLUMN IF NOT EXISTS id SERIAL")
        cur.execute("""DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.table_constraints tc
                       JOIN information_schema.key_column_usage k
                         ON k.constraint_name = tc.constraint_name AND k.table_name = tc.table_name
                       WHERE tc.table_name='raporty_ai' AND tc.constraint_type='PRIMARY KEY'
                         AND k.column_name='household_id') THEN
                ALTER TABLE raporty_ai DROP CONSTRAINT raporty_ai_pkey;
                ALTER TABLE raporty_ai ADD PRIMARY KEY (id);
            END IF;
        END $$""")
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
                okazja: str | None = None, kontekst: bool = False) -> list[dict]:
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


def get_pozycje_do_rekat(month: str | None = None, od: str | None = None, do: str | None = None) -> list[dict]:
    conditions, params = [], []
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


def update_pozycje_kategorie(aktualizacje: list[dict]) -> int:
    with get_db() as cur:
        cur.executemany(
            "UPDATE pozycje SET kategoria_glowna=%s, kategoria=%s WHERE id=%s",
            [(a["kategoria_glowna"], a["kategoria"], a["id"]) for a in aktualizacje],
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


def stats_miesiace(n=6, osoba=None, kategoria=None, household_id=None) -> list[dict]:
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


def stats_sklepy(month=None, osoba=None, limit=10, kategoria=None, household_id=None, od=None, do=None) -> list[dict]:
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
        where = "WHERE " + " AND ".join(conditions)
        params.append(limit)
        query = f"""
            SELECT w.sklep, ROUND(CAST(SUM(w.suma) AS numeric), 2) AS suma, COUNT(*) AS liczba
            FROM wydatki w {where}
            GROUP BY w.sklep ORDER BY suma DESC LIMIT %s"""
    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


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

def zbierz_dane_budzet(household_id: int, miesiace: int = 3) -> dict:
    """Zbiera bogaty, skompresowany zestaw danych do analizy AI za ostatnie `miesiace` miesięcy.
    Grupowanie produktów po nazwie zbija liczbę tokenów przy zachowaniu konkretów."""
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

    return {
        "okres": {"od": od, "do": do, "miesiace": miesiace},
        "wydatki_per_miesiac": wydatki_miesiace,
        "wplywy_per_miesiac": wplywy_miesiace,
        "kategorie_per_miesiac": kat_miesiace,
        "top_produkty": produkty,
        "top_sklepy": sklepy,
        "wydatki_cykliczne": cykliczne,
        "wydatki_okazjonalne": okazje,
    }


def save_raport_ai(household_id: int, miesiace: int, kontekst: str | None,
                   raport_json: str, model: str) -> int:
    with get_db() as cur:
        cur.execute("""
            INSERT INTO raporty_ai (household_id, miesiace, kontekst, raport_json, model)
            VALUES (%s,%s,%s,%s,%s) RETURNING id
        """, (household_id, miesiace, kontekst, raport_json, model))
        return cur.fetchone()["id"]


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
               last_login=CURRENT_TIMESTAMP""",
            (firebase_uid, email, name, picture, default_display),
        )
        cur.execute("SELECT id, display_name FROM users WHERE firebase_uid = %s", (firebase_uid,))
        row = cur.fetchone()
        return row["id"], row["display_name"] or default_display


def update_user_display_name(user_id: int, display_name: str) -> None:
    with get_db() as cur:
        cur.execute("UPDATE users SET display_name=%s WHERE id=%s", (display_name, user_id))


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


def get_household_members(household_id: int) -> list[dict]:
    with get_db() as cur:
        cur.execute(
            """SELECT u.id, u.name, u.display_name, u.email, u.picture, m.role
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


def log_api_usage(household_id: int | None, endpoint: str, input_tokens: int, output_tokens: int) -> None:
    with get_db() as cur:
        cur.execute(
            "INSERT INTO api_usage (household_id, endpoint, input_tokens, output_tokens) VALUES (%s,%s,%s,%s)",
            (household_id, endpoint, input_tokens, output_tokens),
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
        cur.execute("DELETE FROM przelewy WHERE konto_z_id IS NULL AND konto_na_id IS NULL")
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
                   konto_z_id: int, konto_na_id: int, opis: str | None) -> dict:
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
        return dict(cur.fetchone())


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
        return cur.rowcount > 0


def delete_przelew(przelew_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM przelewy WHERE id=%s AND household_id=%s", (przelew_id, household_id))
        return cur.rowcount > 0


# --- wydatki cykliczne ---

def get_cykliczne(household_id: int) -> list[dict]:
    with get_db() as cur:
        cur.execute("""
            SELECT c.*, k.nazwa AS konto_nazwa
            FROM wydatki_cykliczne c LEFT JOIN konta k ON k.id = c.konto_id
            WHERE c.household_id = %s ORDER BY c.aktywne DESC, c.nazwa
        """, (household_id,))
        return [dict(r) for r in cur.fetchall()]


def create_cykliczny(household_id: int, nazwa: str, kwota: float, dzien: int,
                     kategoria_glowna: str, kategoria: str, osoba: str,
                     konto_id: int | None, od_miesiaca: str,
                     limit_naliczen: int | None = None) -> dict:
    with get_db() as cur:
        cur.execute(
            """INSERT INTO wydatki_cykliczne
               (household_id, nazwa, kwota, dzien, kategoria_glowna, kategoria, osoba, konto_id, od_miesiaca, limit_naliczen)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (household_id, nazwa, kwota, dzien, kategoria_glowna, kategoria, osoba, konto_id or None,
             od_miesiaca, limit_naliczen),
        )
        return dict(cur.fetchone())


def update_cykliczny(cykliczny_id: int, household_id: int, nazwa: str, kwota: float,
                     dzien: int, kategoria_glowna: str, kategoria: str, osoba: str,
                     konto_id: int | None, aktywne: bool,
                     limit_naliczen: int | None = None) -> bool:
    with get_db() as cur:
        cur.execute(
            """UPDATE wydatki_cykliczne SET nazwa=%s, kwota=%s, dzien=%s, kategoria_glowna=%s,
               kategoria=%s, osoba=%s, konto_id=%s, aktywne=%s, limit_naliczen=%s
               WHERE id=%s AND household_id=%s""",
            (nazwa, kwota, dzien, kategoria_glowna, kategoria, osoba, konto_id or None,
             aktywne, limit_naliczen, cykliczny_id, household_id),
        )
        return cur.rowcount > 0


def delete_cykliczny(cykliczny_id: int, household_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM wydatki_cykliczne WHERE id=%s AND household_id=%s", (cykliczny_id, household_id))
        return cur.rowcount > 0


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


def _ostatni_termin(od_miesiaca, dzien: int, limit_naliczen) -> "date | None":
    """Data ostatniego naliczenia przy ograniczonej liczbie naliczeń (None = bezterminowo)."""
    if not limit_naliczen:
        return None
    import calendar
    from datetime import date as _date
    mies0 = od_miesiaca.year * 12 + (od_miesiaca.month - 1) + limit_naliczen - 1
    rok, mies = divmod(mies0, 12)
    mies += 1
    ostatni = calendar.monthrange(rok, mies)[1]
    return _date(rok, mies, min(dzien, ostatni))


def naliczaj_cykliczne(household_id: int) -> int:
    """Tworzy wydatki za zaległe terminy wszystkich aktywnych wydatków cyklicznych.
    Zwraca liczbę utworzonych wydatków. Bezpieczne przy równoległych wywołaniach
    (claim przez UPDATE ostatnio_do przed INSERT-ami)."""
    from datetime import date as _date
    today = _date.today()
    utworzone = 0
    with get_db() as cur:
        cur.execute("SELECT * FROM wydatki_cykliczne WHERE household_id=%s AND aktywne=TRUE", (household_id,))
        cykliczne = [dict(r) for r in cur.fetchall()]

    for c in cykliczne:
        ostatni_termin = _ostatni_termin(c["od_miesiaca"], c["dzien"], c.get("limit_naliczen"))
        do_dnia = min(today, ostatni_termin) if ostatni_termin else today
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
        for t in terminy:
            create_wydatek(
                data=t.isoformat(), sklep=c["nazwa"], suma=float(c["kwota"]),
                osoba=c["osoba"], notatki="Wydatek cykliczny", zdjecie=None,
                pozycje=[{"nazwa": c["nazwa"], "cena": float(c["kwota"]), "ilosc": 1,
                          "kategoria_glowna": c["kategoria_glowna"], "kategoria": c["kategoria"]}],
                household_id=household_id, konto_id=c["konto_id"],
            )
            utworzone += 1
    return utworzone


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

        cur.execute("SELECT * FROM konta WHERE household_id=%s ORDER BY created_at", (household_id,))
        konta = [dict(r) for r in cur.fetchall()]

        cur.execute("SELECT * FROM wplywy WHERE konto_id IN (SELECT id FROM konta WHERE household_id=%s) ORDER BY data DESC", (household_id,))
        wplywy = [dict(r) for r in cur.fetchall()]

        hier = get_household_hierarchia(household_id)
    return {"wydatki": wydatki, "konta": konta, "wplywy": wplywy, "hierarchia": hier}


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


def create_inwentaryzacja(konto_id: int, household_id: int, data: str,
                           saldo_rzeczywiste: float, notatki: str | None) -> dict:
    with get_db() as cur:
        cur.execute("SELECT id FROM konta WHERE id=%s AND household_id=%s", (konto_id, household_id))
        if not cur.fetchone():
            raise ValueError("Konto nie istnieje")
        saldo_obl = _saldo_konta_na_date(cur, konto_id, data)
        roznica = round(saldo_rzeczywiste - saldo_obl, 2)
        cur.execute(
            "INSERT INTO inwentaryzacje (konto_id, data, saldo_rzeczywiste, saldo_obliczone, roznica, notatki) VALUES (%s,%s,%s,%s,%s,%s) RETURNING *",
            (konto_id, data, saldo_rzeczywiste, saldo_obl, roznica, notatki or None),
        )
        return dict(cur.fetchone())
