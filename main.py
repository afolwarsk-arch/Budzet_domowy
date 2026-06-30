import asyncio
import re
import subprocess
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

import ai_processor
import database
from auth import get_current_user, require_admin

database.init_db()

app = FastAPI(title="Budżet domowy")

try:
    _BUILD = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], text=True).strip()
except Exception:
    import time; _BUILD = str(int(time.time()))

UPLOADS_DIR = Path(__file__).parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _html(filename: str) -> HTMLResponse:
    content = (STATIC_DIR / filename).read_text(encoding="utf-8")
    content = re.sub(r'(/static/[^"\']*?\.(?:js|css))(\?v=[^"\']*)?', rf'\1?v={_BUILD}', content)
    return HTMLResponse(content=content, headers={"Cache-Control": "no-store"})


@app.get("/")
def root():
    return _html("index.html")


@app.get("/upload")
def upload_page():
    return _html("upload.html")


@app.get("/analiza")
def analiza_page():
    return _html("analiza.html")


@app.get("/login")
def login_page():
    return _html("login.html")


@app.get("/onboarding")
def onboarding_page():
    return _html("onboarding.html")


@app.get("/admin")
def admin_page():
    return _html("admin.html")


@app.get("/konta")
def konta_page():
    return _html("konta.html")


# --- Auth & Household routes ---

@app.get("/api/me")
def get_me(current_user: dict = Depends(get_current_user)):
    household = None
    if current_user["household_id"]:
        h = database.get_household(current_user["household_id"])
        if h:
            household = {"id": h["id"], "name": h["name"], "role": current_user["role"]}
    return {**current_user, "household": household}


@app.patch("/api/me")
def update_me(body: dict, current_user: dict = Depends(get_current_user)):
    display_name = (body.get("display_name") or "").strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="Podaj pseudonim")
    if len(display_name) > 30:
        raise HTTPException(status_code=400, detail="Pseudonim za długi (max 30 znaków)")
    old_name = current_user.get("display_name")
    database.update_user_display_name(current_user["user_id"], display_name)
    if old_name and old_name != display_name and current_user["household_id"]:
        database.rename_osoba_in_household(old_name, display_name, current_user["household_id"])
    return {"ok": True}


