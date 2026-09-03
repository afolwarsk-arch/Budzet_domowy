import base64
import io
import json
import re
import urllib.request
from datetime import date, timedelta
from itertools import product

import anthropic
from PIL import Image


class ObrazError(ValueError):
    """Problem z przesłanym plikiem zdjęcia (zły format, pusty plik itp.)."""


class RozpoznanieError(ValueError):
    """Claude nie zwrócił danych możliwych do przetworzenia."""


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
    "Używki": [
        "Papierosy",
        "Inne używki",
    ],
    "Inne": [
        "Kaucja",
        "Inne",
    ],
}

def _hier_helpers(hier: dict) -> tuple[list[str], dict[str, str], str]:
    """Zwraca (wszystkie_podkategorie, sub_do_glownej, lista_prompt) dla danej hierarchii."""
    wszystkie = [sub for subs in hier.values() for sub in subs]
    sub_do_glownej = {sub: g for g, subs in hier.items() for sub in subs}
    lista = "\n".join(f"  {g}: {', '.join(subs)}" for g, subs in hier.items())
    return wszystkie, sub_do_glownej, lista


def _build_system_prompt(lista_prompt: str) -> str:
    return f"""Jesteś ekspertem od odczytywania polskich paragonów sklepowych. Zwracasz WYŁĄCZNIE poprawny JSON — zero dodatkowego tekstu, zero markdown.

WAŻNE: Jedno zdjęcie może zawierać wiele paragonów lub notatek. Każdy paragon = osobny obiekt na liście.

Każda pozycja musi mieć kategorię główną I podkategorię z tej hierarchii:
{lista_prompt}

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
        "wartosc_przed": 0.00,
        "opust": 0.00,
        "wartosc_po": 0.00,
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
- Jeśli dwie (lub więcej) sąsiednie linie PRODUKTU mają identyczną nazwę, ilość i cenę,
  to NIE jest powtórzenie tego samego wpisu — to osobne skany tego samego produktu.
  Zachowaj KAŻDĄ jako osobną pozycję, nie scalaj ich do jednej i żadnej nie pomijaj.
  - Przykład: "Piwo  4 x5,99  23,96" i zaraz pod spodem znowu "Piwo  4 x5,99  23,96"
    → DWIE osobne pozycje (razem 8 szt.), a nie jedna
  - Dotyczy TYLKO linii produktów. Linie "OPUST"/rabat obsłuż wg sekcji RABATY I OPUSTY
    poniżej (rabat przy pozycji zwijasz w cenę jednostkową — NIE twórz pozycji "OPUST ...")
- CENA to zawsze CENA JEDNOSTKOWA (za 1 sztukę/kg), NIE łączna wartość linii
- Przykład: "6 x 5,29  31,74" → ilosc=6, cena=5.29  (NIE cena=31.74!)
- Przykład: "2,5 kg x 3,99  9,98" → ilosc=2.5, cena=3.99
- Przykład: "Mleko  3,49" (bez ilości) → ilosc=1, cena=3.49

PRZEPISUJ KWOTY, NIE LICZ ICH W PAMIĘCI (najważniejsza zasada!):
Dla KAŻDEJ pozycji podaj trzy kwoty ŁĄCZNE dla całej linii, przepisane dokładnie tak,
jak są WYDRUKOWANE na paragonie. Nie licz ich samodzielnie — po prostu je skopiuj:
- "wartosc_przed" — wartość linii PRZED rabatem (kwota na końcu linii produktu)
- "opust"         — kwota rabatu jako liczba DODATNIA (0, gdy przy pozycji nie ma rabatu)
- "wartosc_po"    — wartość linii PO rabacie (osobna kwota wydrukowana pod linią OPUST)
Gdy pozycja nie ma rabatu: wartosc_przed = wartosc_po, opust = 0.
System sam sprawdzi, czy wartosc_przed - opust = wartosc_po, i sam policzy cenę jednostkową,
więc NIE zaokrąglaj i NIE "poprawiaj" tych kwot — nawet jeśli wyglądają dziwnie.

RABATY I OPUSTY (ważne!):
- Rabat PRZYPISANY DO POZYCJI (linia "OPUST -X,XX" zaraz po produkcie) — NIE dodawaj opustu
  jako osobnej pozycji. Przepisz trzy kwoty i podaj cenę jednostkową = wartosc_po / ilosc:
  - Przykład: "Arbuz luz  6,415×7,99  51,26" + "OPUST  -32,08" + "19,18"
    → ilosc=6.415, wartosc_przed=51.26, opust=32.08, wartosc_po=19.18, cena=2.99
  - Przykład: "Awokado  2×6,99  13,98" + "OPUST  -7,00" + "6,98"
    → ilosc=2, wartosc_przed=13.98, opust=7.00, wartosc_po=6.98, cena=3.49
- UWAGA — najczęstszy błąd: kwota z linii "OPUST" to RABAT, nigdy cena produktu.
  Jeśli produkt kosztuje 39,99, opust wynosi -2,52, a pod spodem widnieje 37,47, to
  wartosc_po = 37.47 (NIE 2,52!). Nie sugeruj się tym, czy cena wygląda wiarygodnie
  dla takiego produktu — przepisz to, co jest wydrukowane.
- Rabat ZBIORCZY na grupę lub cały paragon (np. "Podsuma w grupie 15,77" + "OPUST RABAT KARTA
  5,00% -0,79", "RABAT ŁĄCZNY -X,XX", rabaty za aplikację/kartę lojalnościową) — dodaj OSOBNĄ
  pozycję z UJEMNĄ ceną równą kwocie opustu:
  - nazwa: np. "Rabat (karta 5%)", ilosc=1, cena=-0.79
  - kategoria: taka sama jak większość rabatowanych pozycji
  - dzięki temu suma pozycji równa się kwocie faktycznie zapłaconej (SUMA PLN)

PARAGON APTECZNY / REFUNDACJA (leki na receptę, NFZ):
- W aptece cena pozycji to często cena PEŁNA (przed refundacją), a pacjent płaci mniej.
  Linia typu "U 30%/ Rp./#0567  8,85" albo "Z 50%/ Rp./#0568  5,20" (litera + procent +
  "Rp." + numer recepty + kwota) to kwota, którą PACJENT FAKTYCZNIE PŁACI za lek z linii
  BEZPOŚREDNIO POWYŻEJ (reszta to dopłata NFZ). Traktuj to jak rabat przypisany do pozycji.
- Użyj kwoty po refundacji jako łącznej wartości pozycji (cena jednostkowa = kwota / ilosc);
  NIE dodawaj osobnej pozycji na refundację:
  - "Asertin 100 tabl ... 1 op * 29,43 = 29,43" + "U 30%/ Rp./#0567  8,85" → ilosc=1, cena=8.85
  - "Emanera kaps ... 1 op * 9,35 = 9,35"     + "Z 50%/ Rp./#0568  5,20"  → ilosc=1, cena=5.20
- "suma" = kwota "DO ZAPŁATY PLN" (ile pacjent naprawdę zapłacił), a NIE "SUMA PLN"
  (ta bywa przed refundacją). Kategoria takich leków: "Zdrowie"/"Leki".

Ignoruj linie: PLU, VAT, SUMA, RAZEM, KARTA, GOTÓWKA, PTU, "Podsuma w grupie" (samą podsumę
ignoruj, ale rabatu pod nią NIE ignoruj — patrz wyżej)

KAUCJA ZA OPAKOWANIA ZWROTNE (system kaucyjny — butelki PET, szkło, puszki):
- Linii kaucji NIE ignoruj! "Kaucja PET", "OPAKOWANIA ZWROTNE WYDANIA" itp. → dodaj jako
  osobną pozycję o nazwie "Kaucja za opakowania (PET)" z ilością i ceną z tej linii
  - Przykład: "Kaucja PET(8774)  1,0x0,50  0,50" → nazwa="Kaucja za opakowania (PET)", ilosc=1, cena=0.50
- UWAGA: kaucja NIE jest wliczona w "SUMA PLN" — jeśli na paragonie jest kaucja,
  jako "suma" przyjmij kwotę "DO ZAPŁATY" (ona zawiera kaucję i tyle faktycznie zapłacono)
- Zwrot kaucji (np. "OPAKOWANIA ZWROTNE PRZYJĘCIA", kwota ujemna) → osobna pozycja
  "Zwrot kaucji za opakowania" z ceną ujemną
- Kategoria dla kaucji: "Inne"/"Kaucja" jeśli podkategoria "Kaucja" istnieje w hierarchii;
  w przeciwnym razie "Inne"/"Inne"

WALUTA:
- Sprawdź symbol lub kod waluty na paragonie (€, $, £, Kč, CZK, EUR, USD, GBP itp.)
- Dodaj pole "waluta" z kodem ISO (np. "EUR", "USD", "CZK")
- Jeśli PLN lub brak informacji → "waluta": "PLN"
- Podaj ceny w ORYGINALNEJ walucie paragonu — system sam przeliczy na PLN

DATY:
- DZISIAJ JEST {date.today().isoformat()} (rok {date.today().year})
- Format na polskich paragonach: DD-MM-YYYY lub DD.MM.YYYY → zamień na YYYY-MM-DD
- Jeśli podano dzień i miesiąc BEZ roku (np. "07.07", "18.06") → zawsze użyj bieżącego roku: {date.today().year}
- Jeśli data jest nieczytelna lub jej brak: {date.today().isoformat()}

NOTATKI TEKSTOWE:
- Każdy wpis z inną datą = osobny obiekt na liście

OGÓLNE:
- Ceny w PLN jako float
- Suma = suma pozycji jeśli nie widać jej na paragonie
"""


