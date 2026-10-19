"""Granica zapisu: podczas obsługi polecenia baza widzi tylko odczyty oraz
zapisy do `asystent_log` i `api_usage` — cokolwiek model zawoła."""

import asyncio
import re
from datetime import datetime
from types import SimpleNamespace as NS

import pytest
from fastapi import HTTPException

import asystent
import asystent_db
import database
import task_db
from asystent_narzedzia import Kontekst
from tests.fake_db import podmien_baze

ADAM = {"email": "a.folwarsk@gmail.com", "household_id": 1, "user_id": 2, "ai_zablokowane": False}
DOZWOLONE = re.compile(r"^(SELECT|INSERT INTO asystent_log|INSERT INTO api_usage|UPDATE asystent_log)\b")
ZAKUPY = [{"id": 10, "nazwa": "Zakupy", "status": "aktywna", "pozycje": []}]


def _uzycie(nazwa, wejscie, i):
    return NS(type="tool_use", id=f"t{i}", name=nazwa, input=wejscie)


class FakeKlient:
    """Model, który w kolejnych wywołaniach oddaje kolejne kroki scenariusza,
    potem kończy tekstem „Gotowe.". Krok to lista par (nazwa, wejście); para
    ("#tekst", "…") wstawia blok tekstu obok wywołań narzędzi.

    Licznik kroków jest NA KLASIE: `_rozmowa` tworzy nowego klienta w każdej
    iteracji (limit czasu liczony od nowa), więc licznik na instancji zaczynałby
    od zera i każda iteracja dostawałaby znowu pierwszy krok."""
    scenariusz = []
    krok = 0
    wywolania = 0

    def __init__(self, *a, **kw):
        self.messages = self

    @classmethod
    def ustaw(cls, scenariusz):
        cls.scenariusz, cls.krok, cls.wywolania = scenariusz, 0, 0

    def create(self, **kw):
        assert kw["model"] == "claude-sonnet-4-6"
        cls = type(self)
        cls.wywolania += 1
        if cls.krok < len(cls.scenariusz):
            bloki = [NS(type="text", text=w) if n == "#tekst" else _uzycie(n, w, i)
                     for i, (n, w) in enumerate(cls.scenariusz[cls.krok])]
            cls.krok += 1
            return NS(content=bloki, stop_reason="tool_use",
                      usage=NS(input_tokens=100, output_tokens=20))
        return NS(content=[NS(type="text", text="Gotowe.")], stop_reason="end_turn",
                  usage=NS(input_tokens=100, output_tokens=20))


def _model(monkeypatch, scenariusz):
    FakeKlient.ustaw(scenariusz)
    monkeypatch.setattr(asystent.anthropic, "Anthropic", FakeKlient)


def _wywolaj(cialo, user=ADAM):
    return asyncio.run(asystent.polecenie(cialo, user))


def test_granica_zapisu(monkeypatch):
    kursor = podmien_baze(monkeypatch)
    _model(monkeypatch, [
        [("listy_zakupow", {}), ("drzewo_zadan", {}), ("szukaj_zadania", {"fraza": "farba"})],
        [("zaproponuj_pozycje_listy", {"nazwy": ["mleko"]}),
         ("zaproponuj_odhaczenie_listy", {"pozycja_id": 5}),
         ("zaproponuj_skan", {}),
         ("otworz_aparat", {}),
         ("otworz_widok", {"widok": "lista"})],
    ])
    odp = _wywolaj({"tekst": "dopisz mleko", "teraz": "2026-10-19T08:15:00+02:00"})
    # krok 2 nie domknął się (pusta baza: brak list, brak pozycji) — model dostał
    # wyniki i zakończył trzecim wywołaniem
    assert FakeKlient.wywolania == 3
    assert odp["log_id"] == 1 and odp["wiadomosc"] == "Gotowe."
    zle = [z for z, _ in kursor.zapytania if not DOZWOLONE.match(z)]
    assert zle == []
    assert any(z.startswith("INSERT INTO api_usage") for z, _ in kursor.zapytania)


