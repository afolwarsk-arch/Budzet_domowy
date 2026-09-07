// Baza produktów gospodarstwa: przegląd tego, co apka już zna, i dokładanie
// tego, czego nie zna żadna baza.
//
// OSOBNA STRONA, NIE EKRAN W DZIENNIKU. Arkusz w `eat.js` jest zrośnięty
// z zapisem posiłku — każda jego droga kończy się pytaniem „ile zjadłeś"
// i wpisem do dnia. Tutaj droga kończy się produktem w bazie i niczym więcej;
// wciskanie obu zamiarów w jeden przepływ znaczyłoby, że przed zeskanowaniem
// kodu trzeba wiedzieć, w którym trybie się jest.
//
// Skanowanie kodu z ocenami przyszło tu z dawnej zakładki „Sprawdź produkt".
// Wszystkie oceny są CUDZE i opublikowane — nie liczymy własnego wskaźnika
// „zdrowe/niezdrowe", bo jednej liczby złożonej z wag dobranych przeze mnie
// nie dałoby się ani obronić, ani sprawdzić.

const NS_KOLOR = { a: '#038141', b: '#85bb2f', c: '#fecb02', d: '#ee8100', e: '#e63e11' };
const NS_OPIS = { a: 'bardzo dobra', b: 'dobra', c: 'średnia', d: 'słaba', e: 'bardzo słaba' };
const NOVA_KOLOR = { 1: '#038141', 2: '#85bb2f', 3: '#ee8100', 4: '#e63e11' };
const NOVA_OPIS = { 1: 'nieprzetworzone', 2: 'składnik kulinarny',
                    3: 'przetworzone', 4: 'wysoko przetworzone' };

// Progi „świateł" z brytyjskiego oznaczenia na froncie opakowania (FSA), na 100 g.
// Publikowane i powszechnie używane — dlatego bierzemy je zamiast wymyślać własne.
const PROGI = {
  tluszcz: { nazwa: 'Tłuszcz', niski: 3.0, wysoki: 17.5, jedn: 'g' },
  cukry:   { nazwa: 'Cukry',   niski: 5.0, wysoki: 22.5, jedn: 'g' },
  sol:     { nazwa: 'Sól',     niski: 0.3, wysoki: 1.5,  jedn: 'g' },
};

// Skąd wzięły się wartości. „Własne" to etykieta i ręczne wpisanie: nikt ich
// za nas nie sprawdzi, więc przy poprawianiu warto o tym wiedzieć.
const ZRODLA = {
  off: { opis: 'Open Food Facts', wlasny: false },
  etykieta: { opis: 'z etykiety', wlasny: true },
  reczne: { opis: 'ręcznie', wlasny: true },
  opis: { opis: 'z opisu', wlasny: true },
  baza: { opis: 'baza surowców', wlasny: false },
};

const e = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const zaokr = (v) => Math.round(Number(v) || 0);
const dziesietne = (v) => {
  const n = Number(v) || 0;
  return (Math.round(n * 10) / 10).toString().replace('.', ',');
};

let produkty = [];
let filtr = 'wszystkie';
let fraza = '';
let ark = null;
// Co przenosi się MIĘDZY drogami: kod z nieudanego skanu i odczyt z przodu
// opakowania. Bez tego zdjęcie tabeli z tyłu ląduje w bazie bez nazwy i bez
// kodu — tabela żadnego z nich nie zawiera.
let kontekst = {};

// ── lista ───────────────────────────────────────────────────────────────────

async function wczytaj() {
  try {
    const r = await authFetch('/api/eat/produkty');
    produkty = await r.json();
    if (!Array.isArray(produkty)) produkty = [];
  } catch {
    document.getElementById('lista').innerHTML =
      '<div class="komunikat blad">Nie udało się wczytać bazy.</div>';
    return;
  }
  rysuj();
}

function wlasny(p) {
  const z = ZRODLA[p.zrodlo];
  return z ? z.wlasny : true;
}

function pasuje(p) {
  if (filtr === 'wlasne' && !wlasny(p)) return false;
  if (filtr === 'ulubione' && !p.ulubiony) return false;
  if (!fraza) return true;
  const szukane = fraza.toLowerCase();
  return (p.nazwa || '').toLowerCase().includes(szukane)
    || (p.marka || '').toLowerCase().includes(szukane)
    || (p.kod || '').includes(szukane);
}

function rysuj() {
  const widoczne = produkty.filter(pasuje);
  document.getElementById('ile').textContent = produkty.length
    ? `${widoczne.length} z ${produkty.length}` : '';
  const box = document.getElementById('lista');
  if (!produkty.length) {
    box.innerHTML = `<div class="pusto">Baza jest pusta.<br>
      Stuknij „Dodaj produkt" i zeskanuj pierwszy kod.</div>`;
    return;
  }
  if (!widoczne.length) {
    box.innerHTML = '<div class="pusto">Nic nie pasuje do tego, czego szukasz.</div>';
    return;
  }
  box.innerHTML = widoczne.map((p, i) => {
    const z = ZRODLA[p.zrodlo] || { opis: p.zrodlo, wlasny: true };
    const opis = [
      p.marka ? e(p.marka) : '',
      p.opak_g ? 'opak. ' + zaokr(p.opak_g) + ' g' : '',
      p.uzyc ? 'użyć: ' + p.uzyc : 'nieużywany',
    ].filter(Boolean).join(' · ');
    return `<button class="poz" type="button" data-i="${i}">
      <span class="nz"><b>${e(p.nazwa)}</b><span>${opis}</span></span>
      ${p.ulubiony ? '<span class="serce" aria-label="ulubiony">&#9829;</span>' : ''}
      <span class="zn${z.wlasny ? ' wlasny' : ''}">${e(z.opis)}</span>
      <span class="kc">${zaokr(p.kcal)}</span>
    </button>`;
  }).join('');
  box.querySelectorAll('[data-i]').forEach((b) => {
    b.onclick = () => ekranProduktu(widoczne[Number(b.dataset.i)]);
  });
}

