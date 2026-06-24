import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).parent / "budget.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS wydatki (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    data       DATE NOT NULL,
    sklep      TEXT,
    suma       REAL NOT NULL,
    osoba      TEXT NOT NULL DEFAULT 'Adam',
    notatki    TEXT,
    zdjecie    TEXT,
    waluta     TEXT NOT NULL DEFAULT 'PLN',
    kurs       REAL NOT NULL DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

# Mapa starych kategorii → (glowna, sub) dla migracji
_MIGRACJA_MAP: dict[str, tuple[str, str]] = {
    # stare kategorie główne jako kategoria
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
    # stare podkategorie spożywcze
    "Owoce i warzywa":             ("Spożywcze", "Owoce"),
    "Nabiał i jaja":               ("Spożywcze", "Nabiał i jaja"),
    "Mięso i wędliny":             ("Spożywcze", "Wędliny i gotowe mięso"),
    "Pieczywo i wypieki":          ("Spożywcze", "Pieczywo i wypieki"),
    "Napoje":                      ("Spożywcze", "Napoje"),
    "Słodycze i przekąski":        ("Spożywcze", "Słodycze i przekąski"),
    "Produkty spożywcze":          ("Spożywcze", "Produkty sypkie i przetwory"),
    # stare podkategorie pozostałe
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
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript(SCHEMA)
        # Migracja: dodaj kolumnę kategoria_glowna jeśli jej nie ma
        # Migracja: dodaj waluta i kurs do wydatki jeśli ich nie ma
        wcols = [r[1] for r in conn.execute("PRAGMA table_info(wydatki)").fetchall()]
        if "waluta" not in wcols:
            conn.execute("ALTER TABLE wydatki ADD COLUMN waluta TEXT NOT NULL DEFAULT 'PLN'")
            conn.execute("ALTER TABLE wydatki ADD COLUMN kurs REAL NOT NULL DEFAULT 1.0")

        cols = [r[1] for r in conn.execute("PRAGMA table_info(pozycje)").fetchall()]
        if "kategoria_glowna" not in cols:
            conn.execute("ALTER TABLE pozycje ADD COLUMN kategoria_glowna TEXT NOT NULL DEFAULT 'Inne'")

        # zawsze aktualizuj wiersze wg mapy (obsługuje też kolejne zmiany nazw kategorii)
        for stara, (glowna, sub) in _MIGRACJA_MAP.items():
            conn.execute(
                "UPDATE pozycje SET kategoria_glowna=?, kategoria=? WHERE kategoria=?",
                (glowna, sub, stara),
            )
        # napraw kategoria_glowna które zmieniły nazwę (np. "Zdrowie i leki" → "Zdrowie")
        _GLOWNA_RENAME = {
            "Zdrowie i leki": "Zdrowie",
        }
        for stara, nowa in _GLOWNA_RENAME.items():
            conn.execute("UPDATE pozycje SET kategoria_glowna=? WHERE kategoria_glowna=?", (nowa, stara))


# --- wydatki ---

def create_wydatek(data: str, sklep: str | None, suma: float, osoba: str,
                   notatki: str | None, zdjecie: str | None,
                   pozycje: list[dict],
                   waluta: str = "PLN", kurs: float = 1.0) -> int:
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO wydatki (data, sklep, suma, osoba, notatki, zdjecie, waluta, kurs) VALUES (?,?,?,?,?,?,?,?)",
            (data, sklep, suma, osoba, notatki, zdjecie, waluta, kurs),
        )
        wydatek_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO pozycje (wydatek_id, nazwa, cena, ilosc, kategoria_glowna, kategoria) VALUES (?,?,?,?,?,?)",
            [(wydatek_id, p["nazwa"], p["cena"], p.get("ilosc", 1),
              p.get("kategoria_glowna", "Inne"), p.get("kategoria", "Inne"))
             for p in pozycje],
        )
    return wydatek_id


def get_wydatki(month: str | None = None, osoba: str | None = None,
                kategoria: str | None = None) -> list[dict]:
    conditions, params = [], []
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