def test_petla_konczy_sie_po_samych_propozycjach(monkeypatch):
    podmien_baze(monkeypatch)
    monkeypatch.setattr(database, "get_stan_list", lambda hid: ZAKUPY)
    _model(monkeypatch, [[("#tekst", "Dopisałem mleko."),
                          ("zaproponuj_pozycje_listy", {"nazwy": ["mleko"]})]])
    odp = _wywolaj({"tekst": "dopisz mleko"})
    assert FakeKlient.wywolania == 1          # bez zamykającego wywołania modelu
    assert odp["wiadomosc"] == ""             # „Dopisałem" padło przed zapisem — przepada
    assert odp["propozycje"][0]["tryb"] == "od_razu"


def test_petla_trwa_gdy_propozycja_nie_wyszla(monkeypatch):
    podmien_baze(monkeypatch)
    monkeypatch.setattr(database, "get_stan_list", lambda hid: ZAKUPY)
    _model(monkeypatch, [[("zaproponuj_odhaczenie_listy", {"pozycja_id": 5})]])
    odp = _wywolaj({"tekst": "odhacz mleko"})
    # narzędzie odmówiło („Nie ma takiej pozycji") — model musi to zobaczyć
    assert FakeKlient.wywolania == 2
    assert odp["wiadomosc"] == "Gotowe." and odp["propozycje"] == []


def test_duplikat_konczy_petle_i_trafia_do_wiadomosci(monkeypatch):
    podmien_baze(monkeypatch)
    monkeypatch.setattr(database, "get_stan_list", lambda hid: [
        {"id": 10, "nazwa": "Zakupy", "status": "aktywna",
         "pozycje": [{"id": 1, "nazwa": "mleko", "kupione": False}]}])
    _model(monkeypatch, [[("zaproponuj_pozycje_listy", {"nazwy": ["mleko"]})]])
    odp = _wywolaj({"tekst": "dopisz mleko"})
    assert FakeKlient.wywolania == 1
    assert odp["wiadomosc"] == "Mleko już jest na liście — nie dopisuję drugi raz."
    assert odp["propozycje"] == []


def test_dwa_pasujace_zadania_to_dwie_karty(monkeypatch):
    podmien_baze(monkeypatch)

    def zadanie(i):
        return {"id": i, "tytul": "Pranie", "status": "otwarte", "powtarzaj": None,
                "parent_id": None, "strefa_id": None, "termin": None,
                "wykonawca_user_id": 2, "wykonawca_virtual_id": None}

    monkeypatch.setattr(task_db, "pobierz", lambda h, u, i: zadanie(i) if i in (5, 6) else None)
    monkeypatch.setattr(task_db, "ma_otwarte_dzieci", lambda h, i: False)
    _model(monkeypatch, [[("zaproponuj_odhaczenie_zadania", {"zadanie_id": 5}),
                          ("zaproponuj_odhaczenie_zadania", {"zadanie_id": 6})]])
    odp = _wywolaj({"tekst": "odhacz pranie"})
    assert [p["tryb"] for p in odp["propozycje"]] == ["karta", "karta"]
    assert odp["wiadomosc"] == "Pasują dwa zadania — wybierz, które odhaczyć."
    assert FakeKlient.wywolania == 1


def test_poza_zakresem_karta_przejscia_z_odpowiedzia_modelu(monkeypatch):
    podmien_baze(monkeypatch)
    _model(monkeypatch, [[("#tekst", "Salda kont jeszcze nie sprawdzę. Mogę otworzyć Konta."),
                          ("otworz_widok", {"widok": "konta", "poza_zakresem": True})]])
    odp = _wywolaj({"tekst": "ile mam na koncie?"})
    assert FakeKlient.wywolania == 1
    assert odp["wiadomosc"] == "Salda kont jeszcze nie sprawdzę. Mogę otworzyć Konta."
    p = odp["propozycje"][0]
    assert (p["typ"], p["tryb"], p["dane"]["sciezka"]) == ("widok", "karta", "/konta")