def _build_rekat_prompt(lista_prompt: str) -> str:
    return f"""Przypisz każdej pozycji właściwą kategorię główną i podkategorię z tej hierarchii:
{lista_prompt}

Wejście: lista obiektów JSON z polami id, nazwa, sklep (może być null).
Wyjście: WYŁĄCZNIE JSON — tablica obiektów {{id, kategoria_glowna, kategoria}}.
Bez dodatkowego tekstu. Każdy obiekt wejściowy musi mieć odpowiednik na wyjściu.
Kieruj się nazwą produktu i sklepem. Jeśli nie wiesz — użyj "Inne"/"Inne"."""


# Globalne helpery dla domyślnej hierarchii (cache — nie przeliczaj przy każdym wywołaniu)
# Uwaga: system prompt NIE jest cache'owany, bo zawiera dzisiejszą datę.
WSZYSTKIE_PODKATEGORIE, SUB_DO_GLOWNEJ, _LISTA_PROMPT = _hier_helpers(KATEGORIE_HIERARCHIA)
_REKAT_PROMPT = _build_rekat_prompt(_LISTA_PROMPT)


def _system_prompt_for(hierarchia: dict | None) -> str:
    lista = _hier_helpers(hierarchia)[2] if hierarchia else _LISTA_PROMPT
    return _build_system_prompt(lista)

MAX_BYTES = 4 * 1024 * 1024

# Formaty akceptowane przez Claude API
_OBSLUGIWANE_FORMATY = {"JPEG": "image/jpeg", "PNG": "image/png", "GIF": "image/gif", "WEBP": "image/webp"}


