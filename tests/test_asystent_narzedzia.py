import json
import time
from datetime import date, datetime

import pytest

import ai_processor
import asystent_narzedzia as an
import database
import eat_db
import task_ai
import task_db


def _k(tekst="x", lista=None):
    return an.Kontekst(household_id=1, user_id=2, tekst=tekst,
                       teraz=datetime(2026, 10, 19, 13, 0), lista_domyslna_id=lista)


LISTY = [
    {"id": 9, "nazwa": "Stara", "status": "zamknieta", "pozycje": []},
    {"id": 10, "nazwa": "Zakupy", "status": "aktywna", "pozycje": [
        {"id": 100, "nazwa": "chleb", "kupione": False},
        {"id": 101, "nazwa": "masło", "kupione": True}]},
    {"id": 11, "nazwa": "Drogeria", "status": "aktywna", "pozycje": []},
]

CZLONKOWIE = [{"id": 2, "name": "Adam Folwarski", "display_name": None},
              {"id": 3, "name": "Aleksandra Nowak", "display_name": "Ola"}]
WIRTUALNI = [{"id": 7, "name": "Babcia Zosia"}]


def _domownicy(monkeypatch):
    monkeypatch.setattr(database, "get_household_members", lambda hid: CZLONKOWIE)
    monkeypatch.setattr(database, "get_virtual_members", lambda hid: WIRTUALNI)


def _szacunek(pozycje):
    """Podróbka `szacuj_posilek` przyjmująca limity czasu jak prawdziwa."""
    return lambda opis, timeout=None, max_retries=None: (pozycje, {"input_tokens": 10, "output_tokens": 5})


# ── lista zakupów ────────────────────────────────────────────────────────────

def test_dopisanie_na_domyslna_liste(monkeypatch):
    monkeypatch.setattr(database, "get_stan_list", lambda hid: LISTY)
    k = _k(lista=11)
    an.wykonaj("zaproponuj_pozycje_listy", {"nazwy": ["szampon"]}, k)
    assert k.propozycje == [{"typ": "lista_dopisz", "opis": "Dopisz do listy „Drogeria”: szampon",
                             "dane": {"lista_id": 11, "lista_nazwa": "Drogeria", "nazwy": ["szampon"]}}]
    assert k.uwagi == []


def test_lista_id_spoza_gospodarstwa_spada_na_pierwsza_aktywna(monkeypatch):
    # pierwsza w kolejności jest zamknięta — dopisanie nie może tam trafić
    monkeypatch.setattr(database, "get_stan_list", lambda hid: LISTY)
    k = _k()
    an.wykonaj("zaproponuj_pozycje_listy", {"lista_id": 999, "nazwy": ["mleko"]}, k)
    assert k.propozycje[0]["dane"]["lista_id"] == 10


def test_dopisanie_pomija_niekupione_duplikaty(monkeypatch):
    monkeypatch.setattr(database, "get_stan_list", lambda hid: LISTY)
    k = _k(lista=10)
    wynik = an.wykonaj("zaproponuj_pozycje_listy", {"nazwy": ["Chleb", "masło", "mleko"]}, k)
    # „chleb" stoi niekupiony — nie drugi raz; „masło" jest kupione, więc wraca na listę
    assert k.propozycje[0]["dane"]["nazwy"] == ["masło", "mleko"]
    assert k.propozycje[0]["opis"] == "Dopisz do listy „Zakupy”: masło, mleko"
    assert k.uwagi == ["Chleb już jest na liście — nie dopisuję drugi raz."]
    assert "Chleb" in wynik


def test_same_duplikaty_bez_propozycji_ale_z_uwaga(monkeypatch):
    monkeypatch.setattr(database, "get_stan_list", lambda hid: LISTY)
    k = _k(lista=10)
    an.wykonaj("zaproponuj_pozycje_listy", {"nazwy": ["chleba"]}, k)
    assert k.propozycje == []
    # w uwadze nazwa tak, jak stoi na liście — „Chleba już jest" byłoby niegramatyczne
    assert k.uwagi == ["Chleb już jest na liście — nie dopisuję drugi raz."]


