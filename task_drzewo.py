"""Czysta logika drzewa zadań modułu wiem.task — bez bazy i bez sieci.

ODDZIELONE OD `task_db.py` CELOWO. `database.py` czyta `DATABASE_URL` przy
imporcie modułu, więc wszystko, co go dotyka, jest nieuruchamialne na maszynie
bez bazy — a tam właśnie chodzą testy. Reguły drzewa są jedynym miejscem tego
modułu, gdzie błąd nie wywala się głośno, tylko cicho zapętla dane, więc muszą
dać się przetestować lokalnie.
"""


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
