"""Zapis posiłku z kilku pozycji — wszystkie albo żadna."""

import pytest
from fastapi import HTTPException

import eat
import eat_db
from tests.fake_db import podmien_baze

UZYTKOWNIK = {"household_id": 1, "user_id": 2}


def _cialo(*pozycje):
    return {"posilek": "obiad", "data": "2026-10-19", "nazwa_grupy": "Obiad", "pozycje": list(pozycje)}


def test_blad_w_trzeciej_pozycji_nic_nie_zapisuje(monkeypatch):
    zapisane = []
    monkeypatch.setattr(eat_db, "dodaj_wpisy", lambda h, u, l: zapisane.append(l) or l)
    cialo = _cialo(
        {"nazwa": "Chleb", "ilosc_g": 70, "kcal": 180},
        {"nazwa": "Ser", "ilosc_g": 30, "kcal": 100},
        {"nazwa": "Masło", "ilosc_g": -5, "kcal": 40},
    )
    with pytest.raises(HTTPException) as e:
        eat.dodaj_grupe(cialo, UZYTKOWNIK)
    assert e.value.status_code == 400
    assert e.value.detail.startswith("Pozycja 3:")
    assert e.value.headers["X-Pozycja"] == "2"
    assert zapisane == []


def test_pozycja_z_produktem_ma_kalorie_z_bazy(monkeypatch):
    monkeypatch.setattr(eat_db, "produkt_po_id", lambda pid, hid: {
        "id": 7, "kcal": 200, "bialko": 10, "tluszcz": 5, "wegle": 20})
    monkeypatch.setattr(eat_db, "dodaj_wpisy", lambda h, u, l: l)
    wynik = eat.dodaj_grupe(_cialo(
        {"nazwa": "Ser", "produkt_id": 7, "ilosc_g": 50, "kcal": 9999},
        {"nazwa": "Chleb", "ilosc_g": 70, "kcal": 180},
    ), UZYTKOWNIK)
    ser = wynik["wpisy"][0]
    assert ser["produkt_id"] == 7
    assert ser["kcal"] == 100.0
    assert ser["bialko"] == 5.0
    assert wynik["wpisy"][1]["kcal"] == 180


def test_nieznany_produkt_to_blad_z_numerem(monkeypatch):
    monkeypatch.setattr(eat_db, "produkt_po_id", lambda pid, hid: None)
    monkeypatch.setattr(eat_db, "dodaj_wpisy", lambda h, u, l: l)
    with pytest.raises(HTTPException) as e:
        eat.dodaj_grupe(_cialo({"nazwa": "X", "produkt_id": 99, "ilosc_g": 50}), UZYTKOWNIK)
    assert e.value.status_code == 404
    assert e.value.headers["X-Pozycja"] == "0"


def test_dodaj_wpisy_to_jedna_transakcja(monkeypatch):
    kursor = podmien_baze(monkeypatch)
    wiersz = {"data": "2026-10-19", "posilek": "obiad", "nazwa": "Chleb", "ilosc_g": 70,
              "kcal": 180, "bialko": 6, "tluszcz": 1, "wegle": 35}
    eat_db.dodaj_wpisy(1, 2, [wiersz, wiersz, wiersz])
    inserty = [z for z, _ in kursor.zapytania if z.startswith("INSERT INTO eat_wpisy")]
    assert len(inserty) == 3
    # jedno połączenie, jeden commit — czyli jedna transakcja
    import database
    polaczenie, _ = database._wez_polaczenie()
    assert polaczenie.commity == 1