def test_odhaczenie_juz_kupionej_nie_tworzy_propozycji(monkeypatch):
    monkeypatch.setattr(database, "get_stan_list", lambda hid: LISTY)
    k = _k()
    wynik = an.wykonaj("zaproponuj_odhaczenie_listy", {"pozycja_id": 101}, k)
    assert k.propozycje == []
    assert "już" in wynik


def test_odhaczenie_pamieta_stan_przed(monkeypatch):
    monkeypatch.setattr(database, "get_stan_list", lambda hid: LISTY)
    k = _k()
    an.wykonaj("zaproponuj_odhaczenie_listy", {"pozycja_id": 100}, k)
    assert k.propozycje[0]["dane"] == {"pozycja_id": 100, "nazwa": "chleb", "lista_nazwa": "Zakupy",
                                       "kupione_przed": False, "kupione_po": True}


def test_odhaczenie_pozycji_z_nieaktywnej_listy_odrzucone(monkeypatch):
    listy = [{"id": 9, "nazwa": "Stara", "status": "zamknieta",
              "pozycje": [{"id": 90, "nazwa": "ser", "kupione": False}]}]
    monkeypatch.setattr(database, "get_stan_list", lambda hid: listy)
    k = _k()
    wynik = an.wykonaj("zaproponuj_odhaczenie_listy", {"pozycja_id": 90}, k)
    assert k.propozycje == [] and "Nie ma takiej pozycji" in wynik


def test_dopisanie_deduplikuje_nazwy_w_jednym_wywolaniu(monkeypatch):
    monkeypatch.setattr(database, "get_stan_list", lambda hid: LISTY)
    k = _k(lista=11)
    an.wykonaj("zaproponuj_pozycje_listy", {"nazwy": ["Żółć", "zolc", "mleko", "MLEKO"]}, k)
    assert k.propozycje[0]["dane"]["nazwy"] == ["Żółć", "mleko"]


@pytest.mark.parametrize("zle", ["mleko", None, 5, ["mleko", 3], {"a": 1}])
def test_nazwy_nie_bedace_lista_napisow_to_brak(monkeypatch, zle):
    monkeypatch.setattr(database, "get_stan_list", lambda hid: LISTY)
    k = _k()
    wynik = an.wykonaj("zaproponuj_pozycje_listy", {"nazwy": zle}, k)
    assert k.propozycje == [] and wynik.startswith("Brak nazw do dopisania")


def test_zapytaj_opcje_jako_napis_odrzucone():
    k = _k()
    wynik = an.wykonaj("zapytaj", {"tekst": "Którą?", "opcje": "abc"}, k)
    assert k.pytanie is None and "2 opcji" in wynik


def test_dodaj_nie_sugeruje_zapisu():
    k = _k()
    wynik = an.wykonaj("otworz_aparat", {}, k)
    assert "Niczego jeszcze nie zapisano" in wynik


# ── zadania ──────────────────────────────────────────────────────────────────

def test_odczyty_zadan_ida_przez_filtr_prywatnosci(monkeypatch):
    from tests.fake_db import podmien_baze
    kursor = podmien_baze(monkeypatch)
    an.wykonaj("drzewo_zadan", {}, _k())
    an.wykonaj("szukaj_zadania", {"fraza": "farba"}, _k())
    assert kursor.zapytania and all("prywatne_dla" in z for z, _ in kursor.zapytania)


def test_szukaj_zadania_z_projektem_wykonawca_i_terminem(monkeypatch):
    _domownicy(monkeypatch)
    monkeypatch.setattr(task_db, "szukaj", lambda h, u, f, limit=200: [
        {"id": 4, "tytul": "Dom", "projekt": True, "parent_id": None, "status": "otwarte",
         "termin": None, "powtarzaj": None, "strefa_id": None,
         "wykonawca_user_id": None, "wykonawca_virtual_id": None},
        {"id": 5, "tytul": "Pranie", "projekt": False, "parent_id": 4, "status": "otwarte",
         "termin": date(2026, 10, 24), "powtarzaj": None, "strefa_id": None,
         "wykonawca_user_id": None, "wykonawca_virtual_id": 7},
    ])
    wynik = json.loads(an.wykonaj("szukaj_zadania", {"fraza": "pranie"}, _k()))
    pranie = next(z for z in wynik if z["id"] == 5)
    assert pranie == {"id": 5, "tytul": "Pranie", "status": "otwarte", "termin": "2026-10-24",
                      "powtarzaj": None, "projekt": "Dom", "wykonawca": "Babcia Zosia"}


