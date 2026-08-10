// wiem.eat — dziennik jedzenia.
//
// Cała logika strony /eat. Osobny plik, nie doklejamy do app.js (1400 linii
// finansów) — sekcje mają się nie mieszać.

const POSILKI = [
  ['sniadanie', 'Śniadanie'],
  ['obiad', 'Obiad'],
  ['kolacja', 'Kolacja'],
  ['przekaska', 'Przekąski'],
];

let dzienISO = new Date().toLocaleDateString('sv-SE');   // sv-SE daje YYYY-MM-DD lokalnie
let stanDnia = null;

function e(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const zaokr = (v) => Math.round(Number(v) || 0);

function etykietaDnia(iso) {
  const dzis = new Date().toLocaleDateString('sv-SE');
  if (iso === dzis) return 'Dziś';
  const wczoraj = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
  if (iso === wczoraj) return 'Wczoraj';
  return new Date(iso + 'T12:00:00').toLocaleDateString('pl-PL',
    { weekday: 'long', day: 'numeric', month: 'long' });
}

// ── ekran dnia ──────────────────────────────────────────────────────────────

async function wczytajDzien() {
  document.getElementById('tytul-dnia').textContent = etykietaDnia(dzienISO);
  try {
    stanDnia = await (await authFetch('/api/eat/dzien?data=' + dzienISO)).json();
  } catch {
    document.getElementById('posilki').innerHTML =
      '<p class="komunikat blad">Nie udało się wczytać dnia.</p>';
    return;
  }
  rysujPosilki();
  rysujBilans();
}

function rysujPosilki() {
  const box = document.getElementById('posilki');
  box.innerHTML = POSILKI.map(([klucz, nazwa]) => {
    const wpisy = (stanDnia.posilki && stanDnia.posilki[klucz]) || [];
    const suma = wpisy.reduce((s, w) => s + Number(w.kcal || 0), 0);
    const wiersze = wpisy.map((w) => `
      <div class="poz">
        <span class="nz">${e(w.nazwa)}</span>
        <span class="il">${e(w.opis_porcji || zaokr(w.ilosc_g) + ' g')}</span>
        <span class="kc">${zaokr(w.kcal)}</span>
        <button class="x" data-usun="${w.id}" title="Usuń">&times;</button>
      </div>`).join('');
    return `<div class="posilek">
      <div class="pgl"><b>${nazwa}</b><span class="sum">${suma ? zaokr(suma) + ' kcal' : '—'}</span></div>
      ${wiersze}
      <button class="dodaj-mini" data-dodaj="${klucz}" type="button">+ Dodaj</button>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-dodaj]').forEach((b) => {
    b.onclick = () => otworzArkusz(b.dataset.dodaj);
  });
  box.querySelectorAll('[data-usun]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await authFetch('/api/eat/wpis/' + b.dataset.usun, { method: 'DELETE' });
        if (r.ok) await wczytajDzien(); else b.disabled = false;
      } catch { b.disabled = false; }
    };
  });
}

// Paski na dole: skala bierze się z celu, więc bez ustawionego celu nie mają
// sensu — dlatego cel da się zmienić jednym przyciskiem obok daty.
function rysujBilans() {
  const c = stanDnia.cele || {};
  const s = stanDnia.suma || {};
  // Kalorie biorą kolor modułu (zieleń), reszta ma własne barwy ze zwalidowanej
  // palety wykresów. Nie używamy tu `--good`, bo po przemalowaniu modułu na
  // zielono białko zlewało się z kaloriami.
  const wiersze = [
    ['Kalorie', s.kcal, c.kcal, 'kcal', 'var(--accent)'],
    ['Białko', s.bialko, c.bialko, 'g', '#2a78d6'],
    ['Tłuszcz', s.tluszcz, c.tluszcz, 'g', '#eb6834'],
    ['Węgle', s.wegle, c.wegle, 'g', '#8e44c4'],
  ];
  document.getElementById('bilans-in').innerHTML = wiersze.map(([n, jest, cel, jedn, kolor]) => {
    const pct = cel > 0 ? Math.min(100, (Number(jest || 0) / cel) * 100) : 0;
    return `<div>
      <div class="bl-n">${n}</div>
      <div class="bl-w">${zaokr(jest)}<small> / ${zaokr(cel)} ${jedn}</small></div>
      <div class="pas"><span style="width:${pct.toFixed(1)}%;background:${kolor}"></span></div>
    </div>`;
  }).join('');
}

// ── arkusz dodawania ────────────────────────────────────────────────────────

let posilekDocelowy = 'sniadanie';
let arkusz = null;

function zamknijArkusz() {
  zatrzymajSkaner();
  if (arkusz) { arkusz.remove(); arkusz = null; }
}

function otworzArkusz(posilek) {
  posilekDocelowy = posilek;
  const nazwa = (POSILKI.find((p) => p[0] === posilek) || [, 'Posiłek'])[1];
  arkusz = document.createElement('div');
  arkusz.className = 'ark-tlo';
  arkusz.innerHTML = `
    <div class="ark">
      <div class="ark-gl">
        <h2>${nazwa}</h2>
        <button class="x" id="ark-x" type="button" aria-label="Zamknij">&times;</button>
      </div>

      <div class="szukaj">
        <input type="text" id="ark-szukaj" placeholder="Szukaj albo opisz, co zjadłeś" autocomplete="off">
        <button class="mik" id="ark-mik" type="button" aria-label="Podyktuj">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>
        </button>
      </div>
      <div id="ark-komunikat"></div>

      <div id="ark-wyniki" style="display:none;margin-bottom:14px"></div>

      <div id="skaner-wrap">
        <video id="skaner" playsinline muted></video>
        <div class="komunikat">Skieruj aparat na kod kreskowy.</div>
      </div>

      <div class="drogi">
        <button class="droga glowna" id="d-skan" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5V5a1.5 1.5 0 0 1 1.5-1.5h2.5M16.5 3.5H19A1.5 1.5 0 0 1 20.5 5v2.5M20.5 16.5V19a1.5 1.5 0 0 1-1.5 1.5h-2.5M7.5 20.5H5A1.5 1.5 0 0 1 3.5 19v-2.5"/><path d="M7 8v8M10 8v8M13.5 8v8M17 8v8"/></svg>
          <span><span class="t">Skanuj kod kreskowy</span><span class="o">Najszybsze przy wszystkim z opakowania</span></span>
        </button>
        <button class="droga" id="d-etykieta" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="17" height="13" rx="2.5"/><circle cx="12" cy="12.5" r="3.4"/><path d="M8.5 6l1.4-2.2h4.2L15.5 6"/></svg>
          <span class="t">Zdjęcie etykiety</span><span class="o">Gdy kodu nie ma albo produkt nieznany</span>
        </button>
        <button class="droga" id="d-opis" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9"/></svg>
          <span class="t">Opisz słowami</span><span class="o">Domowy obiad bez kodu</span>
        </button>
      </div>

      <div class="sek-tyt">Ostatnio jadłeś</div>
      <div id="ark-ostatnie"><div class="komunikat">Wczytuję…</div></div>
      <input type="file" id="ark-plik" accept="image/*" capture="environment" style="display:none">
    </div>`;
  document.body.appendChild(arkusz);
  arkusz.addEventListener('click', (ev) => { if (ev.target === arkusz) zamknijArkusz(); });
  arkusz.querySelector('#ark-x').onclick = zamknijArkusz;
  arkusz.querySelector('#d-skan').onclick = uruchomSkaner;
  arkusz.querySelector('#d-etykieta').onclick = () => arkusz.querySelector('#ark-plik').click();
  arkusz.querySelector('#d-opis').onclick = () => wyslijOpis(arkusz.querySelector('#ark-szukaj').value);
  arkusz.querySelector('#ark-plik').onchange = wyslijEtykiete;
  arkusz.querySelector('#ark-mik').onclick = dyktuj;
  // Wpisywanie szuka produktów po nazwie (własna baza + Open Food Facts).
  // Dopiero gdy nic nie ma, proponujemy oszacowanie opisu przez AI.
  let czekaSzukanie = null;
  const poleSzukaj = arkusz.querySelector('#ark-szukaj');
  poleSzukaj.addEventListener('input', () => {
    clearTimeout(czekaSzukanie);
    const fraza = poleSzukaj.value.trim();
    if (fraza.length < 3) { pokazWyniki(null); return; }
    // odczekujemy pół sekundy, żeby nie odpytywać bazy przy każdej literze
    czekaSzukanie = setTimeout(() => szukajProduktow(fraza), 500);
  });
  poleSzukaj.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { clearTimeout(czekaSzukanie); szukajProduktow(poleSzukaj.value.trim()); }
  });
  wczytajOstatnie();
}

function komunikat(tekst, blad) {
  const el = arkusz && arkusz.querySelector('#ark-komunikat');
  if (el) el.innerHTML = tekst ? `<div class="komunikat${blad ? ' blad' : ''}">${e(tekst)}</div>` : '';
}

async function wczytajOstatnie() {
  const box = arkusz.querySelector('#ark-ostatnie');
  try {
    const lista = await (await authFetch('/api/eat/ostatnie')).json();
    if (!lista.length) {
      box.innerHTML = '<div class="komunikat">Jeszcze nic tu nie ma. Zeskanuj pierwszy produkt — kolejne wpisy pójdą stąd jednym stuknięciem.</div>';
      return;
    }
    box.innerHTML = lista.map((p, i) => `
      <button class="szybka" data-i="${i}" type="button">
        <span class="nz"><b>${e(p.nazwa)}</b><span>${e(p.opis_porcji || zaokr(p.ilosc_g) + ' g')}${p.ile > 1 ? ' · ' + p.ile + '×' : ''}</span></span>
        <span class="kc">${zaokr(p.kcal)}</span>
      </button>`).join('');
    box.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => dodajGotowy(lista[b.dataset.i]);
    });
  } catch {
    box.innerHTML = '<div class="komunikat blad">Nie udało się wczytać.</div>';
  }
}

// Powtórka z „ostatnio jadłeś" też idzie przez ekran potwierdzenia — nic nie
// wpada do dziennika, zanim zobaczysz i ewentualnie poprawisz wartości.
function dodajGotowy(p) {
  ekranPotwierdzenia({
    nazwa: p.nazwa,
    opis_porcji: p.opis_porcji,
    ilosc_g: Number(p.ilosc_g) || 100,
    kcal: Number(p.kcal) || 0,
    bialko: Number(p.bialko) || 0,
    tluszcz: Number(p.tluszcz) || 0,
    wegle: Number(p.wegle) || 0,
  });
}

// ── szukanie po nazwie ──────────────────────────────────────────────────────

function pokazWyniki(html) {
  const box = arkusz && arkusz.querySelector('#ark-wyniki');
  if (!box) return;
  box.innerHTML = html || '';
  box.style.display = html ? 'block' : 'none';
}

async function szukajProduktow(fraza) {
  if (!fraza || fraza.length < 3) return;
  pokazWyniki('<div class="komunikat">Szukam…</div>');
  let d;
  try {
    d = await (await authFetch('/api/eat/szukaj?fraza=' + encodeURIComponent(fraza))).json();
  } catch { pokazWyniki('<div class="komunikat blad">Nie udało się poszukać.</div>'); return; }

  const wlasne = d.wlasne || [];
  const propozycje = d.propozycje || [];
  if (!wlasne.length && !propozycje.length) {
    pokazWyniki(`<div class="komunikat">Nic takiego nie znalazłem.
      <button type="button" id="w-opis" class="mini-btn">Oszacuj z opisu</button></div>`);
    const b = arkusz.querySelector('#w-opis');
    if (b) b.onclick = () => wyslijOpis(fraza);
    return;
  }

  const wiersz = (p, zBazy) => `
    <button class="szybka" data-kod="${e(p.kod || '')}" data-id="${p.id || ''}" type="button">
      <span class="nz"><b>${e(p.nazwa)}</b><span>${e(p.marka || '')}${p.marka ? ' · ' : ''}${
        p.kcal ? zaokr(p.kcal) + ' kcal/100 g' : 'brak wartości w bazie'}${
        zBazy ? ' · u Was' : ''}</span></span>
    </button>`;

  pokazWyniki(
    (wlasne.length ? '<div class="sek-tyt">Wasza baza</div>' + wlasne.map((p) => wiersz(p, true)).join('') : '')
    + (propozycje.length ? '<div class="sek-tyt">Open Food Facts</div>' + propozycje.map((p) => wiersz(p, false)).join('') : '')
  );

  arkusz.querySelectorAll('#ark-wyniki [data-kod]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.id;
      if (id) {
        const p = wlasne.find((x) => String(x.id) === id);
        if (p) ekranProduktu(p, 'wlasna');
      } else if (b.dataset.kod) {
        poKodzie(b.dataset.kod);   // zapisze produkt u nas i otworzy potwierdzenie
      }
    };
  });
}

// ── skanowanie kodu ─────────────────────────────────────────────────────────

let strumien = null, skanujeDalej = false;

function zatrzymajSkaner() {
  skanujeDalej = false;
  if (strumien) { strumien.getTracks().forEach((t) => t.stop()); strumien = null; }
}

async function uruchomSkaner() {
  if (!('BarcodeDetector' in window)) {
    komunikat('Ta przeglądarka nie umie czytać kodów. Zrób zdjęcie etykiety — zadziała tak samo, tylko wolniej.', true);
    return;
  }
  const wrap = arkusz.querySelector('#skaner-wrap');
  const video = arkusz.querySelector('#skaner');
  try {
    strumien = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    komunikat('Nie mam dostępu do aparatu. Sprawdź uprawnienia strony.', true);
    return;
  }
  wrap.style.display = 'block';
  video.srcObject = strumien;
  await video.play().catch(() => {});
  komunikat('');

  const detektor = new BarcodeDetector({
    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
  });
  skanujeDalej = true;
  (async function petla() {
    while (skanujeDalej) {
      try {
        const kody = await detektor.detect(video);
        if (kody.length) {
          const kod = kody[0].rawValue;
          zatrzymajSkaner();
          wrap.style.display = 'none';
          await poKodzie(kod);
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
}

async function poKodzie(kod) {
  komunikat('Szukam produktu ' + kod + '…');
  try {
    const r = await authFetch('/api/eat/produkt?kod=' + encodeURIComponent(kod));
    if (r.status === 404) {
      komunikat('Nie znam tego kodu. Zrób zdjęcie etykiety — zapamiętam produkt na przyszłość.', true);
      ostatniKod = kod;
      return;
    }
    if (!r.ok) { komunikat('Nie udało się sprawdzić kodu.', true); return; }
    const d = await r.json();
    komunikat('');
    ekranProduktu(d.produkt, d.skad, d.niepelne);
  } catch { komunikat('Błąd połączenia.', true); }
}

// ── zdjęcie etykiety ────────────────────────────────────────────────────────

let ostatniKod = '';

async function wyslijEtykiete(ev) {
  const plik = ev.target.files && ev.target.files[0];
  if (!plik) return;
  komunikat('Odczytuję etykietę…');
  const fd = new FormData();
  fd.append('file', plik);
  try {
    const url = '/api/eat/etykieta' + (ostatniKod ? '?kod=' + encodeURIComponent(ostatniKod) : '');
    const r = await authFetch(url, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { komunikat(d.detail || 'Nie udało się odczytać.', true); return; }
    ostatniKod = '';
    komunikat('');
    ekranProduktu(d.produkt, 'etykieta');
  } catch { komunikat('Błąd połączenia.', true); }
  finally { ev.target.value = ''; }
}

// ── opis słowami ────────────────────────────────────────────────────────────

async function wyslijOpis(tekst) {
  const opis = (tekst || '').trim();
  if (opis.length < 3) { komunikat('Napisz, co zjadłeś.', true); return; }
  komunikat('Szacuję…');
  try {
    const r = await authFetch('/api/eat/opis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opis }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { komunikat(d.detail || 'Nie udało się oszacować.', true); return; }
    komunikat('');
    ekranPozycji(d.pozycje, opis);
  } catch { komunikat('Błąd połączenia.', true); }
}

// Dyktowanie działa na Androidzie w Chrome; gdzie indziej po prostu chowamy
// przycisk zamiast obiecywać coś, co nie zadziała.
function dyktuj() {
  const Rozpoznawanie = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rozpoznawanie) { komunikat('Ta przeglądarka nie obsługuje dyktowania. Wpisz z klawiatury.', true); return; }
  const btn = arkusz.querySelector('#ark-mik');
  const pole = arkusz.querySelector('#ark-szukaj');
  const r = new Rozpoznawanie();
  r.lang = 'pl-PL';
  r.interimResults = false;
  btn.classList.add('slucha');
  komunikat('Słucham…');
  r.onresult = (ev) => {
    pole.value = ev.results[0][0].transcript;
    komunikat('');
    wyslijOpis(pole.value);
  };
  r.onerror = () => komunikat('Nie usłyszałem. Spróbuj jeszcze raz.', true);
  r.onend = () => btn.classList.remove('slucha');
  r.start();
}

// ── ekran potwierdzenia (wspólny dla wszystkich dróg) ───────────────────────
// Nic nie ląduje w dzienniku bez tego kroku: widzisz kalorie i makro, możesz
// poprawić każdą liczbę i dopiero wtedy zatwierdzasz.
//
// `poz` opisuje pozycję dla PODANEJ ilości gramów. Gdy przyjdzie `na100`
// (produkt z bazy), zmiana gramatury przelicza wartości z niego; bez tego
// skalujemy proporcjonalnie od wartości wyjściowych.
function ekranPotwierdzenia(poz, na100, produktId, naglowekDodatkowy) {
  const ark = arkusz && arkusz.querySelector('.ark');
  if (!ark) return;
  const bazowe = { g: Number(poz.ilosc_g) || 100, kcal: Number(poz.kcal) || 0,
                   bialko: Number(poz.bialko) || 0, tluszcz: Number(poz.tluszcz) || 0,
                   wegle: Number(poz.wegle) || 0 };
  let recznie = false;   // gdy sam poprawisz makro, przestajemy je przeliczać

  const porcje = [];
  if (na100 && na100.opak_g) {
    porcje.push({ etyk: 'całe opak.', g: Math.round(na100.opak_g) });
    porcje.push({ etyk: '½ opak.', g: Math.round(na100.opak_g / 2) });
  }
  porcje.push({ etyk: '100 g', g: 100 }, { etyk: '50 g', g: 50 });

  ark.innerHTML = `
    <div class="ark-gl">
      <button class="x" id="wroc" type="button" style="margin:0" aria-label="Wróć">‹</button>
      <h2 style="font-size:1rem">Sprawdź i dodaj</h2>
      <button class="x" id="zamknij2" type="button" aria-label="Zamknij">&times;</button>
    </div>
    ${naglowekDodatkowy || ''}
    <div class="sek-tyt">Nazwa</div>
    <input type="text" id="p-nazwa" value="${e(poz.nazwa)}" maxlength="120" style="width:100%;margin-bottom:12px">
    ${na100 ? `<div class="sek-tyt">Porcja</div><div class="porcje" id="porcje">
      ${porcje.map((x, i) => `<button class="porcja" data-g="${x.g}" aria-pressed="${i === 0}" type="button">${x.etyk}</button>`).join('')}
    </div>` : ''}
    <div class="sek-tyt">Ile gramów</div>
    <input type="number" id="p-gram" value="${Math.round(bazowe.g)}" min="1" max="5000" style="width:100%;margin-bottom:12px">
    <div class="sek-tyt">Wartości — możesz poprawić</div>
    <div class="makro-siatka">
      <label>kcal<input type="number" id="p-kcal" min="0" max="9000"></label>
      <label>Białko<input type="number" id="p-b" min="0" max="500"></label>
      <label>Tłuszcz<input type="number" id="p-t" min="0" max="500"></label>
      <label>Węgle<input type="number" id="p-w" min="0" max="900"></label>
    </div>
    <div id="p-zgodnosc" class="komunikat"></div>
    <div class="sek-tyt">Do którego posiłku</div>
    <div class="gdzie" id="gdzie">
      ${POSILKI.map(([k, n]) => `<button data-p="${k}" aria-pressed="${k === posilekDocelowy}" type="button">${n}</button>`).join('')}
    </div>
    <div id="ark-komunikat"></div>
    <button class="cta" id="dodaj" type="button">Dodaj do dnia</button>`;

  const pole = (id) => ark.querySelector(id);
  const wartosci = () => ({
    g: Number(pole('#p-gram').value) || 0,
    kcal: Number(pole('#p-kcal').value) || 0,
    bialko: Number(pole('#p-b').value) || 0,
    tluszcz: Number(pole('#p-t').value) || 0,
    wegle: Number(pole('#p-w').value) || 0,
  });

  function wstaw(v) {
    pole('#p-kcal').value = Math.round(v.kcal);
    pole('#p-b').value = Math.round(v.bialko);
    pole('#p-t').value = Math.round(v.tluszcz);
    pole('#p-w').value = Math.round(v.wegle);
  }

  function przelicz() {
    if (recznie) { sprawdzZgodnosc(); return; }
    const g = Number(pole('#p-gram').value) || 0;
    if (na100) {
      const m = g / 100;
      wstaw({ kcal: na100.kcal * m, bialko: (na100.bialko || 0) * m,
              tluszcz: (na100.tluszcz || 0) * m, wegle: (na100.wegle || 0) * m });
    } else if (bazowe.g > 0) {
      const m = g / bazowe.g;
      wstaw({ kcal: bazowe.kcal * m, bialko: bazowe.bialko * m,
              tluszcz: bazowe.tluszcz * m, wegle: bazowe.wegle * m });
    }
    sprawdzZgodnosc();
  }

  // 1 g białka i węgli = 4 kcal, 1 g tłuszczu = 9 kcal. Jeśli wpisane makro
  // rozjeżdża się z kaloriami, mówimy o tym wprost zamiast po cichu zapisać
  // niespójną pozycję.
  function sprawdzZgodnosc() {
    const v = wartosci();
    const zMakro = v.bialko * 4 + v.tluszcz * 9 + v.wegle * 4;
    const box = ark.querySelector('#p-zgodnosc');
    if (!v.kcal || !zMakro) { box.textContent = ''; return; }
    const roznica = Math.abs(zMakro - v.kcal) / v.kcal;
    box.className = roznica > 0.15 ? 'komunikat blad' : 'komunikat';
    box.textContent = roznica > 0.15
      ? `Z makroskładników wychodzi ${Math.round(zMakro)} kcal, a wpisane jest ${Math.round(v.kcal)}.`
      : '';
  }

  przelicz();

  ark.querySelectorAll('#p-kcal, #p-b, #p-t, #p-w').forEach((i) => {
    i.addEventListener('input', () => { recznie = true; sprawdzZgodnosc(); });
  });
  pole('#p-gram').addEventListener('input', przelicz);

  const listaPorcji = ark.querySelector('#porcje');
  if (listaPorcji) listaPorcji.onclick = (ev) => {
    const b = ev.target.closest('.porcja');
    if (!b) return;
    ark.querySelectorAll('.porcja').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    pole('#p-gram').value = b.dataset.g;
    recznie = false;
    przelicz();
  };

  ark.querySelector('#gdzie').onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    ark.querySelectorAll('#gdzie [data-p]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    posilekDocelowy = b.dataset.p;
  };
  ark.querySelector('#wroc').onclick = () => { zamknijArkusz(); otworzArkusz(posilekDocelowy); };
  ark.querySelector('#zamknij2').onclick = zamknijArkusz;

  ark.querySelector('#dodaj').onclick = async (ev) => {
    ev.target.disabled = true;
    const v = wartosci();
    const nazwa = pole('#p-nazwa').value.trim();
    if (!nazwa || !v.g) { komunikat('Podaj nazwę i ilość.', true); ev.target.disabled = false; return; }
    const etyk = ark.querySelector('.porcja[aria-pressed="true"]');
    // Gdy wartości nie były ruszane, wysyłamy produkt_id i liczy je serwer.
    // Po ręcznej poprawce wysyłamy wprost to, co widać na ekranie.
    const cialo = (produktId && !recznie)
      ? { data: dzienISO, posilek: posilekDocelowy, produkt_id: produktId,
          ilosc_g: v.g, opis_porcji: etyk ? etyk.textContent : null }
      : { data: dzienISO, posilek: posilekDocelowy, nazwa,
          opis_porcji: (etyk ? etyk.textContent : poz.opis_porcji) || null,
          ilosc_g: v.g, kcal: v.kcal, bialko: v.bialko, tluszcz: v.tluszcz, wegle: v.wegle };
    try {
      const r = await authFetch('/api/eat/wpis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cialo),
      });
      if (!r.ok) { const x = await r.json().catch(() => ({})); komunikat(x.detail || 'Nie udało się dodać.', true); ev.target.disabled = false; return; }
      zamknijArkusz();
      await wczytajDzien();
    } catch { komunikat('Błąd połączenia.', true); ev.target.disabled = false; }
  };
}

// ── ekran produktu (wybór porcji) ───────────────────────────────────────────

// Ekran produktu to teraz tylko nagłówek — resztą zajmuje się wspólny ekran
// potwierdzenia, żeby każda droga dodawania kończyła się tak samo.
function ekranProduktu(p, skad, niepelne) {
  const zrodla = { off: 'Open Food Facts · zapisano u Was', wlasna: 'Wasza baza',
                   etykieta: 'Odczytane z etykiety' };
  // Część produktów siedzi w bazie bez tabeli wartości — typowo woda mineralna.
  // Nie odrzucamy ich (woda ma zero kalorii i to poprawna wartość), ale mówimy
  // wprost, że liczby trzeba sprawdzić.
  const ostrzezenie = niepelne
    ? '<div class="komunikat blad">Baza nie ma dla tego produktu wartości odżywczych. '
      + 'Przy wodzie zero kalorii jest poprawne — przy czymkolwiek innym wpisz je poniżej '
      + 'albo wróć i zrób zdjęcie etykiety.</div>'
    : '';
  const naglowek = `
    <div class="prod-gora">
      <div class="marka">${e(p.marka || '')}</div>
      <h3>${e(p.nazwa)}</h3>
      <div class="op">${p.opak_g ? 'opakowanie ' + zaokr(p.opak_g) + ' g · ' : ''}${zaokr(p.kcal)} kcal / 100 g</div>
      <div class="zrodlo">${e(zrodla[skad] || 'Wasza baza')}</div>
    </div>${ostrzezenie}`;
  const opak = Number(p.opak_g) || 100;
  ekranPotwierdzenia(
    { nazwa: p.nazwa, ilosc_g: opak, kcal: 0, bialko: 0, tluszcz: 0, wegle: 0 },
    { kcal: Number(p.kcal) || 0, bialko: Number(p.bialko) || 0,
      tluszcz: Number(p.tluszcz) || 0, wegle: Number(p.wegle) || 0,
      opak_g: Number(p.opak_g) || 0 },
    p.id,
    naglowek,
  );
}

// ── ekran pozycji z opisu ───────────────────────────────────────────────────

// Lista pozycji z opisu — kazda z wlasna gramatura do poprawienia. Wartosci
// skaluja sie proporcjonalnie, bo Claude podal je dla oszacowanej ilosci.
function ekranPozycji(pozycje, opis) {
  const ark = arkusz.querySelector('.ark');
  ark.innerHTML = `
    <div class="ark-gl"><button class="x" id="wroc" type="button" style="margin:0" aria-label="Wróć">‹</button>
      <h2 style="font-size:1rem">Sprawdź i popraw</h2>
      <button class="x" id="zamknij2" type="button" aria-label="Zamknij">&times;</button></div>
    <div class="komunikat">Z opisu „${e(opis)}". Odznacz, czego nie jadłeś, popraw gramatury.</div>
    <div id="lista-poz">
      ${pozycje.map((p, i) => `
        <div class="poz-edyt" data-i="${i}">
          <input type="checkbox" data-zazn="${i}" checked>
          <div style="flex:1;min-width:0">
            <div class="pe-nazwa">${e(p.nazwa)}</div>
            <div class="pe-linia">
              <input type="number" data-gram="${i}" value="${zaokr(p.ilosc_g)}" min="1" max="5000"> g
              <span class="pe-kcal" data-kcal="${i}">${zaokr(p.kcal)} kcal</span>
            </div>
          </div>
        </div>`).join('')}
    </div>
    <div class="sek-tyt" style="margin-top:12px">Razem</div>
    <div class="wynik" id="poz-suma"></div>
    <div class="sek-tyt">Do którego posiłku</div>
    <div class="gdzie" id="gdzie">
      ${POSILKI.map(([k, n]) => `<button data-p="${k}" aria-pressed="${k === posilekDocelowy}" type="button">${n}</button>`).join('')}
    </div>
    <div id="ark-komunikat"></div>
    <button class="cta" id="dodaj-wsz" type="button">Dodaj do dnia</button>`;

  const bazowe = pozycje.map((p) => ({
    g: Number(p.ilosc_g) || 100, kcal: Number(p.kcal) || 0, bialko: Number(p.bialko) || 0,
    tluszcz: Number(p.tluszcz) || 0, wegle: Number(p.wegle) || 0,
  }));

  function biezaca(i) {
    const g = Number(ark.querySelector(`[data-gram="${i}"]`).value) || 0;
    const b = bazowe[i];
    const m = b.g > 0 ? g / b.g : 0;
    return { g, kcal: b.kcal * m, bialko: b.bialko * m, tluszcz: b.tluszcz * m, wegle: b.wegle * m };
  }

  function przelicz() {
    const suma = { kcal: 0, bialko: 0, tluszcz: 0, wegle: 0 };
    pozycje.forEach((_, i) => {
      const v = biezaca(i);
      ark.querySelector(`[data-kcal="${i}"]`).textContent = zaokr(v.kcal) + ' kcal';
      if (ark.querySelector(`[data-zazn="${i}"]`).checked) {
        suma.kcal += v.kcal; suma.bialko += v.bialko; suma.tluszcz += v.tluszcz; suma.wegle += v.wegle;
      }
    });
    ark.querySelector('#poz-suma').innerHTML = `
      <div class="wynik-kc">${zaokr(suma.kcal)} kcal</div>
      <div class="wynik-mk"><span>B <b>${zaokr(suma.bialko)} g</b></span>
        <span>T <b>${zaokr(suma.tluszcz)} g</b></span>
        <span>W <b>${zaokr(suma.wegle)} g</b></span></div>`;
  }
  przelicz();

  ark.querySelectorAll('[data-gram], [data-zazn]').forEach((el) => {
    el.addEventListener('input', przelicz);
    el.addEventListener('change', przelicz);
  });

  ark.querySelector('#gdzie').onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    ark.querySelectorAll('#gdzie [data-p]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    posilekDocelowy = b.dataset.p;
  };
  ark.querySelector('#wroc').onclick = () => { zamknijArkusz(); otworzArkusz(posilekDocelowy); };
  ark.querySelector('#zamknij2').onclick = zamknijArkusz;

  ark.querySelector('#dodaj-wsz').onclick = async (ev) => {
    ev.target.disabled = true;
    const wybrane = pozycje
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => ark.querySelector(`[data-zazn="${i}"]`).checked);
    if (!wybrane.length) { zamknijArkusz(); return; }
    komunikat('Zapisuję…');
    try {
      for (const { p, i } of wybrane) {
        const v = biezaca(i);
        await authFetch('/api/eat/wpis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: dzienISO, posilek: posilekDocelowy, nazwa: p.nazwa,
            opis_porcji: p.opis_porcji, ilosc_g: v.g,
            kcal: v.kcal, bialko: v.bialko, tluszcz: v.tluszcz, wegle: v.wegle,
          }),
        });
      }
      zamknijArkusz();
      await wczytajDzien();
    } catch { komunikat('Błąd połączenia.', true); ev.target.disabled = false; }
  };
}

// ── cel dzienny ─────────────────────────────────────────────────────────────

// Kaloryczność makroskładników — to z niej bierze się cała arytmetyka celu.
const KCAL_NA_G = { bialko: 4, tluszcz: 9, wegle: 4 };

// Gotowe rozkłady w procentach: białko / tłuszcz / węglowodany.
const ROZKLADY = [
  ['Zbilansowany', 25, 30, 45],
  ['Wysokobiałkowy', 35, 30, 35],
  ['Mniej węglowodanów', 30, 45, 25],
];

function oknoCeli() {
  const c = (stanDnia && stanDnia.cele) || {};
  let tryb = 'procenty';

  const o = document.createElement('div');
  o.className = 'ark-tlo';
  o.innerHTML = `
    <div class="ark" style="max-width:430px">
      <div class="ark-gl"><h2 style="font-size:1.05rem">Cel dzienny</h2>
        <button class="x" id="c-x" type="button" aria-label="Zamknij">&times;</button></div>
      <div class="komunikat">Od celu zależy skala pasków na dole. Cel jest Twój — Ola ma własny.</div>

      <div class="sek-tyt">Kalorie na dzień</div>
      <input id="c-kcal" type="number" min="800" max="6000" value="${zaokr(c.kcal)}" style="width:100%;margin-bottom:14px">

      <div class="sek-tyt">Rozkład makroskładników</div>
      <div class="gdzie" id="c-tryb" style="margin-bottom:10px">
        <button data-tryb="procenty" aria-pressed="true" type="button">Procentami</button>
        <button data-tryb="gramy" aria-pressed="false" type="button">Gramami</button>
      </div>

      <div id="c-wiersze"></div>
      <div id="c-status" class="komunikat"></div>

      <div class="sek-tyt">Gotowe rozkłady</div>
      <div class="porcje" id="c-rozklady">
        ${ROZKLADY.map((r, i) => `<button class="porcja" data-rozklad="${i}" type="button">${r[0]}</button>`).join('')}
      </div>

      <div id="c-blad" class="komunikat blad"></div>
      <button class="cta" id="c-zapisz" type="button" style="margin-top:8px">Zapisz</button>
    </div>`;
  document.body.appendChild(o);
  o.addEventListener('click', (ev) => { if (ev.target === o) o.remove(); });
  o.querySelector('#c-x').onclick = () => o.remove();

  // Stan trzymamy w GRAMACH — to one idą do bazy. Procenty są tylko sposobem
  // wpisywania, przeliczanym w obie strony.
  const gramy = {
    bialko: Number(c.bialko) || 0,
    tluszcz: Number(c.tluszcz) || 0,
    wegle: Number(c.wegle) || 0,
  };
  const kcalCelu = () => Number(o.querySelector('#c-kcal').value) || 0;
  const zMakro = () => Object.keys(KCAL_NA_G).reduce((s, k) => s + gramy[k] * KCAL_NA_G[k], 0);

  const OPISY = [['bialko', 'Białko'], ['tluszcz', 'Tłuszcz'], ['wegle', 'Węglowodany']];

  function rysuj() {
    const cel = kcalCelu();
    o.querySelector('#c-wiersze').innerHTML = OPISY.map(([k, nazwa]) => {
      const pct = cel > 0 ? (gramy[k] * KCAL_NA_G[k] / cel) * 100 : 0;
      const wartosc = tryb === 'procenty' ? Math.round(pct) : Math.round(gramy[k]);
      const obok = tryb === 'procenty'
        ? `${Math.round(gramy[k])} g`
        : `${Math.round(pct)}%`;
      return `<div class="cel-row">
        <label for="c-${k}">${nazwa}</label>
        <input id="c-${k}" data-makro="${k}" type="number" min="0" max="900" value="${wartosc}">
        <span class="cel-jedn">${tryb === 'procenty' ? '%' : 'g'}</span>
        <span class="cel-obok">${obok}</span>
      </div>`;
    }).join('');

    o.querySelectorAll('[data-makro]').forEach((i) => {
      i.addEventListener('input', () => {
        const k = i.dataset.makro;
        const v = Number(i.value) || 0;
        const cel2 = kcalCelu();
        gramy[k] = tryb === 'procenty' ? (cel2 * (v / 100)) / KCAL_NA_G[k] : v;
        odswiezStatus();
        // przeliczoną wartość obok pokazujemy od razu, bez przerysowania pola
        const wiersz = i.closest('.cel-row').querySelector('.cel-obok');
        const pct = cel2 > 0 ? (gramy[k] * KCAL_NA_G[k] / cel2) * 100 : 0;
        wiersz.textContent = tryb === 'procenty' ? Math.round(gramy[k]) + ' g' : Math.round(pct) + '%';
      });
    });
    odswiezStatus();
  }

  function odswiezStatus() {
    const cel = kcalCelu();
    const z = zMakro();
    const box = o.querySelector('#c-status');
    if (!cel) { box.textContent = ''; return; }
    const roznica = Math.round(z - cel);
    const proc = Math.abs(roznica) / cel;
    if (proc <= 0.02) {
      box.className = 'komunikat';
      box.innerHTML = `Makroskładniki dają <b>${Math.round(z)} kcal</b> — zgadza się z celem.`;
    } else {
      box.className = 'komunikat blad';
      box.innerHTML = `Makroskładniki dają <b>${Math.round(z)} kcal</b>, czyli
        ${roznica > 0 ? 'o ' + roznica + ' za dużo' : 'o ' + (-roznica) + ' za mało'}.
        <button type="button" id="c-wyrownaj" class="mini-btn">Wyrównaj</button>`;
      const b = box.querySelector('#c-wyrownaj');
      if (b) b.onclick = () => {
        // skalujemy wszystkie trzy proporcjonalnie, żeby zachować rozkład
        const wsp = z > 0 ? cel / z : 0;
        Object.keys(gramy).forEach((k) => { gramy[k] = gramy[k] * wsp; });
        rysuj();
      };
    }
  }

  o.querySelector('#c-kcal').addEventListener('input', () => {
    // przy zmianie kalorii trzymamy ROZKŁAD, nie gramy — inaczej podniesienie
    // celu o 200 kcal cicho psułoby proporcje
    const z = zMakro();
    if (z > 0) {
      const wsp = kcalCelu() / z;
      Object.keys(gramy).forEach((k) => { gramy[k] = gramy[k] * wsp; });
    }
    rysuj();
  });

  o.querySelector('#c-tryb').onclick = (ev) => {
    const b = ev.target.closest('[data-tryb]');
    if (!b) return;
    o.querySelectorAll('#c-tryb [data-tryb]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    tryb = b.dataset.tryb;
    rysuj();
  };

  o.querySelector('#c-rozklady').onclick = (ev) => {
    const b = ev.target.closest('[data-rozklad]');
    if (!b) return;
    const [, pb, pt, pw] = ROZKLADY[b.dataset.rozklad];
    const cel = kcalCelu();
    gramy.bialko = (cel * pb / 100) / 4;
    gramy.tluszcz = (cel * pt / 100) / 9;
    gramy.wegle = (cel * pw / 100) / 4;
    rysuj();
  };

  rysuj();

  o.querySelector('#c-zapisz').onclick = async () => {
    const cialo = {
      kcal: kcalCelu(),
      bialko: Math.round(gramy.bialko),
      tluszcz: Math.round(gramy.tluszcz),
      wegle: Math.round(gramy.wegle),
    };
    try {
      const r = await authFetch('/api/eat/cele', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cialo),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { o.querySelector('#c-blad').textContent = d.detail || 'Nie udało się zapisać.'; return; }
      o.remove();
      await wczytajDzien();
    } catch { o.querySelector('#c-blad').textContent = 'Błąd połączenia.'; }
  };
}

// ── start ───────────────────────────────────────────────────────────────────

function przesunDzien(o) {
  const d = new Date(dzienISO + 'T12:00:00');
  d.setDate(d.getDate() + o);
  dzienISO = d.toLocaleDateString('sv-SE');
  wczytajDzien();
}

authRequireHousehold().then(() => {
  document.getElementById('poprz').onclick = () => przesunDzien(-1);
  document.getElementById('nast').onclick = () => przesunDzien(1);
  document.getElementById('btn-cele').onclick = oknoCeli;
  wczytajDzien();
});