// ── arkusz ──────────────────────────────────────────────────────────────────

function otworzArkusz() {
  if (ark) return ark.querySelector('.ark');
  ark = document.createElement('div');
  ark.className = 'ark-tlo';
  ark.innerHTML = '<div class="ark"></div>';
  document.body.appendChild(ark);
  ark.addEventListener('click', (ev) => { if (ev.target === ark) zamknij(); });
  // W trybie aplikacji „wstecz" jest podstawowym gestem zamykania. Bez wpisu
  // w historii wychodziłoby z modułu i gasiło wypełniony formularz.
  try {
    if (!(history.state && history.state.ark)) history.pushState({ ark: 1 }, '');
  } catch {}
  return ark.querySelector('.ark');
}

function zamknij(zHistorii) {
  if (window.Skaner) window.Skaner.stop();
  // Nasłuch mikrofonu żyje poza DOM-em: bez tego dyktowanie chodziło dalej po
  // zamknięciu arkusza, a jego wynik nie miał już gdzie trafić.
  if (window.Dyktowanie) Dyktowanie.stop();
  kontekst = {};
  if (!ark) return;
  ark.remove();
  ark = null;
  if (!zHistorii && history.state && history.state.ark) {
    try { history.back(); } catch {}
  }
}

window.addEventListener('popstate', () => { if (ark) zamknij(true); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && ark) zamknij(); });

// Nagłówek arkusza. `wroc` dostaje funkcję, gdy z tego ekranu jest dokąd wracać
// — martwa strzałka na pierwszym ekranie uczyłaby, że nie działa.
function naglowek(tytul, wroc) {
  return `<div class="ark-gl">
    ${wroc ? '<button class="x" id="a-wroc" type="button" aria-label="Wróć">&lsaquo;</button>' : ''}
    <h2>${e(tytul)}</h2>
    <button class="x koniec" id="a-x" type="button" aria-label="Zamknij">&times;</button>
  </div>`;
}

function podepnijNaglowek(box, wroc) {
  box.querySelector('#a-x').onclick = () => zamknij();
  const b = box.querySelector('#a-wroc');
  if (b) b.onclick = wroc;
}

function czekaj(box, tytul, podpis) {
  if (window.Skaner) window.Skaner.stop();
  box.innerHTML = naglowek(tytul) + `<div class="komunikat">${e(podpis)}</div>`;
  podepnijNaglowek(box);
}

// ── ekran dróg ──────────────────────────────────────────────────────────────

function ekranDrog() {
  const box = otworzArkusz();
  if (window.Skaner) window.Skaner.stop();
  box.innerHTML = naglowek('Dodaj produkt') + `
    <div class="drogi">
      <button class="droga glowna" id="d-skan" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5V5a1.5 1.5 0 0 1 1.5-1.5h2.5M16.5 3.5H19A1.5 1.5 0 0 1 20.5 5v2.5M20.5 16.5V19a1.5 1.5 0 0 1-1.5 1.5h-2.5M7.5 20.5H5A1.5 1.5 0 0 1 3.5 19v-2.5"/><path d="M7 8v8M10 8v8M13.5 8v8M17 8v8"/></svg>
        <span><span class="t">Skanuj kod kreskowy</span><span class="o">Najszybsze przy wszystkim z opakowania</span></span>
      </button>
      <!-- <label for>, a NIE przycisk wołający .click() ze skryptu. Etykieta
           otwiera wybór pliku natywnie — to znosi całą klasę błędów, w której
           stuknięcie nic nie robiło i nawet nie zgłaszało błędu.

           DWA pola na jedno zdjęcie, bo Android nie daje wyboru w jednym:
           atrybut capture otwiera wyłącznie aparat, jego brak wyłącznie galerię.
           Kafelek z dwoma etykietami zostawia decyzję człowiekowi i nie
           kosztuje dodatkowego ekranu. -->
      <div class="droga droga-zrodla">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="3.5" width="13" height="17" rx="2"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4"/></svg>
        <span class="t">Zdjęcie przodu</span><span class="o">Odczyta nazwę i poszuka w bazie</span>
        <span class="zrodla">
          <label class="zrodlo" for="p-przod-ap" tabindex="0" role="button">Aparat</label>
          <label class="zrodlo" for="p-przod" tabindex="0" role="button">Z dysku</label>
        </span>
      </div>
      <div class="droga droga-zrodla">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="17" height="13" rx="2.5"/><circle cx="12" cy="12.5" r="3.4"/><path d="M8.5 6l1.4-2.2h4.2L15.5 6"/></svg>
        <span class="t">Zdjęcie tabeli z tyłu</span><span class="o">Gdy trzeba odczytać wartości odżywcze</span>
        <span class="zrodla">
          <label class="zrodlo" for="p-tyl-ap" tabindex="0" role="button">Aparat</label>
          <label class="zrodlo" for="p-tyl" tabindex="0" role="button">Z dysku</label>
        </span>
      </div>
      <button class="droga" id="d-opis" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9"/></svg>
        <span class="t">Opisz słowami</span><span class="o">Domowy wypiek, warzywa na wagę — AI oszacuje wartości</span>
      </button>
      <button class="droga" id="d-recznie" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1.2-4.2L15.6 5.4a2.2 2.2 0 0 1 3.1 3.1L8.2 18.8z"/><path d="M14 7l3 3"/></svg>
        <span class="t">Wypełnij ręcznie</span><span class="o">Gdy znasz wartości i chcesz je po prostu wpisać</span>
      </button>
    </div>
    <div id="podglad">
      <video id="video" playsinline muted></video>
      <div class="komunikat">Skieruj aparat na kod kreskowy.</div>
    </div>
    <div class="sek-tyt">Albo wpisz cyfry spod kreskówki</div>
    <div class="szukaj">
      <input type="text" id="kod-reczny" inputmode="numeric" placeholder="np. 5900512300016"
             aria-label="Kod kreskowy">
      <button class="cta druga" id="kod-idz" type="button" style="width:auto;padding:0 16px">Sprawdź</button>
    </div>
    <div id="a-kom"></div>
    <input type="file" id="p-przod" accept="image/*" class="schowane">
    <input type="file" id="p-przod-ap" accept="image/*" capture="environment" class="schowane">
    <input type="file" id="p-tyl" accept="image/*" class="schowane">
    <input type="file" id="p-tyl-ap" accept="image/*" capture="environment" class="schowane">`;
  podepnijNaglowek(box);
  box.querySelector('#d-skan').onclick = skanuj;
  box.querySelector('#d-opis').onclick = () => ekranOpisu();
  box.querySelector('#d-recznie').onclick = () => ekranReczny(null, {});
  podepnijKlawisze(box);
  podepnijZdjecia(box, { '#p-przod': wyslijPrzod, '#p-przod-ap': wyslijPrzod,
                         '#p-tyl': wyslijTabele, '#p-tyl-ap': wyslijTabele });
  const idz = () => poKodzie(box.querySelector('#kod-reczny').value);
  box.querySelector('#kod-idz').onclick = idz;
  box.querySelector('#kod-reczny').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); idz(); }
  });
}

