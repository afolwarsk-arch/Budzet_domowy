import base64
import io
import json
import re
import urllib.request
from datetime import date, timedelta

import anthropic
from PIL import Image

# Hierarchia: kategoria_glowna → [podkategorie]
KATEGORIE_HIERARCHIA: dict[str, list[str]] = {
    "Spożywcze": [
        "Owoce",
        "Warzywa",
        "Nabiał i jaja",
        "Mięso surowe i ryby",
        "Wędliny i gotowe mięso",
        "Pieczywo i wypieki",
        "Produkty sypkie i przetwory",
        "Napoje",
        "Słodycze i przekąski",
        "Mrożonki",
        "Alkohol",
        "Catering i obiady abonamentowe",
    ],
    "Higiena i kosmetyki": [
        "Higiena osobista",
        "Kosmetyki i pielęgnacja",
        "Chemia domowa",
    ],
    "Wydatki na dziecko": [
        "Pieluchy i chusteczki",
        "Ubranka dziecięce",
        "Zabawki i gry",
        "Kosmetyki dziecięce",
        "Żywność dla dziecka",
        "Sale zabaw i atrakcje",
        "Zdrowie dziecka",
        "Edukacja dziecka",
        "Akcesoria dziecięce",
    ],
    "Dom i wyposażenie": [
        "AGD i RTV",
        "Meble i dekoracje",
        "Narzędzia i majsterkowanie",
        "Artykuły do domu",
    ],
    "Transport i paliwo": [
        "Paliwo",
        "Parking i autostrady",
        "Transport publiczny",
        "Serwis i części",
    ],
    "Zdrowie": [
        "Leki",
        "Suplementy i witaminy",
        "Badania i wizyty",
    ],
    "Odzież i obuwie": [
        "Odzież dorosłych",
        "Obuwie",
        "Akcesoria",
    ],
    "Rozrywka i hobby": [
        "Restauracje i kawiarnie",
        "Kino, teatr i kultura",
        "Sport i fitness",
        "Subskrypcje",
        "Hobby",
    ],
    "Edukacja": [
        "Kursy i szkolenia",
        "Książki i prasa",
        "Artykuły szkolne",
    ],
    "Elektronika": [
        "Sprzęt elektroniczny",
        "Akcesoria elektroniczne",
    ],
    "Rachunki domowe": [
        "Czynsz",
        "Prąd",
        "Gaz",
        "Internet i TV",
        "Woda i kanalizacja",
        "Meble i wyposażenie",
        "Remont i wykończenie",
    ],
    "Lokal Gałczyńskiego": [
        "Czynsz do spółdzielni",
        "Prąd",
        "Gaz",
        "Woda",
        "Naprawy i remonty",
        "Meble i wyposażenie",
    ],
    "Prezenty": [
        "Książki i gry",
        "Zabawki",
        "Kosmetyki i perfumy",
        "Odzież",
        "Elektronika",
        "Kwiaty i dekoracje",
        "Vouchery i karty podarunkowe",
        "Inne prezenty",
    ],
    "Inne": [
        "Inne",
    ],
}

# Płaska lista wszystkich podkategorii (do walidacji)
WSZYSTKIE_PODKATEGORIE: list[str] = [
    sub for subs in KATEGORIE_HIERARCHIA.values() for sub in subs
]

# Mapa: podkategoria → kategoria główna
SUB_DO_GLOWNEJ: dict[str, str] = {
    sub: glowna
    for glowna, subs in KATEGORIE_HIERARCHIA.items()
    for sub in subs
}

# Skrócona lista do promptu
_LISTA_PROMPT = "\n".join(
    f"  {glowna}: {', '.join(subs)}"
    for glowna, subs in KATEGORIE_HIERARCHIA.items()
)

