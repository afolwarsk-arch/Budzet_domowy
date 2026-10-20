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
    assert odp["wiadomosc"] == "Stuknij „Odhacz” przy zadaniach, które pasują."
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
    assert odp["wiadomosc"] == "Tego jeszcze nie umiem. Mogę przejść do strony „Zdrowie”."
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
    assert asystent._wiadomosc(k, "Odhaczam.", True, prop) == "Stuknij „Odhacz” przy pozycjach, które pasują."
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
    s = asystent._system(k)
    assert "Wywołaj od razu wszystkie potrzebne narzędzia w jednej odpowiedzi." in s
    assert "rozmowa się kończy" not in s


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
    # I2/U1: model nic nie powiedział i niczego nie zaproponował.
    kursor = podmien_baze(monkeypatch)

    class Milczacy(FakeKlient):
        def create(self, **kw):
            type(self).wywolania += 1
            return NS(content=[], stop_reason="end_turn",
                      usage=NS(input_tokens=100, output_tokens=0))

    Milczacy.ustaw([])
    monkeypatch.setattr(asystent.anthropic, "Anthropic", Milczacy)
    odp = _wywolaj({"tekst": "hmm"})
    assert odp["wiadomosc"] == asystent.KOMUNIKAT_NIEJASNE
    assert asystent.KOMUNIKAT_NIEJASNE == "Nie zrozumiałem — powiedz albo napisz np.: „dopisz mleko i chleb”."
    assert odp["propozycje"] == [] and odp["pytanie"] is None
    assert not any(z.startswith("UPDATE asystent_log SET wynik") for z, p in kursor.zapytania)


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
    assert odp["wiadomosc"] == asystent.KOMUNIKAT_502          # brak czasu to NIE „niezrozumiałem"


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
    assert asystent._wiadomosc(k, "", False, prop) == "Tego jeszcze nie umiem. Mogę przejść do strony „Konta”."
    assert asystent._wiadomosc(k, "Salda nie sprawdzę.", False, prop) == "Salda nie sprawdzę."


# ── poprawki po recenzji zadania 8 (U1–U9, K1–K5) ───────────────────────────

def _prompt():
    return asystent._system(Kontekst(household_id=1, user_id=2, tekst="x",
                                     teraz=datetime(2026, 10, 19, 13, 0)))


def test_prompt_u1_u2_u6_u7():
    s = _prompt()
    assert ("Gdy polecenie jest niezrozumiałe albo nie ma w nim nic do zrobienia: odpowiedz jednym "
            "zdaniem „Nie zrozumiałem. Powiedz np.: „dopisz mleko”, „zjadłem jogurt”, "
            "„zadanie: zadzwonić do mechanika”.” — bez narzędzi.") in s
    assert ("Poza usuwaniem stosuj to zdanie wyłącznie, gdy żadna strona nie pasuje. "
            "Nie łącz go ze zdaniem o poza zakresem.") in s
    assert "Dzień starszy niż 7 dni wstecz: powiedz jednym zdaniem, że taki wpis trzeba zrobić w wiem.eat." in s
    assert "„kupiłem X” = odhaczenie pozycji z listy zakupów." in s
    assert "Gdy X nie ma na liście: „Nie ma „X” na liście zakupów.” — nie dopisuj." in s


def test_prompt_u8_uzytkownik():
    k = Kontekst(household_id=1, user_id=2, tekst="x", teraz=datetime(2026, 10, 19, 13, 0),
                 uzytkownik="Adam")
    assert "UŻYTKOWNIK: Adam" in asystent._system(k)
    assert "UŻYTKOWNIK:" not in _prompt()


def test_uzytkownik_z_domownikow_trafia_do_promptu(monkeypatch):
    podmien_baze(monkeypatch)
    monkeypatch.setattr(database, "get_household_members",
                        lambda h: [{"id": 2, "display_name": "Adam"}, {"id": 3, "name": "Ola K"}])
    monkeypatch.setattr(database, "get_virtual_members", lambda h: [])
    widziane = []

    class Podglad(FakeKlient):
        def create(self, **kw):
            widziane.append(kw["system"])
            return super().create(**kw)

    Podglad.ustaw([])
    monkeypatch.setattr(asystent.anthropic, "Anthropic", Podglad)
    _wywolaj({"tekst": "co mam dziś zrobić dla mnie"})
    assert "UŻYTKOWNIK: Adam" in widziane[0] and "DOMOWNICY: Adam, Ola" in widziane[0]