// Etykiety otwierają wybór pliku same z siebie; skrypt jest tu tylko po to, żeby
// działały także z klawiatury — na <label> Enter nic nie robi.
function podepnijKlawisze(box) {
  box.querySelectorAll('label.zrodlo[for], label.cta[for]').forEach((l) => {
    l.onkeydown = (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      const cel = document.getElementById(l.getAttribute('for'));
      if (cel) cel.click();
    };
  });
}

// Pola zdjęć chodzą PARAMI (aparat / dysk), a obsługa jest ta sama — skąd plik
// przyszedł, nie zmienia niczego po naszej stronie. Czyszczenie `value` po
// każdym wyborze, żeby ten sam plik dwa razy z rzędu też zadziałał.
function podepnijZdjecia(box, mapa) {
  Object.entries(mapa).forEach(([sel, obsluga]) => {
    const pole = box.querySelector(sel);
    if (!pole) return;
    pole.onchange = (ev) => {
      const plik = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (plik) obsluga(plik);
    };
  });
}

function kom(tekst, blad) {
  const el = ark && ark.querySelector('#a-kom');
  if (!el) return;
  el.className = 'komunikat' + (blad ? ' blad' : '');
  el.textContent = tekst || '';
}

// ── droga 1: kod kreskowy ───────────────────────────────────────────────────

function skanuj() {
  if (!window.Skaner) { kom('Skaner się nie wczytał. Wpisz cyfry ręcznie.', true); return; }
  kom('Uruchamiam aparat…');
  window.Skaner.start({
    video: ark.querySelector('#video'),
    wrap: ark.querySelector('#podglad'),
    onPodglad: () => kom(''),
    onKod: (kod) => poKodzie(kod),
    onBlad: (t) => kom(t, true),
    onCisza: () => kom('Nie widzę kodu. Podejdź bliżej albo wpisz cyfry ręcznie.'),
  });
}

async function poKodzie(kod) {
  const czysty = String(kod || '').replace(/\D/g, '');
  if (czysty.length < 6) { kom('Kod ma co najmniej 6 cyfr.', true); return; }
  const box = otworzArkusz();
  czekaj(box, 'Sprawdzam kod', 'Szukam ' + czysty + ' w Waszej bazie i w Open Food Facts…');
  let r;
  try {
    r = await authFetch('/api/eat/produkt?kod=' + encodeURIComponent(czysty));
  } catch {
    ekranBledu('Błąd połączenia.', ekranDrog);
    return;
  }
  if (r.status === 404) { ekranNieznany(czysty); return; }
  if (!r.ok) { ekranBledu('Nie udało się sprawdzić kodu.', ekranDrog); return; }
  const d = await r.json().catch(() => ({}));
  const p = d.produkt || d;
  // `/produkt` zapisuje trafienie z Open Food Facts do bazy gospodarstwa —
  // dlatego przy „off" produkt JUŻ jest dodany i mówimy o tym wprost, zamiast
  // dawać przycisk, który niczego by nie zmienił.
  await wczytaj();
  ekranProduktu(p, { skad: d.skad, niepelne: d.niepelne });
}