@app.post("/api/household", status_code=201)
def create_household(body: dict, current_user: dict = Depends(get_current_user)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Podaj nazwę gospodarstwa")
    if current_user["household_id"]:
        raise HTTPException(status_code=409, detail="Jesteś już w gospodarstwie")
    hid = database.create_household(name)
    database.add_member(current_user["user_id"], hid, role="owner")
    return {"household_id": hid}


@app.get("/api/household")
def get_household(current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(status_code=404, detail="Nie należysz do żadnego gospodarstwa")
    h = database.get_household(hid)
    members = database.get_household_members(hid)
    virtual = database.get_virtual_members(hid)
    return {**h, "role": current_user["role"], "members": members, "virtual_members": virtual}


@app.post("/api/household/virtual-members", status_code=201)
def add_virtual_member(body: dict, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(status_code=400, detail="Brak gospodarstwa")
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Podaj imię")
    if len(name) > 30:
        raise HTTPException(status_code=400, detail="Imię za długie")
    vm_id = database.add_virtual_member(hid, name)
    return {"id": vm_id, "name": name}


@app.delete("/api/household/virtual-members/{vm_id}")
def delete_virtual_member(vm_id: int, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(status_code=400, detail="Brak gospodarstwa")
    ok = database.delete_virtual_member(vm_id, hid)
    if not ok:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    return {"ok": True}


@app.post("/api/household/claim-virtual-member")
def claim_virtual_member(body: dict, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(status_code=400, detail="Brak gospodarstwa")
    vm_id = body.get("vm_id")
    display_name = (body.get("display_name") or "").strip()
    if not vm_id:
        raise HTTPException(status_code=400, detail="Podaj vm_id")
    ok = database.claim_virtual_member(vm_id, hid, current_user["user_id"], display_name)
    if not ok:
        raise HTTPException(status_code=404, detail="Nie znaleziono wirtualnego członka")
    return {"ok": True}


@app.post("/api/household/invite")
def create_invite(request: Request, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(status_code=400, detail="Najpierw utwórz gospodarstwo")
    code = database.create_invitation(hid, current_user["user_id"])
    base_url = str(request.base_url).rstrip("/")
    return {"link": f"{base_url}/join/{code}", "code": code}


@app.get("/join/{code}")
def join_page(code: str):
    return _html("join.html")


@app.post("/api/join/{code}")
def join_household(code: str, current_user: dict = Depends(get_current_user)):
    if current_user["household_id"]:
        return {"ok": True, "already_member": True}
    result = database.use_invitation(code)
    if not result:
        raise HTTPException(status_code=404, detail="Link wygasł lub jest nieprawidłowy")
    database.add_member(current_user["user_id"], result["household_id"], role="member")
    virtual = database.get_virtual_members(result["household_id"])
    return {"ok": True, "household_name": result["household_name"], "virtual_members": virtual}


@app.get("/api/admin/households")
def admin_list_households(admin: dict = Depends(require_admin)):
    return database.get_all_households()


@app.get("/api/admin/usage")
def admin_usage(admin: dict = Depends(require_admin)):
    return database.get_usage_stats()


@app.get("/api/admin/stats")
def admin_stats(admin: dict = Depends(require_admin)):
    return database.get_admin_stats()


@app.post("/api/admin/rename-osoba")
def rename_osoba(body: dict, admin: dict = Depends(require_admin)):
    stara = (body.get("stara") or "").strip()
    nowa = (body.get("nowa") or "").strip()
    if not stara or not nowa:
        raise HTTPException(status_code=400, detail="Podaj stara i nowa")
    with database.get_db() as cur:
        cur.execute("UPDATE wydatki SET osoba=%s WHERE osoba=%s", (nowa, stara))
        count = cur.rowcount
    return {"zaktualizowane": count}


@app.post("/api/admin/import-data")
def import_data(body: dict, admin: dict = Depends(require_admin)):
    from collections import defaultdict
    wydatki = body.get("wydatki", [])
    pozycje_all = body.get("pozycje", [])
    household_id = body.get("household_id", 1)
    poz_by_wydatek = defaultdict(list)
    for p in pozycje_all:
        poz_by_wydatek[p["wydatek_id"]].append(p)
    count_w = 0
    count_p = 0
    for w in wydatki:
        pozycje = poz_by_wydatek.get(w["id"], [])
        database.create_wydatek(
            data=w["data"], sklep=w.get("sklep"), suma=w["suma"],
            osoba=w.get("osoba", "Adam"), notatki=w.get("notatki"),
            zdjecie=None, pozycje=pozycje,
            waluta=w.get("waluta", "PLN"), kurs=w.get("kurs", 1.0),
            household_id=household_id,
        )
        count_w += 1
        count_p += len(pozycje)
    return {"imported_wydatki": count_w, "imported_pozycje": count_p}


@app.post("/api/admin/invite")
def admin_create_invite(request: Request, body: dict, admin: dict = Depends(require_admin)):
    hid = body.get("household_id")
    if not hid:
        raise HTTPException(status_code=400, detail="Podaj household_id")
    code = database.create_invitation(int(hid), admin["user_id"])
    base_url = str(request.base_url).rstrip("/")
    return {"link": f"{base_url}/join/{code}", "code": code}


# --- AI processing ---

@app.post("/api/process-image")
async def process_image(
    file: UploadFile = File(...),
    osoba: str = Form("Adam"),
    kontekst: str = Form(""),
    current_user: dict = Depends(get_current_user),
):
    content = await file.read()
    mime = file.content_type or "image/jpeg"
    try:
        results, usage = await asyncio.to_thread(ai_processor.process_image, content, mime, kontekst or None)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Błąd Claude API: {e}")
    database.log_api_usage(current_user["household_id"], "process-image", usage["input_tokens"], usage["output_tokens"])
    for r in results:
        r["osoba"] = osoba
    return results


@app.post("/api/process-text")
async def process_text(payload: dict, current_user: dict = Depends(get_current_user)):
    text = payload.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Brak tekstu")
    kontekst = payload.get("kontekst", "").strip() or None
    try:
        results, usage = await asyncio.to_thread(ai_processor.process_text, text, kontekst)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Błąd Claude API: {e}")
    database.log_api_usage(current_user["household_id"], "process-text", usage["input_tokens"], usage["output_tokens"])
    osoba = payload.get("osoba", "Adam")
    for r in results:
        r["osoba"] = osoba
    return results


# --- CRUD wydatki ---

class PozycjaIn(BaseModel):
    nazwa: str
    cena: float
    ilosc: float = 1
    kategoria_glowna: str = "Inne"
    kategoria: str


class WydatekIn(BaseModel):
    data: str
    sklep: str | None = None
    suma: float
    osoba: str = "Adam"
    notatki: str | None = None
    waluta: str = "PLN"
    kurs: float = 1.0
    pozycje: list[PozycjaIn]
    okazja: str | None = None
    kontekst_kategoria: str | None = None
    kontekst_podkategoria: str | None = None
    konto_id: int | None = None


@app.post("/api/wydatki", status_code=201)
def create_wydatek(body: WydatekIn, current_user: dict = Depends(get_current_user)):
    wid = database.create_wydatek(
        data=body.data,
        sklep=body.sklep,
        suma=body.suma,
        osoba=body.osoba,
        notatki=body.notatki,
        zdjecie=None,
        pozycje=[p.model_dump() for p in body.pozycje],
        waluta=body.waluta,
        kurs=body.kurs,
        household_id=current_user["household_id"],
        okazja=body.okazja,
        kontekst_kategoria=body.kontekst_kategoria,
        kontekst_podkategoria=body.kontekst_podkategoria,
        konto_id=body.konto_id,
    )
    return {"id": wid}


@app.post("/api/wydatki-z-plikiem", status_code=201)
async def create_wydatek_z_plikiem(
    data: str = Form(...),
    sklep: str = Form(""),
    suma: float = Form(...),
    osoba: str = Form("Adam"),
    notatki: str = Form(""),
    waluta: str = Form("PLN"),
    kurs: float = Form(1.0),
    pozycje_json: str = Form(...),
    file: UploadFile | None = File(None),
    current_user: dict = Depends(get_current_user),
):
    import json as _json

    pozycje = _json.loads(pozycje_json)
    zdjecie = None
    if file and file.filename:
        dest = UPLOADS_DIR / file.filename
        dest.write_bytes(await file.read())
        zdjecie = file.filename

    wid = database.create_wydatek(
        data=data,
        sklep=sklep or None,
        suma=suma,
        osoba=osoba,
        notatki=notatki or None,
        zdjecie=zdjecie,
        pozycje=pozycje,
        waluta=waluta,
        kurs=kurs,
        household_id=current_user["household_id"],
    )
    return {"id": wid}


@app.get("/api/wydatki")
def list_wydatki(month: str | None = None, osoba: str | None = None,
                 kategoria: str | None = None, od: str | None = None, do: str | None = None,
                 okazja: str | None = None, kontekst: bool = False,
                 current_user: dict = Depends(get_current_user)):
    return database.get_wydatki(month=month, osoba=osoba, kategoria=kategoria,
                                od=od, do=do, okazja=okazja, kontekst=kontekst,
                                household_id=current_user["household_id"])


@app.get("/api/wydatki/{wydatek_id}")
def get_wydatek(wydatek_id: int):
    row = database.get_wydatek(wydatek_id)
    if not row:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    return row


@app.put("/api/wydatki/{wydatek_id}")
def update_wydatek(wydatek_id: int, body: WydatekIn):
    ok = database.update_wydatek(
        wydatek_id=wydatek_id,
        data=body.data,
        sklep=body.sklep,
        suma=body.suma,
        osoba=body.osoba,
        notatki=body.notatki,
        pozycje=[p.model_dump() for p in body.pozycje],
        okazja=body.okazja,
        kontekst_kategoria=body.kontekst_kategoria,
        kontekst_podkategoria=body.kontekst_podkategoria,
        konto_id=body.konto_id,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    return {"ok": True}


@app.get("/api/admin/rekat-preview")
def rekat_preview(month: str | None = None, od: str | None = None, do: str | None = None):
    pozycje = database.get_pozycje_do_rekat(month=month, od=od, do=do)
    return {"liczba": len(pozycje), "szacowane_paczki": -(-len(pozycje) // 25)}


@app.post("/api/admin/rekategoryzuj")
async def rekategoryzuj(body: dict):
    month = body.get("month")
    od = body.get("od")
    do = body.get("do")
    pozycje = database.get_pozycje_do_rekat(month=month, od=od, do=do)
    if not pozycje:
        return {"zaktualizowane": 0}

    BATCH = 25
    wszystkie = []
    total_in, total_out = 0, 0
    for i in range(0, len(pozycje), BATCH):
        paczka = pozycje[i:i + BATCH]
        wynik, usage = await asyncio.to_thread(ai_processor.rekategoryzuj_batch, paczka)
        wszystkie.extend(wynik)
        total_in += usage["input_tokens"]
        total_out += usage["output_tokens"]
    database.log_api_usage(None, "rekategoryzuj", total_in, total_out)
    zaktualizowane = database.update_pozycje_kategorie(wszystkie)
    return {"zaktualizowane": zaktualizowane, "przetworzone": len(wszystkie)}


@app.patch("/api/wydatki/{wydatek_id}/notatki")
def patch_notatki(wydatek_id: int, body: dict):
    ok = database.update_notatki(wydatek_id, body.get("notatki", ""))
    if not ok:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    return {"ok": True}


@app.delete("/api/wydatki/{wydatek_id}")
def delete_wydatek(wydatek_id: int):
    ok = database.delete_wydatek(wydatek_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    return {"ok": True}


# --- statystyki ---

@app.get("/api/analiza/state")
def get_analiza_state(current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        return {"groups": [], "pool": []}
    return database.get_analiza_state(hid)


@app.post("/api/analiza/state")
def save_analiza_state(body: dict, current_user: dict = Depends(get_current_user)):
    import json as _json
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(status_code=400, detail="Brak gospodarstwa")
    database.save_analiza_state(hid, _json.dumps(body.get("groups", [])), _json.dumps(body.get("pool", [])))
    return {"ok": True}


@app.get("/api/kategorie")
def get_kategorie():
    return ai_processor.KATEGORIE_HIERARCHIA


@app.get("/api/stats/kategorie")
def stats_kategorie(month: str | None = None, osoba: str | None = None,
                    od: str | None = None, do: str | None = None,
                    kontekst: bool = False,
                    current_user: dict = Depends(get_current_user)):
    return database.stats_kategorie(month=month, osoba=osoba,
                                    od=od, do=do, kontekst=kontekst,
                                    household_id=current_user["household_id"])


@app.get("/api/stats/pozycje-subkat")
def stats_pozycje_subkat(kategoria: str, month: str | None = None, osoba: str | None = None,
                         kategoria_glowna: str | None = None, kontekst: bool = False,
                         current_user: dict = Depends(get_current_user)):
    return database.stats_pozycje_subkat(kategoria=kategoria, month=month, osoba=osoba,
                                         kategoria_glowna=kategoria_glowna, kontekst=kontekst,
                                         household_id=current_user["household_id"])


@app.get("/api/stats/subkategorie")
def stats_subkategorie(kategoria_glowna: str, month: str | None = None, osoba: str | None = None,
                       od: str | None = None, do: str | None = None, kontekst: bool = False,
                       current_user: dict = Depends(get_current_user)):
    return database.stats_subkategorie(kategoria_glowna=kategoria_glowna, month=month, osoba=osoba,
                                       od=od, do=do, kontekst=kontekst,
                                       household_id=current_user["household_id"])


@app.get("/api/stats/subkategorie-all")
def stats_subkategorie_all(month: str | None = None, osoba: str | None = None,
                           od: str | None = None, do: str | None = None,
                           kontekst: bool = False,
                           current_user: dict = Depends(get_current_user)):
    return database.stats_subkategorie_all(month=month, osoba=osoba, od=od, do=do,
                                           kontekst=kontekst,
                                           household_id=current_user["household_id"])


@app.get("/api/stats/miesiace")
def stats_miesiace(n: int = 6, osoba: str | None = None, kategoria: str | None = None,
                   current_user: dict = Depends(get_current_user)):
    return database.stats_miesiace(n=n, osoba=osoba, kategoria=kategoria,
                                   household_id=current_user["household_id"])


@app.get("/api/stats/sklepy")
def stats_sklepy(month: str | None = None, osoba: str | None = None,
                 limit: int = 10, kategoria: str | None = None,
                 od: str | None = None, do: str | None = None,
                 current_user: dict = Depends(get_current_user)):
    return database.stats_sklepy(month=month, osoba=osoba, limit=limit, kategoria=kategoria,
                                 od=od, do=do, household_id=current_user["household_id"])


@app.get("/api/stats/top-produkt")
def stats_top_produkt(kategoria: str, month: str | None = None, osoba: str | None = None,
                      od: str | None = None, do: str | None = None,
                      current_user: dict = Depends(get_current_user)):
    result = database.stats_top_produkt(kategoria=kategoria, month=month, osoba=osoba,
                                        od=od, do=do, household_id=current_user["household_id"])
    return result or {}


# --- Konta ---

class KontoIn(BaseModel):
    nazwa: str
    typ: str = "bank"
    osoba: str | None = None
    waluta: str = "PLN"
    saldo_poczatkowe: float = 0.0


@app.get("/api/konta")
def api_get_konta(current_user: dict = Depends(get_current_user)):
    return database.get_konta(current_user["household_id"])


@app.post("/api/konta", status_code=201)
def api_create_konto(body: KontoIn, current_user: dict = Depends(get_current_user)):
    return database.create_konto(current_user["household_id"], body.nazwa, body.typ,
                                 body.osoba, body.waluta, body.saldo_poczatkowe)


@app.put("/api/konta/{konto_id}")
def api_update_konto(konto_id: int, body: KontoIn, current_user: dict = Depends(get_current_user)):
    ok = database.update_konto(konto_id, current_user["household_id"], body.nazwa, body.typ,
                               body.osoba, body.waluta, body.saldo_poczatkowe)
    if not ok:
        raise HTTPException(404, "Konto nie znalezione")
    return {"ok": True}


@app.delete("/api/konta/{konto_id}")
def api_delete_konto(konto_id: int, current_user: dict = Depends(get_current_user)):
    ok = database.delete_konto(konto_id, current_user["household_id"])
    if not ok:
        raise HTTPException(404, "Konto nie znalezione")
    return {"ok": True}


@app.get("/api/konta/{konto_id}/historia")
def api_historia_konta(konto_id: int, month: str | None = None,
                       current_user: dict = Depends(get_current_user)):
    return database.get_historia_konta(konto_id, current_user["household_id"], month=month)


@app.get("/api/konta/{konto_id}/inwentaryzacje")
def api_get_inwentaryzacje(konto_id: int, current_user: dict = Depends(get_current_user)):
    return database.get_inwentaryzacje(konto_id, current_user["household_id"])


class InwentaryzacjaIn(BaseModel):
    data: str
    saldo_rzeczywiste: float
    notatki: str | None = None


@app.post("/api/konta/{konto_id}/inwentaryzacja", status_code=201)
def api_create_inwentaryzacja(konto_id: int, body: InwentaryzacjaIn,
                              current_user: dict = Depends(get_current_user)):
    try:
        return database.create_inwentaryzacja(konto_id, current_user["household_id"],
                                              body.data, body.saldo_rzeczywiste, body.notatki)
    except ValueError as e:
        raise HTTPException(404, str(e))


# --- Wpływy ---

class WplywIn(BaseModel):
    data: str
    kwota: float
    osoba: str | None = None
    kategoria: str = "Inne"
    opis: str | None = None
    konto_id: int | None = None


@app.get("/api/wplywy")
def api_get_wplywy(month: str | None = None, konto_id: int | None = None,
                   current_user: dict = Depends(get_current_user)):
    return database.get_wplywy(current_user["household_id"], month=month, konto_id=konto_id)


@app.post("/api/wplywy", status_code=201)
def api_create_wplyw(body: WplywIn, current_user: dict = Depends(get_current_user)):
    return database.create_wplyw(current_user["household_id"], body.data, body.kwota,
                                 body.osoba, body.kategoria, body.opis, body.konto_id)


@app.delete("/api/wplywy/{wplyw_id}")
def api_delete_wplyw(wplyw_id: int, current_user: dict = Depends(get_current_user)):
    ok = database.delete_wplyw(wplyw_id, current_user["household_id"])
    if not ok:
        raise HTTPException(404, "Wpływ nie znaleziony")
    return {"ok": True}


@app.get("/api/me/konto-domyslne")
def api_get_konto_domyslne(current_user: dict = Depends(get_current_user)):
    konto_id = database.get_konto_domyslne(current_user["user_id"])
    return {"konto_id": konto_id}


@app.put("/api/me/konto-domyslne")
def api_set_konto_domyslne(body: dict, current_user: dict = Depends(get_current_user)):
    database.set_konto_domyslne(current_user["user_id"], body.get("konto_id"))
    return {"ok": True}