def test_ma_otwarte_dzieci_liczy_wszystkie_podzadania_gospodarstwa(monkeypatch):
    from tests.fake_db import podmien_baze
    kursor = podmien_baze(monkeypatch)
    kursor.fetchone = lambda: {"jest": True}
    assert task_db.ma_otwarte_dzieci(1, 5) is True
    sql, params = kursor.zapytania[-1]
    # tylko ostrzeżenie — bez filtra prywatności, ale zawsze w obrębie gospodarstwa
    assert "household_id" in sql and "prywatne_dla" not in sql and params == (5, 1)


def test_zadanie_powtarzalne_z_uwaga(monkeypatch):
    monkeypatch.setattr(task_db, "pobierz", lambda h, u, i: {
        "id": 5, "tytul": "Podlać kwiaty", "status": "otwarte", "powtarzaj": "tydzien",
        "wykonawca_user_id": None, "wykonawca_virtual_id": None})
    monkeypatch.setattr(task_db, "ma_otwarte_dzieci", lambda h, i: True)
    k = _k()
    an.wykonaj("zaproponuj_odhaczenie_zadania", {"zadanie_id": 5}, k)
    d = k.propozycje[0]["dane"]
    assert "powtarzalne" in d["uwaga"] and "Podzadania" in d["uwaga"]
    assert d["cudze"] is False and d["wykonawca"] is None and d["projekt"] is None


def test_odhaczenie_zadania_niesie_projekt_wykonawce_termin_z_bazy(monkeypatch):
    _domownicy(monkeypatch)
    zadania = {
        4: {"id": 4, "tytul": "Dom", "projekt": True, "parent_id": None, "status": "otwarte"},
        5: {"id": 5, "tytul": "Pranie", "projekt": False, "parent_id": 4, "status": "otwarte",
            "termin": date(2026, 10, 24), "powtarzaj": None, "strefa_id": None,
            "wykonawca_user_id": 3, "wykonawca_virtual_id": None},
    }
    monkeypatch.setattr(task_db, "pobierz", lambda h, u, i: zadania.get(i))
    monkeypatch.setattr(task_db, "ma_otwarte_dzieci", lambda h, i: False)
    k = _k()
    # pola od modelu („projekt", „wykonawca") nie mają prawa przejść do propozycji
    an.wykonaj("zaproponuj_odhaczenie_zadania",
               {"zadanie_id": 5, "projekt": "Wstrzyknięty", "wykonawca": "Adam", "cudze": False}, k)
    d = k.propozycje[0]["dane"]
    assert (d["projekt"], d["wykonawca"], d["termin"], d["cudze"]) == ("Dom", "Ola", "2026-10-24", True)
    assert d["uwaga"] is None and d["wykonawca_user_id"] == 3


def test_odhaczenie_wydarzenia_odrzucone(monkeypatch):
    monkeypatch.setattr(task_db, "pobierz", lambda h, u, i: {
        "id": 5, "tytul": "Zjazd", "status": "otwarte", "rodzaj": "wydarzenie"})
    k = _k()
    wynik = an.wykonaj("zaproponuj_odhaczenie_zadania", {"zadanie_id": 5}, k)
    assert k.propozycje == [] and "wydarzenie" in wynik


def _zrozum_z(wykonawca):
    return lambda opis, dzis=None, timeout=None, max_retries=None: (
        {"tytul": "Pranie", "termin": None, "pora": None, "powtarzaj": None, "powtarzaj_co": 1,
         "wykonawca": wykonawca, "gdzie": None}, {"input_tokens": 1, "output_tokens": 1})


def test_wykonawca_opis_to_etykieta_domownika(monkeypatch):
    _domownicy(monkeypatch)
    monkeypatch.setattr(task_ai, "zrozum", _zrozum_z("Oli"))
    monkeypatch.setattr(an, "rozpoznane_miejsce", lambda h, u, g: (None, None))
    monkeypatch.setattr(an, "dopasuj_wykonawce", lambda h, i: (3, None))
    k = _k()
    an.wykonaj("zaproponuj_zadanie", {"opis": "pranie dla Oli"}, k)
    assert k.propozycje[0]["dane"]["wykonawca_opis"] == "Ola" and k.uwagi == []


