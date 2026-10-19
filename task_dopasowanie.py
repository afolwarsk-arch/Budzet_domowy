"""Dopasowanie wypowiedzianych nazw do zadań, obszarów i domowników.

Wydzielone z `task.py`, żeby asystent mógł z tego korzystać bez importowania
routera zadań — a z nim wszystkich funkcji zapisujących."""

import re

import database
import task_db


def slowa(tekst: str) -> set:
    """Słowa znaczące, przycięte do czterech liter.

    Polska odmiana zmienia KOŃCÓWKI, więc porównywanie początków słów łapie
    „urlopu" z „urlop" i „Maladze" z „Malaga" bez tablicy form. Cztery litery
    to kompromis: przy trzech „dzia" zlewa się ze zbyt wieloma słowami, przy
    pięciu „malag" i „malad" przestają być tym samym.
    """
    return {s[:4] for s in re.findall(r"\w+", (tekst or "").lower()) if len(s) >= 3}


def dopasuj_miejsce(kandydaci: list, fraza: str | None) -> dict | None:
    """Wypowiedziana nazwa projektu → konkretne zadanie z bazy albo None.

    Wymagamy, żeby trafiła POŁOWA wypowiedzianych słów znaczących. Pojedyncze
    trafienie wystarczyłoby, żeby „kup mleko do domu" wpadło do projektu
    „Remont domu" — a zadanie w cudzym projekcie jest gorsze niż zadanie luzem,
    bo znika z oczu.
    """
    szukane = slowa(fraza)
    if not szukane:
        return None
    najlepszy, najlepiej = None, 0
    for k in kandydaci:
        trafione = len(szukane & slowa(k["tytul"]))
        if not trafione:
            continue
        # Projekt wygrywa remis: mówiąc „dopisz do zakupu działki" ma się na
        # myśli przedsięwzięcie, a nie krok o podobnej nazwie w jego środku.
        wynik = trafione * 2 + (1 if k.get("projekt") else 0)
        if wynik > najlepiej:
            najlepszy, najlepiej = k, wynik
    if najlepszy and len(szukane & slowa(najlepszy["tytul"])) * 2 >= len(szukane):
        return {"id": najlepszy["id"], "tytul": najlepszy["tytul"]}
    return None


def dopasuj_wykonawce(household_id: int, imie: str | None):
    """Imię z wypowiedzi → (user_id, virtual_id). Bez dopasowania: (None, None).

    Porównujemy po PIERWSZYM CZŁONIE nazwy: w mowie pada „Ola", a w bazie może
    stać „Aleksandra Kowalska" albo pseudonim. Brak trafienia zostawia zadanie
    bez wykonawcy — zgadywanie, kogo miał na myśli, przypisałoby sprawę losowej
    osobie z domu.
    """
    if not imie:
        return None, None
    szukane = imie.strip().lower()
    for m in database.get_household_members(household_id):
        for nazwa in (m.get("display_name"), m.get("name")):
            if nazwa and nazwa.strip().lower().split(" ")[0] == szukane:
                return m["id"], None
    for m in database.get_virtual_members(household_id):
        if (m.get("name") or "").strip().lower().split(" ")[0] == szukane:
            return None, m["id"]
    return None, None


def rozpoznane_miejsce(household_id: int, user_id: int, gdzie: str | None):
    """(cel, obszar) dla wypowiedzianego „gdzie".

    To samo słowo sprawdzamy DWA razy: najpierw wśród zadań, potem wśród
    obszarów życia. Projekt jest konkretniejszy niż obszar, więc „dopisz do
    remontu domu" ma trafić w projekt, a nie w szufladę „Dom". Obszary tylko
    te, których ta osoba używa — wrzucenie zadania do wyłączonego schowałoby
    je jej z oczu w chwili zapisania."""
    cel = dopasuj_miejsce(task_db.drzewo_do_wyboru(household_id, user_id), gdzie)
    if cel:
        return cel, None
    moje = [s for s in task_db.strefy(household_id, user_id) if s.get("moja")]
    trafiony = dopasuj_miejsce([{"id": s["id"], "tytul": s["nazwa"]} for s in moje], gdzie)
    obszar = {"id": trafiony["id"], "nazwa": trafiony["tytul"]} if trafiony else None
    return None, obszar
