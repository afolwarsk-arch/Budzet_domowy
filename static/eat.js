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
  arkusz.querySelector('#ark-szukaj').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') wyslijOpis(ev.target.value);
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

async function dodajGotowy(p) {
  komunikat('Dodaję…');
  try {
    const r = await authFetch('/api/eat/wpis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: dzienISO, posilek: posilekDocelowy, produkt_id: p.produkt_id || null,
        nazwa: p.nazwa, opis_porcji: p.opis_porcji, ilosc_g: p.ilosc_g,
        kcal: p.kcal, bialko: p.bialko, tluszcz: p.tluszcz, wegle: p.wegle,
      }),
    });
    if (!r.ok) { const x = await r.json().catch(() => ({})); komunikat(x.detail || 'Nie udało się dodać.', true); return; }
    zamknijArkusz();
    await wczytajDzien();
  } catch { komunikat('Błąd połączenia.', true); }
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
    ekranProduktu(d.produkt, d.skad);
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

// ── ekran produktu (wybór porcji) ───────────────────────────────────────────

function ekranProduktu(p, skad) {
  const opak = Number(p.opak_g) || 0;
  const porcje = [];
  if (opak) {
    porcje.push({ etyk: 'całe opak.', g: opak });
    porcje.push({ etyk: '½ opak.', g: Math.round(opak / 2) });
  }
  porcje.push({ etyk: '100 g', g: 100 });
  porcje.push({ etyk: '50 g', g: 50 });
  let wybrane = porcje[0].g;

  const zrodlaOpis = { off: 'Open Food Facts · zapisano u Was', wlasna: 'Wasza baza', etykieta: 'Odczytane z etykiety' };
  const ark = arkusz.querySelector('.ark');
  ark.innerHTML = `
    <div class="ark-gl"><button class="x" id="wroc" type="button" style="margin:0" aria-label="Wróć">‹</button>
      <h2 style="font-size:1rem">Ile zjadłeś</h2>
      <button class="x" id="zamknij2" type="button" aria-label="Zamknij">&times;</button></div>
    <div class="prod-gora">
      <div class="marka">${e(p.marka || '')}</div>
      <h3>${e(p.nazwa)}</h3>
      <div class="op">${opak ? 'opakowanie ' + zaokr(opak) + ' g · ' : ''}${zaokr(p.kcal)} kcal / 100 g</div>
      <div class="zrodlo">${e(zrodlaOpis[skad] || 'Wasza baza')}</div>
    </div>
    <div class="sek-tyt">Ile zjadłeś</div>
    <div class="porcje" id="porcje">
      ${porcje.map((x, i) => `<button class="porcja" data-g="${x.g}" aria-pressed="${i === 0}" type="button">${x.etyk}</button>`).join('')}
      <button class="porcja" id="wlasna-g" type="button">wpisz…</button>
    </div>
    <div class="wynik" id="wynik"></div>
    <div class="sek-tyt">Do którego posiłku</div>
    <div class="gdzie" id="gdzie">
      ${POSILKI.map(([k, n]) => `<button data-p="${k}" aria-pressed="${k === posilekDocelowy}" type="button">${n}</button>`).join('')}
    </div>
    <div id="ark-komunikat"></div>
    <button class="cta" id="dodaj" type="button">Dodaj do dnia</button>`;

  function przelicz() {
    const m = wybrane / 100;
    ark.querySelector('#wynik').innerHTML = `
      <div class="wynik-kc">${zaokr(p.kcal * m)} kcal</div>
      <div class="wynik-mk">
        <span>B <b>${zaokr((p.bialko || 0) * m)} g</b></span>
        <span>T <b>${zaokr((p.tluszcz || 0) * m)} g</b></span>
        <span>W <b>${zaokr((p.wegle || 0) * m)} g</b></span>
        <span>${zaokr(wybrane)} g</span>
      </div>`;
  }
  przelicz();

  ark.querySelector('#porcje').onclick = (ev) => {
    const b = ev.target.closest('.porcja');
    if (!b || b.id === 'wlasna-g') return;
    ark.querySelectorAll('.porcja').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    wybrane = Number(b.dataset.g);
    przelicz();
  };
  ark.querySelector('#wlasna-g').onclick = () => {
    const v = prompt('Ile gramów?', String(zaokr(wybrane)));
    const n = Number(String(v || '').replace(',', '.'));
    if (!n || n <= 0) return;
    ark.querySelectorAll('.porcja').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    ark.querySelector('#wlasna-g').setAttribute('aria-pressed', 'true');
    wybrane = n;
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
    const etyk = ark.querySelector('.porcja[aria-pressed="true"]');
    try {
      const r = await authFetch('/api/eat/wpis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: dzienISO, posilek: posilekDocelowy, produkt_id: p.id,
          ilosc_g: wybrane, opis_porcji: etyk && etyk.id !== 'wlasna-g' ? etyk.textContent : null,
        }),
      });
      if (!r.ok) { const x = await r.json().catch(() => ({})); komunikat(x.detail || 'Nie udało się dodać.', true); ev.target.disabled = false; return; }
      zamknijArkusz();
      await wczytajDzien();
    } catch { komunikat('Błąd połączenia.', true); ev.target.disabled = false; }
  };
}