def test_u4_ucinanie_na_granicy_slowa():
    dlugi = "Salda kont jeszcze nie sprawdzę " * 20
    k = Kontekst(household_id=1, user_id=2, tekst="x", teraz=datetime(2026, 10, 19, 13, 0))
    prop = [{"typ": "widok", "dane": {"widok": "konta", "poza_zakresem": True}}]
    w = asystent._wiadomosc(k, dlugi, True, prop)
    assert len(w) <= 300 and not w.endswith(" ")
    assert w.split()[-1] in {"Salda", "kont", "jeszcze", "nie", "sprawdzę"}     # nie w środku słowa
    pierwsze = ("Długie pierwsze zdanie " * 6).strip() + "."
    zdania = pierwsze + " " + "Drugie zdanie jest bardzo długie i się ciągnie " * 10
    w = asystent._wiadomosc(k, zdania, True, prop)
    assert w == pierwsze


def test_kilka_pasuje_ten_sam_tekst_dla_kazdej_liczby():
    """Karty zostają czynne (to może być wybór albo różne rzeczy) — tekst nie
    mówi „wybierz jedno" i nie zależy od liczby kart."""
    k = Kontekst(household_id=1, user_id=2, tekst="x", teraz=datetime(2026, 10, 19, 13, 0))
    for n in (2, 5, 12):
        zad = [{"typ": "zadanie_odhacz", "dane": {}}] * n
        poz = [{"typ": "lista_odhacz", "dane": {}}] * n
        assert asystent._wiadomosc(k, "", True, zad) == "Stuknij „Odhacz” przy zadaniach, które pasują."
        assert asystent._wiadomosc(k, "", True, poz) == "Stuknij „Odhacz” przy pozycjach, które pasują."
    jedno = [{"typ": "zadanie_odhacz", "dane": {}}]
    assert asystent._wiadomosc(k, "", True, jedno) == ""

def test_k1_koszty_best_effort_nie_psuja_200(monkeypatch):
    podmien_baze(monkeypatch)
    monkeypatch.setattr(database, "get_stan_list", lambda hid: ZAKUPY)

    def psuje(*a, **kw):
        raise RuntimeError("baza padla")

    monkeypatch.setattr(database, "log_api_usage", psuje)
    _model(monkeypatch, [[("zaproponuj_pozycje_listy", {"nazwy": ["mleko"]})]])
    odp = _wywolaj({"tekst": "dopisz mleko"})
    assert len(odp["propozycje"]) == 1


def test_k1_koszty_best_effort_nie_zastepuja_502(monkeypatch):
    podmien_baze(monkeypatch)

    def psuje(*a, **kw):
        raise RuntimeError("baza padla")

    monkeypatch.setattr(task_db, "szukaj", lambda *a, **kw: [])

    class Psujacy(FakeKlient):
        def create(self, **kw):
            if type(self).krok >= 1:
                raise KeyError("x")           # drugi krok: koszty pierwszego już są w k.koszty
            return super().create(**kw)

    Psujacy.ustaw([[("szukaj_zadania", {"fraza": "pran"})]])
    monkeypatch.setattr(database, "log_api_usage", psuje)
    monkeypatch.setattr(asystent.anthropic, "Anthropic", Psujacy)
    with pytest.raises(HTTPException) as e:
        _wywolaj({"tekst": "dopisz mleko"})
    assert e.value.status_code == 502


def test_k1_rozpocznij_z_bledem_to_502(monkeypatch):
    podmien_baze(monkeypatch)

    def psuje(*a):
        raise RuntimeError("baza")

    monkeypatch.setattr(asystent_db, "rozpocznij", psuje)
    with pytest.raises(HTTPException) as e:
        _wywolaj({"tekst": "dopisz mleko"})
    assert e.value.status_code == 502