def prepare_image(image_bytes: bytes, mime_type: str = "image/jpeg") -> tuple[bytes, str]:
    """Waliduje i przygotowuje zdjęcie do wysłania do Claude.

    Zgłasza ObrazError z czytelnym komunikatem, gdy plik nie jest obsługiwanym zdjęciem.
    Formaty spoza listy Claude (BMP, TIFF...) konwertuje do JPEG.
    """
    if not image_bytes:
        raise ObrazError("Przesłany plik jest pusty. Wybierz zdjęcie paragonu i spróbuj ponownie.")
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img_format = img.format
    except Exception:
        raise ObrazError(
            "Nie udało się odczytać pliku jako zdjęcia. Obsługiwane formaty: JPG, PNG, WebP, GIF. "
            "Zdjęcia z iPhone'a (HEIC) zapisz jako JPG — w Ustawieniach aparatu wybierz "
            "„Najbardziej zgodne” albo prześlij zdjęcie przez komunikator, który sam je skonwertuje."
        )
    if img_format in _OBSLUGIWANE_FORMATY:
        return _compress_image(image_bytes, _OBSLUGIWANE_FORMATY[img_format])
    # format czytelny dla PIL, ale nieobsługiwany przez Claude — konwertuj do JPEG
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return _compress_image(buf.getvalue(), "image/jpeg")


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


def rekategoryzuj_batch(pozycje: list[dict], hierarchia: dict | None = None) -> tuple[list[dict], dict]:
    """Ponowna kategoryzacja listy pozycji przez Claude. Zwraca ([{id, kategoria_glowna, kategoria}], usage)."""
    hier = hierarchia or KATEGORIE_HIERARCHIA
    prompt = _build_rekat_prompt(_hier_helpers(hier)[2]) if hierarchia else _REKAT_PROMPT
    client = anthropic.Anthropic()
    wejscie = json.dumps(
        [{"id": p["id"], "nazwa": p["nazwa"], "sklep": p.get("sklep")} for p in pozycje],
        ensure_ascii=False,
    )
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=prompt,
        messages=[{"role": "user", "content": wejscie}],
    )
    raw = re.sub(r"```(?:json)?|```", "", msg.content[0].text).strip()
    wynik = json.loads(raw)
    for item in wynik:
        glowna = item.get("kategoria_glowna", "Inne")
        sub = item.get("kategoria", "Inne")
        if glowna not in hier:
            glowna = "Inne"
        if sub not in (hier.get(glowna) or []):
            sub = (hier.get(glowna) or ["Inne"])[0]
        item["kategoria_glowna"] = glowna
        item["kategoria"] = sub
    return wynik, _usage(msg)


def _kontekst_txt(kontekst: str | None) -> str:
    if not kontekst:
        return ""
    return f"\n\nDODATKOWY KONTEKST OD UŻYTKOWNIKA: {kontekst}\nUżyj tego kontekstu do poprawnego przypisania kategorii."


def _usage(message) -> dict:
    return {"input_tokens": message.usage.input_tokens, "output_tokens": message.usage.output_tokens}


def process_image(image_bytes: bytes, mime_type: str = "image/jpeg",
                  kontekst: str | None = None, hierarchia: dict | None = None) -> tuple[list[dict], dict]:
    hier = hierarchia or KATEGORIE_HIERARCHIA
    system = _system_prompt_for(hierarchia)
    client = anthropic.Anthropic()
    image_bytes, mime_type = prepare_image(image_bytes, mime_type)
    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=16000,
        system=system,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": image_b64}},
                {"type": "text", "text": "Przeanalizuj i zwróć JSON." + _kontekst_txt(kontekst)},
            ],
        }],
    )
    return _parse_response(message.content[0].text, hier), _usage(message)


_ETYKIETA_PROMPT = """Odczytujesz tabelę wartości odżywczych z etykiety produktu spożywczego.

Zwróć WYŁĄCZNIE JSON, bez komentarza:
{"nazwa": "...", "marka": "..." lub null, "opak_g": liczba lub null,
 "kcal": liczba, "bialko": liczba, "tluszcz": liczba, "wegle": liczba,
 "blonnik": liczba lub null, "cukry": liczba lub null, "sol": liczba lub null}

ZASADY:
- Wszystkie wartości odżywcze podawaj PRZELICZONE NA 100 g produktu. Jeśli tabela \
podaje je na porcję albo na 100 ml, przelicz. Gdy przeliczenie jest niemożliwe, \
zwróć null zamiast zgadywać.
- Energia w kcal, nie w kJ. Jeśli widnieje tylko kJ, podziel przez 4,184.
- `opak_g` to masa netto CAŁEGO opakowania, jeśli jest widoczna.
- Jeśli na zdjęciu nie ma tabeli wartości odżywczych, zwróć {"kcal": null}.
- Nazwa po polsku, krótka i rozpoznawalna (np. "Serek wiejski", nie cała etykieta).
"""


def czytaj_etykiete(image_bytes: bytes, mime_type: str = "image/jpeg") -> tuple[dict, dict]:
    """Zdjęcie etykiety → (wartości odżywcze na 100 g, zużycie tokenów).

    Droga ratunkowa, gdy kodu nie ma w żadnej bazie. Wynik trafia do bazy
    gospodarstwa, więc ten sam produkt czyta się z AI tylko raz w życiu."""
    import json as _json

    client = anthropic.Anthropic()
    image_bytes, mime_type = prepare_image(image_bytes, mime_type)
    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1000,
        system=_ETYKIETA_PROMPT,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": image_b64}},
                {"type": "text", "text": "Odczytaj tabelę i zwróć JSON."},
            ],
        }],
    )
    surowy = message.content[0].text.strip()
    if surowy.startswith("```"):
        surowy = surowy.split("```")[1].lstrip("json").strip()
    return _json.loads(surowy), _usage(message)


