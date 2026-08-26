// Ekran badań i dokumentacji — wiem.health.
//
// Cztery widoki w jednym pliku, przełączane stanem: OŚ CZASU (ekran główny),
// podgląd świeżo odczytanego dokumentu przed zapisem, szczegóły zapisanego
// i zarządzanie problemami zdrowotnymi.
//
// Oś zastąpiła zwykłą listę, bo dokumentacja medyczna czyta się w czasie:
// pytanie brzmi „co się ze mną działo", a nie „co mam w kartotece". Odstępy są
// proporcjonalne do upływu czasu, więc widać rytm — zagęszczenie przy chorobie
// i ciszę przy zdrowiu.
//
// PODGLĄD PRZED ZAPISEM NIE JEST WYGODĄ, TYLKO WARUNKIEM. Model przepisuje
// wynik z papieru i robi to dobrze, ale wynik zapisany błędnie i niezauważony
// jest gorszy niż brak wyniku — bo za pół roku nikt nie będzie pamiętał, że
// tej liczby nie sprawdzał. Dlatego /odczytaj nic nie zapisuje, a zapis idzie
// osobnym żądaniem dopiero po obejrzeniu.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const RODZAJE = {
  lab: 'Wynik badania',
  obrazowe: 'Badanie obrazowe',
  wizyta: 'Wizyta',
  skierowanie: 'Skierowanie',
  inne: 'Inne',
};

let osoby = [];
// Trzy stany, nie dwa: `undefined` = jeszcze nie wybrano (bierzemy pierwszą
// osobę), `null` = świadomie wybrano „Wszyscy", liczba = konkretna osoba. Bez
// tego rozróżnienia wybór „Wszyscy" byłby nadpisywany przy każdym wczytaniu.
let osobaId;
let problemy = [];
let problemId = null;     // null = bez filtrowania po problemie
let widok = 'os';         // os | podglad | szczegoly | problemy
let odczyt = null;        // { dokument } — czeka na zapis
// Problemy zaznaczone na ekranie podglądu, jeszcze przed zapisem dokumentu.
// Trzymamy je osobno, bo dokument nie ma jeszcze identyfikatora — przypięcie
// idzie drugim żądaniem, zaraz po zapisie.
let wybraneProblemy = new Set();
// Strony bieżącego odczytu — obiekty File, wyłącznie w pamięci karty. Trzymamy
// je do czasu zapisu TYLKO po to, żeby dało się dołożyć kolejną kartkę i
// przeczytać komplet od nowa; do bazy nie idzie żaden oryginał (patrz `zapisz`
// w health.py), więc po zapisie lista leci do kosza.
let strony = [];
let szczegoly = null;

// Ile pikseli dostaje jeden dzień. Suwak zmienia GĘSTOŚĆ osi, nigdy zakres —
// oś zawsze pokazuje całą historię, bo jej sensem jest widzieć całość naraz.
const SKALE = [
  { px: 0.22, opis: 'cała historia' },
  { px: 1.1,  opis: 'rok' },
  { px: 4.5,  opis: 'kwartał' },
];
let skala = 1;

// Odstęp nigdy nie spada poniżej MIN (karty by na siebie nachodziły) ani nie
// przekracza MAX (czteroletnia przerwa dałaby ekran pustki, przez który trzeba
// przewijać). Proporcjonalność działa więc w środku zakresu — a że skrajności
// są przycięte, przerwę nazywamy słowami, żeby informacja nie ginęła.
const ODSTEP_MIN = 10;
const ODSTEP_MAX = 210;
const CISZA_OD = 64;      // od tylu pikseli podpisujemy przerwę

const box = () => document.getElementById('tresc');

// „1 strona", „2 strony", „5 stron" — polska odmiana po liczbie, z wyjątkiem
// nastek (12 stron, nie 12 strony).
function stronyOpis(n) {
  const j = n % 10, d = n % 100;
  if (n === 1) return '1 strona';
  return `${n} ${j >= 2 && j <= 4 && (d < 12 || d > 14) ? 'strony' : 'stron'}`;
}

function dataPl(iso) {
  if (!iso) return '—';
  const [r, m, d] = String(iso).slice(0, 10).split('-');
  return d && m && r ? `${d}.${m}.${r}` : iso;
}

// Wartość wyniku razem z operatorem. „<0,005" musi zostać „<0,005" — sama
// liczba 0,005 znaczy co innego niż „mniej niż 0,005".
function wartosc(w) {
  if (w.wartosc_liczba != null) {
    const liczba = String(w.wartosc_liczba).replace(/\.?0+$/, '').replace('.', ',');
    return (w.operator || '') + liczba + (w.jednostka ? ' ' + esc(w.jednostka) : '');
  }
  return esc(w.wartosc_tekst || '—');
}

function norma(w) {
  if (w.norma_min != null && w.norma_max != null) {
    return `${String(w.norma_min).replace('.', ',')} – ${String(w.norma_max).replace('.', ',')}`;
  }
  if (w.norma_tekst) return esc(w.norma_tekst);
  if (w.norma_min != null) return '≥ ' + String(w.norma_min).replace('.', ',');
  if (w.norma_max != null) return '≤ ' + String(w.norma_max).replace('.', ',');
  return '';
}

// ── wczytanie ───────────────────────────────────────────────────────────────

async function wczytajOsoby() {
  const r = await authFetch('/api/health/osoby');
  if (!r.ok) throw new Error('osoby');
  osoby = (await r.json()).osoby || [];
  if (osobaId === undefined) {
    osobaId = osoby.length ? osoby[0].id : null;     // pierwsze wejście
  } else if (osobaId !== null && !osoby.some((o) => o.id === osobaId)) {
    osobaId = osoby.length ? osoby[0].id : null;     // wskazana osoba zniknęła
  }
}

async function rysuj() {
  if (widok === 'podglad') return rysujPodglad();
  if (widok === 'szczegoly') return rysujSzczegoly();
  if (widok === 'problemy') return rysujProblemy();
  if (widok === 'przebieg') return rysujPrzebieg();
  return rysujOs();
}

// ── oś czasu ────────────────────────────────────────────────────────────────

const dni = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);

// Polska odmiana przez liczbę: 1 rok, 2–4 lata, 5+ lat — z wyjątkiem 12–14,
// które mimo końcówki 2–4 biorą formę mnogą („13 lat", nie „13 lata").
function odmien(n, poj, kilka, wiele) {
  if (n === 1) return poj;
  const r10 = n % 10, r100 = n % 100;
  return (r10 >= 2 && r10 <= 4 && !(r100 >= 12 && r100 <= 14)) ? kilka : wiele;
}

function opiszPrzerwe(d) {
  if (d >= 365) {
    const l = Math.round(d / 365);
    return `${l} ${odmien(l, 'rok', 'lata', 'lat')} przerwy`;
  }
  if (d >= 60) {
    const m = Math.round(d / 30);
    return `${m} ${odmien(m, 'miesiąc', 'miesiące', 'miesięcy')} przerwy`;
  }
  const dn = Math.round(d);
  return `${dn} ${odmien(dn, 'dzień', 'dni', 'dni')} przerwy`;
}

// Kolor bierzemy z PIERWSZEGO problemu dokumentu. Dokument bywa przypięty do
// kilku spraw naraz, ale kropka jest jedna — pozostałe problemy i tak są
// wypisane etykietami pod spodem, więc nic nie ginie.
const kolorWpisu = (d) => (d.problemy && d.problemy.length)
  ? `var(--pr-${d.problemy[0].kolor % 8})` : null;

function etykietyProblemow(d) {
  return (d.problemy || []).map((p) => `<span class="etykieta-pr">
      <span class="kropka-pr" style="background: var(--pr-${p.kolor % 8})"></span>${esc(p.nazwa)}
    </span>`).join('');
}

