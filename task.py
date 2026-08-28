"""Trasy modułu wiem.task. Cienka warstwa: walidacja wejścia i przekazanie
do `task_db`. Reguły danych (prywatność, cykl w drzewie) siedzą w bazie danych,
nie tutaj — inaczej rozjechałyby się między wywołaniami."""

from fastapi import APIRouter, Depends, HTTPException

import task_db
from auth import get_current_user

router = APIRouter(prefix="/api/task", tags=["task"])


def _hid(u: dict) -> int:
    hid = u.get("household_id")
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    return hid


def _dane(d: dict, nowe: bool) -> dict:
    """`nowe=True` tylko przy tworzeniu zadania (POST) — `nowe=False` przy
    edycji (PUT).

    Dlaczego to ma znaczenie: `task_db.edytuj()` rozpoznaje ZAMIAR zmiany
    rodzica (i osobno — zmiany prywatności) po samej OBECNOŚCI klucza
    `parent_id` / `prywatne` w przekazanym słowniku, nie po jego wartości.
    Gdybyśmy przy każdej edycji wstawiali `parent_id` bezwarunkowo (jak
    poprzednio), zwykła zmiana samej daty czy tytułu byłaby odczytana jako
    "przenieś na korzeń" i odczepiałaby zadanie od rodzica, bo klient
    zwykle w ogóle nie przysyła `parent_id` przy takiej edycji. Dlatego przy
    PUT wstawiamy `parent_id` / `prywatne` WYŁĄCZNIE gdy klient naprawdę je
    przysłał. Przy POST nowe zadanie zawsze może być dzieckiem, więc klucz
    `parent_id` ma być zawsze — nawet brak wartości to świadome "bez rodzica".

    Identyfikator właściciela prywatnego zadania (`prywatne_dla`) NIGDY nie
    jest czytany z żądania — mógłby wskazać cudzy user_id i wstawić zadanie
    do cudzej prywatnej skrzynki. Jedyne dopuszczalne wejście od klienta to
    logiczna flaga `prywatne`; identyfikator dokłada wyłącznie kod endpointu
    na podstawie zalogowanej sesji (`current_user["user_id"]`).
    """
    tytul = (d.get("tytul") or "").strip()
    if not tytul:
        raise HTTPException(400, "Podaj treść zadania")
    dane = {
        "tytul": tytul[:300],
        "opis": (d.get("opis") or "").strip() or None,
        "termin": d.get("termin") or None,
        "pora": d.get("pora") or None,
        "data_start": d.get("data_start") or None,
        "projekt": bool(d.get("projekt")),
        "wykonawca_user_id": d.get("wykonawca_user_id") or None,
        "wykonawca_virtual_id": d.get("wykonawca_virtual_id") or None,
        "kamien_milowy": bool(d.get("kamien_milowy")),
    }
    # Data początku po terminie znaczy belkę cofniętą w czasie — wykres nie ma
    # jak tego narysować, a użytkownik prawie na pewno pomylił pola.
    if dane["data_start"] and dane["termin"] and dane["data_start"] > dane["termin"]:
        raise HTTPException(400, "Początek nie może być późniejszy niż termin.")
    if nowe or "parent_id" in d:
        dane["parent_id"] = d.get("parent_id") or None
    if "prywatne" in d:
        dane["prywatne"] = bool(d.get("prywatne"))
    return dane


@router.get("/zadania")
def lista_zadan(zakres: str = "dzis", osoba: int | None = None,
                current_user: dict = Depends(get_current_user)):
    if zakres not in ("dzis", "nadchodzace", "zrobione"):
        raise HTTPException(400, "Nieznany zakres")
    return {"zadania": task_db.lista(_hid(current_user), current_user["user_id"],
                                     zakres, osoba)}


@router.get("/plan")
def plan_zadan(zrobione: bool = False, current_user: dict = Depends(get_current_user)):
    """Zadania z datami — wejście dla wykresu Gantta.

    Zrobione domyślnie poza wykresem: plan pokazuje, co przed nami. Włącza się
    je przełącznikiem, gdy chce się zobaczyć, jak przedsięwzięcie faktycznie
    przebiegło.
    """
    return {"zadania": task_db.plan(_hid(current_user), current_user["user_id"], zrobione)}


@router.post("/zadania")
def nowe_zadanie(dane: dict, current_user: dict = Depends(get_current_user)):
    d = _dane(dane, nowe=True)
    # Prywatność ustawia się wyłącznie na sobie — przekazany identyfikator
    # innego użytkownika byłby cudzą skrzynką.
    if dane.get("prywatne"):
        d["prywatne_dla"] = current_user["user_id"]
    try:
        return {"id": task_db.dodaj(_hid(current_user), current_user["user_id"], d)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.put("/zadania/{zadanie_id}")
def edytuj_zadanie(zadanie_id: int, dane: dict,
                   current_user: dict = Depends(get_current_user)):
    try:
        ok = task_db.edytuj(_hid(current_user), current_user["user_id"], zadanie_id,
                            _dane(dane, nowe=False))
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not ok:
        raise HTTPException(404, "Nie ma takiego zadania")
    return {"ok": True}


@router.patch("/zadania/{zadanie_id}/status")
def status_zadania(zadanie_id: int, dane: dict,
                   current_user: dict = Depends(get_current_user)):
    ile = task_db.ustaw_status(_hid(current_user), current_user["user_id"], zadanie_id,
                               bool(dane.get("zrobione")), bool(dane.get("kaskada")))
    if not ile:
        raise HTTPException(404, "Nie ma takiego zadania")
    return {"zmienione": ile}


@router.delete("/zadania/{zadanie_id}")
def usun_zadanie(zadanie_id: int, current_user: dict = Depends(get_current_user)):
    if not task_db.usun(_hid(current_user), current_user["user_id"], zadanie_id):
        raise HTTPException(404, "Nie ma takiego zadania")
    return {"ok": True}