def test_k1_zapisz_propozycje_z_bledem_to_502_i_slad(monkeypatch):
    kursor = podmien_baze(monkeypatch)
    monkeypatch.setattr(database, "get_stan_list", lambda hid: ZAKUPY)

    def psuje(*a):
        raise RuntimeError("baza")

    monkeypatch.setattr(asystent_db, "zapisz_propozycje", psuje)
    _model(monkeypatch, [[("zaproponuj_pozycje_listy", {"nazwy": ["mleko"]})]])
    with pytest.raises(HTTPException) as e:
        _wywolaj({"tekst": "dopisz mleko"})
    assert e.value.status_code == 502
    assert any(z.startswith("UPDATE asystent_log SET wynik") and p[0] == "blad"
               for z, p in kursor.zapytania)


def test_k1_zapisz_wynik_z_bledem_nie_zaslania_502(monkeypatch):
    podmien_baze(monkeypatch)

    def psuje(*a):
        raise RuntimeError("baza")

    class Psujacy(FakeKlient):
        def create(self, **kw):
            raise KeyError("x")

    monkeypatch.setattr(asystent_db, "zapisz_wynik", psuje)
    monkeypatch.setattr(asystent.anthropic, "Anthropic", Psujacy)
    with pytest.raises(HTTPException) as e:
        _wywolaj({"tekst": "dopisz mleko"})
    assert e.value.status_code == 502


def test_k2_timeout_ma_krotki_connect(monkeypatch):
    podmien_baze(monkeypatch)
    widziane = []

    class Podglad(FakeKlient):
        def __init__(self, *a, **kw):
            widziane.append(kw["timeout"])
            super().__init__(*a, **kw)

    Podglad.ustaw([])
    monkeypatch.setattr(asystent.anthropic, "Anthropic", Podglad)
    _wywolaj({"tekst": "dopisz mleko"})
    t = widziane[0]
    # Klasa z SDK, nie z httpx — nowsze SDK (httpx2) odrzuca httpx.Timeout.
    assert isinstance(t, asystent.anthropic.Timeout) and t.connect <= 5 and t.read <= 45


def test_k3_zerwanie_po_samej_uwadze_zachowuje_ja(monkeypatch):
    podmien_baze(monkeypatch)
    monkeypatch.setattr(database, "get_stan_list", lambda hid: [
        {"id": 10, "nazwa": "Zakupy", "status": "aktywna",
         "pozycje": [{"id": 1, "nazwa": "mleko", "kupione": False}]}])
    monkeypatch.setattr(task_db, "szukaj", lambda *a, **kw: [])

    class Zrywajacy(FakeKlient):
        def create(self, **kw):
            if type(self).krok >= 1:
                raise _blad_sieci("timeout")
            return super().create(**kw)

    Zrywajacy.ustaw([[("zaproponuj_pozycje_listy", {"nazwy": ["mleko"]}),
                      ("szukaj_zadania", {"fraza": "pran"})]])
    monkeypatch.setattr(asystent.anthropic, "Anthropic", Zrywajacy)
    odp = _wywolaj({"tekst": "dopisz mleko"})
    assert odp["wiadomosc"] == "Mleko już jest na liście — nie dopisuję drugi raz."


def test_k4_przerwana_petla_nie_pokazuje_zalegajacego_tekstu(monkeypatch):
    podmien_baze(monkeypatch)

    def zadanie(i):
        return {"id": i, "tytul": "Pranie", "status": "otwarte", "powtarzaj": None,
                "parent_id": None, "strefa_id": None, "termin": None,
                "wykonawca_user_id": 2, "wykonawca_virtual_id": None}

    monkeypatch.setattr(task_db, "pobierz", lambda h, u, i: zadanie(i) if i in (5, 6) else None)
    monkeypatch.setattr(task_db, "ma_otwarte_dzieci", lambda h, i: False)
    monkeypatch.setattr(task_db, "szukaj", lambda *a, **kw: [])
    krok = [("#tekst", "Sprawdzam."), ("szukaj_zadania", {"fraza": "pran"})]
    pierwszy = [("#tekst", "Sprawdzam."), ("zaproponuj_odhaczenie_zadania", {"zadanie_id": 5}),
                ("zaproponuj_odhaczenie_zadania", {"zadanie_id": 6}), ("szukaj_zadania", {"fraza": "pran"})]
    _model(monkeypatch, [pierwszy, krok, krok, krok])
    odp = _wywolaj({"tekst": "odhacz pranie"})
    assert FakeKlient.wywolania == asystent.MAX_ITERACJI
    assert odp["wiadomosc"] == "Stuknij „Odhacz” przy zadaniach, które pasują."


