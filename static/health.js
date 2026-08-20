// Ekran badań i dokumentacji — wiem.health.
//
// Trzy widoki w jednym pliku, przełączane stanem: lista dokumentów, podgląd
// świeżo odczytanego dokumentu przed zapisem, szczegóły zapisanego.
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
let osobaId = null;
let widok = 'lista';      // lista | podglad | szczegoly
let odczyt = null;        // { dokument } — czeka na zapis
// Pliku NIE przetrzymujemy między odczytem a zapisem: oryginały nie trafiają
// do bazy (patrz `zapisz` w health.py), więc nie ma czego wysyłać drugi raz.
let szczegoly = null;

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
  if (osoby.length && !osoby.some((o) => o.id === osobaId)) osobaId = osoby[0].id;
}

async function rysuj() {
  if (widok === 'podglad') return rysujPodglad();
  if (widok === 'szczegoly') return rysujSzczegoly();
  return rysujListe();
}

// ── widok: lista ────────────────────────────────────────────────────────────

function paskiOsob() {
  const chipy = osoby.map((o) =>
    `<button type="button" data-os="${o.id}" aria-pressed="${o.id === osobaId}">${esc(o.imie)}</button>`
  ).join('');
  return `<div class="osoby" id="osoby">${chipy}
      <button type="button" class="dodaj-os" id="dodaj-os">+ Osoba</button>
    </div>`;
}

async function rysujListe() {
  box().innerHTML = '<div class="laduje">Wczytuję…</div>';
  try {
    await wczytajOsoby();
  } catch {
    box().innerHTML = '<div class="blad">Nie udało się wczytać listy osób.</div>';
    return;
  }

  if (!osoby.length) {
    box().innerHTML = `<div class="gora"><h1>Badania i dokumentacja</h1></div>
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
        <div class="akcje"><button class="btn btn-primary" id="n-zapisz">Dodaj osobę</button></div>
      </div>`;
    document.getElementById('n-zapisz').onclick = zapiszOsobe;
    return;
  }

  let dokumenty = [];
  try {
    const r = await authFetch('/api/health/dokumenty?osoba_id=' + osobaId);
    if (r.ok) dokumenty = (await r.json()).dokumenty || [];
  } catch { /* pusta lista jest poprawnym stanem */ }

  const lista = dokumenty.length ? dokumenty.map((d) => `
    <button class="dok" data-dok="${d.id}" type="button">
      <div class="dok-gl">
        <span class="dok-nazwa">${esc(d.nazwa)}</span>
        <span class="dok-data">${dataPl(d.data_badania)}</span>
      </div>
      <div class="dok-pod">
        <span class="znacznik">${esc(RODZAJE[d.rodzaj] || d.rodzaj)}</span>
        ${d.ma_plik ? '<span class="znacznik pdf">PDF</span>' : ''}
        ${d.placowka ? esc(d.placowka) : ''}
      </div>
    </button>`).join('')
    : `<div class="pusto">Brak zapisanych badań.<br>Zrób zdjęcie wyniku albo wgraj PDF
       z laboratorium.</div>`;

  box().innerHTML = `
    <div class="gora"><h1>Badania i dokumentacja</h1></div>
    ${paskiOsob()}
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
    <div id="lista">${lista}</div>`;

  document.getElementById('osoby').onclick = (ev) => {
    const b = ev.target.closest('[data-os]');
    if (!b) return;
    osobaId = Number(b.dataset.os);
    rysuj();
  };
  document.getElementById('dodaj-os').onclick = () => { osoby = []; rysujListe(); };

  // Gest MUSI trafić w to samo pole, które otwieramy — inaczej przeglądarka
  // telefonu uznaje otwarcie aparatu za niewywołane przez użytkownika.
  document.getElementById('w-zdjecie').onclick = () => document.getElementById('plik-zdjecie').click();
  document.getElementById('w-pdf').onclick = () => document.getElementById('plik-pdf').click();
  ['plik-zdjecie', 'plik-pdf'].forEach((id) => {
    document.getElementById(id).onchange = (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (f) odczytaj(f);
      ev.target.value = '';     // ten sam plik da się wybrać drugi raz
    };
  });

  document.getElementById('lista').onclick = (ev) => {
    const b = ev.target.closest('[data-dok]');
    if (b) otworzDokument(Number(b.dataset.dok));
  };
}

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
    rysujListe();
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
    wroc.onclick = () => { widok = 'lista'; rysuj(); };
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
    odczyt = null; widok = 'lista'; rysuj();
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
    odczyt = null; widok = 'lista';
    rysuj();
  } catch {
    btn.disabled = false;
    btn.textContent = 'Zapisz badanie';
    alert('Nie udało się zapisać badania.');
  }
}

// ── widok: szczegóły ────────────────────────────────────────────────────────

async function otworzDokument(id) {
  box().innerHTML = '<div class="laduje">Wczytuję…</div>';
  try {
    const r = await authFetch('/api/health/dokumenty/' + id);
    if (!r.ok) throw new Error();
    szczegoly = await r.json();
    widok = 'szczegoly';
    rysuj();
  } catch {
    box().innerHTML = '<div class="blad">Nie udało się wczytać badania.</div>';
  }
}

function rysujSzczegoly() {
  const d = szczegoly;
  const w = d.wyniki || [];

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

    <div class="akcje"><button class="btn btn-danger" id="usun">Usuń badanie</button></div>`;

  document.getElementById('wroc').onclick = () => { widok = 'lista'; rysuj(); };
  document.getElementById('usun').onclick = async () => {
    if (!confirm('Usunąć to badanie razem z wynikami?')) return;
    await authFetch('/api/health/dokumenty/' + d.id, { method: 'DELETE' });
    widok = 'lista';
    rysuj();
  };
}

authRequireHousehold().then(() => { rysuj(); });
