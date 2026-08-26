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

STATUSY = ("otwarte", "zrobione")


def init_task_db() -> None:
    from database import get_db
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
