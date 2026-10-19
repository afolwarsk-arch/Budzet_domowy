"""Fałszywe połączenie z bazą, które zapisuje każde zapytanie.

Podmieniamy `database._wez_polaczenie`, a nie `get_db` w poszczególnych
modułach: `eat_db`, `task_db` i reszta robią `from database import get_db`,
więc mają własną referencję do funkcji — ale ta funkcja i tak woła
`_wez_polaczenie` z modułu `database`. Jedna podmiana łapie wszystko."""

import database


class FakeKursor:
    def __init__(self):
        self.zapytania = []
        self.rowcount = 1

    def execute(self, sql, params=None):
        self.zapytania.append((" ".join(str(sql).split()), params))

    def fetchone(self):
        # Klucze, o które pytają ścieżki objęte testami (licznik limitu, RETURNING id).
        return {"n": 0, "id": 1}

    def fetchall(self):
        return []

    def close(self):
        pass


class FakePolaczenie:
    def __init__(self, kursor):
        self.kursor = kursor
        self.closed = False
        self.commity = 0

    def cursor(self, cursor_factory=None):
        return self.kursor

    def commit(self):
        self.commity += 1

    def rollback(self):
        pass

    def close(self):
        pass


def podmien_baze(monkeypatch) -> FakeKursor:
    kursor = FakeKursor()
    polaczenie = FakePolaczenie(kursor)
    monkeypatch.setattr(database, "_wez_polaczenie", lambda: (polaczenie, False))
    return kursor