def test_nierozpoznany_wykonawca_to_uwaga(monkeypatch):
    _domownicy(monkeypatch)
    monkeypatch.setattr(task_ai, "zrozum", _zrozum_z("Kasi"))
    monkeypatch.setattr(an, "rozpoznane_miejsce", lambda h, u, g: (None, None))
    monkeypatch.setattr(an, "dopasuj_wykonawce", lambda h, i: (None, None))
    k = _k()
    an.wykonaj("zaproponuj_zadanie", {"opis": "pranie dla Kasi"}, k)
    assert k.propozycje[0]["dane"]["wykonawca_opis"] is None
    assert k.uwagi == ["Nie znalazłem domownika „Kasi” — zadanie bez wykonawcy."]


def test_zadanie_z_data_telefonu_i_budzetem(monkeypatch):
    widziana = {}

    def zrozum(opis, dzis=None, timeout=None, max_retries=None):
        widziana.update(dzis=dzis, timeout=timeout, max_retries=max_retries)
        return ({"tytul": "Zadzwonić do hydraulika", "termin": "2026-10-23", "pora": None,
                 "powtarzaj": None, "powtarzaj_co": 1, "wykonawca": None, "gdzie": "dom"},
                {"input_tokens": 3, "output_tokens": 2})

    monkeypatch.setattr(task_ai, "zrozum", zrozum)
    monkeypatch.setattr(an, "rozpoznane_miejsce", lambda h, u, g: (None, {"id": 4, "nazwa": "Dom"}))
    monkeypatch.setattr(an, "dopasuj_wykonawce", lambda h, i: (None, None))
    k = _k()
    an.wykonaj("zaproponuj_zadanie", {"opis": "zadzwonić do hydraulika w piątek"}, k)
    assert widziana["dzis"].isoformat() == "2026-10-19"
    assert widziana["max_retries"] == 0 and widziana["timeout"] == 30.0
    d = k.propozycje[0]["dane"]
    assert d["strefa_id"] == 4 and d["parent_id"] is None and d["miejsce_opis"] == "Dom"
    assert d["wykonawca_opis"] is None


# ── jedzenie ─────────────────────────────────────────────────────────────────

def test_blad_narzedzia_nie_wywraca_polecenia(monkeypatch):
    def wybuch(opis, timeout=None, max_retries=None):
        raise ValueError("model oddał nie-JSON")
    monkeypatch.setattr(ai_processor, "szacuj_posilek", wybuch)
    k = _k()
    assert "zawiodło" in an.wykonaj("zaproponuj_wpis_jedzenia", {"opis": "dwa jajka"}, k)
    assert k.propozycje == []


def test_jedzenie_laczy_szacunek_z_baza(monkeypatch):
    monkeypatch.setattr(ai_processor, "szacuj_posilek", _szacunek([
        {"nazwa": "Jogurt naturalny", "ilosc_g": 150, "opis_porcji": "kubek",
         "kcal": 90, "bialko": 5, "tluszcz": 3, "wegle": 7},
        {"nazwa": "Banan", "ilosc_g": 120, "opis_porcji": "sztuka",
         "kcal": 105, "bialko": 1, "tluszcz": 0, "wegle": 27},
    ]))
    monkeypatch.setattr(eat_db, "szukaj_produktow", lambda hid, fraza, limit=20: [
        {"id": 7, "nazwa": "Jogurt naturalny Piątnica", "kcal": 60, "bialko": 4,
         "tluszcz": 2, "wegle": 5}] if fraza.startswith(("jogu", "natu")) else [])
    k = _k()
    an.wykonaj("zaproponuj_wpis_jedzenia",
               {"opis": "jogurt naturalny i banan", "nazwa": "Jogurt z bananem"}, k)
    d = k.propozycje[0]["dane"]
    assert d["posilek"] == "obiad" and d["data"] == "2026-10-19"
    assert d["nazwa_grupy"] == "Jogurt z bananem"
    jogurt, banan = d["pozycje"]
    assert jogurt["produkt_id"] == 7 and jogurt["kcal"] == 90.0 and jogurt["szacunek"] is False
    assert jogurt["produkt_nazwa"] == "Jogurt naturalny Piątnica"
    assert banan["produkt_id"] is None and banan["produkt_nazwa"] is None and banan["szacunek"] is True
    assert k.koszty == [("asystent-eat", {"input_tokens": 10, "output_tokens": 5})]


