"""Reguły asystenta, które da się sprawdzić bez bazy i bez modelu.

Tu zapada decyzja, czy propozycja wykona się OD RAZU, czy pójdzie na kartę
do potwierdzenia — nie w modelu. Model mógł zostać nakłoniony (tytułem
zadania od domownika, nazwą produktu z Open Food Facts) do zaproponowania
czegokolwiek; ta warstwa pilnuje, żeby bez stuknięcia działo się tylko to,
co użytkownik sam powiedział w BIEŻĄCYM poleceniu."""

import json
import re
from datetime import datetime

from task_dopasowanie import slowa

MAX_POZYCJI_LISTY = 10
MAX_ELEMENTOW_WYNIKU = 50
MAX_ZNAKOW_WYNIKU = 4000

# Biała lista widoków. Adres buduje przeglądarka z tej samej listy — model
# podaje tylko nazwę, nigdy ścieżkę.
WIDOKI = {
    "pulpit": "/", "lista": "/lista", "analiza": "/analiza", "konta": "/konta",
    "cele": "/cele", "wplywy": "/wplywy", "eat": "/eat", "produkty": "/produkty",
    "przepisy": "/przepisy", "statystyki": "/statystyki", "task": "/task",
    "health": "/health", "waga": "/waga",
}


class ZlaPropozycja(ValueError):
    pass


def nazwa_w_tekscie(nazwa: str, tekst: str, wszystkie: bool = False) -> bool:
    """Czy użytkownik sam wypowiedział tę nazwę, z tolerancją na polską odmianę
    („mleka" = „mleko"). Domyślnie wystarczy połowa słów znaczących (dopisywanie:
    „dopisz jogurt" → „jogurt naturalny"). `wszystkie=True` przy odhaczaniu:
    „odhacz mleko" nie może trafić w „mleko owsiane"."""
    n = slowa(nazwa)
    if not n:
        return False
    trafione = len(n & slowa(tekst))
    return trafione == len(n) if wszystkie else trafione * 2 >= len(n)


def pora_posilku(teraz: datetime) -> str:
    g = teraz.hour
    if 4 <= g < 11:
        return "sniadanie"
    if 11 <= g < 16:
        return "obiad"
    if 16 <= g < 22:
        return "kolacja"
    return "przekaska"


def obetnij(elementy: list) -> str:
    """Wynik narzędzia odczytowego dla modelu. Bez limitu „pokaż listy" przy
    dużym gospodarstwie potrafiłoby wysłać całą bazę w każdej iteracji pętli."""
    tekst = json.dumps(elementy[:MAX_ELEMENTOW_WYNIKU], ensure_ascii=False, default=str)
    if len(tekst) > MAX_ZNAKOW_WYNIKU:
        tekst = tekst[:MAX_ZNAKOW_WYNIKU] + " …(obcięte)"
    return tekst


def sprawdz_widok(widok: str, filtry: dict | None) -> dict:
    if widok not in WIDOKI:
        raise ZlaPropozycja("Nie znam takiego widoku.")
    czyste = {}
    if widok == "pulpit":
        f = filtry or {}
        miesiac = str(f.get("month") or "")
        if re.fullmatch(r"\d{4}-\d{2}", miesiac):
            czyste["month"] = miesiac
        osoba = f.get("osoba")
        if isinstance(osoba, str) and osoba.strip():
            czyste["osoba"] = osoba.strip()[:40]
    return {"widok": widok, "sciezka": WIDOKI[widok], "filtry": czyste}


def ustal_tryby(propozycje: list[dict], tekst: str, user_id: int,
                z_opcji: bool = False) -> list[dict]:
    """Nadaje każdej propozycji tryb. Najwyżej JEDNA wykonuje się od razu —
    reszta czeka na kartach. Nawigacja też się liczy i nie łączy się z zapisem:
    przejście na inną stronę zabrałoby zapisowi przycisk „Cofnij".

    `z_opcji` — „bieżąca wiadomość" to stuknięta opcja pytania, której treść
    napisał MODEL. Nie może więc niczego dopisać od razu: opcję „Dopisz wódkę"
    mógł podsunąć wstrzyknięty tekst z listy czy z bazy produktów."""
    sa_zapisy = any(p["typ"] != "widok" for p in propozycje)
    uzyte = False
    wynik = []
    for p in propozycje:
        tryb = "karta"
        if not uzyte and _moze_od_razu(p, tekst, user_id, sa_zapisy, z_opcji):
            tryb, uzyte = "od_razu", True
        wynik.append({**p, "tryb": tryb})
    return wynik


def _moze_od_razu(p: dict, tekst: str, user_id: int, sa_zapisy: bool, z_opcji: bool) -> bool:
    typ, d = p["typ"], p["dane"]
    if typ == "widok":
        return not sa_zapisy
    if typ == "lista_dopisz":
        nazwy = d.get("nazwy") or []
        return (not z_opcji and 0 < len(nazwy) <= MAX_POZYCJI_LISTY
                and all(nazwa_w_tekscie(n, tekst) for n in nazwy))
    if typ == "lista_odhacz":
        return nazwa_w_tekscie(d.get("nazwa") or "", tekst, wszystkie=True)
    if typ == "zadanie_odhacz":
        return (not d.get("uwaga")
                and d.get("wykonawca_user_id") in (None, user_id)
                and not d.get("wykonawca_virtual_id")
                and nazwa_w_tekscie(d.get("tytul") or "", tekst, wszystkie=True))
    # jedzenie, nowe zadanie, skan, aparat — zawsze karta
    return False
