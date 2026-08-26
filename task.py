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


def _dane(d: dict) -> dict:
    tytul = (d.get("tytul") or "").strip()
    if not tytul:
        raise HTTPException(400, "Podaj treść zadania")
    return {
        "tytul": tytul[:300],
        "opis": (d.get("opis") or "").strip() or None,
        "termin": d.get("termin") or None,
        "pora": d.get("pora") or None,
        "parent_id": d.get("parent_id") or None,
        "wykonawca_user_id": d.get("wykonawca_user_id") or None,
        "wykonawca_virtual_id": d.get("wykonawca_virtual_id") or None,
        "prywatne_dla": d.get("prywatne_dla") or None,
        "kamien_milowy": bool(d.get("kamien_milowy")),
    }


@router.get("/zadania")
def lista_zadan(zakres: str = "dzis", osoba: int | None = None,
                current_user: dict = Depends(get_current_user)):
    if zakres not in ("dzis", "nadchodzace", "zrobione"):
        raise HTTPException(400, "Nieznany zakres")
    return {"zadania": task_db.lista(_hid(current_user), current_user["user_id"],
                                     zakres, osoba)}


@router.post("/zadania")
def nowe_zadanie(dane: dict, current_user: dict = Depends(get_current_user)):
    d = _dane(dane)
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
                            _dane(dane))
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
