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
// Pliku NIE przetrzymujemy między odczytem a zapisem: oryginały nie trafiają
// do bazy (patrz `zapisz` w health.py), więc nie ma czego wysyłać drugi raz.
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
      <input type="file" id="plik-zdjecie" accept="image/*" capture="environment">
      <input type="file" id="plik-pdf" accept="application/pdf,image/*">
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
      const f = ev.target.files && ev.target.files[0];
      if (f) odczytaj(f);
      ev.target.value = '';
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

async function odczytaj(plik) {
  box().innerHTML = `<div class="czekaj">
      <div class="czekaj-znak"><i></i><i></i></div>
      <b>Czytam dokument…</b>
      <span>Przepisuję wyniki, normy i oznaczenia. Zaraz pokażę je do sprawdzenia —
      nic nie zapisuję bez twojej zgody.</span>
    </div>`;

  const fd = new FormData();
  fd.append('plik', plik);
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
    wroc.onclick = () => { widok = 'os'; rysuj(); };
    box().prepend(wroc);
  }
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
      <div class="uwaga">Zapisuję to przy osobie: <b>${esc(osoba ? osoba.imie : '—')}</b>.
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

    ${d.opis ? `<div class="karta"><h2>Opis</h2><div class="proza">${esc(d.opis)}</div></div>` : ''}
    ${d.rozpoznanie ? `<div class="karta"><h2>Rozpoznanie</h2>
      <div class="proza">${esc(d.rozpoznanie)}${d.kod_icd10 ? ` (${esc(d.kod_icd10)})` : ''}</div></div>` : ''}
    ${d.zalecenia ? `<div class="karta"><h2>Zalecenia</h2><div class="proza">${esc(d.zalecenia)}</div></div>` : ''}

    <div class="akcje">
      <button class="btn btn-primary" id="zapisz">Zapisz badanie</button>
    </div>`;

  document.getElementById('anuluj').onclick = () => {
    odczyt = null; widok = 'os'; rysuj();
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
  });

  const fd = new FormData();
  fd.append('osoba_id', String(osobaId));
  fd.append('dane', JSON.stringify(d));

  try {
    const r = await authFetch('/api/health/dokumenty', { method: 'POST', body: fd });
    if (!r.ok) throw new Error();
    odczyt = null; widok = 'os';
    rysuj();
  } catch {
    btn.disabled = false;
    btn.textContent = 'Zapisz badanie';
    alert('Nie udało się zapisać badania.');
  }
}

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
      ${d.kontekst ? `<div class="uwaga">Kontekst badania: ${esc(d.kontekst)}</div>` : ''}
      ${d.norma_wg ? `<div class="uwaga">Normy wg: ${esc(d.norma_wg)}</div>` : ''}
      ${d.ma_plik ? `<div class="akcje" style="margin-top:12px">
        <a class="btn btn-outline" href="/api/health/dokumenty/${d.id}/plik" target="_blank"
           rel="noopener">Otwórz oryginał PDF</a></div>` : ''}
    </div>

    ${w.length ? `<div class="karta">
      <h2>Wyniki</h2>
      <div class="przewin"><table class="wyniki">
        <thead><tr><th>Badanie</th><th>Wynik</th><th>Norma</th></tr></thead>
        <tbody>${wiersze}</tbody>
      </table></div>
    </div>` : ''}

    ${d.opis ? `<div class="karta"><h2>Opis</h2><div class="proza">${esc(d.opis)}</div></div>` : ''}
    ${d.rozpoznanie ? `<div class="karta"><h2>Rozpoznanie</h2>
      <div class="proza">${esc(d.rozpoznanie)}${d.kod_icd10 ? ` (${esc(d.kod_icd10)})` : ''}</div></div>` : ''}
    ${d.zalecenia ? `<div class="karta"><h2>Zalecenia</h2><div class="proza">${esc(d.zalecenia)}</div></div>` : ''}
    ${d.data_nastepnego ? `<div class="karta"><h2>Kontrola</h2>
      <div class="proza">${dataPl(d.data_nastepnego)}</div></div>` : ''}

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
  document.getElementById('usun').onclick = async () => {
    if (!confirm('Usunąć to badanie razem z wynikami?')) return;
    await authFetch('/api/health/dokumenty/' + d.id, { method: 'DELETE' });
    widok = 'os';
    rysuj();
  };
}

authRequireHousehold().then(() => { rysuj(); });
