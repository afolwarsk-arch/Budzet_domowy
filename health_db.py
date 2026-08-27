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

# Rodzaje dokumentu — rozdzielone nie dla porządku, tylko dlatego, że sterują
# wyglądem ekranu: „lab" pokazuje tabelę wyników, „obrazowe" i „wizyta" pokazują
# prozę, a „skierowanie" i „recepta" wysuwają na wierzch kod i termin ważności,
# bo opisują coś, co ma się dopiero wydarzyć.
RODZAJE = ("lab", "obrazowe", "wizyta", "skierowanie", "recepta", "inne")

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

        # Kto przyjmował i w jakim trybie. Przy wizycie sama nazwa („Konsultacja")
        # nie mówi nic — a szuka się właśnie po specjalizacji („kiedy byliśmy
        # u neurologa?"). `specjalizacja` i `lekarz` to zwykły tekst przepisany
        # z pieczątki, bez słownika: specjalizacji jest kilkadziesiąt, lista
        # zawsze byłaby niepełna, a nietypowy przypadek lądowałby w „Inne”.
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS specjalizacja TEXT")
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS lekarz TEXT")
        # 'stacjonarna' albo 'zdalna'. Teleporada bywa niepodpisana inaczej niż
        # słowem w nagłówku, a po roku to jedyny ślad, że wizyty nie było na żywo.
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS forma TEXT")

        # ROZBICIE OPISU WIZYTY NA TRZY CZĘŚCI. Dokumenty same podają ten podział
        # nagłówkami („Wywiad lekarski", „Badanie przedmiotowe"), a sklejanie ich
        # w jedno pole kosztowało czytelność: w konsultacji telemedycznej realna
        # treść to cztery linijki, a resztę z tysiąca znaków zajmują standardowe
        # pouczenia o SOR-ze i numerze 112 — identyczne w każdej takiej wizycie.
        # `opis` ZOSTAJE i jest nadal używany przez badania obrazowe, gdzie cała
        # treść to jeden ciągły opis radiologa. Stare dokumenty mają wypełniony
        # tylko `opis` i tak zostanie — ekran czyta oba warianty.
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS wywiad TEXT")
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS badanie TEXT")
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS pouczenia TEXT")

        # ── skierowanie ─────────────────────────────────────────────────────
        # Skierowanie różni się od reszty tym, że opisuje coś, co ma się DOPIERO
        # WYDARZYĆ. Liczą się przy nim trzy rzeczy, których nie ma w wyniku:
        # czterocyfrowy kod e-skierowania (z nim rejestruje się wizytę),
        # termin ważności (część skierowań przepada po 30 dniach) i tryb —
        # „pilny" wobec „stabilny" ustawia kolejkę w przychodni.
        # Dokąd kieruje, mówi już istniejąca `specjalizacja`.
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS kod_eskierowania TEXT")
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS wazne_do DATE")
        cur.execute("ALTER TABLE health_dokumenty ADD COLUMN IF NOT EXISTS tryb TEXT")

        # ── leki ────────────────────────────────────────────────────────────
        # Osobna tabela, bo „co pan przyjmuje?" to pytanie padające przy każdej
        # wizycie, a odpowiedź na nie z pola tekstowego wymaga czytania prozy
        # z kilku dokumentów. Wiersz na lek daje ją jednym zapytaniem — i z czasem
        # historię: co brał, od kiedy, w jakiej dawce.
        cur.execute("""CREATE TABLE IF NOT EXISTS health_leki (
            id          SERIAL PRIMARY KEY,
            dokument_id INTEGER NOT NULL REFERENCES health_dokumenty(id) ON DELETE CASCADE,
            nazwa       TEXT NOT NULL,
            dawka       TEXT,
            dawkowanie  TEXT,
            odplatnosc  TEXT,
            kolejnosc   INTEGER NOT NULL DEFAULT 0
        )""")
        cur.execute("CREATE INDEX IF NOT EXISTS health_leki_dok "
                    "ON health_leki (dokument_id)")
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

        # ── problemy zdrowotne ──────────────────────────────────────────────
        # Wątek, który ciągnie się przez wiele dokumentów: „tarczyca",
        # „kręgosłup", „ciąża". Problem należy do OSOBY, nie do gospodarstwa —
        # tarczyca Adama i tarczyca Oli to dwie różne historie, które nigdy nie
        # powinny się zejść na jednej osi.
        cur.execute("""CREATE TABLE IF NOT EXISTS health_problemy (
            id           SERIAL PRIMARY KEY,
            household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
            osoba_id     INTEGER NOT NULL REFERENCES health_osoby(id) ON DELETE CASCADE,
            nazwa        TEXT NOT NULL,
            kolor        INTEGER NOT NULL DEFAULT 0,
            opis         TEXT,
            zamkniety    BOOLEAN NOT NULL DEFAULT FALSE,
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        cur.execute("CREATE INDEX IF NOT EXISTS health_probl_osoba "
                    "ON health_problemy (osoba_id)")
        # `kolor` to INDEKS w palecie (0–7), nie hex. Paleta ma osobne kroki dla
        # motywu jasnego i ciemnego, a kolejność slotów jest dobrana tak, żeby
        # sąsiednie były rozróżnialne przy daltonizmie — zapisany hex zamroziłby
        # jeden motyw i uniemożliwił poprawienie palety bez migracji danych.

        # Powiązanie wiele-do-wielu, a NIE kolumna `problem_id` w dokumencie:
        # jeden lipidogram służy naraz diabetologowi i kardiologowi, a wypis ze
        # szpitala potrafi dotyczyć trzech spraw. Kolumna kazałaby wybrać jedną
        # i zgubiłaby dokument przy filtrowaniu po pozostałych.
        cur.execute("""CREATE TABLE IF NOT EXISTS health_dokument_problemy (
            dokument_id INTEGER NOT NULL REFERENCES health_dokumenty(id) ON DELETE CASCADE,
            problem_id  INTEGER NOT NULL REFERENCES health_problemy(id) ON DELETE CASCADE,
            PRIMARY KEY (dokument_id, problem_id)
        )""")
        cur.execute("CREATE INDEX IF NOT EXISTS health_dokprob_problem "
                    "ON health_dokument_problemy (problem_id)")


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
# Prefiks `d.` jest obowiązkowy: lista dołącza tabelę osób, a `id` i `created_at`
# są w obu tabelach — bez niego zapytanie jest niejednoznaczne.
#
# Kolumn `plik` i `plik_nazwa` tu NIE MA i nie będzie: oryginały nie są nigdzie
# przechowywane (patrz `zapisz` w health.py), więc zawsze byłyby puste.
_POLA_DOK = """d.id, d.osoba_id, d.rodzaj, d.nazwa, d.data_badania, d.data_do,
               d.data_pobrania, d.placowka, d.opis, d.rozpoznanie, d.kod_icd10,
               d.zalecenia, d.numer_badania, d.data_nastepnego, d.kontekst,
               d.norma_wg, d.specjalizacja, d.lekarz, d.forma,
               d.wywiad, d.badanie, d.pouczenia,
               d.kod_eskierowania, d.wazne_do, d.tryb,
               d.ukryty, d.dodane_przez, d.created_at"""


# Problemy przypięte do dokumentu, jednym podzapytaniem zamiast pytania na
# każdy wiersz — oś czasu rysuje naraz całą historię, więc N+1 byłoby tu
# odczuwalne od pierwszego roku zbierania.
_PROBLEMY_DOK = """COALESCE((
        SELECT json_agg(json_build_object('id', p.id, 'nazwa', p.nazwa, 'kolor', p.kolor)
                        ORDER BY p.nazwa)
        FROM health_dokument_problemy dp
        JOIN health_problemy p ON p.id = dp.problem_id
        WHERE dp.dokument_id = d.id), '[]'::json) AS problemy"""


def _lista_filtra(wartosc) -> list[str] | None:
    """Wejście filtra → lista kluczy do porównania, albo None gdy pusto.

    Przyjmujemy i pojedynczy ciąg, i listę, bo ten sam filtr bywa wołany
    z jedną wartością (link, stary adres) i z kilkoma naraz (arkusz).
    """
    if wartosc is None:
        return None
    surowe = [wartosc] if isinstance(wartosc, str) else list(wartosc)
    klucze = [w.strip().lower() for w in surowe if w and w.strip()]
    return klucze or None


def dokumenty(household_id: int, osoba_id: int | None = None,
              rodzaj=None, problem_id: int | None = None,
              specjalizacja=None, lekarz=None, placowka=None) -> list[dict]:
    """Dokumenty do listy i do osi czasu.

    `osoba_id = None` znaczy „wszyscy domownicy" — oś czasu ma przełącznik
    i w trybie zbiorczym potrzebuje wiedzieć, czyj jest każdy wpis, stąd JOIN
    po imię.

    KAŻDY Z FILTROW PRZYJMUJE KILKA WARTOŚCI NARAZ i łączy je przez LUB.
    Powód jest w danych, nie w wygodzie: specjalizacja przepisywana z pieczątki
    rozpada się na warianty tego samego („stomatolog-chirurg", „chirurg
    stomatolog"), a scalanie ich automatycznie znaczyłoby zgadywanie, że to
    naprawdę to samo. Zamiast tego pozwalamy zaznaczyć oba warianty.

    Porównanie jest po DOKŁADNEJ wartości — listę wyboru budujemy z tego, co
    w bazie już jest (`wartosci_filtrow`) — ale nieczułe na wielkość liter
    i spacje brzegowe, bo nazwiska bywają przepisane raz wersalikami, raz nie.
    """
    specjalizacja = _lista_filtra(specjalizacja)
    lekarz = _lista_filtra(lekarz)
    placowka = _lista_filtra(placowka)
    rodzaj = _lista_filtra(rodzaj)
    with get_db() as cur:
        cur.execute(
            f"SELECT {_POLA_DOK}, o.imie AS osoba_imie, {_PROBLEMY_DOK}, "
            # Ile wyników w tym dokumencie miało flagę z laboratorium. Bez tego
            # każdy wpis na osi wygląda identycznie i trzeba wchodzić w każdy,
            # żeby się dowiedzieć, czy coś było nie tak. Liczymy FLAGI, nie
            # porównujemy z normą sami — ocena należy do laboratorium.
            "  (SELECT COUNT(*) FROM health_wyniki w "
            "   WHERE w.dokument_id = d.id AND w.flaga IS NOT NULL AND w.flaga <> '') AS ile_flag, "
            "  (SELECT COUNT(*) FROM health_wyniki w WHERE w.dokument_id = d.id) AS ile_wynikow "
            "FROM health_dokumenty d "
            "JOIN health_osoby o ON o.id = d.osoba_id "
            "WHERE d.household_id = %s AND NOT d.ukryty AND NOT o.ukryta "
            "  AND (%s::int IS NULL OR d.osoba_id = %s) "
            "  AND (%s::text[] IS NULL OR lower(btrim(d.rodzaj)) = ANY(%s)) "
            "  AND (%s::int IS NULL OR EXISTS (SELECT 1 FROM health_dokument_problemy f "
            "                                  WHERE f.dokument_id = d.id AND f.problem_id = %s)) "
            "  AND (%s::text[] IS NULL OR lower(btrim(d.specjalizacja)) = ANY(%s)) "
            "  AND (%s::text[] IS NULL OR lower(btrim(d.lekarz)) = ANY(%s)) "
            "  AND (%s::text[] IS NULL OR lower(btrim(d.placowka)) = ANY(%s)) "
            # Dokumenty bez daty badania (jeszcze nieuzupełnione) mają trafiać
            # na górę, a nie na sam koniec — NULLS FIRST przy malejącej dacie.
            "ORDER BY d.data_badania DESC NULLS FIRST, d.id DESC",
            (household_id, osoba_id, osoba_id, rodzaj, rodzaj, problem_id, problem_id,
             specjalizacja, specjalizacja, lekarz, lekarz, placowka, placowka),
        )
        return [dict(r) for r in cur.fetchall()]


def wartosci_filtrow(household_id: int, osoba_id: int | None = None,
                     problem_id: int | None = None, rodzaj=None,
                     specjalizacja=None, lekarz=None, placowka=None) -> dict:
    """Co da się wybrać w filtrach — z licznikami W KONTEKŚCIE reszty wyborów.

    LISTA WYBORU MUSI POCHODZIĆ Z DANYCH, nie ze słownika. Specjalizacja
    i lekarz są przepisywane z pieczątki, więc żadna z góry ustalona lista nie
    trafiłaby w to, co faktycznie leży w bazie tego gospodarstwa.

    LICZNIK KAŻDEGO POLA POMIJA FILTR TEGO SAMEGO POLA, a uwzględnia wszystkie
    pozostałe. Bez tego dawało się złożyć wybór sprzeczny („recepta" plus
    „radiolog") i dostać pustą oś bez wyjaśnienia. Pominięcie własnego pola jest
    konieczne, bo inaczej po zaznaczeniu jednego wariantu specjalizacji reszta
    wariantów pokazywałaby zero i nie dałoby się dobrać drugiego — a to jest
    właśnie powód, dla którego wybór jest wielokrotny.

    Wartości z zerem zostają na liście (wyszarzone po stronie interfejsu),
    zamiast znikać: znikające pozycje wyglądają jak błąd i nie widać, że wybór
    gdzie indziej właśnie je odciął.
    """
    f = {
        "rodzaj": _lista_filtra(rodzaj),
        "specjalizacja": _lista_filtra(specjalizacja),
        "lekarz": _lista_filtra(lekarz),
        "placowka": _lista_filtra(placowka),
    }

    def warunki_bez(pole: str):
        """Warunki i parametry wszystkich filtrów OPRÓCZ wskazanego pola."""
        czesci = ["d.household_id = %s", "NOT d.ukryty", "NOT o.ukryta",
                  "(%s::int IS NULL OR d.osoba_id = %s)"]
        p = [household_id, osoba_id, osoba_id]
        czesci.append("(%s::int IS NULL OR EXISTS (SELECT 1 FROM health_dokument_problemy dp2 "
                      "WHERE dp2.dokument_id = d.id AND dp2.problem_id = %s))")
        p += [problem_id, problem_id]
        for kol, wart in f.items():
            if kol == pole or not wart:
                continue
            czesci.append(f"(lower(btrim(d.{kol})) = ANY(%s))")
            p.append(wart)
        return " AND ".join(czesci), p

    def zbierz(kolumna: str) -> list[dict]:
        gdzie, p = warunki_bez(kolumna)
        with get_db() as cur:
            cur.execute(
                f"SELECT lower(btrim(d.{kolumna})) AS klucz, "
                f"       (array_agg(btrim(d.{kolumna}) ORDER BY btrim(d.{kolumna})))[1] AS nazwa, "
                "       COUNT(*) AS ile "
                "FROM health_dokumenty d "
                "JOIN health_osoby o ON o.id = d.osoba_id "
                f"WHERE {gdzie} "
                f"  AND d.{kolumna} IS NOT NULL AND btrim(d.{kolumna}) <> '' "
                "GROUP BY 1 ORDER BY 3 DESC, 2",
                p,
            )
            znalezione = [{"nazwa": r["nazwa"], "klucz": r["klucz"], "ile": r["ile"]}
                          for r in cur.fetchall()]
        return _dolacz_zerowe(kolumna, znalezione, f.get(kolumna), household_id, osoba_id)

    return {
        "rodzaje": zbierz("rodzaj"),
        "specjalizacje": zbierz("specjalizacja"),
        "lekarze": zbierz("lekarz"),
        "placowki": zbierz("placowka"),
    }


def _dolacz_zerowe(kolumna: str, znalezione: list[dict], wybrane, household_id: int,
                   osoba_id: int | None) -> list[dict]:
    """Dokłada wartości, których przy tym zestawie filtrów nie ma — z zerem.

    Lista skracająca się przy każdym kliknięciu wygląda jak znikające przyciski.
    Lepiej pokazać, że pozycja istnieje, ale w tym zestawieniu nic nie ma —
    interfejs wyszarza ją i nie da się jej kliknąć.
    """
    with get_db() as cur:
        cur.execute(
            f"SELECT lower(btrim(d.{kolumna})) AS klucz, "
            f"       (array_agg(btrim(d.{kolumna}) ORDER BY btrim(d.{kolumna})))[1] AS nazwa "
            "FROM health_dokumenty d JOIN health_osoby o ON o.id = d.osoba_id "
            "WHERE d.household_id = %s AND NOT d.ukryty AND NOT o.ukryta "
            f"  AND d.{kolumna} IS NOT NULL AND btrim(d.{kolumna}) <> '' "
            "  AND (%s::int IS NULL OR d.osoba_id = %s) "
            "GROUP BY 1 ORDER BY 2",
            (household_id, osoba_id, osoba_id),
        )
        wszystkie = [{"nazwa": r["nazwa"], "klucz": r["klucz"], "ile": 0} for r in cur.fetchall()]

    # Wszystko, czego nie było w wyniku, dochodzi z zerem — łącznie z wartościami
    # zaznaczonymi, które przy tym zestawie filtrów nic nie dają. Zaznaczone
    # MUSZĄ zostać na liście, inaczej nie dałoby się ich odznaczyć.
    mam = {w["klucz"] for w in znalezione}
    return znalezione + [w for w in wszystkie if w["klucz"] not in mam]


def slownik_gospodarstwa(household_id: int, limit: int = 40) -> dict:
    """Zapisy już używane w tym gospodarstwie — podpowiedź dla modelu przy odczycie.

    ZAPOBIEGA ROZJAZDOWI U ŹRÓDŁA. Bez tego każdy dokument opisuje tę samą
    przychodnię inaczej, bo adres na pieczątce stoi za każdym razem w innej
    kolejności — i po dwudziestu dokumentach filtr placówki ma dwadzieścia
    pozycji zamiast dziesięciu. Model, który widzi listę wcześniejszych zapisów,
    trafia w istniejący zamiast tworzyć dwudziesty pierwszy.

    Ograniczone do `limit` najczęstszych: lista ma być podpowiedzią w prompcie,
    a nie wyciągiem z bazy — przy stu placówkach koszt zapytania rósłby bez
    pożytku, bo i tak liczą się te, do których się wraca.
    """
    def zbierz(kolumna: str) -> list[str]:
        with get_db() as cur:
            cur.execute(
                f"SELECT (array_agg(btrim(d.{kolumna}) ORDER BY btrim(d.{kolumna})))[1] AS nazwa "
                "FROM health_dokumenty d "
                "WHERE d.household_id = %s AND NOT d.ukryty "
                f"  AND d.{kolumna} IS NOT NULL AND btrim(d.{kolumna}) <> '' "
                f"GROUP BY lower(btrim(d.{kolumna})) "
                "ORDER BY COUNT(*) DESC LIMIT %s",
                (household_id, limit),
            )
            return [r["nazwa"] for r in cur.fetchall()]

    return {
        "placowki": zbierz("placowka"),
        "lekarze": zbierz("lekarz"),
        "specjalizacje": zbierz("specjalizacja"),
    }


SCALALNE = ("specjalizacja", "lekarz", "placowka")


def scal_wartosci(household_id: int, pole: str, warianty: list[str], na: str,
                  gdzie_lekarz: str | None = None) -> int:
    """Zamienia kilka zapisów tej samej rzeczy na jeden. Zwraca liczbę zmian.

    POTRZEBNE, BO DANE POCHODZĄ Z PIECZĄTEK. Ta sama przychodnia bywa zapisana
    na pięć sposobów, bo adres na każdym dokumencie stoi w innej kolejności.
    Scalanie automatyczne odrzucone: to zgadywanie, że dwa różne zapisy
    naprawdę znaczą to samo — decyzję podejmuje człowiek, funkcja ją wykonuje.

    Dopasowanie po zapisie sprowadzonym do małych liter bez spacji brzegowych,
    czyli tak samo jak w filtrach — inaczej wariant różniący się wielkością
    litery przetrwałby scalanie i wróciłby na listę.
    """
    if pole not in SCALALNE:
        raise ValueError(f"Nie scalam pola {pole}.")
    klucze = [w.strip().lower() for w in warianty if w and w.strip()]
    if not klucze or not (na or "").strip():
        return 0
    # Zawężenie do jednego lekarza: ten sam zapis specjalizacji bywa poprawny
    # u jednej osoby i błędny u drugiej. „Stomatolog" przy chirurgu stomatologu
    # trzeba poprawić, ale przy stomatologu zachowawczym już nie.
    warunek_lekarz = ""
    p = [na.strip(), household_id, klucze]
    if gdzie_lekarz and gdzie_lekarz.strip():
        warunek_lekarz = " AND lower(btrim(lekarz)) = %s"
        p.append(gdzie_lekarz.strip().lower())
    with get_db() as cur:
        cur.execute(
            f"UPDATE health_dokumenty SET {pole} = %s "
            f"WHERE household_id = %s AND lower(btrim({pole})) = ANY(%s){warunek_lekarz}",
            p,
        )
        return cur.rowcount


def dokument(household_id: int, dokument_id: int) -> dict | None:
    """Dokument razem z wynikami — ekran szczegółów potrzebuje obu naraz."""
    with get_db() as cur:
        cur.execute(
            f"SELECT {_POLA_DOK}, {_PROBLEMY_DOK} FROM health_dokumenty d "
            "WHERE d.id = %s AND d.household_id = %s",
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
        cur.execute(
            "SELECT id, nazwa, dawka, dawkowanie, odplatnosc FROM health_leki "
            "WHERE dokument_id = %s ORDER BY kolejnosc, id",
            (dokument_id,),
        )
        d["leki"] = [dict(l) for l in cur.fetchall()]
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
                numer_badania, data_nastepnego, kontekst, norma_wg,
                specjalizacja, lekarz, forma, wywiad, badanie, pouczenia,
                kod_eskierowania, wazne_do, tryb, dodane_przez)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                       %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (household_id, osoba_id,
             dane.get("rodzaj") or "lab",
             (dane.get("nazwa") or "Badanie").strip(),
             dane.get("data_badania"), dane.get("data_do"), dane.get("data_pobrania"),
             dane.get("placowka"), dane.get("opis"), dane.get("rozpoznanie"),
             dane.get("kod_icd10"), dane.get("zalecenia"), dane.get("numer_badania"),
             dane.get("data_nastepnego"), dane.get("kontekst"), dane.get("norma_wg"),
             dane.get("specjalizacja"), dane.get("lekarz"), dane.get("forma"),
             dane.get("wywiad"), dane.get("badanie"), dane.get("pouczenia"),
             dane.get("kod_eskierowania"), dane.get("wazne_do"), dane.get("tryb"),
             dodane_przez),
        )
        dok_id = cur.fetchone()["id"]
        for i, w in enumerate(wyniki or []):
            _wstaw_wynik(cur, dok_id, w, i)
        for i, l in enumerate(dane.get("leki") or []):
            nazwa = (l.get("nazwa") or "").strip()
            if not nazwa:
                continue          # lek bez nazwy to nie lek, tylko szum z odczytu
            cur.execute(
                "INSERT INTO health_leki (dokument_id, nazwa, dawka, dawkowanie, "
                "odplatnosc, kolejnosc) VALUES (%s, %s, %s, %s, %s, %s)",
                (dok_id, nazwa, l.get("dawka"), l.get("dawkowanie"),
                 l.get("odplatnosc"), i),
            )
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


# ── edycja nagłówka ─────────────────────────────────────────────────────────
# Zmieniamy WYŁĄCZNIE opis dokumentu, nigdy wyników. Wynik jest przepisany
# z papieru i ma zostać taki, jaki wydało laboratorium — poprawianie liczb
# po fakcie zatarłoby różnicę między tym, co zmierzono, a tym, co ktoś pamięta.
# Nagłówek to co innego: specjalizacji i nazwiska lekarza często nie ma na
# skierowaniu, a dopisuje się je z pamięci tydzień później.
_POLA_EDYCJI = ("nazwa", "data_badania", "data_do", "placowka", "specjalizacja",
                "lekarz", "forma", "rozpoznanie", "kod_icd10", "zalecenia",
                "data_nastepnego", "kontekst", "wywiad", "badanie", "pouczenia",
                "kod_eskierowania", "wazne_do", "tryb")


def edytuj_dokument(household_id: int, dokument_id: int, dane: dict) -> bool:
    """Aktualizuje tylko te pola nagłówka, które faktycznie przyszły w żądaniu.

    Budujemy zapytanie z białej listy `_POLA_EDYCJI`, więc nazwa kolumny nigdy
    nie pochodzi od użytkownika — wartości i tak idą parametrami.
    """
    ustaw, wartosci = [], []
    for pole in _POLA_EDYCJI:
        if pole in dane:
            wartosc = dane[pole]
            if isinstance(wartosc, str):
                wartosc = wartosc.strip() or None
            # Nazwa jest wymagana przez schemat — pusta zostawia poprzednią.
            if pole == "nazwa" and not wartosc:
                continue
            ustaw.append(f"{pole} = %s")
            wartosci.append(wartosc)
    if not ustaw:
        return False
    with get_db() as cur:
        cur.execute(f"UPDATE health_dokumenty SET {', '.join(ustaw)} "
                    "WHERE id = %s AND household_id = %s",
                    (*wartosci, dokument_id, household_id))
        return cur.rowcount > 0


def usun_dokument(household_id: int, dokument_id: int) -> bool:
    with get_db() as cur:
        cur.execute("DELETE FROM health_dokumenty WHERE id = %s AND household_id = %s",
                    (dokument_id, household_id))
        return cur.rowcount > 0


# ── problemy zdrowotne ──────────────────────────────────────────────────────

def problemy(household_id: int, osoba_id: int | None = None) -> list[dict]:
    """Problemy z licznikiem dokumentów — filtr bez liczby jest ślepy.

    Pokazujemy też problemy z zerem wpisów: dopiero co założony problem musi
    być widoczny, żeby dało się do niego cokolwiek przypiąć.
    """
    with get_db() as cur:
        cur.execute(
            "SELECT p.id, p.osoba_id, p.nazwa, p.kolor, p.opis, p.zamkniety, "
            "       o.imie AS osoba_imie, "
            "       (SELECT COUNT(*) FROM health_dokument_problemy dp "
            "        WHERE dp.problem_id = p.id) AS ile "
            "FROM health_problemy p "
            "JOIN health_osoby o ON o.id = p.osoba_id "
            "WHERE p.household_id = %s AND (%s::int IS NULL OR p.osoba_id = %s) "
            "ORDER BY p.zamkniety, p.nazwa",
            (household_id, osoba_id, osoba_id),
        )
        return [dict(r) for r in cur.fetchall()]


def dodaj_problem(household_id: int, osoba_id: int, nazwa: str,
                  kolor: int = 0, opis: str | None = None) -> int:
    with get_db() as cur:
        cur.execute(
            "INSERT INTO health_problemy (household_id, osoba_id, nazwa, kolor, opis) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (household_id, osoba_id, nazwa.strip(), kolor, opis or None),
        )
        return cur.fetchone()["id"]


def edytuj_problem(household_id: int, problem_id: int, nazwa: str, kolor: int,
                   opis: str | None, zamkniety: bool) -> bool:
    with get_db() as cur:
        cur.execute(
            "UPDATE health_problemy SET nazwa=%s, kolor=%s, opis=%s, zamkniety=%s "
            "WHERE id=%s AND household_id=%s",
            (nazwa.strip(), kolor, opis or None, zamkniety, problem_id, household_id),
        )
        return cur.rowcount > 0


def usun_problem(household_id: int, problem_id: int) -> bool:
    """Usuwa sam problem. Dokumenty ZOSTAJĄ — kasujemy etykietę, nie historię
    leczenia; powiązania znikają kaskadą z tabeli łączącej."""
    with get_db() as cur:
        cur.execute("DELETE FROM health_problemy WHERE id=%s AND household_id=%s",
                    (problem_id, household_id))
        return cur.rowcount > 0


def ustaw_problemy_dokumentu(household_id: int, dokument_id: int,
                             problem_ids: list[int]) -> bool:
    """Podmienia CAŁY zestaw problemów dokumentu na podany.

    Podmiana zamiast dokładania, bo ekran wysyła stan wszystkich pól naraz —
    dokładanie nie pozwoliłoby nigdy odpiąć problemu. Filtr po `household_id`
    przy wstawianiu jest po to, żeby nie dało się przypiąć cudzego problemu
    przez spreparowane żądanie.
    """
    with get_db() as cur:
        cur.execute("SELECT id FROM health_dokumenty WHERE id=%s AND household_id=%s",
                    (dokument_id, household_id))
        if not cur.fetchone():
            return False
        cur.execute("DELETE FROM health_dokument_problemy WHERE dokument_id=%s",
                    (dokument_id,))
        for pid in dict.fromkeys(problem_ids or []):
            cur.execute(
                "INSERT INTO health_dokument_problemy (dokument_id, problem_id) "
                "SELECT %s, id FROM health_problemy WHERE id=%s AND household_id=%s",
                (dokument_id, pid, household_id),
            )
        return True


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