function wpisOsi(d, poprzedni) {
  const kolor = kolorWpisu(d);
  let odstep = ODSTEP_MIN;
  let cisza = '';
  if (poprzedni && d.data_badania && poprzedni.data_badania) {
    const roznica = dni(poprzedni.data_badania, d.data_badania);
    odstep = Math.min(ODSTEP_MAX, Math.max(ODSTEP_MIN, roznica * SKALE[skala].px));
    if (odstep >= CISZA_OD) {
      cisza = `<div class="os-cisza" style="margin-top:${Math.round(odstep / 2 - 8)}px">
                 ${opiszPrzerwe(roznica)}</div>`;
      odstep = Math.round(odstep / 2);
    }
  }
  // Każdy element osobnym <span>, żeby rozdzielił je `gap` kontenera. Wpisane
  // obok siebie w jednym tekście sklejają się w „8 wyników Diagnostyka".
  const flagi = Number(d.ile_flag) > 0
    ? `<span class="poza-norma">${d.ile_flag} poza normą</span>` : '';
  const ile = Number(d.ile_wynikow);
  const wynikow = ile > 0
    ? `<span>${ile} ${odmien(ile, 'wynik', 'wyniki', 'wyników')}</span>` : '';

  return cisza + `
    <button class="os-wpis${kolor ? ' ma-problem' : ''}" type="button" data-dok="${d.id}"
            style="margin-top:${Math.round(odstep)}px${kolor ? `; --pr-akt:${kolor}` : ''}">
      <div class="os-gl">
        <span class="os-nazwa">${esc(d.nazwa)}</span>
        <span class="os-data">${dataPl(d.data_badania)}</span>
      </div>
      ${opisWizyty(d) ? `<div class="os-kto">${opisWizyty(d)}</div>` : ''}
      <div class="os-pod">
        ${osobaId === null ? `<span class="os-osoba">${esc(d.osoba_imie || '')}</span>` : ''}
        <span class="znacznik">${esc(RODZAJE[d.rodzaj] || d.rodzaj)}</span>
        ${etykietyProblemow(d)}
        ${flagi}${wynikow}
        ${d.placowka ? `<span>${esc(d.placowka)}</span>` : ''}
      </div>
    </button>`;
}

function budujOs(dokumenty) {
  if (!dokumenty.length) {
    return `<div class="pusto">Nic tu jeszcze nie ma.<br>
      Zrób zdjęcie wyniku albo wgraj PDF — pojawi się na osi.</div>`;
  }
  let rok = null;
  let poprzedni = null;
  const czesci = [];
  for (const d of dokumenty) {
    const r = (d.data_badania || '').slice(0, 4);
    if (r && r !== rok) {
      rok = r;
      czesci.push(`<div class="os-rok" style="margin-top:${poprzedni ? 22 : 0}px">${r}</div>`);
      poprzedni = null;   // po nagłówku roku odstęp liczymy od zera
    }
    czesci.push(wpisOsi(d, poprzedni));
    poprzedni = d;
  }
  return `<div class="os">${czesci.join('')}</div>`;
}

async function rysujOs() {
  box().innerHTML = '<div class="laduje">Wczytuję…</div>';
  try {
    await wczytajOsoby();
  } catch {
    box().innerHTML = '<div class="blad">Nie udało się wczytać listy osób.</div>';
    return;
  }
  if (!osoby.length) return rysujPierwszaOsoba();

  await wczytajProblemy();
  let dokumenty = [];
  try {
    const q = new URLSearchParams();
    if (osobaId !== null) q.set('osoba_id', osobaId);
    if (problemId !== null) q.set('problem_id', problemId);
    const r = await authFetch('/api/health/dokumenty?' + q);
    if (r.ok) dokumenty = (await r.json()).dokumenty || [];
  } catch { /* pusta oś jest poprawnym stanem */ }

  box().innerHTML = `
    <div class="gora"><h1>Historia zdrowia</h1></div>
    <div class="narzedzia">
      <div class="filtry" id="f-osoby">
        <button class="chip" type="button" data-os="wszyscy" aria-pressed="${osobaId === null}">Wszyscy</button>
        ${osoby.map((o) => `<button class="chip" type="button" data-os="${o.id}"
            aria-pressed="${o.id === osobaId}">${esc(o.imie)}</button>`).join('')}
        <button class="chip dodaj" type="button" data-os="nowa">+ Osoba</button>
      </div>
      <div class="filtry" id="f-problemy">
        <button class="chip" type="button" data-pr="wszystkie" aria-pressed="${problemId === null}">Wszystko</button>
        ${problemy.map((p) => `<button class="chip" type="button" data-pr="${p.id}"
            aria-pressed="${p.id === problemId}">
            <span class="kropka-pr" style="background: var(--pr-${p.kolor % 8})"></span>${esc(p.nazwa)}
            <span class="os-data">${p.ile}</span></button>`).join('')}
        <button class="chip dodaj" type="button" data-pr="zarzadzaj">Problemy…</button>
        <button class="chip dodaj" type="button" id="do-przebiegu">Przebieg…</button>
      </div>
      <div class="skala">
        <span>gęstość</span>
        <input type="range" id="suwak" min="0" max="2" step="1" value="${skala}"
               aria-label="Gęstość osi czasu">
        <span id="skala-opis">${SKALE[skala].opis}</span>
      </div>
    </div>
    <div class="wejscia">
      <button class="wejscie" type="button" id="w-zdjecie">
        <svg viewBox="0 0 24 24"><path d="M3.5 8.5h3.2l1.5-2.4h7.6l1.5 2.4h3.2v10.5H3.5z"/><circle cx="12" cy="13.4" r="3.4"/></svg>
        <b>Zdjęcie</b><span>Papierowy wynik albo karta wizyty</span>
      </button>
      <button class="wejscie" type="button" id="w-pdf">
        <svg viewBox="0 0 24 24"><path d="M6 3.5h7.5L19 9v11.5H6z"/><path d="M13.2 3.6V9H19"/></svg>
        <b>PDF</b><span>Wynik z laboratorium — czyta się dokładniej</span>
      </button>
      <input type="file" id="plik-zdjecie" accept="image/*" capture="environment" multiple>
      <input type="file" id="plik-pdf" accept="application/pdf,image/*" multiple>
    </div>
    ${budujOs(dokumenty)}`;

  document.getElementById('f-osoby').onclick = (ev) => {
    const b = ev.target.closest('[data-os]');
    if (!b) return;
    const v = b.dataset.os;
    if (v === 'nowa') return rysujPierwszaOsoba();
    osobaId = v === 'wszyscy' ? null : Number(v);
    // Problem należy do osoby — po zmianie osoby stary filtr nie ma sensu.
    problemId = null;
    rysuj();
  };
  document.getElementById('do-przebiegu').onclick = () => { widok = 'przebieg'; rysuj(); };
  document.getElementById('f-problemy').onclick = (ev) => {
    const b = ev.target.closest('[data-pr]');
    if (!b) return;
    const v = b.dataset.pr;
    if (v === 'zarzadzaj') { widok = 'problemy'; return rysuj(); }
    problemId = v === 'wszystkie' ? null : Number(v);
    rysuj();
  };
  // Przerysowujemy tylko oś — pobieranie danych przy każdym drgnięciu suwaka
  // byłoby żądaniem na każdy krok, a dane się przecież nie zmieniają.
  document.getElementById('suwak').oninput = (ev) => {
    skala = Number(ev.target.value);
    document.getElementById('skala-opis').textContent = SKALE[skala].opis;
    const stara = document.querySelector('.os');
    if (stara) stara.outerHTML = budujOs(dokumenty);
    podepnijOtwieranie();
  };

  document.getElementById('w-zdjecie').onclick = () => document.getElementById('plik-zdjecie').click();
  document.getElementById('w-pdf').onclick = () => document.getElementById('plik-pdf').click();
  ['plik-zdjecie', 'plik-pdf'].forEach((id) => {
    document.getElementById(id).onchange = (ev) => {
      const wybrane = Array.from(ev.target.files || []);
      ev.target.value = '';
      // Aparat na telefonie oddaje jedno zdjęcie naraz mimo `multiple` — drugą
      // kartkę dokłada się na ekranie podglądu, po odczytaniu pierwszej.
      if (wybrane.length) { strony = wybrane; odczytaj(); }
    };
  });
  podepnijOtwieranie();
}

function podepnijOtwieranie() {
  const os = document.querySelector('.os');
  if (os) os.onclick = (ev) => {
    const b = ev.target.closest('[data-dok]');
    if (b) otworzDokument(Number(b.dataset.dok));
  };
}

