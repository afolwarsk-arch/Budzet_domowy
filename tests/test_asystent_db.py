import pytest

import asystent_db
import database
from tests.fake_db import podmien_baze


def test_modul_sql_zna_asystenta():
    assert "LIKE 'asystent-%'" in database._MODUL_SQL
    assert "THEN 'asystent'" in database._MODUL_SQL


def test_rozpocznij_blokuje_wiersz_i_liczy_dzien_warszawski(monkeypatch):
    kursor = podmien_baze(monkeypatch)
    log_id = asystent_db.rozpocznij(1, 2, "dopisz mleko")
    assert log_id == 1
    sql = [z for z, _ in kursor.zapytania]
    assert sql[0].startswith("SELECT id FROM users WHERE id = %s FOR UPDATE")
    assert "Europe/Warsaw" in sql[1]
    assert sql[2].startswith("INSERT INTO asystent_log")


def test_limit_przekroczony(monkeypatch):
    kursor = podmien_baze(monkeypatch)
    monkeypatch.setattr(kursor, "fetchone", lambda: {"n": asystent_db.LIMIT_DZIENNY, "id": 1})
    with pytest.raises(asystent_db.LimitPrzekroczony):
        asystent_db.rozpocznij(1, 2, "dopisz mleko")
    assert not any(z.startswith("INSERT") for z, _ in kursor.zapytania)


def test_wynik_tylko_wlasny_i_ze_slownika(monkeypatch):
    kursor = podmien_baze(monkeypatch)
    assert asystent_db.zapisz_wynik(5, 2, "hakowanie") is False
    assert kursor.zapytania == []
    assert asystent_db.zapisz_wynik(5, 2, "zapisano") is True
    sql, params = kursor.zapytania[0]
    assert "WHERE id = %s AND user_id = %s" in sql
    assert params == ("zapisano", 5, 2)
