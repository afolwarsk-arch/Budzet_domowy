"""Dziennik asystenta — jedyna tabela, do której asystent sam zapisuje.

Służy dwóm rzeczom: dziennemu limitowi poleceń (liczonemu tutaj, po stronie
serwera) i pomiarowi trafności pilotażu (pole `wynik`). `wynik` przysyła
przeglądarka, więc nadaje się do statystyki, nie do żadnej kontroli."""

import json

from database import get_db

LIMIT_DZIENNY = 100
WYNIKI = ("zapisano", "odrzucono", "cofnieto", "blad")


class LimitPrzekroczony(Exception):
    pass


def init_asystent_db() -> None:
    with get_db() as cur:
        cur.execute("""CREATE TABLE IF NOT EXISTS asystent_log (
            id           SERIAL PRIMARY KEY,
            household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            polecenie    TEXT NOT NULL,
            propozycje   JSONB,
            wynik        TEXT
        )""")
        cur.execute("CREATE INDEX IF NOT EXISTS asystent_log_user_czas "
                    "ON asystent_log (user_id, created_at)")


def rozpocznij(household_id: int, user_id: int, polecenie: str) -> int:
    """Wpis PRZED wywołaniem modelu, w jednej transakcji ze sprawdzeniem limitu.

    Blokada wiersza użytkownika (`FOR UPDATE`) szereguje równoległe polecenia
    tej samej osoby — bez niej dwa naraz przeszłyby oba przy stanie 99.
    Dzień liczymy w strefie Europe/Warsaw, bo limit ma się odnawiać o północy
    u użytkownika, a nie o 1:00 czy 2:00."""
    with get_db() as cur:
        cur.execute("SELECT id FROM users WHERE id = %s FOR UPDATE", (user_id,))
        cur.execute("""SELECT COUNT(*) AS n FROM asystent_log
                       WHERE user_id = %s
                         AND (created_at AT TIME ZONE 'Europe/Warsaw')::date
                             = (now() AT TIME ZONE 'Europe/Warsaw')::date""", (user_id,))
        if cur.fetchone()["n"] >= LIMIT_DZIENNY:
            raise LimitPrzekroczony()
        cur.execute("INSERT INTO asystent_log (household_id, user_id, polecenie) "
                    "VALUES (%s, %s, %s) RETURNING id",
                    (household_id, user_id, (polecenie or "")[:600]))
        return cur.fetchone()["id"]


def zapisz_propozycje(log_id: int, propozycje: list) -> None:
    with get_db() as cur:
        cur.execute("UPDATE asystent_log SET propozycje = %s WHERE id = %s",
                    (json.dumps(propozycje, ensure_ascii=False, default=str), log_id))


def zapisz_wynik(log_id: int, user_id: int, wynik: str) -> bool:
    """Tylko własny wpis i tylko wartość ze słownika."""
    if wynik not in WYNIKI:
        return False
    with get_db() as cur:
        cur.execute("UPDATE asystent_log SET wynik = %s WHERE id = %s AND user_id = %s",
                    (wynik, log_id, user_id))
        return cur.rowcount > 0


def sprzataj(dni: int = 90) -> int:
    """Polecenia to treść pisana przez użytkownika — nie trzymamy jej dłużej,
    niż potrzeba do oceny pilotażu."""
    with get_db() as cur:
        cur.execute("DELETE FROM asystent_log WHERE created_at < now() - make_interval(days => %s)",
                    (dni,))
        return cur.rowcount