async function wczytajProblemy() {
  try {
    const q = osobaId !== null ? '?osoba_id=' + osobaId : '';
    const r = await authFetch('/api/health/problemy' + q);
    problemy = r.ok ? ((await r.json()).problemy || []) : [];
  } catch { problemy = []; }
  if (problemId !== null && !problemy.some((p) => p.id === problemId)) problemId = null;
}

// ── widok: lista ────────────────────────────────────────────────────────────

function rysujPierwszaOsoba() {
  box().innerHTML = `<div class="gora"><h1>Historia zdrowia</h1></div>
    <div class="karta">
      <h2>Zacznij od osoby</h2>
      <p class="uwaga">Wyniki zapisujemy przy konkretnej osobie — także takiej, która
      nie ma konta w aplikacji. Data urodzenia jest nieobowiązkowa, ale przy wynikach
      dziecka pozwala odczytać normę właściwą dla wieku w dniu badania.</p>
      <div class="pole" style="margin-top:12px">
        <label for="n-imie">Imię</label>
        <input id="n-imie" autocomplete="off" placeholder="np. Zosia">
      </div>
      <div class="pole">
        <label for="n-ur">Data urodzenia</label>
        <input id="n-ur" type="date">
      </div>
      <div class="akcje">
        ${osoby.length ? '<button class="btn btn-outline" id="n-anuluj">Wróć</button>' : ''}
        <button class="btn btn-primary" id="n-zapisz">Dodaj osobę</button>
      </div>
    </div>`;
  document.getElementById('n-zapisz').onclick = zapiszOsobe;
  const anuluj = document.getElementById('n-anuluj');
  if (anuluj) anuluj.onclick = () => rysuj();
}

// Gest MUSI trafić w to samo pole, które otwieramy — inaczej przeglądarka
// telefonu uznaje otwarcie aparatu za niewywołane przez użytkownika. Dlatego
// przyciski „Zdjęcie"/„PDF" klikają input, zamiast otwierać go po asynchronicznym
// pobraniu czegokolwiek.

async function zapiszOsobe() {
  const imie = document.getElementById('n-imie').value.trim();
  if (!imie) { document.getElementById('n-imie').focus(); return; }
  const btn = document.getElementById('n-zapisz');
  btn.disabled = true;
  try {
    const r = await authFetch('/api/health/osoby', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imie, data_urodzenia: document.getElementById('n-ur').value || null }),
    });
    if (!r.ok) throw new Error();
    osobaId = (await r.json()).id;
    rysuj();
  } catch {
    btn.disabled = false;
    alert('Nie udało się dodać osoby.');
  }
}

// ── odczyt ──────────────────────────────────────────────────────────────────

// Czyta CAŁY komplet `strony` — także przy dokładaniu kartki. Odczyt strony 2
// w oderwaniu od pierwszej dawałby wyniki bez nazwy badania i bez daty, a
// urwaną w połowie tabelę trzeba widzieć z obu stron naraz, żeby ją skleić.
async function odczytaj() {
  const ile = strony.length;
  box().innerHTML = `<div class="czekaj">
      <div class="czekaj-znak"><i></i><i></i></div>
      <b>Czytam dokument…</b>
      <span>${ile > 1 ? `Składam ${stronyOpis(ile)} w jedno badanie. ` : ''}Przepisuję wyniki,
      normy i oznaczenia. Zaraz pokażę je do sprawdzenia — nic nie zapisuję bez twojej zgody.</span>
    </div>`;

  const fd = new FormData();
  strony.forEach((p) => fd.append('pliki', p));
  try {
    const r = await authFetch('/api/health/odczytaj', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || 'Nie udało się odczytać.');
    odczyt = d;
    widok = 'podglad';
    rysuj();
  } catch (e) {
    box().innerHTML = `<div class="blad">${esc(e.message || 'Nie udało się odczytać dokumentu.')}</div>`;
    const wroc = document.createElement('button');
    wroc.className = 'wroc';
    wroc.textContent = '← Wróć';
    wroc.onclick = () => { strony = []; widok = 'os'; rysuj(); };
    box().prepend(wroc);
  }
}

// ── wizyta: kto przyjmował ──────────────────────────────────────────────────
//
// Przy wizycie sama nazwa („Konsultacja") nie mówi nic, a po pół roku szuka się
// właśnie po specjaliście: „kiedy byliśmy u neurologa?". Specjalizacja i lekarz
// to zwykły tekst z pieczątki — bez słownika, bo specjalizacji są dziesiątki
// i lista zawsze byłaby niepełna.

const FORMY = { stacjonarna: 'wizyta w gabinecie', zdalna: 'teleporada' };

