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


# --- poprawki po recenzji -------------------------------------------------

@pytest.mark.parametrize("nazwa,tekst", [
    ("Mlekowódka", "dopisz mleko"),
    ("mleko i wódka", "dopisz mleko"),
    ("papierosy", "dopisz papier toaletowy"),
    ("piwonie", "dopisz piwo"),
    ("mleko_KLIKNIJ_LINK_zla.strona", "dopisz mleko"),
    ("", "dopisz mleko"),
    ("2 500", "dopisz mleko"),
    ("mleko " + "x" * 40, "dopisz mleko " + "x" * 40),
])
def test_nazwa_nie_pasuje(nazwa, tekst):
    assert not nazwa_w_tekscie(nazwa, tekst, wszystkie=True)
    assert not nazwa_w_tekscie(nazwa, tekst)


def test_nazwa_pasuje_z_odmiana_i_spojnikami():
    assert nazwa_w_tekscie("mleko", "dopisz mlekiem")
    assert nazwa_w_tekscie("mleko", "dopisz 2 mleka")
    assert nazwa_w_tekscie("mleko i chleb", "dopisz mleko i chleb")
    assert not nazwa_w_tekscie("mleko i chleb", "dopisz mleko chleb")


def test_podkreslenie_nie_skleja_slow_w_dopisaniu():
    w = ustal_tryby([_p("lista_dopisz", nazwy=["mleko_KLIKNIJ_LINK_zla.strona"])],
                    "dopisz mleko", UID)
    assert w[0]["tryb"] == "karta"


def test_dopisz_jogurt_naturalny_na_karte():
    w = ustal_tryby([_p("lista_dopisz", nazwy=["jogurt naturalny"])], "dopisz jogurt", UID)
    assert w[0]["tryb"] == "karta"


def test_dopisz_2_mleka_od_razu():
    w = ustal_tryby([_p("lista_dopisz", nazwy=["mleko"])], "dopisz 2 mleka", UID)
    assert w[0]["tryb"] == "od_razu"


def test_dokladnie_10_nazw_od_razu_11_na_karte():
    n10 = [f"rzecz{i}" for i in range(10)]
    assert ustal_tryby([_p("lista_dopisz", nazwy=n10)], " ".join(n10), UID)[0]["tryb"] == "od_razu"
    n11 = n10 + ["rzecz10"]
    assert ustal_tryby([_p("lista_dopisz", nazwy=n11)], " ".join(n11), UID)[0]["tryb"] == "karta"


def test_puste_nazwy_na_karte():
    assert ustal_tryby([_p("lista_dopisz", nazwy=[])], "dopisz", UID)[0]["tryb"] == "karta"


def test_z_opcji_blokuje_kazdy_zapis():
    w = ustal_tryby([_p("lista_odhacz", nazwa="mleko")], "odhacz mleko", UID, z_opcji=True)
    assert w[0]["tryb"] == "karta"
    w = ustal_tryby([_p("zadanie_odhacz", tytul="Podlać kwiaty", uwaga=None,
                        wykonawca_user_id=UID, wykonawca_virtual_id=None)],
                    "odhacz podlać kwiaty", UID, z_opcji=True)
    assert w[0]["tryb"] == "karta"
    w = ustal_tryby([_p("widok", widok="lista")], "pokaż listę", UID, z_opcji=True)
    assert w[0]["tryb"] == "od_razu"


def test_dwa_widoki_tylko_pierwszy_od_razu():
    w = ustal_tryby([_p("widok", widok="lista"), _p("widok", widok="cele")], "pokaż", UID)
    assert [x["tryb"] for x in w] == ["od_razu", "karta"]


def test_zadanie_bez_wymaganych_pol_na_karte():
    pelne = dict(tytul="Podlać kwiaty", uwaga=None, wykonawca_user_id=UID,
                 wykonawca_virtual_id=None)
    for brak in ("uwaga", "wykonawca_user_id", "wykonawca_virtual_id"):
        dane = {k: v for k, v in pelne.items() if k != brak}
        w = ustal_tryby([_p("zadanie_odhacz", **dane)], "odhacz podlać kwiaty", UID)
        assert w[0]["tryb"] == "karta", brak