def get_wydatek(wydatek_id: int) -> dict | None:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM wydatki WHERE id = ?", (wydatek_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["pozycje"] = [dict(p) for p in conn.execute(
            "SELECT * FROM pozycje WHERE wydatek_id = ?", (wydatek_id,)
        ).fetchall()]
        return result


def update_wydatek(wydatek_id: int, data: str, sklep: str | None, suma: float,
                   osoba: str, notatki: str | None, pozycje: list[dict]) -> bool:
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE wydatki SET data=?, sklep=?, suma=?, osoba=?, notatki=? WHERE id=?",
            (data, sklep, suma, osoba, notatki, wydatek_id),
        )
        if cur.rowcount == 0:
            return False
        conn.execute("DELETE FROM pozycje WHERE wydatek_id = ?", (wydatek_id,))
        conn.executemany(
            "INSERT INTO pozycje (wydatek_id, nazwa, cena, ilosc, kategoria_glowna, kategoria) VALUES (?,?,?,?,?,?)",
            [(wydatek_id, p["nazwa"], p["cena"], p.get("ilosc", 1),
              p.get("kategoria_glowna", "Inne"), p.get("kategoria", "Inne"))
             for p in pozycje],
        )
    return True


def get_pozycje_do_rekat(month: str | None = None, od: str | None = None, do: str | None = None) -> list[dict]:
    """Zwraca pozycje (z nazwą sklepu) z wybranego okresu do ponownej kategoryzacji."""
    conditions, params = [], []
    if month:
        conditions.append("strftime('%Y-%m', w.data) = ?"); params.append(month)
    if od:
        conditions.append("w.data >= ?"); params.append(od)
    if do:
        conditions.append("w.data <= ?"); params.append(do)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    query = f"""
        SELECT p.id, p.nazwa, p.kategoria_glowna, p.kategoria, w.sklep
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} ORDER BY w.data DESC"""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]


def update_pozycje_kategorie(aktualizacje: list[dict]) -> int:
    """Aktualizuje kategorie wielu pozycji. Zwraca liczbę zmienionych wierszy."""
    with get_db() as conn:
        cur = conn.executemany(
            "UPDATE pozycje SET kategoria_glowna=?, kategoria=? WHERE id=?",
            [(a["kategoria_glowna"], a["kategoria"], a["id"]) for a in aktualizacje],
        )
        return cur.rowcount


def update_notatki(wydatek_id: int, notatki: str) -> bool:
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE wydatki SET notatki=? WHERE id=?", (notatki or None, wydatek_id)
        )
        return cur.rowcount > 0


def delete_wydatek(wydatek_id: int) -> bool:
    with get_db() as conn:
        cur = conn.execute("DELETE FROM wydatki WHERE id = ?", (wydatek_id,))
        return cur.rowcount > 0


# --- statystyki ---

def _where_params(month, osoba):
    conditions, params = [], []
    if month:
        conditions.append("strftime('%Y-%m', w.data) = ?"); params.append(month)
    if osoba:
        conditions.append("w.osoba = ?"); params.append(osoba)
    return ("WHERE " + " AND ".join(conditions)) if conditions else "", params


def stats_kategorie(month=None, osoba=None) -> list[dict]:
    where, params = _where_params(month, osoba)
    query = f"""
        SELECT p.kategoria_glowna AS kategoria_glowna,
               ROUND(SUM(p.cena * p.ilosc), 2) AS suma
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} GROUP BY p.kategoria_glowna ORDER BY suma DESC"""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]


def stats_pozycje_subkat(kategoria: str, month=None, osoba=None, kategoria_glowna=None) -> list[dict]:
    where, params = _where_params(month, osoba)
    extra = f"{'AND' if where else 'WHERE'} p.kategoria = ?"
    params.append(kategoria)
    if kategoria_glowna:
        extra += " AND p.kategoria_glowna = ?"; params.append(kategoria_glowna)
    query = f"""
        SELECT p.id, p.nazwa, p.cena, p.ilosc, ROUND(p.cena * p.ilosc, 2) AS suma, w.sklep, w.data
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} {extra}
        ORDER BY suma DESC"""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]