def test_k4_przerwana_petla_bez_niczego_to_502_z_sladem(monkeypatch):
    kursor = podmien_baze(monkeypatch)
    monkeypatch.setattr(task_db, "szukaj", lambda *a, **kw: [])
    krok = [("#tekst", "Sprawdzam."), ("szukaj_zadania", {"fraza": "pran"})]
    _model(monkeypatch, [krok] * 4)
    odp = _wywolaj({"tekst": "odhacz pranie"})
    assert odp["wiadomosc"] == asystent.KOMUNIKAT_502
    assert any(z.startswith("UPDATE asystent_log SET wynik") and p[0] == "blad"
               for z, p in kursor.zapytania)


def test_k5_log_bez_dostepu():
    with pytest.raises(HTTPException) as e:
        asystent.wynik_polecenia(1, {"wynik": "zapisano"}, {**ADAM, "email": "ola@example.com"})
    assert e.value.status_code == 403


def test_k5_log_nie_swoj_wpis_to_404(monkeypatch):
    kursor = podmien_baze(monkeypatch)
    kursor.rowcount = 0                       # UPDATE ... AND user_id = %s nic nie zmienił
    with pytest.raises(HTTPException) as e:
        asystent.wynik_polecenia(7, {"wynik": "zapisano"}, ADAM)
    assert e.value.status_code == 404
    assert kursor.zapytania[-1][1] == ("zapisano", 7, ADAM["user_id"])


def test_k5_log_zla_wartosc_to_404_bez_zapytania(monkeypatch):
    kursor = podmien_baze(monkeypatch)
    with pytest.raises(HTTPException) as e:
        asystent.wynik_polecenia(7, {"wynik": "cokolwiek"}, ADAM)
    assert e.value.status_code == 404 and kursor.zapytania == []


def test_k5_log_ok(monkeypatch):
    podmien_baze(monkeypatch)
    assert asystent.wynik_polecenia(7, {"wynik": "cofnieto"}, ADAM) == {"ok": True}


def test_k5_api_me_asystent_tylko_dla_listy():
    # main.py nie da się zaimportować w testach (init_db przy imporcie), więc
    # pinujemy dwie połowy: wiązanie flagi w get_me i funkcję, którą wywołuje.
    from pathlib import Path
    zrodlo = (Path(__file__).resolve().parent.parent / "main.py").read_text(encoding="utf-8")
    assert '"asystent": _ASYSTENT_OK and asystent.ma_dostep(current_user)' in zrodlo
    assert asystent.ma_dostep({"email": "A.Folwarsk@gmail.com"}) is True
    assert asystent.ma_dostep({"email": "ola@example.com"}) is False
    assert asystent.ma_dostep({}) is False


# ── ostatnia fala poprawek ──────────────────────────────────────────────────

def test_lista_domyslna_id_nieskonczonosc_nie_daje_500(monkeypatch):
    podmien_baze(monkeypatch)
    _model(monkeypatch, [])
    odp = _wywolaj({"tekst": "dopisz mleko", "lista_domyslna_id": float("inf")})
    assert "wiadomosc" in odp
    assert asystent._int(float("inf")) is None and asystent._int(float("nan")) is None


def test_przeciazenie_529_w_drugiej_rundzie_zwraca_propozycje(monkeypatch):
    import httpx
    podmien_baze(monkeypatch)
    monkeypatch.setattr(database, "get_stan_list", lambda hid: ZAKUPY)
    monkeypatch.setattr(task_db, "szukaj", lambda *a, **kw: [])

    class Przeciazony(FakeKlient):
        def create(self, **kw):
            if type(self).krok >= 1:
                zadanie = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
                raise asystent.anthropic.APIStatusError(
                    "overloaded", response=httpx.Response(529, request=zadanie), body=None)
            return super().create(**kw)

    Przeciazony.ustaw([[("zaproponuj_pozycje_listy", {"nazwy": ["mleko"]}),
                        ("szukaj_zadania", {"fraza": "pran"})]])
    monkeypatch.setattr(asystent.anthropic, "Anthropic", Przeciazony)
    odp = _wywolaj({"tekst": "dopisz mleko"})
    assert [p["typ"] for p in odp["propozycje"]] == ["lista_dopisz"]


def test_budzet_czasu_z_zapasem_przed_ciecieem_proxy():
    assert asystent.MAX_CZAS_S <= 55