def test_poza_zakresem_bez_tekstu_modelu(monkeypatch):
    podmien_baze(monkeypatch)
    _model(monkeypatch, [[("otworz_widok", {"widok": "health", "poza_zakresem": True})]])
    odp = _wywolaj({"tekst": "jakie mam wyniki krwi?"})
    assert odp["wiadomosc"] == "Tego jeszcze nie umiem. Mogę otworzyć Zdrowie."
    assert odp["propozycje"][0]["tryb"] == "karta"


def test_poza_zakresem_spoza_listy_nie_daje_karty(monkeypatch):
    podmien_baze(monkeypatch)
    _model(monkeypatch, [[("otworz_widok", {"widok": "admin", "poza_zakresem": True})]])
    odp = _wywolaj({"tekst": "pokaż panel admina"})
    assert odp["propozycje"] == [] and FakeKlient.wywolania == 2


def test_pytanie_wraca_jako_wiadomosc(monkeypatch):
    podmien_baze(monkeypatch)
    _model(monkeypatch, [[("zapytaj", {"tekst": "Co było w posiłku?", "opcje": ["Kanapka", "Zupa"]})]])
    odp = _wywolaj({"tekst": "zjadłem posiłek z kilku produktów"})
    assert FakeKlient.wywolania == 1          # po pytaniu pętla się kończy
    assert odp["wiadomosc"] == "Co było w posiłku?"
    assert odp["pytanie"]["opcje"] == ["Kanapka", "Zupa"]


def test_nazwa_tylko_w_historii_idzie_na_karte(monkeypatch):
    podmien_baze(monkeypatch)
    monkeypatch.setattr(database, "get_stan_list", lambda hid: ZAKUPY)
    _model(monkeypatch, [[("zaproponuj_pozycje_listy", {"nazwy": ["mleko", "wódka"]})]])
    odp = _wywolaj({"tekst": "dopisz mleko",
                    "historia": [{"kto": "user", "tekst": "co z wódką?"},
                                 {"kto": "asystent", "tekst": "wódka jest na liście"}]})
    assert odp["propozycje"][0]["tryb"] == "karta"


def test_odpowiedz_z_opcji_nie_dopisuje_od_razu(monkeypatch):
    podmien_baze(monkeypatch)
    monkeypatch.setattr(database, "get_stan_list", lambda hid: ZAKUPY)
    _model(monkeypatch, [[("zaproponuj_pozycje_listy", {"nazwy": ["wódka"]})]])
    odp = _wywolaj({"tekst": "Dopisz wódkę", "z_opcji": True})
    assert odp["propozycje"][0]["tryb"] == "karta"


def test_limit_z_tekstem_z_recenzji(monkeypatch):
    podmien_baze(monkeypatch)

    def pelno(*a):
        raise asystent_db.LimitPrzekroczony()

    monkeypatch.setattr(asystent_db, "rozpocznij", pelno)
    with pytest.raises(HTTPException) as e:
        _wywolaj({"tekst": "dopisz mleko"})
    assert e.value.status_code == 429
    assert e.value.detail.startswith("Na dziś to już 100 poleceń.")


def test_prompt_zna_domownikow_i_ostatnie_dni():
    k = Kontekst(household_id=1, user_id=2, tekst="x", teraz=datetime(2026, 10, 19, 13, 0),
                 domownicy=["Adam", "Ola"])
    s = asystent._system(k)
    assert "DOMOWNICY: Adam, Ola" in s
    assert "2026-10-18 (niedziela, wczoraj)" in s and "2026-10-12 (poniedziałek)" in s
    assert "2026-10-11" not in s
    assert "Na koniec odpowiedz" not in s      # zamykające zdanie = zbędne wywołanie modelu


def test_wiadomosc_kilka_pozycji_listy():
    k = Kontekst(household_id=1, user_id=2, tekst="x", teraz=datetime(2026, 10, 19, 13, 0))
    prop = [{"typ": "lista_odhacz", "dane": {}}, {"typ": "lista_odhacz", "dane": {}}]
    assert asystent._wiadomosc(k, "Odhaczam.", True, prop) == "Pasują dwie pozycje — wybierz, którą odhaczyć."
    assert asystent._wiadomosc(k, "Odhaczam.", False, prop) == "Odhaczam."


