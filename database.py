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
                   household_id: int | None = None) -> int:
    with get_db() as cur:
        cur.execute(
            "INSERT INTO wydatki (data,sklep,suma,osoba,notatki,zdjecie,waluta,kurs,household_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
            (data, sklep, suma, osoba, notatki, zdjecie, waluta, kurs, household_id),
        )
        wydatek_id = cur.fetchone()["id"]
        if pozycje:
            cur.executemany(
                "INSERT INTO pozycje (wydatek_id,nazwa,cena,ilosc,kategoria_glowna,kategoria) VALUES (%s,%s,%s,%s,%s,%s)",
                [(wydatek_id, p["nazwa"], p["cena"], p.get("ilosc", 1),
                  p.get("kategoria_glowna", "Inne"), p.get("kategoria", "Inne"))
                 for p in pozycje],
            )
    return wydatek_id


def get_wydatki(month: str | None = None, osoba: str | None = None,
                kategoria: str | None = None, household_id: int | None = None,
                od: str | None = None, do: str | None = None) -> list[dict]:
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
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    if kategoria:
        query = f"""
            SELECT DISTINCT w.id, w.data, w.sklep, w.suma, w.osoba, w.notatki, w.zdjecie, w.created_at
            FROM wydatki w JOIN pozycje p ON p.wydatek_id = w.id
            {where} {'AND' if where else 'WHERE'} p.kategoria_glowna = %s
            ORDER BY w.data DESC"""
        params.append(kategoria)
    else:
        query = f"""
            SELECT w.id, w.data, w.sklep, w.suma, w.osoba, w.notatki, w.zdjecie, w.created_at
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
                   osoba: str, notatki: str | None, pozycje: list[dict]) -> bool:
    with get_db() as cur:
        cur.execute(
            "UPDATE wydatki SET data=%s,sklep=%s,suma=%s,osoba=%s,notatki=%s WHERE id=%s",
            (data, sklep, suma, osoba, notatki, wydatek_id),
        )
        if cur.rowcount == 0:
            return False
        cur.execute("DELETE FROM pozycje WHERE wydatek_id = %s", (wydatek_id,))
        if pozycje:
            cur.executemany(
                "INSERT INTO pozycje (wydatek_id,nazwa,cena,ilosc,kategoria_glowna,kategoria) VALUES (%s,%s,%s,%s,%s,%s)",
                [(wydatek_id, p["nazwa"], p["cena"], p.get("ilosc", 1),
                  p.get("kategoria_glowna", "Inne"), p.get("kategoria", "Inne"))
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


def update_notatki(wydatek_id: int, notatki: str) -> bool:
    with get_db() as cur:
        cur.execute("UPDATE wydatki SET notatki=%s WHERE id=%s", (notatki or None, wydatek_id))
        return cur.rowcount > 0


def delete_wydatek(wydatek_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM wydatki WHERE id = %s", (wydatek_id,))
        return cur.rowcount > 0


# --- statystyki ---

def _where_params(month, osoba, household_id=None, od=None, do=None):
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
    return ("WHERE " + " AND ".join(conditions)) if conditions else "", params


def stats_kategorie(month=None, osoba=None, household_id=None, od=None, do=None) -> list[dict]:
    where, params = _where_params(month, osoba, household_id, od=od, do=do)
    query = f"""
        SELECT p.kategoria_glowna,
               ROUND(CAST(SUM(p.cena * p.ilosc) AS numeric), 2) AS suma
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} GROUP BY p.kategoria_glowna ORDER BY suma DESC"""
    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def stats_pozycje_subkat(kategoria: str, month=None, osoba=None, kategoria_glowna=None, household_id=None, od=None, do=None) -> list[dict]:
    where, params = _where_params(month, osoba, household_id, od=od, do=do)
    extra = f"{'AND' if where else 'WHERE'} p.kategoria = %s"
    params.append(kategoria)
    if kategoria_glowna:
        extra += " AND p.kategoria_glowna = %s"; params.append(kategoria_glowna)
    query = f"""
        SELECT p.id, p.nazwa, p.cena, p.ilosc,
               ROUND(CAST(p.cena * p.ilosc AS numeric), 2) AS suma, w.sklep, w.data
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} {extra}
        ORDER BY suma DESC"""
    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def stats_subkategorie(kategoria_glowna: str, month=None, osoba=None, household_id=None, od=None, do=None) -> list[dict]:
    where, params = _where_params(month, osoba, household_id, od=od, do=do)
    params.append(kategoria_glowna)
    query = f"""
        SELECT p.kategoria, ROUND(CAST(SUM(p.cena * p.ilosc) AS numeric), 2) AS suma
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} {'AND' if where else 'WHERE'} p.kategoria_glowna = %s
        GROUP BY p.kategoria ORDER BY suma DESC"""
    with get_db() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def stats_subkategorie_all(month=None, osoba=None, household_id=None, od=None, do=None) -> list[dict]:
    where, params = _where_params(month, osoba, household_id, od=od, do=do)
    query = f"""
        SELECT p.kategoria_glowna, p.kategoria,
               ROUND(CAST(SUM(p.cena * p.ilosc) AS numeric), 2) AS suma
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} GROUP BY p.kategoria_glowna, p.kategoria ORDER BY p.kategoria_glowna, suma DESC"""
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
                COALESCE(MAX(au.last_call), NULL) AS last_api_call
            FROM households h
            LEFT JOIN memberships m ON m.household_id = h.id
            LEFT JOIN users u ON u.id = m.user_id
            LEFT JOIN wydatki w ON w.household_id = h.id
            LEFT JOIN (
                SELECT household_id,
                       COUNT(*) AS calls,
                       ROUND(CAST(SUM(input_tokens * 3.0 + output_tokens * 15.0) / 1000000 AS numeric), 4) AS cost_usd,
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