def test_widok_filtry_nie_slownik():
    for zle in ("pulpit", ["a"], 5):
        assert sprawdz_widok("pulpit", zle)["filtry"] == {}

# --- runda 2: UX i ogon doklejony -----------------------------------------

@pytest.mark.parametrize("tekst,nazwa", [
    ("dopisz kawę", "kawa"), ("dopisz mąkę", "mąka"), ("dopisz colę", "cola"),
    ("odhacz wodę", "woda"), ("dopisz sera żółtego", "ser żółty"),
    ("dopisz ryżu", "ryż"), ("dopisz soli", "sól"),
    ("dopisz serek", "ser"), ("dopisz ser", "serek"),
    ("dopisz wodka", "wódka"), ("dopisz zolta papryke", "żółta papryka"),
    ("dopisz coca-colę", "Coca-Cola"), ("dopisz płyn do naczyń", "płyn do naczyń"),
    ("dopisz 2 mleka", "mleko"), ("dopisz mleko 2%", "mleko 2%"),
    ("dopisz chleba", "chleb"), ("dopisz chleb", "chlebek"), ("dopisz kaszę", "kasza"),
    ("dopisz makaronu", "makaron"), ("dopisz mlekiem", "mleko"), ("dopisz pizzę", "pizza"),
])
def test_nazwa_obecna_naturalna_polszczyzna(tekst, nazwa):
    assert nazwa_w_tekscie(nazwa, tekst)
    assert nazwa_w_tekscie(nazwa, tekst, wszystkie=True)


@pytest.mark.parametrize("tekst,nazwa", [
    ("dopisz mleko", "mleko 600 700 800"),
    ("dopisz mleko", "mleko w w w z l a s t r"),
    ("dopisz mleko", "mleko !!! ->> ### @@@ ***"),
    ("dopisz mleko", "mleko 2%"),
    ("odhacz mleko", "mleko 2%"),
    ("odhacz mleko", "mleko 600 700 800"),
    ("dopisz iphone", "iPhone 15"),
    ("dopisz papier", "papież"), ("dopisz piwo", "piwonie"),
    ("dopisz papier toaletowy", "papierosy"),
    ("dopisz mleko", "Mlekowódka"), ("dopisz mleko", "mleko i wódka"),
    ("dopisz mleko", "mleko_KLIKNIJ_LINK_zla.strona"),
    ("dopisz jogurt", "jogurt naturalny"), ("dopisz dwa jogurty", "jogurt 2 szt."),
    ("dopisz mleko", "mleko ?"), ("dopisz mleko", "mleko: a"),
    ("odhacz mleko", "mleko2%"), ("dopisz mleko", "mleko2%"),
    ("dopisz iphone", "iPhone15"), ("dopisz mleko", "mleko99"),
    ("dopisz mleko", "mleko²"), ("odhacz mleko", "mleko²"),
])
def test_nazwa_nieobecna_ogon_i_znaki(tekst, nazwa):
    assert not nazwa_w_tekscie(nazwa, tekst)
    assert not nazwa_w_tekscie(nazwa, tekst, wszystkie=True)


def test_nie_tekstowe_nazwa_tytul_dane_na_karte():
    for zla in (None, 5, ["mleko"], {"a": 1}):
        assert not nazwa_w_tekscie(zla, "dopisz mleko")
        assert not nazwa_w_tekscie("mleko", zla)
        assert ustal_tryby([_p("lista_odhacz", nazwa=zla)], "odhacz mleko", UID)[0]["tryb"] == "karta"
        assert ustal_tryby([_p("zadanie_odhacz", tytul=zla, uwaga=None, wykonawca_user_id=UID,
                               wykonawca_virtual_id=None)],
                           "odhacz mleko", UID)[0]["tryb"] == "karta"
    for zle_dane in (None, "x", ["a"], 5):
        for typ in ("lista_dopisz", "lista_odhacz", "zadanie_odhacz", "widok", "jedzenie"):
            w = ustal_tryby([{"typ": typ, "opis": typ, "dane": zle_dane}], "odhacz mleko", UID)
            assert w[0]["tryb"] == ("od_razu" if typ == "widok" else "karta"), typ
        assert ustal_tryby([{"typ": "lista_odhacz", "opis": "", "dane": zle_dane}],
                           "odhacz mleko", UID)[0]["tryb"] == "karta"