// Kodu nie zna nikt — to jest dokładnie ten przypadek, dla którego powstała ta
// strona. Zamiast komunikatu o porażce dajemy trzy drogi dalej, każda z kodem
// zapamiętanym w tle.
function ekranNieznany(kod) {
  kontekst.kod = kod;
  const box = otworzArkusz();
  box.innerHTML = naglowek('Nieznany kod', true) + `
    <div class="komunikat">Kodu <b>${e(kod)}</b> nie ma ani w Waszej bazie, ani
      w Open Food Facts. Dodaj produkt jedną z dróg poniżej — kod zapamiętam
      i następnym razem wystarczy go zeskanować.</div>
    <div class="drogi">
      <div class="droga droga-zrodla">
        <span class="t">Zdjęcie przodu</span><span class="o">Odczyta nazwę i gramaturę</span>
        <span class="zrodla">
          <label class="zrodlo" for="n-przod-ap" tabindex="0" role="button">Aparat</label>
          <label class="zrodlo" for="n-przod" tabindex="0" role="button">Z dysku</label>
        </span>
      </div>
      <div class="droga droga-zrodla">
        <span class="t">Zdjęcie tabeli z tyłu</span><span class="o">Odczyta wartości odżywcze</span>
        <span class="zrodla">
          <label class="zrodlo" for="n-tyl-ap" tabindex="0" role="button">Aparat</label>
          <label class="zrodlo" for="n-tyl" tabindex="0" role="button">Z dysku</label>
        </span>
      </div>
      <button class="droga" id="n-opis" type="button">
        <span class="t">Opisz słowami</span><span class="o">AI oszacuje wartości na 100 g</span>
      </button>
      <button class="droga" id="n-recznie" type="button">
        <span class="t">Wypełnij ręcznie</span><span class="o">Gdy zdjęcie i tak nic nie da</span>
      </button>
    </div>
    <div id="a-kom"></div>
    <input type="file" id="n-przod" accept="image/*" class="schowane">
    <input type="file" id="n-przod-ap" accept="image/*" capture="environment" class="schowane">
    <input type="file" id="n-tyl" accept="image/*" class="schowane">
    <input type="file" id="n-tyl-ap" accept="image/*" capture="environment" class="schowane">`;
  podepnijNaglowek(box, ekranDrog);
  box.querySelector('#n-opis').onclick = () => ekranOpisu();
  box.querySelector('#n-recznie').onclick = () => ekranReczny(null, { kod });
  podepnijKlawisze(box);
  podepnijZdjecia(box, { '#n-przod': wyslijPrzod, '#n-przod-ap': wyslijPrzod,
                         '#n-tyl': wyslijTabele, '#n-tyl-ap': wyslijTabele });
}

// ── droga 2: zdjęcie przodu opakowania ──────────────────────────────────────

async function wyslijPrzod(plik) {
  const box = otworzArkusz();
  czekaj(box, 'Czytam opakowanie', 'Odczytuję nazwę i szukam jej w bazie produktów.');
  const fd = new FormData();
  fd.append('file', plik);
  let d;
  try {
    const r = await authFetch('/api/eat/etykieta-przod', { method: 'POST', body: fd });
    d = await r.json().catch(() => ({}));
    if (!r.ok) { ekranBledu(d.detail || 'Nie udało się odczytać opakowania.', ekranDrog); return; }
  } catch { ekranBledu('Błąd połączenia.', ekranDrog); return; }
  ekranZPrzodu(d);
}

function ekranZPrzodu(d) {
  const box = otworzArkusz();
  const o = d.odczyt || {};
  const wlasne = d.wlasne || [];
  // Nazwa i gramatura z przodu doklejają się potem do wartości odczytanych
  // z tyłu — tamta tabela nie zawiera ani jednego, ani drugiego.
  kontekst.przod = o;

  const wiersz = (p, rodzaj) => `<button class="szybka" data-rodzaj="${rodzaj}"
      data-kod="${e(p.kod || '')}" data-id="${p.id || ''}" type="button">
    <span class="nz"><b>${e(p.nazwa)}</b><span>${(p.marka ? e(p.marka) + ' · ' : '')
      + (p.kcal ? zaokr(p.kcal) + ' kcal/100 g' : 'brak wartości w bazie')}</span></span>
  </button>`;

  const propozycje = d.propozycje || [];
  box.innerHTML = naglowek('Odczytane z opakowania', true) + `
    <div class="prod-gora">
      <div class="marka">${e(o.marka || '')}</div>
      <h3>${e(o.nazwa || '')}</h3>
      <div class="op">${o.opak_g ? 'opakowanie ' + zaokr(o.opak_g) + ' g' : 'gramatury nie widać'}${
        o.sztuk ? ' · ' + zaokr(o.sztuk) + ' szt.' : ''}</div>
    </div>
    ${d.off_padlo ? '<div class="komunikat blad">Baza produktów markowych odmówiła odpowiedzi '
      + '(odbija większość zapytań przy natłoku). To NIE znaczy, że produktu tam nie ma — '
      + 'spróbuj poszukać jeszcze raz.</div>' : ''}
    ${wlasne.length ? '<div class="sek-tyt">Macie już u siebie</div>'
      + wlasne.map((p) => wiersz(p, 'wlasna')).join('') : ''}
    <div class="sek-tyt">Znalezione w bazie zewnętrznej</div>
    <div id="p-wyniki">${propozycje.length
      ? propozycje.map((p) => wiersz(p, 'off')).join('')
      : `<div class="komunikat">${d.off_padlo ? 'Nie udało się sprawdzić.'
        : 'Nic nie znalazłem pod tą nazwą.'}</div>`}</div>
    <div class="szukaj" style="margin-top:8px">
      <input type="text" id="p-fraza" value="${e(d.szukano_zapasowo || d.szukano || o.nazwa || '')}"
             autocomplete="off" aria-label="Czego szukać w bazie">
      <button class="cta druga" id="p-szukaj" type="button" style="width:auto;padding:0 16px">Szukaj</button>
    </div>
    <div class="komunikat">Możesz poprawić hasło i poszukać ponownie — bez robienia
      zdjęcia od nowa.</div>
    <div class="sek-tyt">Albo dokończ sam</div>
    <div class="droga droga-zrodla">
      <span class="t">Zdjęcie tabeli z tyłu</span><span class="o">Stamtąd biorą się wartości odżywcze</span>
      <span class="zrodla">
        <label class="zrodlo" for="z-tyl-ap" tabindex="0" role="button">Aparat</label>
        <label class="zrodlo" for="z-tyl" tabindex="0" role="button">Z dysku</label>
      </span>
    </div>
    <input type="file" id="z-tyl" accept="image/*" class="schowane">
    <input type="file" id="z-tyl-ap" accept="image/*" capture="environment" class="schowane">
    <button class="cta druga" id="z-recznie" type="button" style="margin-top:8px">
      Wpisz wartości ręcznie</button>
    <div id="a-kom"></div>`;
  podepnijNaglowek(box, ekranDrog);

  podepnijKlawisze(box);
  podepnijZdjecia(box, { '#z-tyl': wyslijTabele, '#z-tyl-ap': wyslijTabele });
  // Ręczne dokończenie startuje z tym, co model odczytał z przodu — przepisywanie
  // nazwy, którą apka przed chwilą pokazała, byłoby pracą za darmo.
  box.querySelector('#z-recznie').onclick = () => ekranReczny(null, {
    nazwa: o.nazwa, marka: o.marka, opak_g: o.opak_g,
    sztuk_w_opak: o.sztuk, kod: kontekst.kod || '',
  });

  const podepnijWyniki = () => {
    box.querySelectorAll('[data-rodzaj]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.rodzaj === 'wlasna') {
          const p = wlasne.find((x) => String(x.id) === b.dataset.id);
          if (p) ekranProduktu(p, { skad: 'wlasna' });
        } else if (b.dataset.kod) {
          poKodzie(b.dataset.kod);
        }
      };
    });
  };
  podepnijWyniki();

  // Powtórne szukanie BEZ ponownego zdjęcia. Open Food Facts odbija większość
  // anonimowych zapytań i wtedy „nic nie znalazłem" jest nieprawdą — produkt
  // często tam jest, tylko serwer odmówił odpowiedzi.
  const szukajPonownie = async () => {
    const f = box.querySelector('#p-fraza').value.trim();
    if (f.length < 3) return;
    const wyn = box.querySelector('#p-wyniki');
    wyn.innerHTML = '<div class="komunikat">Szukam…</div>';
    try {
      const r = await authFetch('/api/eat/szukaj/off?fraza=' + encodeURIComponent(f));
      const x = await r.json().catch(() => ({}));
      const lista = x.propozycje || [];
      wyn.innerHTML = lista.length
        ? lista.map((p) => wiersz(p, 'off')).join('')
        : `<div class="komunikat${x.off_padlo ? ' blad' : ''}">${x.off_padlo
          ? 'Baza znowu odmówiła. Spróbuj jeszcze raz za chwilę.'
          : 'Nic nie znalazłem pod tym hasłem.'}</div>`;
      podepnijWyniki();
    } catch { wyn.innerHTML = '<div class="komunikat blad">Błąd połączenia.</div>'; }
  };
  box.querySelector('#p-szukaj').onclick = szukajPonownie;
  box.querySelector('#p-fraza').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); szukajPonownie(); }
  });
}