def test_nieoczekiwany_blad_to_502(monkeypatch):
    podmien_baze(monkeypatch)

    class Psujacy(FakeKlient):
        def create(self, **kw):
            raise KeyError("cokolwiek")

    monkeypatch.setattr(asystent.anthropic, "Anthropic", Psujacy)
    with pytest.raises(HTTPException) as e:
        _wywolaj({"tekst": "dopisz mleko"})
    assert e.value.status_code == 502


def test_asystent_nie_importuje_routerow():
    # Granica zapisu zaczyna się od importów: router zadań czy main wciągnąłby
    # wszystkie funkcje zapisujące.
    from pathlib import Path
    for plik in ("asystent.py", "asystent_narzedzia.py", "asystent_reguly.py", "asystent_db.py"):
        zrodlo = Path(plik).read_text(encoding="utf-8")
        assert not re.search(r"^\s*(import (task|main|eat)\b|from (task|main|eat) import)", zrodlo, re.M), plik


def test_brak_dostepu():
    with pytest.raises(HTTPException) as e:
        _wywolaj({"tekst": "x"}, {**ADAM, "email": "ola@example.com"})
    assert e.value.status_code == 403


def test_ai_wylaczone():
    with pytest.raises(HTTPException) as e:
        _wywolaj({"tekst": "x"}, {**ADAM, "ai_zablokowane": True})
    assert e.value.status_code == 403


def test_historia_obcieta_i_bez_ostatniego_usera():
    h = asystent._historia([{"kto": "asystent", "tekst": "a"}] +
                           [{"kto": k, "tekst": "x" * 900} for k in ["user", "asystent"] * 8] +
                           [{"kto": "user", "tekst": "zawieszone"}])
    assert h[0]["role"] == "user" and h[-1]["role"] == "assistant"
    assert len(h) <= 12 and all(len(w["content"]) <= 500 for w in h)


def test_teraz_z_zepsutym_zegarem_to_czas_serwera():
    assert asystent._teraz("2001-01-01T00:00:00+01:00").year != 2001
    assert asystent._teraz("bzdura").tzinfo is not None


# ── poprawki po recenzji planu (I1, I2, M1, M2) i D3 ────────────────────────

def test_prompt_kaze_wolac_narzedzia_razem():
    k = Kontekst(household_id=1, user_id=2, tekst="x", teraz=datetime(2026, 10, 19, 13, 0))
    assert ("W pierwszej odpowiedzi wywołaj RAZEM wszystkie potrzebne narzędzia (odczyty i "
            "propozycje niewymagające odczytu); po turze z samymi propozycjami rozmowa się "
            "kończy.") in asystent._system(k)


def test_propozycja_z_odczytem_w_jednej_turze_to_druga_runda(monkeypatch):
    # I1: odczyt obok propozycji — model musi zobaczyć wynik odczytu.
    podmien_baze(monkeypatch)
    monkeypatch.setattr(database, "get_stan_list", lambda hid: ZAKUPY)
    monkeypatch.setattr(task_db, "szukaj", lambda *a, **kw: [])
    _model(monkeypatch, [[("zaproponuj_pozycje_listy", {"nazwy": ["mleko"]}),
                          ("szukaj_zadania", {"fraza": "pran"})]])
    odp = _wywolaj({"tekst": "dopisz mleko i odhacz pranie"})
    assert FakeKlient.wywolania == 2
    assert odp["wiadomosc"] == "Gotowe." and len(odp["propozycje"]) == 1


def test_pusta_odpowiedz_to_komunikat_bledu(monkeypatch):
    # I2: model nic nie powiedział i niczego nie zaproponował.
    kursor = podmien_baze(monkeypatch)

    class Milczacy(FakeKlient):
        def create(self, **kw):
            type(self).wywolania += 1
            return NS(content=[], stop_reason="end_turn",
                      usage=NS(input_tokens=100, output_tokens=0))

    Milczacy.ustaw([])
    monkeypatch.setattr(asystent.anthropic, "Anthropic", Milczacy)
    odp = _wywolaj({"tekst": "hmm"})
    assert odp["wiadomosc"] == asystent.KOMUNIKAT_502
    assert odp["propozycje"] == [] and odp["pytanie"] is None
    assert any(z.startswith("UPDATE asystent_log SET wynik") and p[0] == "blad"
               for z, p in kursor.zapytania)