SYSTEM_PROMPT = f"""Jesteś ekspertem od odczytywania polskich paragonów sklepowych. Zwracasz WYŁĄCZNIE poprawny JSON — zero dodatkowego tekstu, zero markdown.

WAŻNE: Jedno zdjęcie może zawierać wiele paragonów lub notatek. Każdy paragon = osobny obiekt na liście.

Każda pozycja musi mieć kategorię główną I podkategorię z tej hierarchii:
{_LISTA_PROMPT}

Format — zawsze tablica:
[
  {{
    "sklep": "nazwa sklepu lub null",
    "data": "YYYY-MM-DD",
    "waluta": "PLN",
    "suma": 0.00,
    "pozycje": [
      {{
        "nazwa": "nazwa produktu",
        "cena": 0.00,
        "ilosc": 1,
        "kategoria_glowna": "np. Spożywcze",
        "kategoria": "np. Napoje"
      }}
    ]
  }}
]

JAK ROZPOZNAĆ SKLEP:
- Szukaj logo lub nagłówka (Biedronka, Lidl, Rossmann, Żabka, Orlen, Netto, Carrefour, itp.)
- Paragon Rossmann: nagłówek "Rossmann SDP"
- Jeśli nie możesz odczytać — wpisz null

JAK ODCZYTYWAĆ POZYCJE:
- Przejrzyj KAŻDĄ linię paragonu od góry do dołu
- Każdy produkt = osobna pozycja, NIE łącz wielu w jedną
- CENA to zawsze CENA JEDNOSTKOWA (za 1 sztukę/kg), NIE łączna wartość linii
- Przykład: "6 x 5,29  31,74" → ilosc=6, cena=5.29  (NIE cena=31.74!)
- Przykład: "2,5 kg x 3,99  9,98" → ilosc=2.5, cena=3.99
- Przykład: "Mleko  3,49" (bez ilości) → ilosc=1, cena=3.49

RABATY I OPUSTY (ważne!):
- Jeśli po pozycji jest linia "OPUST -X,XX" — użyj kwoty PO rabacie jako łącznej wartości
- Oblicz cenę jednostkową = (wartość_przed - opust) / ilosc
- NIE dodawaj OPUST jako osobnej pozycji
- Przykład: "Arbuz luz  6,415×7,99  51,26" + "OPUST  -32,08" + "19,18"
  → ilosc=6.415, cena=2.99 (bo 19,18/6,415 ≈ 2,99)
- Przykład: "Awokado  2×6,99  13,98" + "OPUST  -7,00" + "6,98"
  → ilosc=2, cena=3.49 (bo 6,98/2=3,49)

Ignoruj linie: PLU, VAT, SUMA, RAZEM, RABAT całkowity, KARTA, GOTÓWKA, PTU, OPUSTY ŁĄCZNIE

WALUTA:
- Sprawdź symbol lub kod waluty na paragonie (€, $, £, Kč, CZK, EUR, USD, GBP itp.)
- Dodaj pole "waluta" z kodem ISO (np. "EUR", "USD", "CZK")
- Jeśli PLN lub brak informacji → "waluta": "PLN"
- Podaj ceny w ORYGINALNEJ walucie paragonu — system sam przeliczy na PLN

DATY:
- Format na polskich paragonach: DD-MM-YYYY lub DD.MM.YYYY
- Zamień na YYYY-MM-DD
- Jeśli nieczytelna: {date.today().isoformat()}

NOTATKI TEKSTOWE:
- Każdy wpis z inną datą = osobny obiekt na liście

OGÓLNE:
- Ceny w PLN jako float
- Suma = suma pozycji jeśli nie widać jej na paragonie
"""

MAX_BYTES = 4 * 1024 * 1024


def get_exchange_rate(currency: str, receipt_date: str) -> float:
    """Pobiera kurs średni NBP dla danej waluty i daty paragonu."""
    currency = currency.upper()
    if currency == "PLN":
        return 1.0

    # NBP nie publikuje kursów w weekendy — cofamy się max 5 dni roboczych
    d = date.fromisoformat(receipt_date)
    for _ in range(5):
        url = f"http://api.nbp.pl/api/exchangerates/rates/a/{currency}/{d.isoformat()}/?format=json"
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                data = json.loads(r.read())
                return float(data["rates"][0]["mid"])
        except urllib.error.HTTPError as e:
            if e.code == 404:
                d -= timedelta(days=1)
                continue
            raise
    raise ValueError(f"Brak kursu NBP dla {currency} w okolicach {receipt_date}")


