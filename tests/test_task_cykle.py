"""Testy przesuwania daty przy zadaniach powtarzalnych — bez bazy, bez sieci.

Liczenie następnego terminu to jedyny kawałek cykliczności, który da się
sprawdzić lokalnie, a przy okazji ten, w którym najłatwiej o cichy błąd:
pomyłka nie wywala się głośno, tylko po miesiącu okazuje się, że „co miesiąc
15." wypada 13. albo że lutego nie ma wcale.
"""

from datetime import date

from task_db import nastepna_data


def test_dzien():
    assert nastepna_data(date(2026, 8, 28), "dzien", 1) == date(2026, 8, 29)


def test_co_kilka_dni():
    assert nastepna_data(date(2026, 8, 28), "dzien", 10) == date(2026, 9, 7)


def test_tydzien_trzyma_dzien_tygodnia():
    d = date(2026, 8, 25)          # wtorek
    n = nastepna_data(d, "tydzien", 1)
    assert n == date(2026, 9, 1)
    assert n.weekday() == d.weekday()


def test_co_dwa_tygodnie():
    assert nastepna_data(date(2026, 8, 25), "tydzien", 2) == date(2026, 9, 8)


def test_miesiac_trzyma_dzien_miesiaca():
    # Kalendarzowo, nie „30 dni": inaczej data dryfowałaby przy każdym powtórzeniu.
    assert nastepna_data(date(2026, 8, 15), "miesiac", 1) == date(2026, 9, 15)


def test_miesiac_przez_koniec_roku():
    assert nastepna_data(date(2026, 12, 10), "miesiac", 1) == date(2027, 1, 10)


def test_miesiac_31_stycznia_nie_ucieka_na_marzec():
    # 31 lutego nie istnieje — cofamy się do ostatniego dnia miesiąca, bo skok
    # na 3 marca byłby dla użytkownika niespodzianką.
    assert nastepna_data(date(2027, 1, 31), "miesiac", 1) == date(2027, 2, 28)


def test_miesiac_31_stycznia_rok_przestepny():
    assert nastepna_data(date(2028, 1, 31), "miesiac", 1) == date(2028, 2, 29)


def test_rok():
    assert nastepna_data(date(2026, 8, 28), "rok", 1) == date(2027, 8, 28)


def test_rok_29_lutego():
    assert nastepna_data(date(2028, 2, 29), "rok", 1) == date(2029, 2, 28)


def test_brak_daty_daje_none():
    assert nastepna_data(None, "tydzien", 1) is None


def test_nieznany_okres_daje_none():
    assert nastepna_data(date(2026, 8, 28), "kwartal", 1) is None


def test_zero_traktowane_jak_jeden():
    # Interfejs nie powinien tego przysłać, ale zero dałoby zadanie o tym samym
    # terminie w kółko — czyli nieskończoną pętlę odhaczania.
    assert nastepna_data(date(2026, 8, 28), "dzien", 0) == date(2026, 8, 29)


def test_data_jako_tekst():
    assert nastepna_data("2026-08-28", "dzien", 1) == date(2026, 8, 29)