_PRZOD_PROMPT = """Odczytujesz PRZEDNIĄ stronę opakowania produktu spożywczego.

Zwróć WYŁĄCZNIE JSON:
{"nazwa": "...", "marka": "...", "opak_g": liczba albo null, "sztuk": liczba albo null,
 "fraza": "..."}

ZASADY:
- `nazwa` to nazwa produktu tak, jak stoi na opakowaniu, BEZ marki.
- `marka` to producent (Lays, Wedel, Alpro…). Gdy nie widać — null.
- `opak_g` to masa netto CAŁEGO opakowania w gramach. Przelicz mililitry na
  gramy 1:1 dla napojów i mleka. „500 g", „1 kg", „330 ml" → 500, 1000, 330.
- `sztuk` to liczba sztuk w opakowaniu, jeśli jest podana — „24 praliny",
  „10 x 25 g", „6 batonów" → 24, 10, 6. Gdy nie ma, null.
- `fraza` to hasło do wyszukania produktu w bazie — KRÓTKIE, najwyżej cztery
  słowa: marka plus to, czym produkt jest. Bez gramatury, bez haseł
  reklamowych, bez opisów smaku. „Alpro napój owsiany", „Fizz Up cola zero".
  Długie hasła nie trafiają w nic, bo baza dopasowuje wszystkie słowa naraz.
- Nie zgaduj wartości odżywczych — one są z TYŁU opakowania, nie z przodu.
- Gdy to nie jest opakowanie jedzenia, zwróć {"nazwa": null}.
"""


def czytaj_przod(image_bytes: bytes, mime_type: str = "image/jpeg") -> tuple[dict, dict]:
    """Zdjęcie PRZODU opakowania → nazwa, marka, gramatura, liczba sztuk.

    Uzupełnia odczyt tabeli z tyłu: z przodu bierze się to, czego w tabeli nie
    ma — jak produkt się nazywa i ile sztuk jest w środku."""
    import json as _json

    client = anthropic.Anthropic()
    image_bytes, mime_type = prepare_image(image_bytes, mime_type)
    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=600,
        system=_PRZOD_PROMPT,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": image_b64}},
                {"type": "text", "text": "Odczytaj przód opakowania i zwróć JSON."},
            ],
        }],
    )
    surowy = message.content[0].text.strip()
    if surowy.startswith("```"):
        surowy = surowy.split("```")[1].lstrip("json").strip()
    return _json.loads(surowy), _usage(message)


_PRZEPIS_PROMPT = """Rozkładasz PRZEPIS KULINARNY na składniki wraz z wartościami odżywczymi.

Zwróć WYŁĄCZNIE JSON:
{"nazwa": "...", "porcje": liczba,
 "skladniki": [{"nazwa": "...", "ilosc_g": liczba,
                "kcal": liczba, "bialko": liczba, "tluszcz": liczba, "wegle": liczba}]}

ZASADY:
- To PRZEPIS na całe danie, nie pojedynczy posiłek. Wartości każdego składnika
  dotyczą CAŁEJ ilości użytej do gotowania, nie jednej porcji.
- `porcje` to liczba porcji, na jaką wychodzi danie. Jeśli przepis to podaje
  („na 4 osoby", „4 porcje") — użyj tej liczby. Jeśli nie podaje, oszacuj po
  ilości składników i wpisz swoje oszacowanie. Nigdy nie zwracaj 0.
- `nazwa` to nazwa dania. Jeśli przepis jej nie podaje, nazwij danie po tym,
  czym jest („Makaron z sosem pomidorowym").
- Składniki podawaj w postaci SUROWEJ, czyli takiej, w jakiej się je odmierza
  przed gotowaniem — 500 g makaronu suchego, nie ugotowanego. Kalorie nie
  zmieniają się przy gotowaniu, zmienia się tylko masa.
- Przeliczaj miary domowe na gramy: łyżka oleju 10 g, łyżka masła 15 g,
  szklanka mąki 130 g, szklanka mleka 250 g, ząbek czosnku 5 g, jajko 55 g,
  średnia cebula 100 g, puszka pomidorów 400 g.
- Pomijaj sól, pieprz, wodę i przyprawy bez wartości odżywczej.
- Gdy z tekstu nie da się odczytać żadnych składników, zwróć {"skladniki": []}.
- Nie dopisuj składników, których nie ma w przepisie.
"""


def szacuj_przepis(opis: str) -> tuple[dict, dict]:
    """Opis przepisu słowami → (danie ze składnikami, zużycie tokenów).

    Inaczej niż `szacuj_posilek`: tam chodzi o to, co ktoś zjadł, tu o to, co
    ugotował — z liczbą porcji, na którą danie wychodzi."""
    import json as _json

    client = anthropic.Anthropic()
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2500,
        system=_PRZEPIS_PROMPT,
        messages=[{"role": "user", "content": opis.strip()[:4000]}],
    )
    surowy = message.content[0].text.strip()
    if surowy.startswith("```"):
        surowy = surowy.split("```")[1].lstrip("json").strip()
    return _json.loads(surowy), _usage(message)


