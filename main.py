import asyncio
import re
import subprocess
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

import ai_processor
import database
from auth import get_current_user, require_admin, user_from_token

database.init_db()

app = FastAPI(title="Budżet domowy")

try:
    _BUILD = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], text=True).strip()
except Exception:
    import time; _BUILD = str(int(time.time()))

UPLOADS_DIR = Path(__file__).parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

STATIC_DIR = Path(__file__).parent / "static"


class CachedStaticFiles(StaticFiles):
    """Statyki z długim cache: JS/CSS mają w HTML ?v=<hash-commita> (cache-busting
    per deploy), więc mogą być immutable; reszta (ikony, manifest) — 1h."""
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            if path.endswith((".js", ".css")):
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            else:
                response.headers["Cache-Control"] = "public, max-age=3600"
        return response


app.mount("/static", CachedStaticFiles(directory=STATIC_DIR), name="static")


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


@app.get("/kategorie")
def kategorie_page():
    return _html("kategorie.html")


@app.get("/powiadomienia")
def powiadomienia_page():
    return _html("powiadomienia.html")


@app.get("/lista")
def lista_page():
    return _html("lista.html")


# --- Wspólna lista zakupów: zapisy przez REST (niezawodne), push zmian przez WebSocket ---

class _ListaManager:
    """Trzyma otwarte połączenia WS pogrupowane per gospodarstwo i rozsyła
    do nich pełny stan listy po każdej zmianie. Zakłada pojedynczy worker
    uvicorna (tak jak deploy na Railway) — stan połączeń jest w pamięci procesu."""
    def __init__(self):
        self.conns: dict[int, set[WebSocket]] = {}

    async def connect(self, hid: int, ws: WebSocket):
        await ws.accept()
        self.conns.setdefault(hid, set()).add(ws)

    def disconnect(self, hid: int, ws: WebSocket):
        s = self.conns.get(hid)
        if s:
            s.discard(ws)

    async def broadcast(self, hid: int, payload: dict):
        for ws in list(self.conns.get(hid, ())):
            try:
                await ws.send_json(payload)
            except Exception:
                self.disconnect(hid, ws)


_lista_mgr = _ListaManager()


async def _broadcast_lista(hid: int):
    items = await run_in_threadpool(database.get_lista, hid)
    await _lista_mgr.broadcast(hid, {"typ": "lista", "items": items})


@app.websocket("/ws/lista")
async def ws_lista(websocket: WebSocket, token: str = ""):
    user = await run_in_threadpool(user_from_token, token)
    if not user or not user.get("household_id"):
        await websocket.close(code=1008)
        return
    hid = user["household_id"]
    await _lista_mgr.connect(hid, websocket)
    try:
        items = await run_in_threadpool(database.get_lista, hid)
        await websocket.send_json({"typ": "lista", "items": items})
        while True:
            # klient wysyła okresowy "ping" dla utrzymania łącza — treść ignorujemy
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _lista_mgr.disconnect(hid, websocket)


@app.get("/api/lista")
def lista_get(current_user: dict = Depends(get_current_user)):
    if not current_user["household_id"]:
        return []
    return database.get_lista(current_user["household_id"])