// ── ekran pozycji z opisu ───────────────────────────────────────────────────

function ekranPozycji(pozycje, opis) {
  const ark = arkusz.querySelector('.ark');
  ark.innerHTML = `
    <div class="ark-gl"><button class="x" id="wroc" type="button" style="margin:0" aria-label="Wróć">‹</button>
      <h2 style="font-size:1rem">Znalazłem</h2>
      <button class="x" id="zamknij2" type="button" aria-label="Zamknij">&times;</button></div>
    <div class="komunikat">Z opisu „${e(opis)}". Odznacz, czego nie jadłeś.</div>
    <div id="lista-poz">
      ${pozycje.map((p, i) => `
        <label class="szybka" style="cursor:pointer">
          <input type="checkbox" data-i="${i}" checked style="width:18px;height:18px;flex:none">
          <span class="nz"><b>${e(p.nazwa)}</b><span>${e(p.opis_porcji || '')} · ${zaokr(p.ilosc_g)} g</span></span>
          <span class="kc">${zaokr(p.kcal)}</span>
        </label>`).join('')}
    </div>
    <div class="sek-tyt" style="margin-top:12px">Do którego posiłku</div>
    <div class="gdzie" id="gdzie">
      ${POSILKI.map(([k, n]) => `<button data-p="${k}" aria-pressed="${k === posilekDocelowy}" type="button">${n}</button>`).join('')}
    </div>
    <div id="ark-komunikat"></div>
    <button class="cta" id="dodaj-wsz" type="button">Dodaj do dnia</button>`;

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
    const wybrane = [...ark.querySelectorAll('#lista-poz input:checked')].map((c) => pozycje[c.dataset.i]);
    if (!wybrane.length) { zamknijArkusz(); return; }
    komunikat('Zapisuję…');
    try {
      for (const p of wybrane) {
        await authFetch('/api/eat/wpis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: dzienISO, posilek: posilekDocelowy, nazwa: p.nazwa,
            opis_porcji: p.opis_porcji, ilosc_g: p.ilosc_g,
            kcal: p.kcal, bialko: p.bialko, tluszcz: p.tluszcz, wegle: p.wegle,
          }),
        });
      }
      zamknijArkusz();
      await wczytajDzien();
    } catch { komunikat('Błąd połączenia.', true); ev.target.disabled = false; }
  };
}

// ── cel dzienny ─────────────────────────────────────────────────────────────

function oknoCeli() {
  const c = (stanDnia && stanDnia.cele) || {};
  const o = document.createElement('div');
  o.className = 'ark-tlo';
  o.innerHTML = `
    <div class="ark" style="max-width:400px">
      <div class="ark-gl"><h2 style="font-size:1.05rem">Cel dzienny</h2>
        <button class="x" id="c-x" type="button" aria-label="Zamknij">&times;</button></div>
      <div class="komunikat">To od niego zależy skala pasków na dole. Cel jest Twój — Ola ma własny.</div>
      <div class="cele-row"><label for="c-kcal">Kalorie</label><input id="c-kcal" type="number" value="${zaokr(c.kcal)}"></div>
      <div class="cele-row"><label for="c-b">Białko (g)</label><input id="c-b" type="number" value="${zaokr(c.bialko)}"></div>
      <div class="cele-row"><label for="c-t">Tłuszcz (g)</label><input id="c-t" type="number" value="${zaokr(c.tluszcz)}"></div>
      <div class="cele-row"><label for="c-w">Węglowodany (g)</label><input id="c-w" type="number" value="${zaokr(c.wegle)}"></div>
      <div id="c-blad" class="komunikat blad"></div>
      <button class="cta" id="c-zapisz" type="button" style="margin-top:8px">Zapisz</button>
    </div>`;
  document.body.appendChild(o);
  o.addEventListener('click', (ev) => { if (ev.target === o) o.remove(); });
  o.querySelector('#c-x').onclick = () => o.remove();
  o.querySelector('#c-zapisz').onclick = async () => {
    const ciało = {
      kcal: Number(o.querySelector('#c-kcal').value),
      bialko: Number(o.querySelector('#c-b').value),
      tluszcz: Number(o.querySelector('#c-t').value),
      wegle: Number(o.querySelector('#c-w').value),
    };
    try {
      const r = await authFetch('/api/eat/cele', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ciało),
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
