"""Warstwa bazy dla sekcji wiem.health — badania, dokumentacja, historia leczenia.

Osobny plik z tego samego powodu co `eat_db.py`: `database.py` obsługuje finanse
i nie ma po co wiedzieć o morfologii. Wspólny jest tylko `get_db` i tabela
`households`.

MODEL DANYCH JEST PRZEPISANY Z HL7 FHIR, a nie wymyślony. Każdy lekarz wydaje
wynik w innym układzie, więc zamiast zgadywać wspólny mianownik bierzemy ten,
który już istnieje i jest wdrożony w systemach szpitalnych na świecie:

  health_dokumenty  ≈  DiagnosticReport  (jedno badanie / jedna wizyta)
  health_wyniki     ≈  Observation       (jedna zmierzona wartość)

Podział przechodzi próbę ognia na dwóch skrajnych przypadkach: morfologia to
jeden dokument i trzydzieści wyników liczbowych, a opis tomografii to jeden
dokument, zero wyników i cała treść w polu `opis`.

ZASADA NADRZĘDNA — PRZEPISUJEMY, NIE LICZYMY. Norma i flaga H/L pochodzą
z wyniku, który wydało laboratorium; nigdy ich nie wyliczamy ani nie
interpretujemy. Ta sama sodowa norma różni się między laboratoriami, a wynik
„poza normą" policzony przez nas wyglądałby dokładnie tak samo jak wynik
poza normą stwierdzony przez diagnostę — i nie dałoby się ich odróżnić.
"""

from database import get_db

# Cztery rodzaje dokumentu, bo każdy czyta się inaczej. Rozdzielone nie dla
# porządku, tylko dlatego, że sterują wyglądem ekranu: „lab" pokazuje tabelę
# wyników, „obrazowe" i „wizyta" pokazują opis, bo tam cała treść jest w prozie.
RODZAJE = ("lab", "obrazowe", "wizyta", "inne")

# Operator przy wyniku. Laboratorium wydaje „TSH <0,005", bo poniżej progu
# czułości metody nie da się zmierzyć wartości — tylko stwierdzić, że jest
# mniejsza. Bez tego pola zostają dwie złe drogi: zapisać 0,005 (fałszowanie
# danych — wynik jest mniejszy) albo zapisać tekstem (wypada z wykresu).
OPERATORY = ("<", ">", "<=", ">=")