@app.post("/api/lista", status_code=201)
async def lista_add(body: dict, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    nazwa = (body.get("nazwa") or "").strip()
    if not nazwa:
        raise HTTPException(400, "Pusta nazwa")
    item = await run_in_threadpool(database.add_pozycja_listy, hid, nazwa[:200], current_user["display_name"])
    await _broadcast_lista(hid)
    return item


@app.patch("/api/lista/{item_id}")
async def lista_toggle(item_id: int, body: dict, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    ok = await run_in_threadpool(database.set_pozycja_kupione, item_id, hid, bool(body.get("kupione")))
    if not ok:
        raise HTTPException(404, "Nie znaleziono")
    await _broadcast_lista(hid)
    return {"ok": True}


@app.delete("/api/lista/{item_id}")
async def lista_delete(item_id: int, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    ok = await run_in_threadpool(database.delete_pozycja_listy, item_id, hid)
    if not ok:
        raise HTTPException(404, "Nie znaleziono")
    await _broadcast_lista(hid)
    return {"ok": True}


@app.post("/api/lista/wyczysc-kupione")
async def lista_clear(current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    n = await run_in_threadpool(database.clear_kupione_listy, hid)
    await _broadcast_lista(hid)
    return {"usuniete": n}


# --- Auth & Household routes ---

@app.get("/api/me")
def get_me(current_user: dict = Depends(get_current_user)):
    household = None
    if current_user["household_id"]:
        h = database.get_household(current_user["household_id"])
        if h:
            household = {"id": h["id"], "name": h["name"], "role": current_user["role"]}
    return {**current_user, "household": household,
            "samouczek": database.get_samouczek(current_user["user_id"])}


@app.post("/api/me/samouczek")
def zaliczony_samouczek(current_user: dict = Depends(get_current_user)):
    database.set_samouczek(current_user["user_id"])
    return {"ok": True}


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


_USTAWIENIA_PRZYPOMNIEN = {
    "przyp_reczne_dni": "7",    # ile dni przed terminem pojawia się przypomnienie o przelewie ręcznym
    "przyp_auto_dni": "3",      # ile dni przed obciążeniem automatycznym przypominać o środkach
    "przyp_zolte_dni": "3",     # od ilu dni do terminu poziom żółty
    "przyp_czerwone_dni": "1",  # od ilu dni do terminu poziom czerwony
}


@app.get("/api/admin/ustawienia")
def admin_get_ustawienia(admin: dict = Depends(require_admin)):
    return {k: int(database.get_ustawienie(k, v)) for k, v in _USTAWIENIA_PRZYPOMNIEN.items()}


@app.put("/api/admin/ustawienia")
def admin_put_ustawienia(body: dict, admin: dict = Depends(require_admin)):
    for k, v in body.items():
        if k not in _USTAWIENIA_PRZYPOMNIEN:
            raise HTTPException(400, f"Nieznane ustawienie: {k}")
        try:
            iv = int(v)
        except (TypeError, ValueError):
            raise HTTPException(400, f"{k}: wartość musi być liczbą dni")
        if not 0 <= iv <= 60:
            raise HTTPException(400, f"{k}: zakres 0-60 dni")
        database.set_ustawienie(k, str(iv))
    return {"ok": True}


@app.get("/api/admin/osoby")
def admin_osoby(admin: dict = Depends(require_admin)):
    with database.get_db() as cur:
        cur.execute("""SELECT osoba, COUNT(*) AS ile FROM wydatki
                       WHERE osoba IS NOT NULL AND osoba <> ''
                       GROUP BY osoba ORDER BY osoba""")
        return [dict(r) for r in cur.fetchall()]


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

import anthropic as _anthropic


def _ai_http_error(e: Exception) -> HTTPException:
    """Tłumaczy wyjątki z warstwy AI na czytelne dla użytkownika komunikaty HTTP."""
    if isinstance(e, ai_processor.ObrazError):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, ai_processor.RozpoznanieError):
        return HTTPException(status_code=422, detail=str(e))
    if isinstance(e, _anthropic.AuthenticationError):
        return HTTPException(status_code=502, detail=(
            "Błąd konfiguracji serwera — nieprawidłowy klucz Claude API. "
            "Skontaktuj się z administratorem."))
    if isinstance(e, _anthropic.RateLimitError):
        return HTTPException(status_code=503, detail=(
            "Zbyt wiele zapytań do Claude AI w krótkim czasie. "
            "Odczekaj około minuty i spróbuj ponownie."))
    if isinstance(e, _anthropic.BadRequestError):
        return HTTPException(status_code=400, detail=(
            "Claude AI odrzucił żądanie — najczęściej oznacza to uszkodzone lub "
            "nieobsługiwane zdjęcie. Zapisz je jako JPG i wyślij ponownie."))
    if isinstance(e, _anthropic.APIConnectionError):
        return HTTPException(status_code=503, detail=(
            "Brak połączenia z serwerami Claude AI. "
            "Sprawdź połączenie z internetem i spróbuj ponownie."))
    if isinstance(e, _anthropic.APIStatusError):
        return HTTPException(status_code=503, detail=(
            f"Serwery Claude AI są chwilowo niedostępne (kod {e.status_code}). "
            "Spróbuj ponownie za kilka minut."))
    return HTTPException(status_code=502, detail=f"Nieoczekiwany błąd analizy: {e}")


@app.post("/api/process-image")
async def process_image(
    file: UploadFile = File(...),
    osoba: str = Form("Adam"),
    kontekst: str = Form(""),
    current_user: dict = Depends(get_current_user),
):
    hid = current_user["household_id"]
    hier = database.get_household_hierarchia(hid) if hid else None
    content = await file.read()
    mime = file.content_type or "image/jpeg"
    try:
        results, usage = await asyncio.to_thread(ai_processor.process_image, content, mime, kontekst or None, hier)
    except Exception as e:
        raise _ai_http_error(e)
    database.log_api_usage(hid, "process-image", usage["input_tokens"], usage["output_tokens"])
    for r in results:
        r["osoba"] = osoba
    return results


@app.post("/api/process-text")
async def process_text(payload: dict, current_user: dict = Depends(get_current_user)):
    text = payload.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Brak tekstu")
    kontekst = payload.get("kontekst", "").strip() or None
    hid = current_user["household_id"]
    hier = database.get_household_hierarchia(hid) if hid else None
    try:
        results, usage = await asyncio.to_thread(ai_processor.process_text, text, kontekst, hier)
    except Exception as e:
        raise _ai_http_error(e)
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
    if current_user["household_id"]:
        database.naliczaj_cykliczne(current_user["household_id"])
    return database.get_wydatki(month=month, osoba=osoba, kategoria=kategoria,
                                od=od, do=do, okazja=okazja, kontekst=kontekst,
                                household_id=current_user["household_id"])


@app.get("/api/szukaj")
def szukaj(q: str = "", current_user: dict = Depends(get_current_user)):
    q = (q or "").strip()
    if len(q) < 2 or not current_user["household_id"]:
        return {"wydatki": [], "suma_pozycji": 0, "liczba_pozycji": 0, "q": q}
    wynik = database.szukaj_wydatki(q, current_user["household_id"])
    wynik["q"] = q
    return wynik


@app.get("/api/ceny")
def ceny(q: str = "", current_user: dict = Depends(get_current_user)):
    q = (q or "").strip()
    if len(q) < 2 or not current_user["household_id"]:
        return {"punkty": [], "sklepy": [], "podsumowanie": {}, "liczba": 0, "q": q}
    wynik = database.historia_cen(q, current_user["household_id"])
    wynik["q"] = q
    return wynik


@app.get("/api/wydatki/{wydatek_id}")
def get_wydatek(wydatek_id: int, current_user: dict = Depends(get_current_user)):
    row = database.get_wydatek(wydatek_id)
    if not row:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    if row.get("household_id") != current_user["household_id"]:
        raise HTTPException(status_code=403, detail="Brak dostępu")
    return row


@app.put("/api/wydatki/{wydatek_id}")
def update_wydatek(wydatek_id: int, body: WydatekIn, current_user: dict = Depends(get_current_user)):
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
        household_id=current_user["household_id"],
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    return {"ok": True}


@app.get("/api/admin/rekat-preview")
def rekat_preview(month: str | None = None, od: str | None = None, do: str | None = None,
                  admin: dict = Depends(require_admin)):
    pozycje = database.get_pozycje_do_rekat(month=month, od=od, do=do)
    return {"liczba": len(pozycje), "szacowane_paczki": -(-len(pozycje) // 25)}


@app.post("/api/admin/rekategoryzuj")
async def rekategoryzuj(body: dict, admin: dict = Depends(require_admin)):
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
def patch_notatki(wydatek_id: int, body: dict, current_user: dict = Depends(get_current_user)):
    ok = database.update_notatki(wydatek_id, body.get("notatki", ""), household_id=current_user["household_id"])
    if not ok:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    return {"ok": True}


@app.delete("/api/wydatki/{wydatek_id}")
def delete_wydatek(wydatek_id: int, current_user: dict = Depends(get_current_user)):
    ok = database.delete_wydatek(wydatek_id, household_id=current_user["household_id"])
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


# --- Doradca budżetowy (analiza AI) ---

class RaportIn(BaseModel):
    miesiace: int = 3
    kontekst: str | None = None


def _raport_response(row: dict) -> dict:
    import json as _json
    return {
        "id": row.get("id"),
        "raport": _json.loads(row["raport_json"]),
        "miesiace": row["miesiace"],
        "kontekst": row["kontekst"],
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
    }


class ProfilIn(BaseModel):
    tresc: str


@app.get("/api/analiza/profil")
def get_analiza_profil(current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    return database.get_profil_ai(hid)


@app.post("/api/analiza/profil", status_code=201)
def add_analiza_profil(body: ProfilIn, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    tresc = body.tresc.strip()
    if not tresc:
        raise HTTPException(400, "Pusta treść")
    if len(tresc) > 500:
        raise HTTPException(400, "Maksymalnie 500 znaków")
    wid = database.add_profil_ai(hid, tresc)
    return {"id": wid, "tresc": tresc}


@app.delete("/api/analiza/profil/{wpis_id}")
def delete_analiza_profil(wpis_id: int, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    if not database.delete_profil_ai(wpis_id, hid):
        raise HTTPException(404, "Nie znaleziono wpisu")
    return {"ok": True}


@app.get("/api/analiza/raporty")
def list_analiza_raporty(current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    return database.list_raporty_ai(hid)


@app.get("/api/analiza/raport")
def get_analiza_raport(current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    row = database.get_raport_ai(hid)
    return _raport_response(row) if row else {"raport": None}


@app.get("/api/analiza/raport/{raport_id}")
def get_analiza_raport_by_id(raport_id: int, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    row = database.get_raport_ai(hid, raport_id)
    if not row:
        raise HTTPException(404, "Nie znaleziono raportu")
    return _raport_response(row)


@app.delete("/api/analiza/raport/{raport_id}")
def delete_analiza_raport(raport_id: int, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    if not database.delete_raport_ai(raport_id, hid):
        raise HTTPException(404, "Nie znaleziono raportu")
    return {"ok": True}


@app.post("/api/analiza/raport")
def generuj_analiza_raport(body: RaportIn, current_user: dict = Depends(get_current_user)):
    import json as _json
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    miesiace = max(1, min(body.miesiace, 24))
    try:
        dane = database.zbierz_dane_budzet(hid, miesiace)
    except Exception as e:
        raise HTTPException(500, f"Błąd przygotowania danych do analizy: {e}")
    if not dane["wydatki_per_miesiac"]:
        raise HTTPException(400, "Za mało danych do analizy — dodaj najpierw kilka wydatków.")
    profil = [p["tresc"] for p in database.get_profil_ai(hid)]
    try:
        raport, usage = ai_processor.analizuj_budzet(dane, body.kontekst, profil)
    except Exception as e:
        raise HTTPException(502, f"Nie udało się wygenerować analizy: {e}")
    # liczby kondycji zawsze z systemu — model bywa kreatywny w arytmetyce
    kw = dane["kondycja_wyliczona"]
    kondycja = raport.setdefault("kondycja", {})
    kondycja["wydatki_mies"] = kw["wydatki_mies"]
    kondycja["wplywy_mies"] = kw["wplywy_mies"]
    kondycja["bilans_mies"] = kw["bilans_mies"]
    database.log_api_usage(hid, "analiza-raport", usage["input_tokens"], usage["output_tokens"])
    try:
        rid = database.save_raport_ai(hid, miesiace, body.kontekst,
                                      _json.dumps(raport, ensure_ascii=False), "claude-sonnet-4-6")
        row = database.get_raport_ai(hid, rid)
        return _raport_response(row)
    except Exception as e:
        # raport już wygenerowany (i opłacony) — pokaż go mimo problemu z zapisem historii
        from datetime import datetime as _dt
        return {"id": None, "raport": raport, "miesiace": miesiace, "kontekst": body.kontekst,
                "created_at": _dt.utcnow().isoformat(),
                "blad_zapisu": f"Raport nie zapisał się w historii: {e}"}


@app.get("/api/kategorie")
def get_kategorie(current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    custom = database.get_household_hierarchia(hid) if hid else None
    return custom if custom is not None else ai_processor.KATEGORIE_HIERARCHIA


@app.put("/api/kategorie")
def save_kategorie(body: dict, current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    hier = body.get("hierarchia")
    if not isinstance(hier, dict) or not hier:
        raise HTTPException(400, "Nieprawidłowa hierarchia")
    database.save_household_hierarchia(hid, hier)
    return {"ok": True}


@app.get("/api/kategorie/template")
def get_kategorie_template():
    return ai_processor.KATEGORIE_HIERARCHIA


@app.get("/api/export")
def export_data(current_user: dict = Depends(get_current_user)):
    from fastapi.responses import JSONResponse
    import json
    hid = current_user["household_id"]
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    data = database.export_household_data(hid)
    data["exported_at"] = __import__("datetime").datetime.utcnow().isoformat() + "Z"
    data["household_id"] = hid
    content = json.dumps(data, ensure_ascii=False, indent=2, default=str)
    from fastapi.responses import Response
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename=budzet_backup_{__import__('datetime').date.today()}.json"},
    )


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
    if current_user["household_id"]:
        database.naliczaj_cykliczne(current_user["household_id"])
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


# --- Przelewy między kontami ---

class PrzelewIn(BaseModel):
    data: str
    kwota: float
    konto_z_id: int
    konto_na_id: int
    opis: str | None = None


@app.post("/api/przelewy", status_code=201)
def api_create_przelew(body: PrzelewIn, current_user: dict = Depends(get_current_user)):
    if body.kwota <= 0:
        raise HTTPException(400, "Kwota przelewu musi być większa od zera")
    if body.konto_z_id == body.konto_na_id:
        raise HTTPException(400, "Konto źródłowe i docelowe muszą być różne")
    try:
        return database.create_przelew(current_user["household_id"], body.data, body.kwota,
                                       body.konto_z_id, body.konto_na_id, body.opis)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/przelewy/{przelew_id}")
def api_get_przelew(przelew_id: int, current_user: dict = Depends(get_current_user)):
    row = database.get_przelew(przelew_id, current_user["household_id"])
    if not row:
        raise HTTPException(404, "Przelew nie znaleziony")
    return row


@app.put("/api/przelewy/{przelew_id}")
def api_update_przelew(przelew_id: int, body: PrzelewIn,
                       current_user: dict = Depends(get_current_user)):
    if body.kwota <= 0:
        raise HTTPException(400, "Kwota przelewu musi być większa od zera")
    if body.konto_z_id == body.konto_na_id:
        raise HTTPException(400, "Konto źródłowe i docelowe muszą być różne")
    try:
        ok = database.update_przelew(przelew_id, current_user["household_id"], body.data,
                                     body.kwota, body.konto_z_id, body.konto_na_id, body.opis)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not ok:
        raise HTTPException(404, "Przelew nie znaleziony")
    return {"ok": True}


@app.delete("/api/przelewy/{przelew_id}")
def api_delete_przelew(przelew_id: int, current_user: dict = Depends(get_current_user)):
    ok = database.delete_przelew(przelew_id, current_user["household_id"])
    if not ok:
        raise HTTPException(404, "Przelew nie znaleziony")
    return {"ok": True}


# --- Wydatki cykliczne ---

class CyklicznyIn(BaseModel):
    nazwa: str
    kwota: float
    dzien: int = 1
    kategoria_glowna: str = "Rozrywka i hobby"
    kategoria: str = "Subskrypcje"
    osoba: str
    konto_id: int | None = None
    od_miesiaca: str | None = None
    aktywne: bool = True
    limit_naliczen: int | None = None
    do_miesiaca: str | None = None   # 'YYYY-MM' — miesiąc ostatniego naliczenia
    automatyczny: bool = True
    typ: str = "wydatek"          # 'wydatek' | 'przelew'
    konto_na_id: int | None = None


def _waliduj_zakonczenie(body: "CyklicznyIn") -> str | None:
    """Zwraca do_miesiaca jako datę 'YYYY-MM-01' albo None; pilnuje formatu i wykluczania."""
    if body.limit_naliczen is not None and body.limit_naliczen < 1:
        raise HTTPException(400, "Liczba naliczeń musi być większa od zera")
    if not body.do_miesiaca:
        return None
    if body.limit_naliczen is not None:
        raise HTTPException(400, "Wybierz jedno zakończenie: liczbę naliczeń albo miesiąc końcowy")
    import re as _re
    if not _re.fullmatch(r"\d{4}-\d{2}", body.do_miesiaca):
        raise HTTPException(400, "Miesiąc końcowy w formacie RRRR-MM")
    return f"{body.do_miesiaca}-01"


def _waliduj_cykliczny_przelew(body: "CyklicznyIn", household_id: int) -> None:
    if body.typ not in ("wydatek", "przelew"):
        raise HTTPException(400, "Typ musi być 'wydatek' albo 'przelew'")
    if body.typ != "przelew":
        return
    if not body.konto_id or not body.konto_na_id:
        raise HTTPException(400, "Przelew cykliczny wymaga konta źródłowego i docelowego")
    if body.konto_id == body.konto_na_id:
        raise HTTPException(400, "Konto źródłowe i docelowe muszą być różne")
    konta = {k["id"]: k for k in database.get_konta(household_id)}
    if body.konto_id not in konta or body.konto_na_id not in konta:
        raise HTTPException(400, "Konto nie istnieje")
    if konta[body.konto_id]["waluta"] != konta[body.konto_na_id]["waluta"]:
        raise HTTPException(400, "Przelewy możliwe tylko między kontami w tej samej walucie")


@app.get("/api/przypomnienia")
def api_przypomnienia(current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        return []
    database.naliczaj_cykliczne(hid)
    return database.get_przypomnienia(hid)


@app.post("/api/platnosci/{platnosc_id}/potwierdz")
def api_potwierdz_platnosc(platnosc_id: int, current_user: dict = Depends(get_current_user)):
    try:
        wid = database.potwierdz_platnosc(platnosc_id, current_user["household_id"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    if wid is None:
        raise HTTPException(404, "Nie znaleziono oczekującej płatności")
    return {"ok": True, "wydatek_id": wid}


@app.get("/api/przypomnienia/archiwum")
def api_archiwum_powiadomien(current_user: dict = Depends(get_current_user)):
    hid = current_user["household_id"]
    if not hid:
        return []
    return database.get_archiwum_powiadomien(hid)


@app.get("/api/cykliczne")
def api_get_cykliczne(current_user: dict = Depends(get_current_user)):
    return database.get_cykliczne(current_user["household_id"])


@app.post("/api/cykliczne", status_code=201)
def api_create_cykliczny(body: CyklicznyIn, current_user: dict = Depends(get_current_user)):
    if not body.nazwa.strip():
        raise HTTPException(400, "Podaj nazwę")
    if body.kwota <= 0:
        raise HTTPException(400, "Kwota musi być większa od zera")
    if not 1 <= body.dzien <= 31:
        raise HTTPException(400, "Dzień miesiąca musi być z zakresu 1-31")
    do_data = _waliduj_zakonczenie(body)
    _waliduj_cykliczny_przelew(body, current_user["household_id"])
    from datetime import date as _date
    od = body.od_miesiaca or _date.today().strftime("%Y-%m")
    od_data = f"{od}-01" if len(od) == 7 else od
    if do_data and do_data < od_data:
        raise HTTPException(400, "Miesiąc końcowy nie może być wcześniejszy niż początek naliczania")
    wynik = database.create_cykliczny(current_user["household_id"], body.nazwa.strip(),
                                      body.kwota, body.dzien, body.kategoria_glowna,
                                      body.kategoria, body.osoba, body.konto_id, od_data,
                                      body.limit_naliczen, body.automatyczny,
                                      body.typ, body.konto_na_id, do_data)
    database.naliczaj_cykliczne(current_user["household_id"])
    return wynik


@app.put("/api/cykliczne/{cykliczny_id}")
def api_update_cykliczny(cykliczny_id: int, body: CyklicznyIn,
                         current_user: dict = Depends(get_current_user)):
    if not 1 <= body.dzien <= 31:
        raise HTTPException(400, "Dzień miesiąca musi być z zakresu 1-31")
    do_data = _waliduj_zakonczenie(body)
    _waliduj_cykliczny_przelew(body, current_user["household_id"])
    ok = database.update_cykliczny(cykliczny_id, current_user["household_id"],
                                   body.nazwa.strip(), body.kwota, body.dzien,
                                   body.kategoria_glowna, body.kategoria, body.osoba,
                                   body.konto_id, body.aktywne, body.limit_naliczen,
                                   body.automatyczny, body.typ, body.konto_na_id, do_data)
    if not ok:
        raise HTTPException(404, "Nie znaleziono")
    return {"ok": True}


@app.delete("/api/cykliczne/{cykliczny_id}")
def api_delete_cykliczny(cykliczny_id: int, current_user: dict = Depends(get_current_user)):
    ok = database.delete_cykliczny(cykliczny_id, current_user["household_id"])
    if not ok:
        raise HTTPException(404, "Nie znaleziono")
    return {"ok": True}


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


@app.put("/api/wplywy/{wplyw_id}")
def api_update_wplyw(wplyw_id: int, body: WplywIn,
                     current_user: dict = Depends(get_current_user)):
    if body.kwota <= 0:
        raise HTTPException(400, "Kwota musi być większa od zera")
    ok = database.update_wplyw(wplyw_id, current_user["household_id"], body.data, body.kwota,
                               body.osoba, body.kategoria, body.opis, body.konto_id)
    if not ok:
        raise HTTPException(404, "Wpływ nie znaleziony")
    return {"ok": True}


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
