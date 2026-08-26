"""Testy czystej logiki drzewa zadań — bez bazy, bez sieci."""

from task_db import wykryj_cykl

# pary: [(id, parent_id), ...] — całe drzewo gospodarstwa
DRZEWO = [(1, None), (2, 1), (3, 2), (4, None)]


def test_przeniesienie_do_obcego_poddrzewa_jest_ok():
    assert wykryj_cykl(DRZEWO, 4, 3) is False


def test_bezposrednie_dziecko_jako_rodzic_to_cykl():
    assert wykryj_cykl(DRZEWO, 1, 2) is True


def test_dalszy_potomek_jako_rodzic_to_cykl():
    assert wykryj_cykl(DRZEWO, 1, 3) is True


def test_samo_na_siebie_to_cykl():
    assert wykryj_cykl(DRZEWO, 2, 2) is True


def test_odpiecie_do_korzenia_jest_ok():
    assert wykryj_cykl(DRZEWO, 3, None) is False