def przepis_ze_zdjecia(image_bytes: bytes, mime_type: str = "image/jpeg") -> tuple[dict, dict]:
    """Zdjęcie przepisu (z książki, z ekranu) → danie ze składnikami.

    Najdroższa z dróg — wywołanie z obrazem — ale robione RAZ na danie,
    nie przy każdym jedzeniu."""
    import json as _json

    client = anthropic.Anthropic()
    image_bytes, mime_type = prepare_image(image_bytes, mime_type)
    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2500,
        system=_PRZEPIS_PROMPT,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": image_b64}},
                {"type": "text", "text": "Odczytaj przepis ze zdjęcia i zwróć JSON."},
            ],
        }],
    )
    surowy = message.content[0].text.strip()
    if surowy.startswith("```"):
        surowy = surowy.split("```")[1].lstrip("json").strip()
    return _json.loads(surowy), _usage(message)


_POSILEK_PROMPT = """Szacujesz wartości odżywcze posiłku opisanego słowami po polsku.

Zwróć WYŁĄCZNIE JSON:
{"pozycje": [{"nazwa": "...", "ilosc_g": liczba, "opis_porcji": "...",
              "kcal": liczba, "bialko": liczba, "tluszcz": liczba, "wegle": liczba}]}

ZASADY:
- Rozbij opis na osobne składniki. „Kanapka z serem" to pieczywo i ser osobno.
- `kcal` i makroskładniki dotyczą PODANEJ ILOŚCI, nie 100 g.
- `ilosc_g` to Twoje najlepsze oszacowanie masy w gramach; `opis_porcji` to
  sposób, w jaki człowiek to opisał (np. "2 kromki", "średnia porcja").
- Typowe polskie porcje: kromka chleba 35 g, jajko 55 g, łyżka oleju 10 g,
  szklanka mleka 250 g, średni ziemniak 100 g, porcja mięsa 120 g.
- Gdy opis jest zbyt ogólny, żeby cokolwiek oszacować, zwróć {"pozycje": []}.
- Nie dopisuj niczego, czego nie ma w opisie.
"""


def szacuj_posilek(opis: str) -> tuple[list[dict], dict]:
    """Opis słowami („dwa jajka i kromka chleba") → lista pozycji z wartościami.

    Potrzebne przy domowych posiłkach, które nie mają żadnego kodu kreskowego."""
    import json as _json

    client = anthropic.Anthropic()
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        system=_POSILEK_PROMPT,
        messages=[{"role": "user", "content": opis.strip()[:600]}],
    )
    surowy = message.content[0].text.strip()
    if surowy.startswith("```"):
        surowy = surowy.split("```")[1].lstrip("json").strip()
    dane = _json.loads(surowy)
    return dane.get("pozycje") or [], _usage(message)


# Zdjęcie jest tu nośnikiem TEKSTU, nie widokiem jedzenia: kartka, strona
# książki kucharskiej, ekran cudzej apki do liczenia kalorii. Kolejność zasad
# ma znaczenie — model, któremu najpierw powie się o talerzu, zaczyna zgadywać
# z wyglądu nawet wtedy, gdy gramatura jest wypisana wprost obok.
_POSILEK_FOTO_PROMPT = _POSILEK_PROMPT + """
ZDJĘCIE ZAMIAST OPISU:
- Najczęściej to ZAPISANY OPIS posiłku: odręczna notatka, strona książki
  kucharskiej, karta dań albo ekran innej aplikacji do liczenia kalorii.
- ODCZYTUJ TO, CO NAPISANE. Gdy widać gotowe wartości (nazwa, gramatura, kcal,
  makro) — przepisz je, nie szacuj od nowa. Wypisana liczba jest zawsze
  pewniejsza niż Twoje oszacowanie.
- Gdy podana jest sama nazwa i ilość, oszacuj wartości tak jak przy opisie
  słowami.
- Zdjęcie samego talerza to przypadek OSTATECZNY: dopiero gdy nie ma na nim
  żadnego tekstu, oszacuj porcje z wielkości naczynia i sztućców.
- Dopisz pole "opis" z jednym zdaniem o tym, co odczytałeś — trafia do
  dziennika jako ślad, skąd wpis pochodzi.
- Gdy na zdjęciu nie ma jedzenia ani jego opisu, zwróć {"pozycje": []}.
"""


def posilek_ze_zdjecia(image_bytes: bytes, mime_type: str = "image/jpeg") -> tuple[list, str, dict]:
    """Zdjęcie posiłku → (pozycje, jednozdaniowy opis, zużycie tokenów).

    Bliźniak `szacuj_posilek`, tylko wejściem jest obraz. Osobna funkcja, a nie
    przełącznik w tamtej: różnią się promptem i kosztem wywołania, a mieszanie
    tego w jednym miejscu kończy się tym, że nie wiadomo, która gałąź się
    wykonała, gdy wynik jest dziwny.
    """
    import json as _json

    client = anthropic.Anthropic()
    image_bytes, mime_type = prepare_image(image_bytes, mime_type)
    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        system=_POSILEK_FOTO_PROMPT,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": image_b64}},
                {"type": "text", "text": "Odczytaj posiłek ze zdjęcia i zwróć JSON."},
            ],
        }],
    )
    surowy = message.content[0].text.strip()
    if surowy.startswith("```"):
        surowy = surowy.split("```")[1].lstrip("json").strip()
    dane = _json.loads(surowy)
    return dane.get("pozycje") or [], (dane.get("opis") or "").strip(), _usage(message)