def test_produkt_bez_kalorii_nie_jest_dopasowaniem(monkeypatch):
    # produkt z Open Food Facts bez kcal: /wpisy/grupa policzyłby float(None)
    monkeypatch.setattr(ai_processor, "szacuj_posilek", _szacunek([
        {"nazwa": "Jogurt naturalny", "ilosc_g": 150, "kcal": 90}]))
    monkeypatch.setattr(eat_db, "szukaj_produktow", lambda hid, fraza, limit=20: [
        {"id": 7, "nazwa": "Jogurt naturalny", "kcal": None}])
    k = _k()
    an.wykonaj("zaproponuj_wpis_jedzenia", {"opis": "jogurt naturalny", "nazwa": "Jogurt"}, k)
    assert k.propozycje[0]["dane"]["pozycje"][0]["produkt_id"] is None


def test_parser_zwraca_nie_slownik_pomijamy_pozycje(monkeypatch):
    monkeypatch.setattr(ai_processor, "szacuj_posilek", _szacunek([
        "śmieć", None, {"nazwa": "Banan", "ilosc_g": 120, "kcal": 105}]))
    monkeypatch.setattr(eat_db, "szukaj_produktow", lambda hid, fraza, limit=20: [])
    k = _k()
    an.wykonaj("zaproponuj_wpis_jedzenia", {"opis": "banan", "nazwa": "Banan"}, k)
    assert [p["nazwa"] for p in k.propozycje[0]["dane"]["pozycje"]] == ["Banan"]


def test_data_spoza_zakresu_podaje_daty(monkeypatch):
    monkeypatch.setattr(ai_processor, "szacuj_posilek", lambda *a, **kw: 1 / 0)
    k = _k()
    for data in ("2026-10-20", "2026-10-01"):
        wynik = an.wykonaj("zaproponuj_wpis_jedzenia", {"opis": "banan", "nazwa": "B", "data": data}, k)
        assert "Dziś jest 2026-10-19" in wynik and "2026-10-12 do 2026-10-19" in wynik
        assert "wiem.eat" in wynik
    assert k.propozycje == []


def test_posilek_zgadniety_tylko_dla_innego_dnia_bez_posilku(monkeypatch):
    monkeypatch.setattr(ai_processor, "szacuj_posilek", _szacunek([
        {"nazwa": "Banan", "ilosc_g": 120, "kcal": 105}]))
    monkeypatch.setattr(eat_db, "szukaj_produktow", lambda hid, fraza, limit=20: [])
    wyniki = []
    for dane in ({}, {"data": "2026-10-18"}, {"data": "2026-10-18", "posilek": "kolacja"}):
        k = _k()
        an.wykonaj("zaproponuj_wpis_jedzenia", {"opis": "banan", "nazwa": "Banan", **dane}, k)
        d = k.propozycje[0]["dane"]
        wyniki.append((d["posilek_zgadniety"], d["inny_dzien"], d["posilek"]))
    assert wyniki == [(False, False, "obiad"), (True, True, "obiad"), (False, True, "kolacja")]
    k = _k()
    an.wykonaj("zaproponuj_skan", {"data": "2026-10-18"}, k)
    assert k.propozycje[0]["dane"]["posilek_zgadniety"] is True


