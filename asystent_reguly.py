"""Reguły asystenta, które da się sprawdzić bez bazy i bez modelu.

Tu zapada decyzja, czy propozycja wykona się OD RAZU, czy pójdzie na kartę
do potwierdzenia — nie w modelu. Model mógł zostać nakłoniony (tytułem
zadania od domownika, nazwą produktu z Open Food Facts) do zaproponowania
czegokolwiek; ta warstwa pilnuje, żeby bez stuknięcia działo się tylko to,
co użytkownik sam powiedział w BIEŻĄCYM poleceniu."""

import json
import re
from datetime import datetime

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


MAX_ZNAKOW_NAZWY = 40
_SLOWO = re.compile(r"[^\W_]+")


def _tokeny(tekst: str) -> list[str]:
    # `[^\W_]` — litery i cyfry bez podkreślenia, więc „_" i „." dzielą słowa
    # (nazwa „mleko_KLIKNIJ_LINK" nie skleja się w jedno słowo).
    return _SLOWO.findall((tekst or "").lower())


def _to_samo_slowo(a: str, b: str) -> bool:
    """Słowo nazwy = słowo wiadomości: ten sam początek (4 litery) i różnica
    długości najwyżej 2 — końcówka fleksyjna, nie doklejony ogon
    („piwo" ≠ „piwonie", „papier" ≠ „papierosy")."""
    if len(a) < 4 or len(b) < 4:
        return a == b
    return a[:4] == b[:4] and abs(len(a) - len(b)) <= 2


def nazwa_w_tekscie(nazwa: str, tekst: str, wszystkie: bool = False) -> bool:
    """Czy użytkownik sam wypowiedział tę nazwę, z tolerancją na polską odmianę
    („mleka" = „mleko"). Wymagane są ZAWSZE wszystkie słowa nazwy (decyzja
    Adama): „dopisz jogurt" nie obejmuje „jogurt naturalny". Parametr `wszystkie`
    zostaje dla zgodności wywołań i nic nie zmienia. Jednoliterowe spójniki
    i same cyfry w nazwie są pomijane; nazwa pusta lub dłuższa niż 40 znaków
    nigdy nie pasuje."""
    nazwa = nazwa or ""
    if len(nazwa) > MAX_ZNAKOW_NAZWY:
        return False
    n = [t for t in _tokeny(nazwa) if len(t) >= 2 and not t.isdigit()]
    if not n:
        return False
    m = _tokeny(tekst)
    return all(any(_to_samo_slowo(x, y) for y in m) for x in n)

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
        f = filtry if isinstance(filtry, dict) else {}
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
    if z_opcji:
        return False  # treść opcji napisał model — żaden zapis bez stuknięcia karty
    if typ == "lista_dopisz":
        nazwy = d.get("nazwy")
        return (isinstance(nazwy, list) and 0 < len(nazwy) <= MAX_POZYCJI_LISTY
                and all(isinstance(n, str) and nazwa_w_tekscie(n, tekst) for n in nazwy))
    if typ == "lista_odhacz":
        return nazwa_w_tekscie(d.get("nazwa") or "", tekst, wszystkie=True)
    if typ == "zadanie_odhacz":
        if not {"uwaga", "wykonawca_user_id", "wykonawca_virtual_id"} <= d.keys():
            return False  # brak pól = nie wiemy, czy zadanie jest cudze/powtarzalne
        return (not d.get("uwaga")
                and d.get("wykonawca_user_id") in (None, user_id)
                and not d.get("wykonawca_virtual_id")
                and nazwa_w_tekscie(d.get("tytul") or "", tekst, wszystkie=True))
    # jedzenie, nowe zadanie, skan, aparat — zawsze karta
    return False
