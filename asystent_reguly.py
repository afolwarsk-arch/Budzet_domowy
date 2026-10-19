"""Reguły asystenta, które da się sprawdzić bez bazy i bez modelu.

Tu zapada decyzja, czy propozycja wykona się OD RAZU, czy pójdzie na kartę
do potwierdzenia — nie w modelu. Model mógł zostać nakłoniony (tytułem
zadania od domownika, nazwą produktu z Open Food Facts) do zaproponowania
czegokolwiek; ta warstwa pilnuje, żeby bez stuknięcia działo się tylko to,
co użytkownik sam powiedział w BIEŻĄCYM poleceniu."""

import json
import re
import unicodedata
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
# Ciągi liter i ciągi cyfr to OSOBNE tokeny („mleko2" = mleko + 2), żeby cyfry
# doklejone do słowa nie przechodziły przez regułę rdzenia.
_SLOWO = re.compile(r"[^\W\d_]+|\d+")
# Poza słowami w nazwie wolno tylko białe znaki i te znaki; reszta (`!#@*>:;=+?&`,
# podkreślenie) to nie nazwa produktu, tylko doklejony ogon.
_DOZWOLONE_POZA_SLOWAMI = re.compile(r"[\s%,.\-/'\"()]*")


def _zloz(tekst: str) -> str:
    """Małe litery, bez znaków diakrytycznych (NFD) i ł→l (nie ma rozkładu)."""
    rozlozony = unicodedata.normalize("NFD", tekst.lower())
    bez = "".join(c for c in rozlozony if unicodedata.category(c) != "Mn")
    return bez.replace("ł", "l")


def _tokeny(tekst: str) -> list[str]:
    # litery i cyfry osobno, bez podkreślenia — „_" i „." dzielą słowa.
    return _SLOWO.findall(_zloz(tekst))


def _rdzen(s: str) -> str:
    return s[:-1] if s[-1] in "aeiouy" else s


def _to_samo_slowo(a: str, b: str) -> bool:
    """Słowo nazwy a = słowo wiadomości b. Cyfry i słowa do 2 znaków — tylko
    identyczne. Dłuższe: rdzenie (bez jednej końcowej samogłoski) w relacji
    przedrostka, długości różne o najwyżej 2, krótszy rdzeń ≥ 2 znaki — to
    końcówka fleksyjna, nie doklejony ogon („piwo" ≠ „piwonie", „papier" ≠
    „papierosy"). Znane, zaakceptowane fałszywe alarmy: „cukier" ~ „cukierki", „ser" ~
    „serum"/„seria", „sok" ~ „sokół" oraz kolizje po zdjęciu znaków
    diakrytycznych: „mak" ~ „mąka", „paczek" ~ „pączek"."""
    if a.isdecimal() or b.isdecimal() or len(a) < 3 or len(b) < 3:
        return a == b
    if abs(len(a) - len(b)) > 2:
        return False
    sa, sb = _rdzen(a), _rdzen(b)
    krotszy, dluzszy = (sa, sb) if len(sa) <= len(sb) else (sb, sa)
    return len(krotszy) >= 2 and dluzszy.startswith(krotszy)


def nazwa_w_tekscie(nazwa: str, tekst: str, wszystkie: bool = False) -> bool:
    """Czy użytkownik sam wypowiedział tę nazwę, z tolerancją na polską odmianę
    („mleka" = „mleko") i brak polskich znaków („wodka" = „wódka"). Wymagane
    są ZAWSZE wszystkie słowa nazwy, także jednoliterowe i cyfry (decyzja
    Adama): „dopisz jogurt" nie obejmuje „jogurt naturalny", a „mleko 600 700"
    nie przejdzie na „dopisz mleko". Parametr `wszystkie` zostaje dla zgodności
    wywołań i nic nie zmienia. Nazwa nietekstowa, pusta lub dłuższa niż 40
    znaków nigdy nie pasuje."""
    if not isinstance(nazwa, str) or not isinstance(tekst, str):
        return False
    if len(nazwa) > MAX_ZNAKOW_NAZWY:
        return False
    zlozona = _zloz(nazwa)
    n = _SLOWO.findall(zlozona)
    if not n:
        return False
    # token z „cyfrą" spoza dziesiętnych (np. ²) albo innym znakiem niebędącym
    # literą — to nie nazwa produktu
    if not all(x.isdecimal() or x.isalpha() for x in n):
        return False
    reszta = _SLOWO.sub("", zlozona)
    if not _DOZWOLONE_POZA_SLOWAMI.fullmatch(reszta):
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
    typ, d = p["typ"], p.get("dane")
    if not isinstance(d, dict):
        d = {}
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