def _compress_image(image_bytes: bytes, mime_type: str = "image/jpeg") -> tuple[bytes, str]:
    if len(image_bytes) <= MAX_BYTES:
        return image_bytes, mime_type

    img = Image.open(io.BytesIO(image_bytes))
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")

    for quality in (95, 90, 85, 80, 75, 70):
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        data = buf.getvalue()
        if len(data) <= MAX_BYTES:
            return data, "image/jpeg"

    img = img.resize((img.width * 3 // 4, img.height * 3 // 4), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue(), "image/jpeg"


_REKAT_PROMPT = f"""Przypisz każdej pozycji właściwą kategorię główną i podkategorię z tej hierarchii:
{_LISTA_PROMPT}

Wejście: lista obiektów JSON z polami id, nazwa, sklep (może być null).
Wyjście: WYŁĄCZNIE JSON — tablica obiektów {{id, kategoria_glowna, kategoria}}.
Bez dodatkowego tekstu. Każdy obiekt wejściowy musi mieć odpowiednik na wyjściu.
Kieruj się nazwą produktu i sklepem. Jeśli nie wiesz — użyj "Inne"/"Inne"."""


def rekategoryzuj_batch(pozycje: list[dict]) -> tuple[list[dict], dict]:
    """Ponowna kategoryzacja listy pozycji przez Claude. Zwraca ([{id, kategoria_glowna, kategoria}], usage)."""
    client = anthropic.Anthropic()
    wejscie = json.dumps(
        [{"id": p["id"], "nazwa": p["nazwa"], "sklep": p.get("sklep")} for p in pozycje],
        ensure_ascii=False,
    )
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=_REKAT_PROMPT,
        messages=[{"role": "user", "content": wejscie}],
    )
    raw = re.sub(r"```(?:json)?|```", "", msg.content[0].text).strip()
    wynik = json.loads(raw)
    for item in wynik:
        glowna = item.get("kategoria_glowna", "Inne")
        sub = item.get("kategoria", "Inne")
        if glowna not in KATEGORIE_HIERARCHIA:
            glowna = "Inne"
        if sub not in (KATEGORIE_HIERARCHIA.get(glowna) or []):
            sub = KATEGORIE_HIERARCHIA[glowna][0]
        item["kategoria_glowna"] = glowna
        item["kategoria"] = sub
    return wynik, _usage(msg)


def _kontekst_txt(kontekst: str | None) -> str:
    if not kontekst:
        return ""
    return f"\n\nDODATKOWY KONTEKST OD UŻYTKOWNIKA: {kontekst}\nUżyj tego kontekstu do poprawnego przypisania kategorii."


def _usage(message) -> dict:
    return {"input_tokens": message.usage.input_tokens, "output_tokens": message.usage.output_tokens}


def process_image(image_bytes: bytes, mime_type: str = "image/jpeg", kontekst: str | None = None) -> tuple[list[dict], dict]:
    client = anthropic.Anthropic()
    image_bytes, mime_type = _compress_image(image_bytes, mime_type)
    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": image_b64}},
                {"type": "text", "text": "Przeanalizuj i zwróć JSON." + _kontekst_txt(kontekst)},
            ],
        }],
    )
    return _parse_response(message.content[0].text), _usage(message)


def process_text(text: str, kontekst: str | None = None) -> tuple[list[dict], dict]:
    client = anthropic.Anthropic()
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": f"Przeanalizuj tę notatkę wydatków:\n\n{text}" + _kontekst_txt(kontekst)}],
    )
    return _parse_response(message.content[0].text), _usage(message)


def _parse_response(raw: str) -> list[dict]:
    cleaned = re.sub(r"```(?:json)?|```", "", raw).strip()
    data = json.loads(cleaned)
    if isinstance(data, dict):
        data = [data]

    today = date.today().isoformat()
    for item in data:
        if not item.get("data"):
            item["data"] = today

        # przeliczenie waluty obcej na PLN
        waluta = (item.get("waluta") or "PLN").upper()
        item["waluta"] = waluta
        item["kurs"] = 1.0

        if waluta != "PLN":
            try:
                kurs = get_exchange_rate(waluta, item["data"])
                item["kurs"] = round(kurs, 4)
                for p in item.get("pozycje", []):
                    p["cena"] = round(p["cena"] * kurs, 2)
                if item.get("suma"):
                    item["suma"] = round(item["suma"] * kurs, 2)
            except Exception as e:
                item["_kurs_blad"] = str(e)

        for p in item.get("pozycje", []):
            kat = p.get("kategoria", "")
            glowna = p.get("kategoria_glowna", "")
            if kat not in WSZYSTKIE_PODKATEGORIE:
                p["kategoria"] = "Inne"
                p["kategoria_glowna"] = "Inne"
            elif glowna not in KATEGORIE_HIERARCHIA:
                p["kategoria_glowna"] = SUB_DO_GLOWNEJ.get(kat, "Inne")

        if item.get("pozycje"):
            suma_obliczona = round(sum(p["cena"] * p.get("ilosc", 1) for p in item["pozycje"]), 2)
            suma_z_paragonu = item.get("suma") or 0.0
            if not suma_z_paragonu:
                item["suma"] = suma_obliczona
            else:
                roznica = abs(suma_obliczona - suma_z_paragonu)
                prog = max(0.50, 0.02 * suma_z_paragonu)
                if roznica > prog:
                    item["suma_paragon"] = suma_z_paragonu
                    item["suma"] = suma_obliczona
                    item["_ostrzezenie"] = (
                        f"Suma z paragonu ({suma_z_paragonu:.2f} PLN) różni się od sumy "
                        f"wykrytych pozycji ({suma_obliczona:.2f} PLN) o {roznica:.2f} PLN. "
                        "Paragon może być ucięty lub niektóre pozycje nie zostały odczytane."
                    )

    return data