def test_termin_liczony_od_poczatku_polecenia(monkeypatch):
    # M1: czas zużyty przed pętlą (limit, domownicy) zjada budżet 60 s.
    podmien_baze(monkeypatch)
    zegar = {"t": 1000.0}
    monkeypatch.setattr(asystent, "time", NS(monotonic=lambda: zegar["t"]))
    prawdziwe = asystent_db.rozpocznij

    def wolne_rozpocznij(*a):
        zegar["t"] += 57.0
        return prawdziwe(*a)

    monkeypatch.setattr(asystent_db, "rozpocznij", wolne_rozpocznij)
    _model(monkeypatch, [])
    odp = _wywolaj({"tekst": "dopisz mleko"})
    assert FakeKlient.wywolania == 0          # zostały 3 s — model nie startuje
    assert odp["wiadomosc"] == asystent.KOMUNIKAT_502


def _blad_sieci(rodzaj):
    import httpx
    zadanie = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    if rodzaj == "timeout":
        return asystent.anthropic.APITimeoutError(request=zadanie)
    return asystent.anthropic.APIConnectionError(request=zadanie)


@pytest.mark.parametrize("rodzaj", ["timeout", "polaczenie"])
def test_zerwanie_w_drugiej_rundzie_zwraca_propozycje(monkeypatch, rodzaj):
    # M2: propozycje z pierwszej rundy nie przepadają przez timeout drugiej.
    podmien_baze(monkeypatch)
    monkeypatch.setattr(database, "get_stan_list", lambda hid: ZAKUPY)
    monkeypatch.setattr(task_db, "szukaj", lambda *a, **kw: [])

    class Zrywajacy(FakeKlient):
        def create(self, **kw):
            if type(self).krok >= 1:
                type(self).wywolania += 1
                raise _blad_sieci(rodzaj)
            return super().create(**kw)

    Zrywajacy.ustaw([[("zaproponuj_pozycje_listy", {"nazwy": ["mleko"]}),
                      ("szukaj_zadania", {"fraza": "pran"})]])
    monkeypatch.setattr(asystent.anthropic, "Anthropic", Zrywajacy)
    odp = _wywolaj({"tekst": "dopisz mleko"})
    assert Zrywajacy.wywolania == 2
    assert [p["typ"] for p in odp["propozycje"]] == ["lista_dopisz"]


def test_zerwanie_bez_propozycji_to_502(monkeypatch):
    podmien_baze(monkeypatch)
    monkeypatch.setattr(task_db, "szukaj", lambda *a, **kw: [])

    class Zrywajacy(FakeKlient):
        def create(self, **kw):
            if type(self).krok >= 1:
                raise _blad_sieci("timeout")
            return super().create(**kw)

    Zrywajacy.ustaw([[("szukaj_zadania", {"fraza": "pran"})]])
    monkeypatch.setattr(asystent.anthropic, "Anthropic", Zrywajacy)
    with pytest.raises(HTTPException) as e:
        _wywolaj({"tekst": "odhacz pranie"})
    assert e.value.status_code == 502


def test_poza_zakresem_bez_tekstu_po_dalszej_rundzie():
    # D3: pętla nie stanęła na propozycjach, a model nic nie napisał —
    # zdanie o braku umiejętności składa serwer.
    k = Kontekst(household_id=1, user_id=2, tekst="x", teraz=datetime(2026, 10, 19, 13, 0))
    prop = [{"typ": "widok", "dane": {"widok": "konta", "poza_zakresem": True}}]
    assert asystent._wiadomosc(k, "", False, prop) == "Tego jeszcze nie umiem. Mogę otworzyć Konta."
    assert asystent._wiadomosc(k, "Salda nie sprawdzę.", False, prop) == "Salda nie sprawdzę."