# M8: każde słowo pozycji musi być w nazwie produktu, a produkt może mieć
# najwyżej JEDNO słowo więcej — „banan" nie trafia w „Banany suszone chipsy".
@pytest.mark.parametrize("pozycja,produkt,pasuje", [
    ("banan", "Banan", True),
    ("chleb", "Chleb żytni", True),
    ("banan", "Banany suszone", True),          # jedno słowo więcej — karta pokaże „z bazy"
    ("banan", "Banany suszone chipsy", False),
    ("jogurt naturalny", "Jogurt", False),      # brak słowa pozycji w produkcie
    ("jogurt naturalny", "Jogurt naturalny Piątnica", True),
])
def test_dopasowanie_produktu_wszystkie_slowa_i_najwyzej_jedno_wiecej(monkeypatch, pozycja,
                                                                       produkt, pasuje):
    monkeypatch.setattr(eat_db, "szukaj_produktow", lambda hid, fraza, limit=20: [
        {"id": 7, "nazwa": produkt, "kcal": 90}])
    wynik = an._dopasuj_produkt(1, pozycja)
    assert (wynik is not None) == pasuje


def test_dopasowanie_woli_produkt_bez_nadmiarowych_slow(monkeypatch):
    monkeypatch.setattr(eat_db, "szukaj_produktow", lambda hid, fraza, limit=20: [
        {"id": 8, "nazwa": "Banany suszone", "kcal": 350},
        {"id": 7, "nazwa": "Banan", "kcal": 90}])
    assert an._dopasuj_produkt(1, "banan")["id"] == 7


def test_banan_spoza_bazy_zostaje_szacunkiem(monkeypatch):
    monkeypatch.setattr(ai_processor, "szacuj_posilek", _szacunek([
        {"nazwa": "Banan", "ilosc_g": 120, "kcal": 105}]))
    monkeypatch.setattr(eat_db, "szukaj_produktow", lambda hid, fraza, limit=20: [
        {"id": 9, "nazwa": "Banany suszone chipsy", "kcal": 500}])
    k = _k()
    an.wykonaj("zaproponuj_wpis_jedzenia", {"opis": "banan", "nazwa": "Banan"}, k)
    poz = k.propozycje[0]["dane"]["pozycje"][0]
    assert poz["produkt_id"] is None and poz["szacunek"] is True and poz["kcal"] == 105.0


def test_nazwa_grupy_bez_nazwy_od_modelu_to_nazwa_posilku(monkeypatch):
    monkeypatch.setattr(ai_processor, "szacuj_posilek", _szacunek([
        {"nazwa": "Schabowy", "ilosc_g": 150, "kcal": 400},
        {"nazwa": "Ziemniaki", "ilosc_g": 200, "kcal": 160}]))
    monkeypatch.setattr(eat_db, "szukaj_produktow", lambda hid, fraza, limit=20: [])
    k = _k()
    an.wykonaj("zaproponuj_wpis_jedzenia",
               {"opis": "na obiad był schabowy z ziemniakami i surówką z kapusty"}, k)
    d = k.propozycje[0]["dane"]
    assert d["nazwa_grupy"] == "Obiad"          # nigdy wycinek opisu
    assert k.propozycje[0]["opis"] == "Wpis do dziennika: Obiad"


def test_jedzenie_z_wczoraj(monkeypatch):
    monkeypatch.setattr(ai_processor, "szacuj_posilek", _szacunek([
        {"nazwa": "Banan", "ilosc_g": 120, "kcal": 105}]))
    monkeypatch.setattr(eat_db, "szukaj_produktow", lambda hid, fraza, limit=20: [])
    k = _k()
    an.wykonaj("zaproponuj_wpis_jedzenia", {"opis": "banan", "nazwa": "Banan", "data": "2026-10-18"}, k)
    assert k.propozycje[0]["dane"]["data"] == "2026-10-18"


def test_jedzenie_z_przyszlosci_bez_propozycji_i_bez_parsera(monkeypatch):
    def nie_wolno(*a, **kw):
        raise AssertionError("zła data — parser nie może się uruchomić")
    monkeypatch.setattr(ai_processor, "szacuj_posilek", nie_wolno)
    k = _k()
    wynik = an.wykonaj("zaproponuj_wpis_jedzenia",
                       {"opis": "banan", "nazwa": "Banan", "data": "2026-10-20"}, k)
    assert k.propozycje == [] and "spoza zakresu" in wynik