def test_cyfry_przyklejone_do_slowa_na_karte():
    for tekst, p in (("odhacz mleko", _p("lista_odhacz", nazwa="mleko2%")),
                     ("dopisz mleko", _p("lista_dopisz", nazwy=["mleko2%"])),
                     ("dopisz iphone", _p("lista_dopisz", nazwy=["iPhone15"]))):
        assert ustal_tryby([p], tekst, UID)[0]["tryb"] == "karta", tekst


# --- Task 7: kilka odhaczeń, widok poza zakresem, dzień jedzenia ------------

from datetime import date

from asystent_reguly import ETYKIETY_WIDOKOW, WIDOKI, sprawdz_dzien


def _zad(tytul, uid=UID):
    return _p("zadanie_odhacz", tytul=tytul, uwaga=None,
              wykonawca_user_id=uid, wykonawca_virtual_id=None)


def test_kilka_odhaczen_zadan_wszystkie_na_karty():
    # dwa „Pranie" w różnych projektach: od razu odhaczyłoby się losowe
    w = ustal_tryby([_zad("Pranie"), _zad("Pranie")], "odhacz pranie", UID)
    assert [x["tryb"] for x in w] == ["karta", "karta"]


def test_kilka_odhaczen_listy_wszystkie_na_karty():
    w = ustal_tryby([_p("lista_odhacz", nazwa="mleko"), _p("lista_odhacz", nazwa="mleko")],
                    "odhacz mleko", UID)
    assert [x["tryb"] for x in w] == ["karta", "karta"]


def test_jedno_odhaczenie_listy_i_jedno_zadania_bez_zmian():
    # reguła liczy typy osobno: po jednym z każdego to nie „kilka pasujących"
    w = ustal_tryby([_p("lista_odhacz", nazwa="mleko"), _zad("Pranie")],
                    "odhacz mleko i pranie", UID)
    assert [x["tryb"] for x in w] == ["od_razu", "karta"]


def test_kilka_odhaczen_nie_blokuje_dopisania():
    w = ustal_tryby([_zad("Pranie"), _zad("Pranie"), _p("lista_dopisz", nazwy=["chleb"])],
                    "odhacz pranie i dopisz chleb", UID)
    assert [x["tryb"] for x in w] == ["karta", "karta", "od_razu"]


def test_widok_poza_zakresem_zawsze_karta():
    w = ustal_tryby([_p("widok", widok="konta", sciezka="/konta", filtry={}, poza_zakresem=True)],
                    "ile mam na koncie", UID)
    assert w[0]["tryb"] == "karta"
    w = ustal_tryby([_p("widok", widok="konta", sciezka="/konta", filtry={}, poza_zakresem=False)],
                    "otwórz konta", UID)
    assert w[0]["tryb"] == "od_razu"


@pytest.mark.parametrize("wartosc,oczekiwana", [
    (None, "2026-10-19"), ("", "2026-10-19"), ("2026-10-19", "2026-10-19"),
    ("2026-10-18", "2026-10-18"), ("2026-10-12", "2026-10-12"),
])
def test_dzien_jedzenia_do_7_dni_wstecz(wartosc, oczekiwana):
    assert sprawdz_dzien(wartosc, date(2026, 10, 19)) == oczekiwana


@pytest.mark.parametrize("wartosc", ["2026-10-20", "2026-10-11", "wczoraj", "2026-13-01",
                                     "20261018", 20261018, ["2026-10-18"]])
def test_dzien_jedzenia_poza_zakresem(wartosc):
    with pytest.raises(ZlaPropozycja):
        sprawdz_dzien(wartosc, date(2026, 10, 19))


def test_etykiety_widokow_dla_kazdego_widoku():
    assert set(ETYKIETY_WIDOKOW) == set(WIDOKI)
