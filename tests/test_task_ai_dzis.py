from datetime import date, timedelta

import task_ai


def test_kontekst_uzywa_podanej_daty():
    assert "2026-10-23 (piątek)" in task_ai._dzis_kontekst(date(2026, 10, 23))


def test_kontekst_bez_daty_to_dzisiaj():
    assert date.today().isoformat() in task_ai._dzis_kontekst()


def test_data_klienta_przyjeta_w_promieniu_dnia():
    jutro = date.today() + timedelta(days=1)
    assert task_ai.dzis_z_klienta(jutro.isoformat()) == jutro


def test_data_klienta_odrzucona_gdy_zepsuty_zegar():
    assert task_ai.dzis_z_klienta((date.today() + timedelta(days=3)).isoformat()) is None


def test_data_klienta_odrzucona_gdy_smiec():
    assert task_ai.dzis_z_klienta("wczoraj") is None
    assert task_ai.dzis_z_klienta(None) is None