function blokWizyty(d) {
  // Pokazujemy przy wizycie, a przy innych rodzajach tylko wtedy, gdy coś już
  // jest wpisane — pola „specjalista" przy morfologii byłyby hałasem.
  const widoczny = d.rodzaj === 'wizyta' || d.specjalizacja || d.lekarz || d.forma;
  return `
    <div id="p-wizyta" style="${widoczny ? '' : 'display:none'}">
      <div class="pola-2">
        <div class="pole">
          <label for="p-spec">Specjalista</label>
          <input id="p-spec" list="lista-spec" autocomplete="off"
                 placeholder="np. stomatolog" value="${esc(d.specjalizacja || '')}">
          <datalist id="lista-spec">
            ${SPECJALIZACJE.map((s) => `<option value="${esc(s)}">`).join('')}
          </datalist>
        </div>
        <div class="pole">
          <label for="p-forma">Forma</label>
          <select id="p-forma">
            <option value="">—</option>
            ${Object.entries(FORMY).map(([k, v]) =>
              `<option value="${k}"${k === d.forma ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="pole">
        <label for="p-lekarz">Lekarz</label>
        <input id="p-lekarz" autocomplete="off" placeholder="imię i nazwisko"
               value="${esc(d.lekarz || '')}">
      </div>
    </div>`;
}

// Podpowiedzi, nie słownik: pole zostaje otwarte, a lista tylko skraca pisanie
// tego, co powtarza się najczęściej.
const SPECJALIZACJE = ['stomatolog', 'lekarz rodzinny', 'pediatra', 'ginekolog',
  'dermatolog', 'neurolog', 'ortopeda', 'okulista', 'laryngolog', 'kardiolog',
  'endokrynolog', 'psychiatra', 'fizjoterapeuta'];

function daneWizyty() {
  const w = (id) => {
    const el = document.getElementById(id);
    return el && el.value.trim() ? el.value.trim() : null;
  };
  return { specjalizacja: w('p-spec'), lekarz: w('p-lekarz'), forma: w('p-forma') };
}

// Opis wizyty jedną linią — na oś czasu i do nagłówka szczegółów.
function opisWizyty(d) {
  return [d.specjalizacja, d.lekarz, FORMY[d.forma]].filter(Boolean).map(esc).join(' · ');
}

// ── treść dokumentu ─────────────────────────────────────────────────────────
//
// Jedna funkcja na dwa ekrany: podgląd przed zapisem i szczegóły zapisanego.
// Wcześniej były to dwa niemal identyczne kawałki szablonu i rozjeżdżały się
// przy każdej zmianie.
//
// KOLEJNOŚĆ NIE JEST PRZYPADKOWA: najpierw leki i rozpoznanie (po to się tu
// wraca), potem wywiad i badanie, na końcu pouczenia — standardowe formuły
// o SOR-ze i numerze 112, identyczne na każdej karcie teleporady. Są zwinięte,
// bo w konsultacji potrafią zająć trzy czwarte tekstu i przykryć te cztery
// linijki, które naprawdę dotyczą pacjenta.

function karta(tytul, tresc, klasa) {
  if (!tresc) return '';
  return `<div class="karta"><h2>${tytul}</h2><div class="${klasa || 'proza'}">${tresc}</div></div>`;
}

// Skierowanie czyta się inaczej niż wynik: opisuje coś, co ma się DOPIERO
// wydarzyć. Najważniejszy jest kod, z którym się rejestrujesz, i termin
// ważności — jedno i drugie ma być widoczne bez czytania prozy.
function kartaSkierowania(d) {
  if (d.rodzaj !== 'skierowanie' && !d.kod_eskierowania && !d.wazne_do) return '';
  const dzis = new Date(); dzis.setHours(0, 0, 0, 0);
  let stan = '';
  if (d.wazne_do) {
    const koniec = new Date(String(d.wazne_do).slice(0, 10) + 'T00:00:00');
    const dni = Math.round((koniec - dzis) / 86400000);
    stan = dni < 0 ? '<span class="wazne-po">termin minął</span>'
      : `<span class="wazne-do">ważne jeszcze ${odmien(dni, 'dzień', 'dni', 'dni')}</span>`;
  }
  return `
    <div class="karta">
      <h2>Skierowanie</h2>
      ${d.kod_eskierowania ? `<div class="kod-e">
        <span class="kod-e-etykieta">kod e-skierowania</span>
        <span class="kod-e-cyfry">${esc(d.kod_eskierowania)}</span>
      </div>` : ''}
      <div class="dok-pod">
        ${d.specjalizacja ? `<span>do: ${esc(d.specjalizacja)}</span>` : ''}
        ${d.tryb ? `<span class="znacznik">${esc(d.tryb)}</span>` : ''}
        ${d.wazne_do ? `<span>ważne do ${dataPl(d.wazne_do)}</span>` : ''}
        ${stan}
      </div>
    </div>`;
}

function sekcjeTresci(d) {
  const leki = (d.leki || []).map((l) => `
    <div class="lek">
      <div class="lek-nazwa">${esc(l.nazwa)}${l.dawka ? ` <span class="lek-dawka">${esc(l.dawka)}</span>` : ''}</div>
      ${l.dawkowanie ? `<div class="lek-pod">${esc(l.dawkowanie)}</div>` : ''}
      ${l.odplatnosc ? `<div class="lek-pod">odpłatność ${esc(l.odplatnosc)}</div>` : ''}
    </div>`).join('');

  return `
    ${kartaSkierowania(d)}
    ${leki ? `<div class="karta"><h2>Leki</h2>${leki}</div>` : ''}
    ${d.rozpoznanie ? karta('Rozpoznanie',
      esc(d.rozpoznanie) + (d.kod_icd10 ? ` <span class="znacznik">${esc(d.kod_icd10)}</span>` : '')) : ''}
    ${karta('Zalecenia', d.zalecenia ? esc(d.zalecenia) : '')}
    ${karta('Wywiad', d.wywiad ? esc(d.wywiad) : '')}
    ${karta('Badanie przedmiotowe', d.badanie ? esc(d.badanie) : '')}
    ${karta('Opis', d.opis ? esc(d.opis) : '')}
    ${d.data_nastepnego ? karta('Kontrola', dataPl(d.data_nastepnego)) : ''}
    ${d.pouczenia ? `<details class="karta pouczenia">
      <summary>Standardowe pouczenia</summary>
      <div class="proza">${esc(d.pouczenia)}</div>
    </details>` : ''}`;
}

// Przepisuje to, co użytkownik zdążył poprawić w polach, z powrotem do odczytu.
// Wywołuj PRZED każdym przerysowaniem podglądu — ekran budowany jest z `odczyt`,
// więc bez tego dodanie problemu skasowałoby poprawioną nazwę badania albo datę.
function zachowajPolaPodgladu() {
  if (!odczyt || !odczyt.dokument) return;
  const w = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : undefined;
  };
  const d = odczyt.dokument;
  if (w('p-nazwa') !== undefined) d.nazwa = w('p-nazwa').trim() || d.nazwa;
  if (w('p-rodzaj') !== undefined) d.rodzaj = w('p-rodzaj');
  if (w('p-data') !== undefined) d.data_badania = w('p-data') || null;
  if (w('p-placowka') !== undefined) d.placowka = w('p-placowka').trim() || null;
  Object.assign(d, daneWizyty());
}

// ── widok: podgląd przed zapisem ────────────────────────────────────────────

function rysujPodglad() {
  const d = odczyt.dokument || {};
  const w = d.wyniki || [];
  const osoba = osoby.find((o) => o.id === osobaId);

  const wiersze = w.length ? w.map((x, i) => `
    <tr>
      <td>${esc(x.nazwa)}${x.minuta != null ? ` <span class="w-norma">${x.minuta}′</span>` : ''}
          ${x.metoda ? `<div class="w-norma">${esc(x.metoda)}</div>` : ''}</td>
      <td class="w-wart">${wartosc(x)}${x.flaga ? `<span class="flaga">${esc(x.flaga)}</span>` : ''}</td>
      <td class="w-norma">${norma(x)}</td>
    </tr>`).join('') : '';

  box().innerHTML = `
    <button class="wroc" id="anuluj">← Odrzuć i wróć</button>
    <div class="gora"><h1>Sprawdź, zanim zapiszę</h1></div>
    <div class="karta">
      <div class="pole">
        <label for="p-nazwa">Nazwa badania</label>
        <input id="p-nazwa" value="${esc(d.nazwa || '')}">
      </div>
      <div class="pola-2">
        <div class="pole">
          <label for="p-rodzaj">Rodzaj</label>
          <select id="p-rodzaj">
            ${Object.entries(RODZAJE).map(([k, v]) =>
              `<option value="${k}"${k === d.rodzaj ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="pole">
          <label for="p-data">Data badania</label>
          <input id="p-data" type="date" value="${esc((d.data_badania || '').slice(0, 10))}">
        </div>
      </div>
      <div class="pole">
        <label for="p-placowka">Placówka</label>
        <input id="p-placowka" value="${esc(d.placowka || '')}">
      </div>
      ${blokWizyty(d)}
      <div class="uwaga">Zapisuję to przy osobie: <b>${esc(osoba ? osoba.imie : '—')}</b>.
        ${strony.length > 1 ? `Odczytane z <b>${stronyOpis(strony.length)}</b>. ` : ''}
        Zapisuję <b>tylko odczytane dane</b> — plik służył do odczytu i nie zostanie
        zachowany. Zatrzymaj oryginał u siebie, jeśli będzie potrzebny u lekarza.</div>
    </div>

    ${w.length ? `<div class="karta">
      <h2>Odczytane wyniki — ${w.length}</h2>
      <div class="przewin"><table class="wyniki">
        <thead><tr><th>Badanie</th><th>Wynik</th><th>Norma</th></tr></thead>
        <tbody>${wiersze}</tbody>
      </table></div>
      <div class="uwaga">Normy i oznaczenia (H, L, klasa, centyl) są <b>przepisane
        z dokumentu</b>, nie wyliczone przez aplikację.</div>
    </div>` : ''}

    ${sekcjeTresci(d)}

    <div class="karta">
      <h2>Przypisz do problemu</h2>
      <div class="filtry" id="p-problemy">
        ${problemy.map((p) => `<button class="chip" type="button" data-pr="${p.id}"
            aria-pressed="${wybraneProblemy.has(p.id)}">
            <span class="kropka-pr" style="background: var(--pr-${p.kolor % 8})"></span>${esc(p.nazwa)}
          </button>`).join('')}
        <button class="chip dodaj" type="button" id="p-nowy">+ Nowy problem</button>
      </div>
      <div class="pole" id="p-nowy-pole" style="display:none;margin-top:10px">
        <label for="p-nowa-nazwa">Nazwa problemu</label>
        <input id="p-nowa-nazwa" autocomplete="off" placeholder="np. Ból pleców">
      </div>
      <div class="uwaga">Przypnij od razu, zamiast wracać do tego po zapisie.
        Jedno badanie może należeć do kilku problemów.</div>
    </div>

    <div class="karta dokladanie">
      <b>Dokument ma dalszy ciąg?</b>
      <p class="uwaga">Dołóż kolejną kartkę, a przeczytam <b>całość od nowa</b> jako jedno
      badanie — razem z tabelą urwaną na granicy stron. Poprawki wpisane wyżej trzeba
      będzie nanieść ponownie, więc dokładaj strony przed poprawianiem.</p>
      <div class="akcje">
        <button class="btn btn-outline" type="button" id="dodaj-strone">+ Dodaj kolejną stronę</button>
      </div>
      <input type="file" id="plik-strona" class="plik-ukryty" accept="image/*,application/pdf" multiple>
    </div>

    <div class="akcje">
      <button class="btn btn-primary" id="zapisz">Zapisz badanie</button>
    </div>`;

  document.getElementById('anuluj').onclick = () => {
    odczyt = null; strony = []; wybraneProblemy = new Set(); widok = 'os'; rysuj();
  };
  const chipyProblemow = document.getElementById('p-problemy');
  if (chipyProblemow) chipyProblemow.onclick = (ev) => {
    const b = ev.target.closest('[data-pr]');
    if (!b) return;
    const id = Number(b.dataset.pr);
    if (wybraneProblemy.has(id)) wybraneProblemy.delete(id); else wybraneProblemy.add(id);
    b.setAttribute('aria-pressed', wybraneProblemy.has(id));
  };

  // NOWY PROBLEM WPROST STĄD. Skanujesz zwykle wtedy, gdy dzieje się coś
  // nowego — czyli dokładnie wtedy, gdy właściwego problemu jeszcze nie ma.
  // Odsyłanie po niego na inny ekran kończyłoby się nieprzypięciem niczego.
  const nowyBtn = document.getElementById('p-nowy');
  if (nowyBtn) nowyBtn.onclick = async () => {
    const pole = document.getElementById('p-nowy-pole');
    const wpis = document.getElementById('p-nowa-nazwa');
    if (pole.style.display === 'none') {
      pole.style.display = '';
      wpis.focus();
      return;
    }
    const nazwa = wpis.value.trim();
    if (!nazwa) { wpis.focus(); return; }
    nowyBtn.disabled = true;
    try {
      const r = await authFetch('/api/health/problemy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nazwa, osoba_id: osobaId, kolor: problemy.length }),
      });
      if (!r.ok) throw new Error();
      const { id } = await r.json();
      await wczytajProblemy();
      wybraneProblemy.add(id);       // świeżo utworzony od razu zaznaczony
      zachowajPolaPodgladu();        // patrz niżej — przerysowanie kasuje pola
      rysujPodglad();                // nowy problem pojawia się wśród kafelków
    } catch {
      nowyBtn.disabled = false;
      toast('Nie udało się dodać problemu.', 'blad');
    }
  };
  const wpisNowy = document.getElementById('p-nowa-nazwa');
  if (wpisNowy) wpisNowy.onkeydown = (ev) => {
    // Enter w polu ma robić to samo co przycisk — inaczej trzeba celować
    // w przycisk po wpisaniu nazwy, co na telefonie jest uciążliwe.
    if (ev.key === 'Enter') { ev.preventDefault(); nowyBtn.click(); }
  };
  // Przełączenie rodzaju na „wizyta" odsłania pola specjalisty bez przerysowania
  // ekranu — przerysowanie zgubiłoby to, co użytkownik zdążył poprawić wyżej.
  document.getElementById('p-rodzaj').onchange = (ev) => {
    const blok = document.getElementById('p-wizyta');
    if (blok) blok.style.display = ev.target.value === 'wizyta' ? '' : 'none';
  };
  // Bez `capture`, w odróżnieniu od wejścia na ekranie głównym: drugą stronę
  // równie często się fotografuje, co dobiera z galerii albo z pobranych PDF-ów.
  document.getElementById('dodaj-strone').onclick = () => document.getElementById('plik-strona').click();
  document.getElementById('plik-strona').onchange = (ev) => {
    const wybrane = Array.from(ev.target.files || []);
    ev.target.value = '';
    if (!wybrane.length) return;
    strony = strony.concat(wybrane);
    odczytaj();
  };
  document.getElementById('zapisz').onclick = zapiszDokument;
}

async function zapiszDokument() {
  const btn = document.getElementById('zapisz');
  btn.disabled = true;
  btn.textContent = 'Zapisuję…';

  const d = Object.assign({}, odczyt.dokument, {
    nazwa: document.getElementById('p-nazwa').value.trim() || 'Badanie',
    rodzaj: document.getElementById('p-rodzaj').value,
    data_badania: document.getElementById('p-data').value || null,
    placowka: document.getElementById('p-placowka').value.trim() || null,
  }, daneWizyty());

  const fd = new FormData();
  fd.append('osoba_id', String(osobaId));
  fd.append('dane', JSON.stringify(d));

  try {
    const r = await authFetch('/api/health/dokumenty', { method: 'POST', body: fd });
    if (!r.ok) throw new Error();
    // Problemy przypinamy drugim żądaniem — dopiero teraz dokument ma
    // identyfikator. Nieudane przypięcie NIE cofa zapisu badania: gorzej
    // stracić przypisanie niż odczytany wynik, a przypiąć można później.
    if (wybraneProblemy.size) {
      const { id } = await r.json();
      try { await zapiszProblemyDokumentu(id, [...wybraneProblemy]); }
      catch { toast('Badanie zapisane, ale nie udało się przypiąć problemu.', 'blad'); }
    }
    odczyt = null; strony = []; wybraneProblemy = new Set(); widok = 'os';
    rysuj();
  } catch {
    btn.disabled = false;
    btn.textContent = 'Zapisz badanie';
    alert('Nie udało się zapisać badania.');
  }
}

// ── widok: przebieg parametru ───────────────────────────────────────────────
//
// Rysujemy własnym SVG, a nie biblioteką wykresów. Powód: dwie rzeczy, które
// tu decydują o poprawności, są w bibliotekach walką pod prąd — PASMO NORMY
// MUSI BYĆ SCHODKOWE (norma bywa inna w każdym laboratorium, więc jedno pasmo
// na cały wykres pokazałoby stary wynik jako „poza normą", której wtedy nie
// było) oraz wyniki z operatorem („<0,005") muszą wyglądać inaczej niż zwykły
// pomiar, bo to nie jest zmierzona wartość, tylko granica czułości metody.

let parametry = [];
let parametr = null;
let przebieg = [];

const OS_L = 46, OS_P = 14, OS_G = 16, OS_D = 28;   // marginesy pola rysunku

function skalujY(punkty) {
  const wart = [];
  for (const p of punkty) {
    wart.push(Number(p.wartosc_liczba));
    if (p.norma_min != null) wart.push(Number(p.norma_min));
    if (p.norma_max != null) wart.push(Number(p.norma_max));
  }
  let min = Math.min(...wart), max = Math.max(...wart);
  if (min === max) { min -= 1; max += 1; }          // jedna wartość, płaski zakres
  const luz = (max - min) * 0.12;
  // Luz na dole nie może zejść pod zero, jeśli żadna wartość ani norma nie jest
  // ujemna: oś sięgająca −0,7 przy TSH sugeruje zakres, który nie istnieje.
  // Twardego obcięcia do zera NIE robimy — są parametry naturalnie ujemne
  // (niedobór zasad BE, temperatura), a im zero odcięłoby połowę wykresu.
  const dol = min - luz;
  return { min: (min >= 0 && dol < 0) ? 0 : dol, max: max + luz };
}

const liczba = (v) => String(Number(v)).replace(/\.?0+$/, '').replace('.', ',');

function rysujWykres(punkty, szer) {
  const wys = 250;
  const zakres = skalujY(punkty);
  const t0 = new Date(punkty[0].data_badania).getTime();
  const t1 = new Date(punkty[punkty.length - 1].data_badania).getTime();
  const rozpietosc = t1 - t0 || 1;

  const X = (p) => OS_L + ((new Date(p.data_badania).getTime() - t0) / rozpietosc) * (szer - OS_L - OS_P);
  const Y = (v) => OS_G + (1 - (Number(v) - zakres.min) / (zakres.max - zakres.min)) * (wys - OS_G - OS_D);

  const xs = punkty.map(X);

  // Pasmo normy — osobny prostokąt na każdy pomiar, rozciągnięty do połowy
  // odległości do sąsiadów. Stąd schodki: zmiana normy między badaniami jest
  // widoczna jako uskok, a nie wygładzona w nieistniejącą ciągłość.
  const pasma = punkty.map((p, i) => {
    if (p.norma_min == null && p.norma_max == null) return '';
    const lewo = i === 0 ? OS_L : (xs[i - 1] + xs[i]) / 2;
    const prawo = i === punkty.length - 1 ? szer - OS_P : (xs[i] + xs[i + 1]) / 2;
    const gora = Y(p.norma_max != null ? p.norma_max : zakres.max);
    const dol = Y(p.norma_min != null ? p.norma_min : zakres.min);
    return `<rect class="pasmo" x="${lewo.toFixed(1)}" y="${gora.toFixed(1)}"
             width="${Math.max(0, prawo - lewo).toFixed(1)}" height="${Math.max(0, dol - gora).toFixed(1)}"/>
            <line class="pasmo-ramka" x1="${lewo.toFixed(1)}" y1="${gora.toFixed(1)}"
             x2="${prawo.toFixed(1)}" y2="${gora.toFixed(1)}"/>
            <line class="pasmo-ramka" x1="${lewo.toFixed(1)}" y1="${dol.toFixed(1)}"
             x2="${prawo.toFixed(1)}" y2="${dol.toFixed(1)}"/>`;
  }).join('');

  const linia = punkty.map((p, i) => `${xs[i].toFixed(1)},${Y(p.wartosc_liczba).toFixed(1)}`).join(' ');

  const marki = punkty.map((p, i) => {
    const x = xs[i], y = Y(p.wartosc_liczba);
    const flaga = p.flaga ? ' flaga' : '';
    // Operator: trójkąt zwrócony w stronę, w którą wartość „ucieka" poza skalę
    // pomiaru. Kółko znaczy „zmierzono tyle", trójkąt „wiadomo tylko tyle".
    const znak = p.operator
      ? `<path class="punkt${flaga}" d="${p.operator.startsWith('<')
          ? `M${x - 5},${y - 4} L${x + 5},${y - 4} L${x},${y + 5} Z`
          : `M${x - 5},${y + 4} L${x + 5},${y + 4} L${x},${y - 5} Z`}"/>`
      : `<circle class="punkt${flaga}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5"/>`;
    // Przezroczysta łatka 30×30 — punkt ma 9 px, a palec potrzebuje więcej.
    return znak + `<rect class="dotyk" data-i="${i}" x="${(x - 15).toFixed(1)}"
                     y="${(y - 15).toFixed(1)}" width="30" height="30"><title>${
                     esc(dataPl(p.data_badania))}: ${esc((p.operator || '') + liczba(p.wartosc_liczba))}${
                     p.jednostka ? ' ' + esc(p.jednostka) : ''}</title></rect>`;
  }).join('');

  // Podpisujemy tylko pierwszy i ostatni pomiar — liczba nad każdym punktem
  // zamienia wykres w tabelę i przestaje się go czytać jako kształt.
  const skrajne = [0, punkty.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  const etykiety = skrajne.map((i) => {
    const p = punkty[i], x = xs[i], y = Y(p.wartosc_liczba);
    return `<text class="wartosc" x="${Math.min(szer - OS_P, Math.max(OS_L, x)).toFixed(1)}"
              y="${(y - 11).toFixed(1)}" text-anchor="${i === 0 ? 'start' : 'end'}">${
              esc((p.operator || '') + liczba(p.wartosc_liczba))}</text>`;
  }).join('');

  const dolPola = wys - OS_D;
  return `<svg class="wykres" viewBox="0 0 ${szer} ${wys}" width="${szer}" height="${wys}"
            role="img" aria-label="Przebieg parametru ${esc(parametr || '')} w czasie">
      ${pasma}
      <line class="siatka" x1="${OS_L}" y1="${dolPola}" x2="${szer - OS_P}" y2="${dolPola}"/>
      <text class="opis" x="${OS_L - 6}" y="${OS_G + 4}" text-anchor="end">${liczba(zakres.max.toFixed(1))}</text>
      <text class="opis" x="${OS_L - 6}" y="${dolPola}" text-anchor="end">${liczba(zakres.min.toFixed(1))}</text>
      <text class="opis" x="${OS_L}" y="${wys - 8}">${esc(dataPl(punkty[0].data_badania))}</text>
      <text class="opis" x="${szer - OS_P}" y="${wys - 8}" text-anchor="end">${
        esc(dataPl(punkty[punkty.length - 1].data_badania))}</text>
      <polyline class="linia" points="${linia}"/>
      ${marki}${etykiety}
    </svg>`;
}

function tabelaPrzebiegu(punkty) {
  return `<div class="przewin"><table class="wyniki">
      <thead><tr><th>Data</th><th>Wynik</th><th>Norma</th><th>Placówka</th></tr></thead>
      <tbody>${punkty.slice().reverse().map((p) => `<tr>
        <td>${dataPl(p.data_badania)}${p.metoda ? `<div class="w-norma">${esc(p.metoda)}</div>` : ''}</td>
        <td class="w-wart">${esc((p.operator || '') + liczba(p.wartosc_liczba))}${
          p.jednostka ? ' ' + esc(p.jednostka) : ''}${
          p.flaga ? `<span class="flaga">${esc(p.flaga)}</span>` : ''}</td>
        <td class="w-norma">${norma(p)}</td>
        <td class="w-norma">${esc(p.placowka || '')}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

async function rysujPrzebieg() {
  if (osobaId === null) {          // przebieg jest z natury jednej osoby
    box().innerHTML = `<button class="wroc" id="wroc">← Oś czasu</button>
      <div class="gora"><h1>Przebieg parametru</h1></div>
      <div class="pusto">Wybierz najpierw osobę — przebieg pokazuje jedną historię,
      a nie kilka naraz.</div>`;
    document.getElementById('wroc').onclick = () => { widok = 'os'; rysuj(); };
    return;
  }

  box().innerHTML = '<div class="laduje">Wczytuję…</div>';
  try {
    const r = await authFetch('/api/health/parametry?osoba_id=' + osobaId);
    parametry = r.ok ? ((await r.json()).parametry || []) : [];
  } catch { parametry = []; }

  if (!parametry.length) {
    box().innerHTML = `<button class="wroc" id="wroc">← Oś czasu</button>
      <div class="gora"><h1>Przebieg parametru</h1></div>
      <div class="pusto">Nie ma jeszcze czego rysować.<br>Przebieg powstaje, gdy ten sam
      parametr zostanie zmierzony <b>co najmniej dwa razy</b>.</div>`;
    document.getElementById('wroc').onclick = () => { widok = 'os'; rysuj(); };
    return;
  }

  if (!parametry.some((p) => p.nazwa === parametr)) parametr = parametry[0].nazwa;
  try {
    const r = await authFetch(`/api/health/przebieg?osoba_id=${osobaId}&nazwa=${encodeURIComponent(parametr)}`);
    przebieg = r.ok ? ((await r.json()).punkty || []) : [];
  } catch { przebieg = []; }

  if (!przebieg.length) {
    // Parametr trafił na listę (ma ≥2 pomiary), ale wszystkie okazały się
    // nieliczbowe — na wykres nie pójdą. Lepiej powiedzieć to wprost niż
    // pokazać puste płótno.
    box().innerHTML = `<button class="wroc" id="wroc">← Oś czasu</button>
      <div class="gora"><h1>${esc(parametr)}</h1></div>
      <div class="pusto">Ten parametr nie ma wyników liczbowych — nie da się go
      narysować w czasie.</div>`;
    document.getElementById('wroc').onclick = () => { widok = 'os'; rysuj(); };
    return;
  }

  const jednostka = (przebieg.find((p) => p.jednostka) || {}).jednostka || '';
  box().innerHTML = `
    <button class="wroc" id="wroc">← Oś czasu</button>
    <div class="gora"><h1>Przebieg parametru</h1></div>
    <div class="filtry" id="lista-param" style="margin-bottom:14px">
      ${parametry.map((p) => `<button class="chip" type="button" data-p="${esc(p.nazwa)}"
          aria-pressed="${p.nazwa === parametr}">${esc(p.nazwa)}
          <span class="os-data">${p.ile}</span></button>`).join('')}
    </div>
    <div class="wyk-karta">
      <div class="wyk-gl">
        <h2>${esc(parametr)}${jednostka ? ` <span class="w-norma">${esc(jednostka)}</span>` : ''}</h2>
        <span class="os-data">${przebieg.length} pomiarów</span>
      </div>
      <div id="plotno"></div>
      <div class="wyk-podpis" id="podpis">Szare pasmo to norma z danego badania —
        potrafi się zmieniać między laboratoriami.</div>
    </div>
    <div class="karta">
      <h2>Wszystkie pomiary</h2>
      ${tabelaPrzebiegu(przebieg)}
      <div class="uwaga">Wyniki podane jako „mniej niż" albo „więcej niż" rysujemy
      trójkątem — to granica czułości metody, nie zmierzona wartość.</div>
    </div>`;

  przerysujPlotno();
  document.getElementById('lista-param').onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    parametr = b.dataset.p;
    rysujPrzebieg();
  };
  document.getElementById('wroc').onclick = () => { widok = 'os'; rysuj(); };
}

function przerysujPlotno() {
  const plotno = document.getElementById('plotno');
  if (!plotno || !przebieg.length) return;
  // Rysujemy w RZECZYWISTYCH pikselach kontenera, a nie w stałym viewBox ze
  // skalowaniem: przy skalowaniu opisy osi kurczyłyby się razem z wykresem i na
  // telefonie zrobiłyby się nieczytelne.
  plotno.innerHTML = rysujWykres(przebieg, Math.max(280, plotno.clientWidth));
  plotno.querySelector('svg').onclick = (ev) => {
    const t = ev.target.closest('[data-i]');
    if (!t) return;
    const p = przebieg[Number(t.dataset.i)];
    document.getElementById('podpis').innerHTML =
      `<b>${dataPl(p.data_badania)}</b> — ${esc((p.operator || '') + liczba(p.wartosc_liczba))}`
      + `${p.jednostka ? ' ' + esc(p.jednostka) : ''}`
      + `${norma(p) ? ` · norma ${norma(p)}` : ''}`
      + `${p.placowka ? ` · ${esc(p.placowka)}` : ''}`;
  };
}

let czasomierzRozmiaru = null;
addEventListener('resize', () => {
  if (widok !== 'przebieg') return;
  clearTimeout(czasomierzRozmiaru);
  czasomierzRozmiaru = setTimeout(przerysujPlotno, 150);
});

// ── widok: problemy zdrowotne ───────────────────────────────────────────────

// Problem zakłada człowiek, nie model. Świadomie: „tarczyca" i „kręgosłup" to
// sposób, w jaki TY dzielisz swoją historię, a podpowiedź z rozpoznania w
// dokumencie tworzyłaby osobny problem na każdą wariację nazwy z papieru.

function rysujProblemy() {
  const osoba = osoby.find((o) => o.id === osobaId);
  const doOsoby = osobaId === null ? problemy : problemy.filter((p) => p.osoba_id === osobaId);

  const wiersze = doOsoby.length ? doOsoby.map((p) => `
    <div class="os-wpis" style="margin-top:8px; cursor:default">
      <div class="os-gl">
        <span class="os-nazwa">
          <span class="kropka-pr" style="background: var(--pr-${p.kolor % 8}); display:inline-block; margin-right:7px"></span>
          ${esc(p.nazwa)}${p.zamkniety ? ' <span class="znacznik">zamknięty</span>' : ''}
        </span>
        <span class="os-data">${p.ile} ${p.ile === 1 ? 'wpis' : 'wpisów'}</span>
      </div>
      <div class="os-pod">
        ${osobaId === null ? `<span class="os-osoba">${esc(p.osoba_imie || '')}</span>` : ''}
        ${p.opis ? esc(p.opis) : ''}
        <button class="chip" type="button" data-usun="${p.id}"
                style="margin-left:auto; min-height:32px; padding:4px 10px">Usuń</button>
      </div>
    </div>`).join('')
    : '<div class="pusto">Nie ma jeszcze żadnego problemu.</div>';

  box().innerHTML = `
    <button class="wroc" id="wroc">← Oś czasu</button>
    <div class="gora"><h1>Problemy zdrowotne</h1></div>
    <div class="karta">
      <p class="uwaga" style="margin-top:0">Problem to wątek ciągnący się przez wiele
      dokumentów — „tarczyca", „kręgosłup", „ciąża". Jeden dokument może należeć do
      kilku naraz, bo lipidogram bywa potrzebny i diabetologowi, i kardiologowi.
      Problem zakładasz przy konkretnej osobie.</p>
      <div class="pola-2" style="margin-top:12px">
        <div class="pole">
          <label for="pr-nazwa">Nazwa</label>
          <input id="pr-nazwa" autocomplete="off" placeholder="np. tarczyca">
        </div>
        <div class="pole">
          <label for="pr-osoba">Osoba</label>
          <select id="pr-osoba">
            ${osoby.map((o) => `<option value="${o.id}"${o.id === osobaId ? ' selected' : ''}>${esc(o.imie)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="pole">
        <label>Kolor na osi</label>
        <div class="filtry" id="pr-kolory">
          ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `
            <button class="chip" type="button" data-kolor="${i}" aria-pressed="${i === 0}"
                    aria-label="Kolor ${i + 1}">
              <span class="kropka-pr" style="background: var(--pr-${i}); width:14px; height:14px"></span>
            </button>`).join('')}
        </div>
      </div>
      <div class="akcje"><button class="btn btn-primary" id="pr-dodaj">Dodaj problem</button></div>
    </div>
    <div id="pr-lista">${wiersze}</div>`;

  let wybranyKolor = 0;
  document.getElementById('pr-kolory').onclick = (ev) => {
    const b = ev.target.closest('[data-kolor]');
    if (!b) return;
    wybranyKolor = Number(b.dataset.kolor);
    [...b.parentElement.children].forEach((x) =>
      x.setAttribute('aria-pressed', String(x === b)));
  };

  document.getElementById('pr-dodaj').onclick = async () => {
    const nazwa = document.getElementById('pr-nazwa').value.trim();
    if (!nazwa) { document.getElementById('pr-nazwa').focus(); return; }
    const btn = document.getElementById('pr-dodaj');
    btn.disabled = true;
    try {
      const r = await authFetch('/api/health/problemy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nazwa, kolor: wybranyKolor,
          osoba_id: Number(document.getElementById('pr-osoba').value) }),
      });
      if (!r.ok) throw new Error();
      await wczytajProblemy();
      rysujProblemy();
    } catch {
      btn.disabled = false;
      alert('Nie udało się dodać problemu.');
    }
  };

  document.getElementById('pr-lista').onclick = async (ev) => {
    const b = ev.target.closest('[data-usun]');
    if (!b) return;
    // Kasujemy etykietę, nie badania — warto to powiedzieć wprost, bo przy
    // dokumentacji medycznej „usuń" brzmi groźniej niż jest.
    if (!confirm('Usunąć ten problem? Badania zostaną — zniknie tylko przypisanie.')) return;
    await authFetch('/api/health/problemy/' + b.dataset.usun, { method: 'DELETE' });
    await wczytajProblemy();
    rysujProblemy();
  };

  document.getElementById('wroc').onclick = () => { widok = 'os'; rysuj(); };
  if (osoba) document.getElementById('pr-osoba').value = String(osoba.id);
}

// ── widok: szczegóły ────────────────────────────────────────────────────────

let problemyOsoby = [];   // problemy osoby, do której należy otwarty dokument

async function otworzDokument(id) {
  box().innerHTML = '<div class="laduje">Wczytuję…</div>';
  try {
    const r = await authFetch('/api/health/dokumenty/' + id);
    if (!r.ok) throw new Error();
    szczegoly = await r.json();
    // Pobieramy problemy WŁAŚCICIELA dokumentu, a nie te z filtra osi: na osi
    // zbiorczej filtr jest pusty, a przypiąć wolno tylko problem tej osoby.
    try {
      const rp = await authFetch('/api/health/problemy?osoba_id=' + szczegoly.osoba_id);
      problemyOsoby = rp.ok ? ((await rp.json()).problemy || []) : [];
    } catch { problemyOsoby = []; }
    widok = 'szczegoly';
    rysuj();
  } catch {
    box().innerHTML = '<div class="blad">Nie udało się wczytać badania.</div>';
  }
}

async function zapiszProblemyDokumentu(dokumentId, ids) {
  await authFetch(`/api/health/dokumenty/${dokumentId}/problemy`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ problem_ids: ids }),
  });
}

// Formularz poprawek nagłówka zapisanego dokumentu. WYNIKÓW nie ruszamy —
// są przepisane z papieru i mają zostać takie, jakie wydało laboratorium.
// Nagłówek to co innego: specjalizacji ani nazwiska lekarza często nie ma na
// dokumencie i dopisuje się je z pamięci, po fakcie.
function blokPoprawek(d) {
  return `
    <div id="d-formularz" style="display:none;margin-top:14px">
      <div class="pola-2">
        <div class="pole">
          <label for="e-nazwa">Nazwa</label>
          <input id="e-nazwa" value="${esc(d.nazwa || '')}">
        </div>
        <div class="pole">
          <label for="e-data">Data</label>
          <input id="e-data" type="date" value="${esc((d.data_badania || '').slice(0, 10))}">
        </div>
      </div>
      <div class="pole">
        <label for="e-placowka">Placówka</label>
        <input id="e-placowka" value="${esc(d.placowka || '')}">
      </div>
      <div class="pola-2">
        <div class="pole">
          <label for="e-spec">Specjalista</label>
          <input id="e-spec" list="lista-spec-e" autocomplete="off"
                 placeholder="np. stomatolog" value="${esc(d.specjalizacja || '')}">
          <datalist id="lista-spec-e">
            ${SPECJALIZACJE.map((s) => `<option value="${esc(s)}">`).join('')}
          </datalist>
        </div>
        <div class="pole">
          <label for="e-forma">Forma</label>
          <select id="e-forma">
            <option value="">—</option>
            ${Object.entries(FORMY).map(([k, v]) =>
              `<option value="${k}"${k === d.forma ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="pole">
        <label for="e-lekarz">Lekarz</label>
        <input id="e-lekarz" autocomplete="off" placeholder="imię i nazwisko"
               value="${esc(d.lekarz || '')}">
      </div>
      <div class="akcje">
        <button class="btn btn-outline" type="button" id="e-anuluj">Anuluj</button>
        <button class="btn btn-primary" type="button" id="e-zapisz">Zapisz poprawki</button>
      </div>
    </div>`;
}

async function zapiszPoprawki(id) {
  const v = (x) => {
    const el = document.getElementById(x);
    return el ? (el.value.trim() || null) : null;
  };
  const btn = document.getElementById('e-zapisz');
  btn.disabled = true;
  try {
    const r = await authFetch(`/api/health/dokumenty/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nazwa: v('e-nazwa'), data_badania: v('e-data'), placowka: v('e-placowka'),
        specjalizacja: v('e-spec'), lekarz: v('e-lekarz'), forma: v('e-forma'),
      }),
    });
    if (!r.ok) throw new Error();
    // Przeładowanie z serwera, a nie łatanie ekranu w miejscu: pokazuje to,
    // co naprawdę zostało zapisane, razem z odświeżonym podpisem wizyty.
    await otworzDokument(id);
    toast('Zapisano.', 'ok');
  } catch {
    btn.disabled = false;
    toast('Nie udało się zapisać poprawek.', 'blad');
  }
}

function rysujSzczegoly() {
  const d = szczegoly;
  const w = d.wyniki || [];
  // Zbiór, nie tablica: przypinanie i odpinanie to sprawdzanie obecności przy
  // każdym stuknięciu, a zestaw wysyłamy i tak w całości.
  const przypiete = new Set((d.problemy || []).map((p) => p.id));

  // Wyniki bywają pogrupowane (szczep w antybiogramie, panel alergenów) —
  // nagłówek grupy wstawiamy tylko wtedy, gdy się zmienia.
  let grupa = null;
  const wiersze = w.map((x) => {
    let przed = '';
    if (x.grupa && x.grupa !== grupa) {
      grupa = x.grupa;
      przed = `<tr class="w-grupa"><td colspan="3">${esc(x.grupa)}</td></tr>`;
    }
    const podpis = [x.metoda, x.strona, x.lokalizacja, x.moment].filter(Boolean).map(esc).join(' · ');
    return przed + `
      <tr>
        <td>${esc(x.nazwa)}${x.minuta != null ? ` <span class="w-norma">${x.minuta}′</span>` : ''}
            ${podpis ? `<div class="w-norma">${podpis}</div>` : ''}</td>
        <td class="w-wart">${wartosc(x)}${x.flaga ? `<span class="flaga">${esc(x.flaga)}</span>` : ''}</td>
        <td class="w-norma">${norma(x)}</td>
      </tr>`;
  }).join('');

  box().innerHTML = `
    <button class="wroc" id="wroc">← Wszystkie badania</button>
    <div class="gora"><h1>${esc(d.nazwa)}</h1></div>
    <div class="karta">
      <div class="dok-pod">
        <span class="znacznik">${esc(RODZAJE[d.rodzaj] || d.rodzaj)}</span>
        <span>${dataPl(d.data_badania)}</span>
        ${d.placowka ? `<span>${esc(d.placowka)}</span>` : ''}
        ${d.numer_badania ? `<span>nr ${esc(d.numer_badania)}</span>` : ''}
      </div>
      ${opisWizyty(d) ? `<div class="dok-kto">${opisWizyty(d)}</div>` : ''}
      ${d.kontekst ? `<div class="uwaga">Kontekst badania: ${esc(d.kontekst)}</div>` : ''}
      ${d.norma_wg ? `<div class="uwaga">Normy wg: ${esc(d.norma_wg)}</div>` : ''}
      <div class="akcje" style="margin-top:12px">
        <button class="btn btn-outline" type="button" id="d-popraw">
          ${d.rodzaj === 'wizyta' && !opisWizyty(d) ? 'Dopisz specjalistę' : 'Popraw opis'}
        </button>
      </div>
      ${blokPoprawek(d)}
    </div>

    ${w.length ? `<div class="karta">
      <h2>Wyniki</h2>
      <div class="przewin"><table class="wyniki">
        <thead><tr><th>Badanie</th><th>Wynik</th><th>Norma</th></tr></thead>
        <tbody>${wiersze}</tbody>
      </table></div>
    </div>` : ''}

    ${sekcjeTresci(d)}

    <div class="karta">
      <h2>Problemy</h2>
      ${problemyOsoby.length ? `<div class="filtry" id="d-problemy">
        ${problemyOsoby.map((p) => `<button class="chip" type="button" data-pr="${p.id}"
            aria-pressed="${przypiete.has(p.id)}">
            <span class="kropka-pr" style="background: var(--pr-${p.kolor % 8})"></span>${esc(p.nazwa)}
          </button>`).join('')}
        </div>
        <div class="uwaga">Stuknij, żeby przypiąć albo odpiąć. Jedno badanie może
        należeć do kilku problemów naraz — zapisuje się od razu.</div>`
      : `<div class="uwaga" style="margin-top:0">Nie ma jeszcze żadnego problemu dla tej
         osoby. Załóż go w „Problemy…" nad osią czasu, a potem wróć tutaj.</div>`}
    </div>

    <div class="akcje"><button class="btn btn-danger" id="usun">Usuń badanie</button></div>`;

  const panelPr = document.getElementById('d-problemy');
  if (panelPr) panelPr.onclick = async (ev) => {
    const b = ev.target.closest('[data-pr]');
    if (!b) return;
    const id = Number(b.dataset.pr);
    // Przełączamy od razu w widoku, zapis leci w tle — czekanie na odpowiedź
    // przy stuknięciu w etykietę wyglądałoby jak zacięcie.
    if (przypiete.has(id)) przypiete.delete(id); else przypiete.add(id);
    b.setAttribute('aria-pressed', String(przypiete.has(id)));
    await zapiszProblemyDokumentu(d.id, [...przypiete]);
  };

  document.getElementById('wroc').onclick = () => { widok = 'os'; rysuj(); };
  const popraw = document.getElementById('d-popraw');
  const formularz = document.getElementById('d-formularz');
  popraw.onclick = () => {
    const otwarty = formularz.style.display !== 'none';
    formularz.style.display = otwarty ? 'none' : '';
    if (!otwarty) document.getElementById('e-spec').focus();
  };
  document.getElementById('e-anuluj').onclick = () => { formularz.style.display = 'none'; };
  document.getElementById('e-zapisz').onclick = () => zapiszPoprawki(d.id);

  document.getElementById('usun').onclick = async () => {
    if (!confirm('Usunąć to badanie razem z wynikami?')) return;
    await authFetch('/api/health/dokumenty/' + d.id, { method: 'DELETE' });
    widok = 'os';
    rysuj();
  };
}

authRequireHousehold().then(() => { rysuj(); });