def init_health_db() -> None:
    with get_db() as cur:
        # ── osoby ───────────────────────────────────────────────────────────
        # NIE są to konta w aplikacji. Dziecko i babcia nie mają logowania,
        # a ich wyniki trzeba gdzieś trzymać. Powiązanie z kontem jest luźne
        # (user_id nullable) — osoba istnieje niezależnie od tego, czy ktoś
        # się nią loguje.
        cur.execute("""CREATE TABLE IF NOT EXISTS health_osoby (
            id             SERIAL PRIMARY KEY,
            household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            imie           TEXT NOT NULL,
            data_urodzenia DATE,
            ukryta         BOOLEAN NOT NULL DEFAULT FALSE,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        # Data urodzenia nie jest ozdobą: przy wynikach dziecka norma zależy od
        # wieku W DNIU BADANIA, nie dzisiejszego. Mając datę urodzenia i datę
        # badania wiek jest zawsze wyliczalny wstecz; trzymanie samego „wieku"
        # zepsułoby się przy pierwszych urodzinach.
        cur.execute("CREATE INDEX IF NOT EXISTS health_osoby_dom "
                    "ON health_osoby (household_id)")

        # ── dokumenty ───────────────────────────────────────────────────────
        cur.execute("""CREATE TABLE IF NOT EXISTS health_dokumenty (
            id            SERIAL PRIMARY KEY,
            household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            osoba_id      INTEGER NOT NULL REFERENCES health_osoby(id) ON DELETE CASCADE,
            rodzaj        TEXT NOT NULL DEFAULT 'lab',
            nazwa         TEXT NOT NULL,
            data_badania  DATE,
            placowka      TEXT,
            opis          TEXT,
            rozpoznanie   TEXT,
            kod_icd10     TEXT,
            zalecenia     TEXT,
            ukryty        BOOLEAN NOT NULL DEFAULT FALSE,
            dodane_przez  TEXT,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        # `rozpoznanie` i `kod_icd10` celowo NIE są ograniczone do rodzaju
        # „wizyta". Wynik histopatologiczny JEST rozpoznaniem, a leży w „lab".
        cur.execute("CREATE INDEX IF NOT EXISTS health_dok_osoba "
                    "ON health_dokumenty (osoba_id, data_badania DESC)")

        # Badanie potrafi trwać dłużej niż dzień (dobowa zbiórka moczu, holter,
        # hospitalizacja), a data pobrania materiału bywa inna niż data wyniku —
        # przy posiewie różnica to kilka dni i to ona ustawia kolejność zdarzeń.
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS data_do DATE")
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS data_pobrania DATE")
        # Numer z papieru — jedyny sposób, żeby dopasować nasz wpis do oryginału
        # w laboratorium, gdy trzeba coś reklamować albo dosłać.
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS numer_badania TEXT")
        # „Kontrola za 3 miesiące" jest zaleceniem, które ma termin. Bez osobnego
        # pola ginie w prozie `zalecenia` i nikt o nim nie przypomni.
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS data_nastepnego DATE")
        # Stan, w którym wykonano badanie — bez niego liczba bywa bez znaczenia.
        # Tydzień ciąży przy badaniu prenatalnym, doba życia przy noworodku,
        # dni abstynencji przy badaniu nasienia, faza cyklu przy hormonach.
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS kontekst TEXT")
        # Wobec jakiej normy wynik był oceniany: „WHO 2021", „siatki OLAF".
        # Ta sama liczba nasienia jest prawidłowa wg WHO 2021 i nieprawidłowa
        # wg WHO 1999 — bez zapisania wersji porównanie po latach jest fałszywe.
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS norma_wg TEXT")

        # Kolumny po nieaktualnej decyzji: przez jeden dzień oryginały PDF
        # trafiały do bazy. NIC ICH JUŻ NIE ZAPISUJE — żadne zdjęcie, skan ani
        # PDF nie zostaje na serwerze (patrz `zapisz` w health.py). Zostają
        # puste, żeby nie kasować danych migracją; usuniemy je świadomie.
        #
        # Powód, dla którego to się zmieniło — wart zapamiętania, bo poprzedni
        # komentarz mylił w tym miejscu przez cały czas swojego istnienia:
        # Railway MA trwałe wolumeny, ale Postgres sam na takim stoi, więc plik
        # w bazie i plik na dysku zjadają tę samą pulę (Hobby: 5 GB na wszystko,
        # razem z budżetem domowym). Skany bywają grube — wypis szpitalny to
        # 1–2 MB na stronę — więc dokumentacja medyczna potrafiłaby wypchnąć
        # apkę, z której korzystamy codziennie. Docelowe miejsce na oryginały
        # to dysk Google użytkownika: jego miejsce i jego dane.
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS plik BYTEA")
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS plik_nazwa TEXT")

        # ── wyniki ──────────────────────────────────────────────────────────
        cur.execute("""CREATE TABLE IF NOT EXISTS health_wyniki (
            id             SERIAL PRIMARY KEY,
            dokument_id    INTEGER NOT NULL REFERENCES health_dokumenty(id) ON DELETE CASCADE,
            nazwa          TEXT NOT NULL,
            wartosc_liczba NUMERIC(12,4),
            wartosc_tekst  TEXT,
            jednostka      TEXT,
            norma_min      NUMERIC(12,4),
            norma_max      NUMERIC(12,4),
            norma_tekst    TEXT,
            flaga          TEXT,
            kolejnosc      INTEGER NOT NULL DEFAULT 0
        )""")
        cur.execute("CREATE INDEX IF NOT EXISTS health_wyn_dok "
                    "ON health_wyniki (dokument_id, kolejnosc)")

        # Dwa pola wartości, bo wyniki są dwojakiego rodzaju i sprowadzenie ich
        # do jednego typu psuje albo jedne, albo drugie. Hemoglobina to liczba
        # i musi trafić na wykres; posiew to „Escherichia coli" i na wykres nie
        # trafi nigdy. Grupa krwi to „A Rh+", nie liczba.

        # Operator — patrz komentarz przy OPERATORY na górze pliku.
        cur.execute("ALTER TABLE health_wyniki ADD COLUMN IF NOT EXISTS operator TEXT")
        # Krzywa cukrowa i insulinowa to jedno badanie i kilka pomiarów tego
        # samego parametru, rozróżnianych WYŁĄCZNIE czasem. Bez `minuta`
        # trzy glukozy w jednym dokumencie są nie do odróżnienia, a cała
        # wartość diagnostyczna krzywej leży w ich kolejności.
        cur.execute("ALTER TABLE health_wyniki ADD COLUMN IF NOT EXISTS minuta INTEGER")
        cur.execute("ALTER TABLE health_wyniki ADD COLUMN IF NOT EXISTS moment TEXT")
        # Strona ciała i miejsce — „gęstość kości" bez informacji, że to szyjka
        # kości udowej lewej, nie da się porównać z badaniem za dwa lata.
        cur.execute("ALTER TABLE health_wyniki ADD COLUMN IF NOT EXISTS strona TEXT")
        cur.execute("ALTER TABLE health_wyniki ADD COLUMN IF NOT EXISTS lokalizacja TEXT")
        # Grupowanie wewnątrz dokumentu: szczep bakterii w antybiogramie,
        # panel alergenów, układ w badaniu ogólnym.
        cur.execute("ALTER TABLE health_wyniki ADD COLUMN IF NOT EXISTS grupa TEXT")
        # Metoda oznaczenia. To NIE jest szczegół techniczny: D-dimery podawane
        # w jednostkach FEU i DDU różnią się dwukrotnie, więc wykres zbierający
        # wyniki z dwóch laboratoriów bez tej informacji pokazuje skok, którego
        # w organizmie nie było.
        cur.execute("ALTER TABLE health_wyniki ADD COLUMN IF NOT EXISTS metoda TEXT")
        # Wartość należna — spirometria i densytometria podają wynik zmierzony
        # ORAZ oczekiwany dla wieku i wzrostu; sam pomiar nic nie znaczy.
        cur.execute("ALTER TABLE health_wyniki ADD COLUMN IF NOT EXISTS wartosc_odniesienia NUMERIC(12,4)")
        cur.execute("ALTER TABLE health_wyniki ADD COLUMN IF NOT EXISTS komentarz TEXT")

        # `flaga` jest TEKSTEM, nie polem logicznym „poza normą". Laboratoria
        # oznaczają wyniki na wiele sposobów i wszystkie trzeba przepisać bez
        # tłumaczenia: H/L, HH/LL przy wartościach krytycznych, klasa IgE 0–6,
        # centyl u dziecka, kategoria BI-RADS w mammografii.


# ── osoby ───────────────────────────────────────────────────────────────────

def osoby(household_id: int, z_ukrytymi: bool = False) -> list[dict]:
    with get_db() as cur:
        cur.execute(
            "SELECT id, imie, data_urodzenia, ukryta FROM health_osoby "
            "WHERE household_id = %s AND (%s OR NOT ukryta) "
            "ORDER BY ukryta, imie",
            (household_id, z_ukrytymi),
        )
        return [dict(r) for r in cur.fetchall()]


def dodaj_osobe(household_id: int, imie: str, data_urodzenia=None) -> int:
    with get_db() as cur:
        cur.execute(
            "INSERT INTO health_osoby (household_id, imie, data_urodzenia) "
            "VALUES (%s, %s, %s) RETURNING id",
            (household_id, imie.strip(), data_urodzenia),
        )
        return cur.fetchone()["id"]


def osoba_po_id(household_id: int, osoba_id: int) -> dict | None:
    with get_db() as cur:
        cur.execute(
            "SELECT id, imie, data_urodzenia, ukryta FROM health_osoby "
            "WHERE id = %s AND household_id = %s",
            (osoba_id, household_id),
        )
        r = cur.fetchone()
        return dict(r) if r else None


# ── dokumenty ───────────────────────────────────────────────────────────────

# Kolumny dokumentu bez `plik` — bajty PDF-a nie mają czego szukać na liście
# ani w JSON-ie odpowiedzi. Wyciągamy je wyłącznie przy pobieraniu pliku.
_POLA_DOK = """id, osoba_id, rodzaj, nazwa, data_badania, data_do, data_pobrania,
               placowka, opis, rozpoznanie, kod_icd10, zalecenia, numer_badania,
               data_nastepnego, kontekst, norma_wg, ukryty, dodane_przez,
               created_at, plik_nazwa, (plik IS NOT NULL) AS ma_plik"""


def dokumenty(household_id: int, osoba_id: int | None = None,
              rodzaj: str | None = None) -> list[dict]:
    with get_db() as cur:
        cur.execute(
            f"SELECT {_POLA_DOK} FROM health_dokumenty "
            "WHERE household_id = %s AND NOT ukryty "
            "  AND (%s::int IS NULL OR osoba_id = %s) "
            "  AND (%s::text IS NULL OR rodzaj = %s) "
            # Dokumenty bez daty badania (jeszcze nieuzupełnione) mają trafiać
            # na górę, a nie na sam koniec — NULLS FIRST przy malejącej dacie.
            "ORDER BY data_badania DESC NULLS FIRST, id DESC",
            (household_id, osoba_id, osoba_id, rodzaj, rodzaj),
        )
        return [dict(r) for r in cur.fetchall()]


def dokument(household_id: int, dokument_id: int) -> dict | None:
    """Dokument razem z wynikami — ekran szczegółów potrzebuje obu naraz."""
    with get_db() as cur:
        cur.execute(
            f"SELECT {_POLA_DOK} FROM health_dokumenty WHERE id = %s AND household_id = %s",
            (dokument_id, household_id),
        )
        r = cur.fetchone()
        if not r:
            return None
        d = dict(r)
        cur.execute(
            "SELECT id, nazwa, wartosc_liczba, wartosc_tekst, jednostka, operator, "
            "       norma_min, norma_max, norma_tekst, flaga, minuta, moment, "
            "       strona, lokalizacja, grupa, metoda, wartosc_odniesienia, komentarz "
            "FROM health_wyniki WHERE dokument_id = %s ORDER BY kolejnosc, id",
            (dokument_id,),
        )
        d["wyniki"] = [dict(w) for w in cur.fetchall()]
        return d


def zapisz_dokument(household_id: int, osoba_id: int, dane: dict,
                    wyniki: list[dict], dodane_przez: str | None = None) -> int:
    """Zapisuje dokument wraz z wynikami w JEDNEJ transakcji.

    Dokument bez wyników jest poprawny (opis tomografii), ale wynik bez
    dokumentu nie ma sensu — dlatego jedno wywołanie, a nie dwa.
    """
    with get_db() as cur:
        cur.execute(
            """INSERT INTO health_dokumenty
               (household_id, osoba_id, rodzaj, nazwa, data_badania, data_do,
                data_pobrania, placowka, opis, rozpoznanie, kod_icd10, zalecenia,
                numer_badania, data_nastepnego, kontekst, norma_wg, dodane_przez)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (household_id, osoba_id,
             dane.get("rodzaj") or "lab",
             (dane.get("nazwa") or "Badanie").strip(),
             dane.get("data_badania"), dane.get("data_do"), dane.get("data_pobrania"),
             dane.get("placowka"), dane.get("opis"), dane.get("rozpoznanie"),
             dane.get("kod_icd10"), dane.get("zalecenia"), dane.get("numer_badania"),
             dane.get("data_nastepnego"), dane.get("kontekst"), dane.get("norma_wg"),
             dodane_przez),
        )
        dok_id = cur.fetchone()["id"]
        for i, w in enumerate(wyniki or []):
            _wstaw_wynik(cur, dok_id, w, i)
        return dok_id


def _wstaw_wynik(cur, dokument_id: int, w: dict, kolejnosc: int) -> None:
    op = w.get("operator")
    cur.execute(
        """INSERT INTO health_wyniki
           (dokument_id, nazwa, wartosc_liczba, wartosc_tekst, jednostka, operator,
            norma_min, norma_max, norma_tekst, flaga, minuta, moment, strona,
            lokalizacja, grupa, metoda, wartosc_odniesienia, komentarz, kolejnosc)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (dokument_id,
         (w.get("nazwa") or "?").strip(),
         w.get("wartosc_liczba"), w.get("wartosc_tekst"), w.get("jednostka"),
         op if op in OPERATORY else None,
         w.get("norma_min"), w.get("norma_max"), w.get("norma_tekst"),
         w.get("flaga"), w.get("minuta"), w.get("moment"), w.get("strona"),
         w.get("lokalizacja"), w.get("grupa"), w.get("metoda"),
         w.get("wartosc_odniesienia"), w.get("komentarz"), kolejnosc),
    )


def usun_dokument(household_id: int, dokument_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM health_dokumenty WHERE id = %s AND household_id = %s",
                    (dokument_id, household_id))
        return cur.rowcount > 0


def plik_dokumentu(household_id: int, dokument_id: int) -> tuple[bytes, str] | None:
    with get_db() as cur:
        cur.execute("SELECT plik, plik_nazwa FROM health_dokumenty "
                    "WHERE id = %s AND household_id = %s AND plik IS NOT NULL",
                    (dokument_id, household_id))
        r = cur.fetchone()
        return (bytes(r["plik"]), r["plik_nazwa"] or "wynik.pdf") if r else None


# ── przebieg parametru w czasie ─────────────────────────────────────────────

def przebieg(household_id: int, osoba_id: int, nazwa: str) -> list[dict]:
    """Jeden parametr (np. TSH) w kolejnych badaniach — materiał na wykres.

    Wyniki z operatorem („<0,005") ZOSTAJĄ w odpowiedzi wraz z operatorem,
    żeby ekran mógł je narysować inaczej — jako punkt przy granicy, a nie jako
    zwykły pomiar. Wycięcie ich z wykresu ukryłoby najciekawsze przypadki,
    bo poza skalę wychodzą wyniki skrajne.
    """
    with get_db() as cur:
        cur.execute(
            "SELECT d.data_badania, d.placowka, w.wartosc_liczba, w.jednostka, "
            "       w.operator, w.norma_min, w.norma_max, w.flaga, w.metoda "
            "FROM health_wyniki w JOIN health_dokumenty d ON d.id = w.dokument_id "
            "WHERE d.household_id = %s AND d.osoba_id = %s AND NOT d.ukryty "
            "  AND lower(w.nazwa) = lower(%s) AND w.wartosc_liczba IS NOT NULL "
            "ORDER BY d.data_badania",
            (household_id, osoba_id, nazwa.strip()),
        )
        return [dict(r) for r in cur.fetchall()]


def nazwy_parametrow(household_id: int, osoba_id: int) -> list[dict]:
    """Które parametry mają co najmniej dwa pomiary — tylko te da się narysować."""
    with get_db() as cur:
        cur.execute(
            "SELECT w.nazwa, COUNT(*) AS ile FROM health_wyniki w "
            "JOIN health_dokumenty d ON d.id = w.dokument_id "
            "WHERE d.household_id = %s AND d.osoba_id = %s AND NOT d.ukryty "
            "  AND w.wartosc_liczba IS NOT NULL "
            "GROUP BY w.nazwa HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC, w.nazwa",
            (household_id, osoba_id),
        )
        return [dict(r) for r in cur.fetchall()]
