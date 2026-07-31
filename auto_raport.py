"""Automatyczny raport budżetowy — generowany w OSTATNI dzień każdego miesiąca.

Odpalany przez scheduler (APScheduler) w main.py. Dla każdego gospodarstwa domyka
miesiąc i generuje raport doradcy AI, o ile takiego (automatycznego) jeszcze w tym
miesiącu nie ma. Bieżący miesiąc traktowany jest jako pełny (miesiac_pelny=True)."""

import json as _json
from datetime import datetime
from zoneinfo import ZoneInfo

import ai_processor
import database

MIESIACE_OKNO = 3          # ile miesięcy wstecz bierze doradca do kontekstu/trendów
STREFA = ZoneInfo("Europe/Warsaw")
MODEL = "claude-sonnet-4-6"


def _raport_dla_gospodarstwa(hid: int, miesiac: str) -> str:
    """Generuje i zapisuje jeden raport. Zwraca krótki opis wyniku (do logu)."""
    if database.auto_raport_istnieje(hid, miesiac):
        return f"gosp {hid}: raport za {miesiac} już istnieje — pomijam"

    dane = database.zbierz_dane_budzet(hid, MIESIACE_OKNO, miesiac_pelny=True)
    if not dane["wydatki_per_miesiac"]:
        return f"gosp {hid}: brak wydatków — pomijam"

    profil = [p["tresc"] for p in database.get_profil_ai(hid)]
    # kontekst do modelu = None (nie zaśmiecamy promptu etykietą); etykieta idzie tylko do historii
    raport, usage = ai_processor.analizuj_budzet(dane, None, profil)

    # liczby kondycji zawsze z systemu — model bywa kreatywny w arytmetyce
    kw = dane["kondycja_wyliczona"]
    kondycja = raport.setdefault("kondycja", {})
    kondycja["wydatki_mies"] = kw["wydatki_mies"]
    kondycja["wplywy_mies"] = kw["wplywy_mies"]
    kondycja["bilans_mies"] = kw["bilans_mies"]

    database.log_api_usage(hid, "analiza-raport", usage["input_tokens"], usage["output_tokens"])
    etykieta = f"Raport miesięczny (automatyczny) — {miesiac}"
    database.save_raport_ai(hid, MIESIACE_OKNO, etykieta,
                            _json.dumps(raport, ensure_ascii=False), MODEL, auto=True)
    return f"gosp {hid}: raport za {miesiac} zapisany"


def uruchom_auto_raporty() -> None:
    """Wejście dla schedulera. Sam sprawdza, czy dziś jest ostatni dzień miesiąca
    (job i tak jest zaplanowany na `day='last'`, ale to zabezpieczenie na wypadek
    ręcznego wywołania). Błąd jednego gospodarstwa nie przerywa reszty."""
    import calendar
    teraz = datetime.now(STREFA)
    ostatni = calendar.monthrange(teraz.year, teraz.month)[1]
    if teraz.day != ostatni:
        print(f"[auto_raport] {teraz.date()} nie jest ostatnim dniem miesiąca — pomijam")
        return

    miesiac = teraz.strftime("%Y-%m")
    print(f"[auto_raport] start — raporty miesięczne za {miesiac}")
    for hid in database.get_all_household_ids():
        try:
            print(f"[auto_raport] {_raport_dla_gospodarstwa(hid, miesiac)}")
        except Exception as e:
            print(f"[auto_raport] gosp {hid}: BŁĄD — {e!r}")
    print("[auto_raport] koniec")


if __name__ == "__main__":
    from dotenv import load_dotenv
    from pathlib import Path
    load_dotenv(Path(__file__).parent / ".env")
    uruchom_auto_raporty()