def test_parser_dostaje_reszte_budzetu_bez_ponowien(monkeypatch):
    widziane = {}

    def szacuj(opis, timeout=None, max_retries=None):
        widziane.update(timeout=timeout, max_retries=max_retries)
        return [{"nazwa": "Banan", "ilosc_g": 120, "kcal": 105}], {"input_tokens": 1, "output_tokens": 1}

    monkeypatch.setattr(ai_processor, "szacuj_posilek", szacuj)
    monkeypatch.setattr(eat_db, "szukaj_produktow", lambda hid, fraza, limit=20: [])
    k = _k()
    k.koniec = time.monotonic() + 20
    an.wykonaj("zaproponuj_wpis_jedzenia", {"opis": "banan", "nazwa": "Banan"}, k)
    assert widziane["max_retries"] == 0 and 10 < widziane["timeout"] <= 18


def test_za_malo_czasu_parser_nie_startuje(monkeypatch):
    def nie_wolno(*a, **kw):
        raise AssertionError("za mało czasu — parser nie może się uruchomić")
    monkeypatch.setattr(ai_processor, "szacuj_posilek", nie_wolno)
    k = _k()
    k.koniec = time.monotonic() + 5
    wynik = an.wykonaj("zaproponuj_wpis_jedzenia", {"opis": "banan", "nazwa": "Banan"}, k)
    assert k.propozycje == [] and "czasu" in wynik


def test_skan_z_powiedziana_porcja_i_dniem():
    k = _k()
    an.wykonaj("zaproponuj_skan", {"sztuk": 2, "gramy": 99999, "data": "2026-10-18"}, k)
    assert k.propozycje[0]["dane"] == {"data": "2026-10-18", "posilek": "obiad", "posilek_zgadniety": True,
                                         "sztuk": 2.0}


# ── widok ────────────────────────────────────────────────────────────────────

def test_widok_spoza_listy_to_komunikat_bez_propozycji():
    k = _k()
    wynik = an.wykonaj("otworz_widok", {"widok": "admin", "poza_zakresem": True}, k)
    assert k.propozycje == [] and "Nie znam" in wynik


def test_widok_osoba_rozpoznana_z_odmiana(monkeypatch):
    _domownicy(monkeypatch)
    k = _k()
    an.wykonaj("otworz_widok", {"widok": "pulpit", "filtry": {"month": "2026-09", "osoba": "Oli"}}, k)
    p = k.propozycje[0]
    assert p["opis"] == "Przejdź: Pulpit"
    assert p["dane"] == {"widok": "pulpit", "sciezka": "/", "poza_zakresem": False,
                         "filtry": {"month": "2026-09", "osoba": "Ola"}}


def test_widok_nieznana_osoba_to_blad_dla_modelu(monkeypatch):
    _domownicy(monkeypatch)
    k = _k()
    wynik = an.wykonaj("otworz_widok", {"widok": "pulpit", "filtry": {"osoba": "Zenek"}}, k)
    assert k.propozycje == [] and "Zenek" in wynik and "Ola" in wynik


def test_widok_poza_zakresem_tylko_scisle_true():
    k = _k()
    an.wykonaj("otworz_widok", {"widok": "konta", "poza_zakresem": True}, k)
    an.wykonaj("otworz_widok", {"widok": "konta", "poza_zakresem": "tak"}, k)
    assert [p["dane"]["poza_zakresem"] for p in k.propozycje] == [True, False]
    assert k.propozycje[0]["opis"] == "Przejdź: Konta"


def test_etykiety_domownikow_jak_filtr_pulpitu(monkeypatch):
    _domownicy(monkeypatch)
    assert an.etykiety_domownikow(1) == ["Adam", "Ola", "Babcia Zosia"]


# ── reszta ───────────────────────────────────────────────────────────────────

def test_zapytaj_ustawia_pytanie():
    k = _k()
    an.wykonaj("zapytaj", {"tekst": "Do którego projektu?", "opcje": ["Dom", "Praca", "Bez", "X", "Y"]}, k)
    assert k.pytanie == {"tekst": "Do którego projektu?", "opcje": ["Dom", "Praca", "Bez", "X"]}


def test_nieznane_narzedzie():
    assert "Nieznane" in an.wykonaj("usun_wszystko", {}, _k())


def test_lista_narzedzi_propozycji():
    nazwy = {t["name"] for t in an.TOOLS}
    assert an.NARZEDZIA_PROPOZYCJI == (
        {n for n in nazwy if n.startswith(("zaproponuj_", "otworz_"))} | {"zapytaj"})