// ── droga 3: zdjęcie tabeli wartości ────────────────────────────────────────

async function wyslijTabele(plik) {
  const box = otworzArkusz();
  czekaj(box, 'Czytam etykietę', 'Odczytuję wartości odżywcze z tabeli.');
  const fd = new FormData();
  fd.append('file', plik);
  const przod = kontekst.przod || {};
  if (przod.nazwa) fd.append('nazwa', przod.nazwa);
  if (przod.marka) fd.append('marka', przod.marka);
  if (przod.opak_g) fd.append('opak_g', String(przod.opak_g));
  if (przod.sztuk) fd.append('sztuk', String(przod.sztuk));
  const adres = '/api/eat/etykieta' + (kontekst.kod ? '?kod=' + encodeURIComponent(kontekst.kod) : '');
  let d;
  try {
    const r = await authFetch(adres, { method: 'POST', body: fd });
    d = await r.json().catch(() => ({}));
    if (!r.ok) { ekranBledu(d.detail || 'Nie udało się odczytać etykiety.', ekranDrog); return; }
  } catch { ekranBledu('Błąd połączenia.', ekranDrog); return; }
  await wczytaj();
  ekranProduktu(d.produkt, { skad: 'etykieta' });
}

// ── droga 4: opis słowami ───────────────────────────────────────────────────
//
// Dla wszystkiego, co nie ma ani kodu, ani etykiety: domowy wypiek, warzywa
// na wagę, bułka z lokalnej piekarni. Dotąd jedyną drogą było ręczne wpisanie
// siedmiu liczb, których nikt nie zna z głowy — czyli w praktyce produkt
// nie trafiał do bazy wcale.
//
// Osobny endpoint, a nie ten od dziennika: baza trzyma wartości NA 100 G,
// a tamten szacuje zjedzoną porcję. Przeliczanie jednego na drugie wnosiłoby
// do stałej wartości błąd zgadywania wielkości porcji.
// `wstepny` niesie z powrotem to, co już napisano: po nieudanym oszacowaniu
// ekran budowany jest od zera i bez tego kasowałby cały opis.
function ekranOpisu(wstepny) {
  const box = otworzArkusz();
  if (window.Skaner) window.Skaner.stop();
  box.innerHTML = naglowek('Opisz produkt', true) + `
    <div class="sek-tyt">Co to jest</div>
    <button class="dyktuj hidden" id="dyktuj" type="button" aria-pressed="false">
      <span class="dyktuj-kropka"></span><span id="dyktuj-napis">Podyktuj opis</span>
    </button>
    <textarea id="o-opis" placeholder="np. domowy sernik na kruchym spodzie, z twarogu półtłustego, bez rodzynek">${e(wstepny || '')}</textarea>
    <div class="komunikat">Im więcej szczegółów, tym bliżej prawdy: rodzaj, tłustość,
      z czego zrobione. Wartości wyjdą <b>na 100 g</b> i przed zapisem zobaczysz je
      w formularzu.</div>
    <div id="a-kom"></div>
    <button class="cta" id="o-szacuj" type="button">Oszacuj wartości</button>`;
  podepnijNaglowek(box, ekranDrog);

  // Dyktowanie DOPISUJE nową linią zamiast podmieniać pole: opis produktu
  // uzupełnia się partiami, a każda przerwa w mówieniu kończy nasłuch.
  const btn = box.querySelector('#dyktuj');
  const pole = box.querySelector('#o-opis');
  const napis = box.querySelector('#dyktuj-napis');
  if (window.Dyktowanie && Dyktowanie.dostepne()) {
    btn.classList.remove('hidden');
    btn.onclick = () => {
      if (Dyktowanie.sluchaMy()) { Dyktowanie.stop(); return; }
      Dyktowanie.start({
        onStan: (slucha) => {
          btn.setAttribute('aria-pressed', slucha ? 'true' : 'false');
          napis.textContent = slucha ? 'Słucham… (stuknij, by zakończyć)' : 'Podyktuj opis';
        },
        onTekst: (tekst) => {
          if (!tekst) return;
          const teraz = pole.value;
          pole.value = teraz && !teraz.endsWith('\n') ? teraz + '\n' + tekst : teraz + tekst;
          kom('Dopisano: „' + tekst + '". Możesz mówić dalej albo oszacować.');
        },
        onBlad: (t) => kom(t, true),
      });
    };
  }

  box.querySelector('#o-szacuj').onclick = async (ev) => {
    const opis = pole.value.trim();
    if (opis.length < 3) { kom('Napisz, co to za produkt.', true); pole.focus(); return; }
    if (window.Dyktowanie) Dyktowanie.stop();
    ev.target.disabled = true;
    czekaj(box, 'Szacuję', 'Liczę wartości odżywcze na 100 g produktu.');
    let d;
    try {
      const r = await authFetch('/api/eat/produkty/z-opisu', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opis }),
      });
      d = await r.json().catch(() => ({}));
      if (!r.ok) {
        ekranBledu(d.detail || 'Nie udało się oszacować.', () => ekranOpisu(opis));
        return;
      }
    } catch { ekranBledu('Błąd połączenia.', () => ekranOpisu(opis)); return; }
    // Wynik NIE idzie prosto do bazy — ląduje w formularzu, gdzie widać każdą
    // liczbę i można ją poprawić przed zapisem.
    ekranReczny(null, Object.assign({}, d.produkt, {
      kod: kontekst.kod || '',
      zrodlo: 'opis',
      pewnosc: d.pewnosc,
      uwaga: d.uwaga,
    }));
  };
}