_DORADCA_PROMPT = """Jesteś doświadczonym, konkretnym doradcą budżetowym dla polskiego gospodarstwa domowego. \
Dostajesz zagregowane dane o wydatkach z ostatnich kilku miesięcy (kwoty w PLN). \
Twoim zadaniem jest znaleźć REALNE, oparte na danych możliwości oszczędzania — nie ogólniki.

Zasady:
- Odwołuj się do konkretnych liczb z danych (nazwy produktów, częstotliwość, kwoty). Zamiast "ogranicz jedzenie na mieście" napisz "kawa na mieście: 14 zakupów, średnio 18 zł, razem 252 zł/mies".
- Zwracaj uwagę na: częste drobne zakupy, które się sumują; abonamenty i subskrypcje (łatwe oszczędności); kategorie rosnące z miesiąca na miesiąc; wydatki nietypowo wysokie w danym miesiącu.
- BIEŻĄCY MIESIĄC JEST NIEPEŁNY (pole okres.uwaga mówi, ile dni obejmuje). Nigdy nie porównuj go \
wprost z pełnymi miesiącami ("lipiec droższy od czerwca" z 8 dni danych to błąd) i nie licz z niego \
trendów. Przy każdej kwocie z niepełnego miesiąca dopisz, że to wartość częściowa; jeśli szacujesz \
pełny miesiąc proporcjonalnie (run-rate), powiedz to wprost.
- WPŁYWY masz WYSZCZEGÓLNIONE co do źródła w wplywy_zrodla_per_miesiac — każdy wpływ z osobna \
(zrodlo = opis „za co", kategoria, osoba, suma, miesiac). Wiesz więc dokładnie, ZA CO jest każdy wpływ \
(pensja, czynsz z najmu, świadczenia, zwroty itd.). ZANIM uznasz jakąś kategorię WYDATKÓW za czysty \
koszt, sprawdź, czy nie ma powiązanego wpływu, który ją równoważy — np. czynsz od najemcy vs koszty \
wynajmowanego lokalu, świadczenie na dziecko vs wydatki na dziecko. Wtedy oceniaj WYNIK NETTO \
(przychód − koszty), a nie same koszty. NIGDY nie pisz, że jakiegoś przychodu „nie widać w danych", \
jeśli figuruje w wplywy_zrodla_per_miesiac — dopasuj go po opisie źródła.
- Rekomendacje muszą mieć realny szacunek oszczędności miesięcznej (oszczednosc_mies) i ocenę trudności.
- Wydatki z listy wydatki_okazjonalne (urodziny, święta, imprezy) to zdarzenia JEDNORAZOWE — nie wyciągaj z nich nawyków ani miesięcznych rekomendacji oszczędności; możesz je co najwyżej odnotować w obserwacjach jako koszt jednorazowy. Produkty z takich zakupów są celowo wyłączone z listy top_produkty.
- NIE kwestionuj kategoryzacji wydatków — kategorie w danych są kontekstowe i przypisane świadomie przez użytkownika (np. zakupy na przyjęcie dziecka mogą celowo być w kategorii dziecka). Błędna kategoryzacja nie jest tematem tej analizy.
- Nie powtarzaj tego samego tematu w kilku sekcjach: jeden temat = jedno miejsce (rekomendacja, jeśli jest z tym związana akcja; w przeciwnym razie obserwacja). Trendy dotyczą wyłącznie zmian kategorii w czasie.
- Nie wymyślaj danych, których nie ma. Jeśli danych jest mało, powiedz to wprost w podsumowaniu.
- Liczby do pola kondycja (wydatki_mies, wplywy_mies, bilans_mies) są już WYLICZONE przez system \
w polu kondycja_wyliczona — przepisz je 1:1, nie licz ich samodzielnie. Ty dobierasz tylko "ocena". \
Pole "metoda" mówi, z jakiego okresu policzono średnią — uwzględnij to w podsumowaniu.
- Pisz po polsku, rzeczowo, bez lania wody. Kwoty jako liczby (bez "zł" w polach liczbowych).

WARSTWA PLANÓW (jeśli obecna w danych — wykorzystaj ją, to najbardziej konkretne sygnały):
- limity[]: budżety miesięczne użytkownika. Każdy ma limit, wydane, pozostalo, procent. Limit \
przekroczony lub blisko przekroczenia (procent ≥ ~90) to gotowa OBSERWACJA lub REKOMENDACJA — podaj \
o ile i w której kategorii. Gdy okres.uwaga mówi, że miesiąc jest KOMPLETNY, przekroczenie jest \
faktem (nie ekstrapolacją). Nie wymyślaj limitów, których nie ma na liście.
- cele[]: cele oszczędnościowe (koperty). Pola: odlozone, brakuje, postep (%), tempo_miesieczne \
(średnia wpłat/mies.), prognoza_miesiecy, termin, wymagane_miesieczne, na_czas. Gdy na_czas=false lub \
tempo < wymagane_miesieczne — cel jest zagrożony: powiedz to i podaj, ile trzeba dokładać miesięcznie. \
Wolne oszczędności z rekomendacji wiąż z konkretną kopertą (np. „te 200 zł kieruj na cel X").
- cel_przeplywowy: docelowa miesięczna nadwyżka gospodarstwa (typ „kwota" = zł/mies., typ „procent" \
= % wpływów). Oceń bilans_mies względem tego celu — czy gospodarstwo trafia w swój własny cel przepływowy.
- konta_agregat: oszczednosci, biezace, razem oraz poduszka_miesiecy (ile miesięcy średnich wydatków \
pokrywają oszczędności). Użyj poduszka_miesiecy jako kontekstu kondycji: <3 mies. to cienka poduszka \
(argument za budowaniem rezerwy), >6 mies. daje swobodę. Nie licz tych liczb sam — są gotowe.

Zwróć WYŁĄCZNIE poprawny JSON w tym formacie (bez markdown, bez komentarzy):
{
  "podsumowanie": "2-4 zdania o ogólnej sytuacji budżetu",
  "kondycja": {"ocena": "dobra|ok|uwaga", "wydatki_mies": 0, "wplywy_mies": 0, "bilans_mies": 0},
  "obserwacje": [{"tytul": "krótki", "opis": "z konkretnymi liczbami", "waga": "wysoka|srednia|niska"}],
  "rekomendacje": [{"tytul": "krótki", "opis": "jak i dlaczego", "oszczednosc_mies": 0, "trudnosc": "latwe|srednie|trudne"}],
  "trendy": [{"kategoria": "nazwa", "kierunek": "rosnie|spada|stabilnie", "opis": "krótko"}],
  "potencjal_oszczednosci_mies": 0,
  "pytania": [{"pytanie": "krótkie pytanie do użytkownika", "opcje": ["opcja 1", "opcja 2"], "dlaczego": "jedno zdanie, co zmieni odpowiedź"}]
}
potencjal_oszczednosci_mies to suma realistycznych oszczednosc_mies z rekomendacji. \
Podaj 3-6 obserwacji i 3-6 rekomendacji, posortowanych od najważniejszych.

Pytania (pole pytania): dodaj 0-3 pytania WYŁĄCZNIE o rzeczy, których odpowiedź realnie \
zmieniłaby Twoją interpretację lub rekomendację (np. czy rachunki są płacone kwartalnie, \
czy subskrypcja jest używana zawodowo, czy duży wydatek się powtórzy). Do każdego 2-4 krótkie \
opcje odpowiedzi. NIE pytaj o nic, co wynika z danych albo z PROFILU GOSPODARSTWA. \
Jeśli nie ma istotnych niejasności, zwróć pustą listę.
Jeśli w wiadomości jest PROFIL GOSPODARSTWA, traktuj go jako pewne fakty nadrzędne wobec \
domysłów z danych — rekomendacje nie mogą być z nim sprzeczne (np. nie sugeruj rezygnacji \
z narzędzia, które użytkownik zadeklarował jako potrzebne)."""