def stats_subkategorie(kategoria_glowna: str, month=None, osoba=None) -> list[dict]:
    where, params = _where_params(month, osoba)
    params.append(kategoria_glowna)
    query = f"""
        SELECT p.kategoria, ROUND(SUM(p.cena * p.ilosc), 2) AS suma
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} {'AND' if where else 'WHERE'} p.kategoria_glowna = ?
        GROUP BY p.kategoria ORDER BY suma DESC"""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]


def stats_subkategorie_all(month=None, osoba=None) -> list[dict]:
    where, params = _where_params(month, osoba)
    query = f"""
        SELECT p.kategoria_glowna, p.kategoria, ROUND(SUM(p.cena * p.ilosc), 2) AS suma
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} GROUP BY p.kategoria_glowna, p.kategoria ORDER BY p.kategoria_glowna, suma DESC"""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]


def stats_miesiace(n=6, osoba=None, kategoria=None) -> list[dict]:
    params = []
    if kategoria:
        conditions = [f"w.data >= date('now', '-{n} months')", "p.kategoria_glowna = ?"]
        if osoba:
            conditions.append("w.osoba = ?"); params.append(kategoria); params.append(osoba)
        else:
            params.append(kategoria)
        where = "WHERE " + " AND ".join(conditions)
        query = f"""
            SELECT strftime('%Y-%m', w.data) AS miesiac, w.osoba,
                   ROUND(SUM(p.cena * p.ilosc), 2) AS suma
            FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
            {where} GROUP BY miesiac, w.osoba ORDER BY miesiac"""
    else:
        osoba_filter = ""
        if osoba:
            osoba_filter = "AND w.osoba = ?"; params.append(osoba)
        query = f"""
            SELECT strftime('%Y-%m', w.data) AS miesiac, w.osoba,
                   ROUND(SUM(w.suma), 2) AS suma
            FROM wydatki w
            WHERE w.data >= date('now', '-{n} months') {osoba_filter}
            GROUP BY miesiac, w.osoba ORDER BY miesiac"""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]


def stats_sklepy(month=None, osoba=None, limit=10, kategoria=None) -> list[dict]:
    params = []
    if kategoria:
        conditions = ["w.sklep IS NOT NULL", "p.kategoria_glowna = ?"]
        params.append(kategoria)
        if month:
            conditions.append("strftime('%Y-%m', w.data) = ?"); params.append(month)
        if osoba:
            conditions.append("w.osoba = ?"); params.append(osoba)
        where = "WHERE " + " AND ".join(conditions)
        params.append(limit)
        query = f"""
            SELECT w.sklep, ROUND(SUM(p.cena * p.ilosc), 2) AS suma, COUNT(DISTINCT w.id) AS liczba
            FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
            {where} GROUP BY w.sklep ORDER BY suma DESC LIMIT ?"""
    else:
        conditions = ["w.sklep IS NOT NULL"]
        if month:
            conditions.append("strftime('%Y-%m', w.data) = ?"); params.append(month)
        if osoba:
            conditions.append("w.osoba = ?"); params.append(osoba)
        where = "WHERE " + " AND ".join(conditions)
        params.append(limit)
        query = f"""
            SELECT w.sklep, ROUND(SUM(w.suma), 2) AS suma, COUNT(*) AS liczba
            FROM wydatki w {where}
            GROUP BY w.sklep ORDER BY suma DESC LIMIT ?"""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]


def stats_top_produkt(kategoria: str, month=None, osoba=None) -> dict | None:
    where, params = _where_params(month, osoba)
    params.append(kategoria)
    query = f"""
        SELECT p.nazwa, COUNT(*) AS ile_razy, ROUND(SUM(p.cena * p.ilosc), 2) AS suma_total
        FROM pozycje p JOIN wydatki w ON w.id = p.wydatek_id
        {where} {'AND' if where else 'WHERE'} p.kategoria_glowna = ?
        GROUP BY p.nazwa ORDER BY suma_total DESC LIMIT 1"""
    with get_db() as conn:
        row = conn.execute(query, params).fetchone()
        return dict(row) if row else None