// ── droga 5: ręcznie ────────────────────────────────────────────────────────

// `edytowany` niepuste = poprawiamy istniejący produkt. To ten sam formularz,
// bo pola są te same, a osobny ekran do poprawek rozjechałby się z tym przy
// pierwszej zmianie.
function ekranReczny(edytowany, wstepne) {
  const p = edytowany || wstepne || {};
  const box = otworzArkusz();
  const pole = (id, etykieta, wartosc, dodatki = '') =>
    `<div class="pole"><label for="f-${id}">${etykieta}</label>
      <input id="f-${id}" ${dodatki} value="${wartosc == null ? '' : e(wartosc)}"></div>`;
  const num = 'type="text" inputmode="decimal" autocomplete="off"';
  // Wartości z AI są ZGADYWANE i muszą tak wyglądać. Formularz wypełniony po
  // cichu niczym się nie różni od przepisanej etykiety, a różnica jest cała:
  // etykietę ktoś zmierzył, oszacowanie ktoś obstawił.
  const zOpisu = !edytowany && p.zrodlo === 'opis';
  const PEWNOSC = { wysoka: 'produkt typowy, wartości powinny być blisko',
                    'średnia': 'przepisy bywają różne — sprawdź, czy to Wasz',
                    niska: 'model zgadywał, potraktuj to jak punkt wyjścia' };
  box.innerHTML = naglowek(edytowany ? 'Popraw produkt' : 'Nowy produkt', true)
    + (zOpisu ? `<div class="uwaga-ai">
        <b>Oszacowane przez AI, nie odczytane z etykiety.</b>
        ${p.uwaga ? ' ' + e(p.uwaga) : ''}
        ${PEWNOSC[p.pewnosc] ? '<br>Pewność ' + e(p.pewnosc) + ' — '
          + PEWNOSC[p.pewnosc] + '.' : ''}
        <br>Popraw, co wiesz lepiej, i dopiero wtedy zapisz.
      </div>` : '') + `
    <div class="pola">
      <div class="pole cale"><label for="f-nazwa">Nazwa</label>
        <input id="f-nazwa" value="${e(p.nazwa || '')}" autocomplete="off"
               placeholder="np. Twaróg półtłusty"></div>
      ${pole('marka', 'Marka', p.marka, 'autocomplete="off"')}
      ${pole('kod', 'Kod kreskowy', p.kod, 'inputmode="numeric" autocomplete="off"')}
    </div>
    <div class="sek-tyt">Wartości na 100 g</div>
    <div class="na100">Tak stoi na każdej etykiecie i tak trzyma je baza —
      przepisz kolumnę „w 100 g", nie „w porcji".</div>
    <div class="pola">
      ${pole('kcal', 'Kalorie', p.kcal, num)}
      ${pole('bialko', 'Białko (g)', p.bialko, num)}
      ${pole('tluszcz', 'Tłuszcz (g)', p.tluszcz, num)}
      ${pole('wegle', 'Węglowodany (g)', p.wegle, num)}
      ${pole('cukry', 'w tym cukry (g)', p.cukry, num)}
      ${pole('blonnik', 'Błonnik (g)', p.blonnik, num)}
      ${pole('sol', 'Sól (g)', p.sol, num)}
    </div>
    <div class="sek-tyt">Opakowanie</div>
    <div class="pola">
      ${pole('opak_g', 'Całe opakowanie (g)', p.opak_g, num)}
      ${pole('sztuk_w_opak', 'Sztuk w opakowaniu', p.sztuk_w_opak, 'inputmode="numeric"')}
      ${pole('porcja_g', 'Waga sztuki (g)', p.porcja_g, num)}
      ${pole('opis_porcji', 'Nazwa sztuki', p.opis_porcji, 'autocomplete="off" placeholder="np. kromka"')}
    </div>
    <div id="a-kom"></div>
    <button class="cta" id="f-zapisz" type="button">${
      edytowany ? 'Zapisz zmiany' : 'Dodaj do bazy'}</button>`;
  podepnijNaglowek(box, edytowany ? () => ekranProduktu(edytowany) : ekranDrog);

  const wartosc = (id) => box.querySelector('#f-' + id).value.trim();
  box.querySelector('#f-zapisz').onclick = async () => {
    const dane = {};
    ['nazwa', 'marka', 'kod', 'kcal', 'bialko', 'tluszcz', 'wegle', 'cukry', 'blonnik',
     'sol', 'opak_g', 'sztuk_w_opak', 'porcja_g', 'opis_porcji'].forEach((k) => {
      dane[k] = wartosc(k) || null;
    });
    if (!dane.nazwa) { kom('Podaj nazwę produktu.', true); return; }
    // Znacznik źródła na liście produktów: „z opisu" kontra „ręcznie". Bez tego
    // po tygodniu nie widać, które liczby ktoś przepisał, a które obstawił model.
    if (zOpisu) dane.zrodlo = 'opis';
    const btn = box.querySelector('#f-zapisz');
    btn.disabled = true;
    try {
      const r = await authFetch(
        edytowany ? '/api/eat/produkty/' + edytowany.id : '/api/eat/produkty',
        { method: edytowany ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dane) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { kom(d.detail || 'Nie udało się zapisać.', true); btn.disabled = false; return; }
      await wczytaj();
      ekranProduktu(d.produkt, { skad: edytowany ? null : 'nowy' });
    } catch {
      kom('Błąd połączenia — produkt nie został zapisany.', true);
      btn.disabled = false;
    }
  };
  const poleNazwy = box.querySelector('#f-nazwa');
  if (poleNazwy && !poleNazwy.value) poleNazwy.focus();
}

// ── karta produktu ──────────────────────────────────────────────────────────

function swiatlo(wartosc, prog) {
  if (wartosc == null) return null;
  if (wartosc <= prog.niski) return { kolor: '#038141', slowo: 'mało' };
  if (wartosc > prog.wysoki) return { kolor: '#e63e11', slowo: 'dużo' };
  return { kolor: '#fecb02', slowo: 'średnio' };
}

function wierszOdzywczy(klucz, wartosc) {
  const prog = PROGI[klucz];
  const s = swiatlo(wartosc, prog);
  if (!s) return '';
  // Pasek pokazuje położenie wartości względem progu „dużo" — powyżej niego
  // wypełnia się do końca, bo dalsza skala już niczego nie różnicuje.
  const udzial = Math.min(100, (Number(wartosc) / prog.wysoki) * 100);
  return `<div class="odz">
    <span class="odz-pas"><i style="width:${Math.max(6, udzial)}%;background:${s.kolor}"></i></span>
    <span class="odz-n">${prog.nazwa}</span>
    <span class="odz-w">${dziesietne(wartosc)} ${prog.jedn}</span>
    <span class="odz-p">${s.slowo}</span>
  </div>`;
}

function ekranProduktu(p, opcje = {}) {
  if (!p) { ekranBledu('Nie znam tego produktu.', ekranDrog); return; }
  const box = otworzArkusz();
  const ns = (p.nutriscore || '').toLowerCase();
  const nova = Number(p.nova) || 0;
  const dodatki = p.dodatki;
  const ocena = (duza, kolor, maly) => `<div class="ocena"${kolor ? ` style="border-color:${kolor}"` : ''}>
    <span class="duza"${kolor ? ` style="color:${kolor}"` : ' style="color:var(--muted)"'}>${duza}</span>
    <span class="maly">${maly}</span></div>`;

  // Nagłówek mówi, co się przed chwilą stało. Po skanie produkt JUŻ jest
  // w bazie (`/produkt` go zapisuje), więc przycisk „dodaj" byłby kłamstwem —
  // zamiast niego stoi zdanie o tym, że jest.
  const stan = {
    off: 'Znaleziony w Open Food Facts i dodany do Waszej bazy.',
    etykieta: 'Odczytany z etykiety i dodany do Waszej bazy.',
    nowy: 'Dodany do Waszej bazy.',
    wlasna: 'Ten produkt już macie u siebie.',
  }[opcje.skad];

  // Strzałka „wróć" TYLKO wtedy, gdy jest dokąd wracać. Otwarta z listy karta
  // ma jedno wyjście — zamknięcie — a dwa przyciski robiące to samo uczą, że
  // jeden z nich jest nieprzewidywalny.
  box.innerHTML = naglowek('Produkt', !!opcje.skad) + `
    <div class="prod-gora">
      ${p.marka ? `<div class="marka">${e(p.marka)}</div>` : ''}
      <h3>${e(p.nazwa)}</h3>
      <div class="op">${p.kod ? 'kod ' + e(p.kod) : 'bez kodu kreskowego'}${
        p.opak_g ? ' · opakowanie ' + zaokr(p.opak_g) + ' g' : ''}${
        p.sztuk_w_opak ? ' · ' + p.sztuk_w_opak + ' szt.' : ''}</div>
    </div>
    ${stan ? `<div class="komunikat">${e(stan)}</div>` : ''}
    ${opcje.niepelne ? '<div class="komunikat blad">Baza nie miała kompletu wartości — '
      + 'sprawdź je i popraw, zanim zaczniesz z tego liczyć.</div>' : ''}

    <div class="oceny">
      ${ns ? ocena(ns.toUpperCase(), NS_KOLOR[ns], `Nutri-Score<br>${NS_OPIS[ns]} jakość odżywcza`)
           : ocena('—', null, 'Nutri-Score<br>brak w bazie')}
      ${nova ? ocena(nova, NOVA_KOLOR[nova], `NOVA<br>${NOVA_OPIS[nova]}`)
             : ocena('—', null, 'NOVA<br>brak w bazie')}
      ${dodatki === null || dodatki === undefined
        ? ocena('—', null, 'Dodatki<br>brak danych')
        : ocena(dodatki, dodatki ? null : '#038141', 'dodatków (E)<br>bez oceny szkodliwości')}
    </div>

    <div class="sek-tyt">Wartości na 100 g</div>
    <div class="odz"><span class="odz-pas"></span><span class="odz-n">Kalorie</span>
      <span class="odz-w">${zaokr(p.kcal)} kcal</span><span class="odz-p"></span></div>
    <div class="odz"><span class="odz-pas"></span><span class="odz-n">Białko</span>
      <span class="odz-w">${dziesietne(p.bialko)} g</span><span class="odz-p"></span></div>
    <div class="odz"><span class="odz-pas"></span><span class="odz-n">Węglowodany</span>
      <span class="odz-w">${dziesietne(p.wegle)} g</span><span class="odz-p"></span></div>
    ${['tluszcz', 'cukry', 'sol'].map((k) => wierszOdzywczy(k, p[k])).join('')}

    <div class="sek-tyt">Co dalej</div>
    <button class="cta druga" id="k-popraw" type="button">Popraw wartości</button>
    <button class="cta druga" id="k-ulub" type="button" style="margin-top:8px">
      ${p.ulubiony ? '&#9829; Odepnij z ulubionych' : '&#9825; Przypnij do ulubionych'}</button>
    <button class="cta-usun" id="k-usun" type="button">Usuń z bazy</button>

    <div class="stopka">
      Nutri-Score i NOVA pochodzą z Open Food Facts — to cudze, opublikowane skale.
      Progi „mało / średnio / dużo" to brytyjskie oznaczenie z frontu opakowania (FSA)
      w przeliczeniu na 100 g.
      <br>Liczba dodatków to fakt z opakowania — <b>nie</b> oceniamy ich szkodliwości,
      bo takie klasyfikacje są autorskie i sporne.
    </div>`;
  // Wróć prowadzi tam, skąd się przyszło: z listy zamyka arkusz, z drogi
  // dodawania cofa do dróg.
  podepnijNaglowek(box, opcje.skad ? ekranDrog : () => zamknij());

  box.querySelector('#k-popraw').onclick = () => ekranReczny(p, null);
  box.querySelector('#k-ulub').onclick = async () => {
    const b = box.querySelector('#k-ulub');
    b.disabled = true;
    try {
      const r = await authFetch('/api/eat/produkty/' + p.id + '/ulubiony', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ulubiony: !p.ulubiony }),
      });
      if (!r.ok) throw new Error();
      const nowy = await r.json();
      await wczytaj();
      ekranProduktu(nowy, opcje);
    } catch { b.disabled = false; toast('Nie udało się zmienić.', 'blad'); }
  };
  box.querySelector('#k-usun').onclick = async () => {
    // Wpisy w dzienniku mają własną kopię nazwy i wartości, więc historia się
    // nie zmienia — i właśnie to trzeba powiedzieć, zanim ktoś się zawaha.
    if (!(await potwierdz({
      tytul: `Usunąć „${p.nazwa}"?`,
      tresc: p.uzyc ? `Ten produkt jest w ${p.uzyc} wpisach dziennika — zostaną nietknięte, `
                    + 'bo trzymają własną kopię wartości.'
                  : 'Nie ma go w żadnym wpisie dziennika.',
      tak: 'Usuń', groznie: true,
    }))) return;
    try {
      const r = await authFetch('/api/eat/produkty/' + p.id, { method: 'DELETE' });
      if (!r.ok) { toast('Nie udało się usunąć.', 'blad'); return; }
      zamknij();
      await wczytaj();
      toast('Produkt usunięty z bazy.', 'ok');
    } catch { toast('Błąd połączenia.', 'blad'); }
  };
}

function ekranBledu(tekst, wroc) {
  const box = otworzArkusz();
  box.innerHTML = naglowek('Nie wyszło', !!wroc)
    + `<div class="komunikat blad">${e(tekst)}</div>`;
  podepnijNaglowek(box, wroc);
}

// ── start ───────────────────────────────────────────────────────────────────

authRequireHousehold().then(() => {
  document.getElementById('dodaj').onclick = ekranDrog;
  document.getElementById('filtry').onclick = (ev) => {
    const b = ev.target.closest('[data-f]');
    if (!b) return;
    filtr = b.dataset.f;
    document.querySelectorAll('#filtry .chip').forEach((c) => {
      c.setAttribute('aria-pressed', String(c.dataset.f === filtr));
    });
    rysuj();
  };
  const pole = document.getElementById('fraza');
  pole.addEventListener('input', () => { fraza = pole.value.trim(); rysuj(); });
  wczytaj();
});