def analizuj_budzet(dane: dict, kontekst: str | None = None,
                    profil: list[str] | None = None) -> tuple[dict, dict]:
    """Analiza budżetu przez Claude. Zwraca (raport_dict, usage)."""
    client = anthropic.Anthropic()
    tresc = (f"DZISIAJ JEST {date.today().isoformat()}.\n\n"
             "DANE BUDŻETU (JSON):\n" + json.dumps(dane, ensure_ascii=False, default=str))
    if profil:
        tresc += ("\n\nPROFIL GOSPODARSTWA — trwałe fakty podane przez użytkownika "
                  "(pewne, nadrzędne wobec domysłów; nie zadawaj pytań o te tematy):\n"
                  + "\n".join(f"- {p}" for p in profil))
    if kontekst and kontekst.strip():
        tresc += (f"\n\nKONTEKST GOSPODARSTWA (uwzględnij w rekomendacjach): {kontekst.strip()}")
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=8192,
        system=_DORADCA_PROMPT,
        messages=[{"role": "user", "content": tresc}],
    )
    raw = msg.content[0].text.strip()
    # model czasem dokleja tekst albo fence'y wokół JSON — wytnij zewnętrzny obiekt {...}
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        raise ValueError(f"Model nie zwrócił JSON (początek odpowiedzi: {raw[:200]!r})")
    try:
        raport = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        raise ValueError(f"Niepoprawny JSON z modelu ({e}; fragment: {m.group(0)[:200]!r})")
    return raport, _usage(msg)


# Tolerancje uzgadniania pozycji z paragonem.
# Linia: 2 gr — tyle potrafi zjeść zaokrąglenie przy pozycjach na wagę.
# Suma: 5 gr — sklep zaokrągla każdą linię osobno, więc drobny dryf jest normalny.
_TOL_LINIA = 0.02
_TOL_SUMA = 0.05
# Powyżej tylu spornych linii rezygnujemy z przeszukiwania (2^13 = 8192 kombinacji).
_MAX_SPORNYCH = 13


def _warianty_pozycji(p: dict) -> list[float]:
    """Możliwe wartości łączne linii — pierwsza to odczyt „jak jest".

    Na paragonie rabatowana linia niesie trzy kwoty powiązane równaniem
    wartosc_przed - opust = wartosc_po. Gdy równanie się nie spina, jedna z tych
    liczb została źle odczytana — zwracamy wtedy DWA warianty, a rozstrzyga
    dopiero suma z paragonu (patrz _uzgodnij_pozycje).
    """
    ilosc = p.get("ilosc") or 1
    przed, po = p.get("wartosc_przed"), p.get("wartosc_po")
    opust = abs(p.get("opust") or 0.0)

    if po is None and przed is None:
        # model nie podał rozbicia (notatka tekstowa, starszy format) — stara ścieżka
        return [round((p.get("cena") or 0.0) * ilosc, 2)]
    if po is None:
        return [round(przed - opust, 2)]
    if przed is None:
        return [round(po, 2)]

    po, odtworzone = round(po, 2), round(przed - opust, 2)
    if abs(odtworzone - po) <= _TOL_LINIA:
        return [po]
    return [po, odtworzone]


