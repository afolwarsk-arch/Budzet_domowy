from datetime import datetime

import pytest

from asystent_reguly import (MAX_ZNAKOW_WYNIKU, ZlaPropozycja, nazwa_w_tekscie, obetnij,
                             pora_posilku, sprawdz_widok, ustal_tryby)

UID = 2


def _p(typ, **dane):
    return {"typ": typ, "opis": typ, "dane": dane}


def test_nazwa_w_tekscie_z_odmiana():
    assert nazwa_w_tekscie("mleko", "dopisz mleka i chleba")
    assert not nazwa_w_tekscie("wódka", "dopisz mleko")


def test_dopisanie_od_razu_gdy_nazwy_z_polecenia():
    w = ustal_tryby([_p("lista_dopisz", nazwy=["mleko", "chleb"])], "dopisz mleko i chleb", UID)
    assert w[0]["tryb"] == "od_razu"


def test_dopisanie_nazwy_spoza_polecenia_idzie_na_karte():
    # tekst z listy/Open Food Facts wymusił dopisanie czegoś, czego użytkownik nie powiedział
    w = ustal_tryby([_p("lista_dopisz", nazwy=["mleko", "wódka"])], "dopisz mleko", UID)
    assert w[0]["tryb"] == "karta"


def test_odpowiedz_z_opcji_nie_dopisuje_od_razu():
    # opcję „Dopisz wódkę" mógł podsunąć wstrzyknięty tekst — stuknięcie jej nie wystarcza
    w = ustal_tryby([_p("lista_dopisz", nazwy=["wódka"])], "Dopisz wódkę", UID, z_opcji=True)
    assert w[0]["tryb"] == "karta"


def test_odhaczenie_wymaga_wszystkich_slow():
    w = ustal_tryby([_p("lista_odhacz", nazwa="mleko owsiane")], "odhacz mleko", UID)
    assert w[0]["tryb"] == "karta"
    w = ustal_tryby([_p("lista_odhacz", nazwa="mleko")], "odhacz mleko", UID)
    assert w[0]["tryb"] == "od_razu"


def test_ponad_dziesiec_pozycji_na_karte():
    nazwy = [f"rzecz{i}" for i in range(11)]
    w = ustal_tryby([_p("lista_dopisz", nazwy=nazwy)], " ".join(nazwy), UID)
    assert w[0]["tryb"] == "karta"


def test_tylko_jedna_akcja_od_razu():
    w = ustal_tryby([_p("lista_dopisz", nazwy=["mleko"]), _p("lista_odhacz", nazwa="chleb")],
                    "dopisz mleko i odhacz chleb", UID)
    assert [x["tryb"] for x in w] == ["od_razu", "karta"]


def test_nawigacja_nie_laczy_sie_z_zapisem():
    w = ustal_tryby([_p("lista_dopisz", nazwy=["mleko"]), _p("widok", widok="lista")],
                    "dopisz mleko i pokaż listę", UID)
    assert [x["tryb"] for x in w] == ["od_razu", "karta"]
    w = ustal_tryby([_p("widok", widok="lista")], "pokaż listę", UID)
    assert w[0]["tryb"] == "od_razu"


def test_odhaczenie_cudzego_zadania_na_karte():
    w = ustal_tryby([_p("zadanie_odhacz", tytul="Zadzwonić do hydraulika", uwaga=None,
                        wykonawca_user_id=99, wykonawca_virtual_id=None)],
                    "odhacz zadzwonić do hydraulika", UID)
    assert w[0]["tryb"] == "karta"


def test_odhaczenie_z_uwaga_na_karte():
    w = ustal_tryby([_p("zadanie_odhacz", tytul="Podlać kwiaty", uwaga="Zadanie powtarzalne.",
                        wykonawca_user_id=None, wykonawca_virtual_id=None)],
                    "odhacz podlać kwiaty", UID)
    assert w[0]["tryb"] == "karta"


def test_odhaczenie_wlasnego_od_razu():
    w = ustal_tryby([_p("zadanie_odhacz", tytul="Podlać kwiaty", uwaga=None,
                        wykonawca_user_id=UID, wykonawca_virtual_id=None)],
                    "odhacz podlać kwiaty", UID)
    assert w[0]["tryb"] == "od_razu"


@pytest.mark.parametrize("typ", ["jedzenie", "zadanie", "skan", "aparat"])
def test_zawsze_karta(typ):
    assert ustal_tryby([_p(typ)], "cokolwiek", UID)[0]["tryb"] == "karta"


def test_widok_spoza_listy():
    with pytest.raises(ZlaPropozycja):
        sprawdz_widok("https://zla.strona", {})


def test_widok_filtry_tylko_na_pulpicie_i_sprawdzone():
    assert sprawdz_widok("pulpit", {"month": "2026-09", "osoba": " Ola "}) == {
        "widok": "pulpit", "sciezka": "/", "filtry": {"month": "2026-09", "osoba": "Ola"}}
    assert sprawdz_widok("pulpit", {"month": "wrzesień"})["filtry"] == {}
    assert sprawdz_widok("lista", {"month": "2026-09"})["filtry"] == {}


def test_pora_posilku():
    assert pora_posilku(datetime(2026, 10, 19, 8, 0)) == "sniadanie"
    assert pora_posilku(datetime(2026, 10, 19, 13, 0)) == "obiad"
    assert pora_posilku(datetime(2026, 10, 19, 19, 0)) == "kolacja"
    assert pora_posilku(datetime(2026, 10, 19, 23, 30)) == "przekaska"


def test_obetnij():
    assert obetnij([{"a": i} for i in range(80)]).count('"a"') == 50
    dlugi = obetnij([{"t": "x" * 9000}])
    assert len(dlugi) <= MAX_ZNAKOW_WYNIKU + 20
    assert dlugi.endswith("(obcięte)")