def _uzgodnij_pozycje(item: dict) -> None:
    """Uzgadnia wartości pozycji z sumą wydrukowaną na paragonie.

    SUMA PLN to jedna duża liczba, którą model odczytuje pewnie — o wiele pewniej
    niż kilkadziesiąt kwot drobnym drukiem. Traktujemy ją więc jako kotwicę: gdy
    któreś linie mają złamane równanie, wybieramy taki zestaw wariantów, który
    najlepiej trafia w tę sumę. Ustawia p["cena"] i (przy rozjeździe) _ostrzezenie.
    """
    poz = item.get("pozycje") or []
    if not poz:
        return

    warianty = [_warianty_pozycji(p) for p in poz]
    odczyt = [w[0] for w in warianty]      # wartości „jak model odczytał"
    wybor = odczyt[:]
    sporne = [i for i, w in enumerate(warianty) if len(w) > 1]
    suma_paragon = item.get("suma") or 0.0

    if suma_paragon and sporne and len(sporne) <= _MAX_SPORNYCH:
        cel = round(suma_paragon, 2)
        najlepsza = abs(round(sum(wybor), 2) - cel)
        if najlepsza > _TOL_SUMA:
            for maska in product(*(range(len(warianty[i])) for i in sporne)):
                proba = wybor[:]
                for i, k in zip(sporne, maska):
                    proba[i] = warianty[i][k]
                odchylka = abs(round(sum(proba), 2) - cel)
                if odchylka < najlepsza - 1e-9:
                    najlepsza, wybor = odchylka, proba

    naprawione = []
    for p, wartosc, surowa in zip(poz, wybor, odczyt):
        ilosc = p.get("ilosc") or 1
        p["cena"] = round(wartosc / ilosc, 2) if ilosc else round(wartosc, 2)
        if abs(wartosc - surowa) > _TOL_LINIA:
            naprawione.append(p.get("nazwa") or "?")
        for pole in ("wartosc_przed", "opust", "wartosc_po"):
            p.pop(pole, None)

    suma_pozycji = round(sum(wybor), 2)
    if not suma_paragon:
        item["suma"] = suma_pozycji
        return

    # Suma z paragonu wygrywa z sumą pozycji — nigdy odwrotnie.
    item["suma"] = round(suma_paragon, 2)
    roznica = round(suma_paragon - suma_pozycji, 2)
    if naprawione:
        item["_naprawione"] = naprawione
    if abs(roznica) > max(0.50, 0.02 * suma_paragon):
        item["suma_pozycje"] = suma_pozycji
        item["_ostrzezenie"] = (
            f"Suma pozycji ({suma_pozycji:.2f} zł) nie zgadza się z sumą z paragonu "
            f"({suma_paragon:.2f} zł) o {abs(roznica):.2f} zł. W polu Suma zostawiono kwotę "
            "z paragonu — sprawdź pozycje, bo któraś ma źle odczytaną cenę."
        )


def process_text(text: str, kontekst: str | None = None, hierarchia: dict | None = None) -> tuple[list[dict], dict]:
    hier = hierarchia or KATEGORIE_HIERARCHIA
    system = _system_prompt_for(hierarchia)
    client = anthropic.Anthropic()
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=system,
        messages=[{"role": "user", "content": f"Przeanalizuj tę notatkę wydatków:\n\n{text}" + _kontekst_txt(kontekst)}],
    )
    return _parse_response(message.content[0].text, hier), _usage(message)


def _parse_response(raw: str, hierarchia: dict | None = None) -> list[dict]:
    hier = hierarchia or KATEGORIE_HIERARCHIA
    if hier is KATEGORIE_HIERARCHIA:
        wszystkie, sub_do_glownej = WSZYSTKIE_PODKATEGORIE, SUB_DO_GLOWNEJ
    else:
        wszystkie, sub_do_glownej, _ = _hier_helpers(hier)

    cleaned = re.sub(r"```(?:json)?|```", "", raw).strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        # model czasem owija JSON prozą (np. komentarz o refundacji przy paragonie
        # aptecznym) — wytnij najbardziej zewnętrzną tablicę [...] albo obiekt {...}
        m = re.search(r"\[.*\]", cleaned, re.DOTALL) or re.search(r"\{.*\}", cleaned, re.DOTALL)
        data = None
        if m:
            try:
                data = json.loads(m.group(0))
            except json.JSONDecodeError:
                data = None
        if data is None:
            raise RozpoznanieError(
                "Claude nie rozpoznał paragonu — odpowiedź nie zawierała danych wydatku. "
                "Upewnij się, że zdjęcie jest wyraźne, dobrze oświetlone i obejmuje cały paragon, "
                "albo dodaj wskazówkę dla AI i spróbuj ponownie."
            )
    if isinstance(data, dict):
        data = [data]
    if not data:
        raise RozpoznanieError(
            "Claude nie znalazł żadnego wydatku ani paragonu w przesłanych danych. "
            "Sprawdź, czy na zdjęciu widać paragon (lub czy notatka zawiera kwoty) i spróbuj ponownie."
        )

    today = date.today().isoformat()
    for item in data:
        if not item.get("data"):
            item["data"] = today

        waluta = (item.get("waluta") or "PLN").upper()
        item["waluta"] = waluta
        item["kurs"] = 1.0

        # Uzgodnij PRZED przeliczeniem waluty — kwoty przepisane z paragonu
        # (wartosc_przed/opust/wartosc_po) są w walucie paragonu, nie w złotówkach.
        _uzgodnij_pozycje(item)

        if waluta != "PLN":
            try:
                kurs = get_exchange_rate(waluta, item["data"])
                item["kurs"] = round(kurs, 4)
                for p in item.get("pozycje", []):
                    p["cena"] = round(p["cena"] * kurs, 2)
                if item.get("suma"):
                    item["suma"] = round(item["suma"] * kurs, 2)
                if item.get("suma_pozycje"):
                    item["suma_pozycje"] = round(item["suma_pozycje"] * kurs, 2)
            except Exception as e:
                item["_kurs_blad"] = str(e)

        for p in item.get("pozycje", []):
            kat = p.get("kategoria", "")
            glowna = p.get("kategoria_glowna", "")
            if kat not in wszystkie:
                p["kategoria"] = "Inne"
                p["kategoria_glowna"] = "Inne"
            elif glowna not in hier:
                p["kategoria_glowna"] = sub_do_glownej.get(kat, "Inne")

    return data
