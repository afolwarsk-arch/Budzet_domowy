// wiem.health — masa ciała.
//
// OSOBNA STRONA, nie ekran w historii zdrowia. Waga jest jedynym pomiarem
// wpisywanym codziennie: na osi czasu mieszałaby się z dokumentami, a wspólny
// „przebieg parametru" nie ma gdzie pokazać celu ani tempa.
//
// Pomiary czytamy z `/przebieg`, a nie z `/pomiary`, bo tamten scala DWA
// źródła: wpisy z domu i wagę odczytaną z dokumentu (np. z karty wizyty).
// To jedna historia ciała i ma stać na jednym wykresie — kasować można
// oczywiście tylko własne wpisy, poznawane po `pomiar_id`.

const POMIAR = 'Waga';

let osoby = [];
let osobaId = null;
let punkty = [];
let cel = null;
let wygladz = false;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Liczba po polsku. Bez obcinania zer wyrażeniem na całym napisie — tamten
// wariant robił z „80" ósemkę; patrz komentarz przy `bezZer` w health.js.
const liczba = (v) => String(Number(v)).replace('.', ',');
const kg1 = (v) => (Math.round(Number(v) * 10) / 10).toFixed(1).replace('.', ',');
const dzisISO = () => new Date().toLocaleDateString('sv-SE');
const naDate = (iso) => new Date(iso + 'T12:00:00');
const dni = (a, b) => Math.round((naDate(a) - naDate(b)) / 86400000);

function dataPl(iso) {
  if (!iso) return '';
  const [r, m, d] = String(iso).slice(0, 10).split('-');
  return d && m && r ? `${d}.${m}.${r}` : iso;
}

function odmien(n, poj, kilka, wiele) {
  if (n === 1) return poj;
  const r10 = n % 10, r100 = n % 100;
  return (r10 >= 2 && r10 <= 4 && !(r100 >= 12 && r100 <= 14)) ? kilka : wiele;
}

function odKiedy(iso) {
  const d = dni(dzisISO(), iso);
  if (d === 0) return 'dziś';
  if (d === 1) return 'wczoraj';
  if (d < 31) return `${d} ${odmien(d, 'dzień', 'dni', 'dni')} temu`;
  return dataPl(iso);
}

// Różnica z zachowanym znakiem — „−0,6" i „0,6" to dwie przeciwne wiadomości.
function roznica(nowa, stara) {
  const d = Math.round((Number(nowa) - Number(stara)) * 10) / 10;
  if (!d) return { tekst: 'bez zmiany', klasa: '' };
  return { tekst: (d > 0 ? '+' : '−') + kg1(Math.abs(d)) + ' kg',
           klasa: d > 0 ? 'w-gore' : 'w-dol' };
}

const box = () => document.getElementById('tresc');

function kom(tekst, blad) {
  const el = document.getElementById('kom');
  if (!el) return;
  el.className = 'kom' + (blad ? ' blad' : '');
  el.textContent = tekst || '';
}

// ── dane ────────────────────────────────────────────────────────────────────

async function wczytajOsoby() {
  const r = await authFetch('/api/health/osoby');
  if (!r.ok) throw new Error('osoby');
  osoby = (await r.json()).osoby || [];
  if (!osoby.some((o) => o.id === osobaId)) osobaId = osoby.length ? osoby[0].id : null;
}

async function wczytajDane() {
  if (osobaId === null) { punkty = []; cel = null; return; }
  const [rp, rc] = await Promise.all([
    authFetch(`/api/health/przebieg?osoba_id=${osobaId}&nazwa=${encodeURIComponent(POMIAR)}`),
    authFetch(`/api/health/cel?osoba_id=${osobaId}&nazwa=${encodeURIComponent(POMIAR)}`),
  ]);
  punkty = rp.ok ? ((await rp.json()).punkty || []) : [];
  cel = rc.ok ? ((await rc.json()).cel || null) : null;
}

// ── cel: gdzie jesteś względem planu ────────────────────────────────────────
//
// Wartość oczekiwana na dziś to prosta od punktu startu do celu. Bez terminu
// nie ma tempa i nie ma czego liczyć — zostaje sama odległość do celu.
function stanCelu() {
  if (!cel || !punkty.length) return null;
  const teraz = Number(punkty[punkty.length - 1].wartosc_liczba);
  const start = Number(cel.start_wartosc);
  const doCelu = Number(cel.cel);
  const zostalo = Math.abs(teraz - doCelu);
  const droga = Math.abs(start - doCelu);
  // Postęp liczymy od STARTU, nie od zera: „przeszedłeś 2 z 4 kg”. Zero nie
  // jest tu żadnym punktem odniesienia — nikt nie zmierza do zera kilogramów.
  const postep = droga > 0 ? Math.min(1, Math.max(0, (start - teraz) / (start - doCelu))) : 1;
  const osiagniety = (start > doCelu && teraz <= doCelu) || (start < doCelu && teraz >= doCelu);

  let tempo = null;
  if (cel.termin) {
    const caly = dni(cel.termin, cel.start_data);
    const minelo = dni(dzisISO(), cel.start_data);
    const udzial = caly > 0 ? Math.min(1, Math.max(0, minelo / caly)) : 1;
    const oczekiwana = start + (doCelu - start) * udzial;
    // Znak liczymy WZGLĘDEM KIERUNKU celu: przy chudnięciu mniej znaczy lepiej,
    // przy przybieraniu odwrotnie. Bez tego „przed planem" i „za wolno"
    // zamieniałyby się miejscami dla kogoś, kto chce przytyć.
    const kierunek = doCelu < start ? 1 : -1;
    const przewaga = (oczekiwana - teraz) * kierunek;
    tempo = {
      oczekiwana,
      przewaga,
      zostaloDni: dni(cel.termin, dzisISO()),
      // Ćwierć kilograma to szum wagi łazienkowej, nie wyprzedzenie planu.
      stan: Math.abs(przewaga) < 0.25 ? 'rowno' : (przewaga > 0 ? 'przed' : 'tyl'),
    };
  }
  return { teraz, start, doCelu, zostalo, postep, osiagniety, tempo };
}

// ── wykres ──────────────────────────────────────────────────────────────────

const OS_L = 38, OS_P = 12, OS_G = 16, OS_D = 26;

function rysujWykres(szer) {
  if (!punkty.length) return '';
  const wys = 240;

  // Oś czasu sięga do TERMINU celu, gdy ten jest w przyszłości — inaczej linia
  // tempa nie miałaby dokąd biec i cel byłby niewidoczny na wykresie.
  const t0 = Math.min(naDate(punkty[0].data_badania).getTime(),
                      cel ? naDate(cel.start_data).getTime() : Infinity);
  const tKoniec = Math.max(naDate(punkty[punkty.length - 1].data_badania).getTime(),
                           (cel && cel.termin) ? naDate(cel.termin).getTime() : 0);
  const rozpietosc = (tKoniec - t0) || 1;
  const X = (iso) => OS_L + ((naDate(iso).getTime() - t0) / rozpietosc) * (szer - OS_L - OS_P);

  const wart = punkty.map((p) => Number(p.wartosc_liczba));
  if (cel) wart.push(Number(cel.cel), Number(cel.start_wartosc));
  let min = Math.min(...wart), max = Math.max(...wart);
  if (min === max) { min -= 1; max += 1; }
  const luz = (max - min) * 0.14;
  min -= luz; max += luz;
  const Y = (v) => OS_G + (1 - (Number(v) - min) / (max - min)) * (wys - OS_G - OS_D);

  const xs = punkty.map((p) => X(p.data_badania));
  const linia = punkty.map((p, i) => `${xs[i].toFixed(1)},${Y(p.wartosc_liczba).toFixed(1)}`).join(' ');

  // Wygładzanie: okno SIEDMIU DNI, nie siedmiu ostatnich punktów. Przy
  // nieregularnym ważeniu tamto mieszałoby dane sprzed miesiąca z dzisiejszymi.
  const srednia = wygladz ? punkty.map((p) => {
    const t = naDate(p.data_badania).getTime();
    const okno = punkty.filter((q) => {
      const tq = naDate(q.data_badania).getTime();
      return tq <= t && tq > t - 7 * 86400000;
    });
    return okno.reduce((s, q) => s + Number(q.wartosc_liczba), 0) / okno.length;
  }) : null;

  const liniaCelu = cel
    ? `<line class="cel-linia" x1="${OS_L}" y1="${Y(cel.cel).toFixed(1)}"
              x2="${(szer - OS_P).toFixed(1)}" y2="${Y(cel.cel).toFixed(1)}"/>
       <text class="opis" x="${(szer - OS_P).toFixed(1)}" y="${(Y(cel.cel) - 5).toFixed(1)}"
             text-anchor="end">cel ${esc(kg1(cel.cel))}</text>` : '';

  const liniaTempa = (cel && cel.termin)
    ? `<line class="tempo" x1="${X(cel.start_data).toFixed(1)}" y1="${Y(cel.start_wartosc).toFixed(1)}"
              x2="${X(cel.termin).toFixed(1)}" y2="${Y(cel.cel).toFixed(1)}"/>` : '';

  const marki = punkty.map((p, i) => {
    const x = xs[i], y = Y(p.wartosc_liczba);
    // Pomiar z dokumentu (ważenie w przychodni) rysujemy pierścieniem: waga
    // w ubraniu po południu to nie to samo co waga rano na czczo.
    const klasa = 'punkt' + (p.pomiar_id ? '' : ' zbadania') + (wygladz ? ' przygaszony' : '');
    return `<circle class="${klasa}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"/>
      <rect class="dotyk" data-i="${i}" x="${(x - 15).toFixed(1)}" y="${(y - 15).toFixed(1)}"
            width="30" height="30"></rect>`;
  }).join('');

  const dolPola = wys - OS_D;
  return `<svg class="wykres" viewBox="0 0 ${szer} ${wys}" width="${szer}" height="${wys}"
            role="img" aria-label="Masa ciała w czasie">
      <line class="siatka" x1="${OS_L}" y1="${dolPola}" x2="${szer - OS_P}" y2="${dolPola}"/>
      <text class="opis" x="${OS_L - 6}" y="${OS_G + 4}" text-anchor="end">${kg1(max)}</text>
      <text class="opis" x="${OS_L - 6}" y="${dolPola}" text-anchor="end">${kg1(min)}</text>
      <text class="opis" x="${OS_L}" y="${wys - 8}">${esc(dataPl(punkty[0].data_badania))}</text>
      <text class="opis" x="${szer - OS_P}" y="${wys - 8}" text-anchor="end">${
        esc(dataPl((cel && cel.termin && cel.termin > punkty[punkty.length - 1].data_badania)
          ? cel.termin : punkty[punkty.length - 1].data_badania))}</text>
      ${liniaTempa}${liniaCelu}
      <polyline class="linia${wygladz ? ' przygaszona' : ''}" points="${linia}"/>
      ${srednia ? `<polyline class="srednia" points="${srednia.map((v, i) =>
        `${xs[i].toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>` : ''}
      ${marki}
    </svg>`;
}

function przerysujPlotno() {
  const plotno = document.getElementById('plotno');
  if (!plotno || !punkty.length) return;
  // Rysujemy w RZECZYWISTYCH pikselach kontenera: przy skalowaniu viewBoxem
  // opisy osi kurczyłyby się razem z wykresem i na telefonie byłyby nieczytelne.
  plotno.innerHTML = rysujWykres(Math.max(280, plotno.clientWidth));
  const svg = plotno.querySelector('svg');
  if (!svg) return;
  svg.onclick = (ev) => {
    const t = ev.target.closest('[data-i]');
    if (!t) return;
    const p = punkty[Number(t.dataset.i)];
    document.getElementById('podpis').innerHTML =
      `<b>${dataPl(p.data_badania)}</b> — ${esc(kg1(p.wartosc_liczba))} kg`
      + (p.pomiar_id ? '' : ` · z dokumentu${p.placowka ? ' · ' + esc(p.placowka) : ''}`);
  };
}

// ── ekran ───────────────────────────────────────────────────────────────────

function kartaCelu() {
  if (!cel) {
    return `<div class="karta">
      <div class="cel-gl"><h2>Cel</h2></div>
      <div class="pusto">Nie masz ustawionego celu.<br>
        Cel to waga docelowa i termin — dołożę do wykresu linię tempa i będzie
        widać, czy zdążasz.</div>
      <div class="akcje" style="margin-top:12px">
        <button class="btn-glowny" type="button" id="cel-ustaw">Ustaw cel</button>
      </div>
    </div>`;
  }
  const s = stanCelu();
  if (!s) return '';
  const stanTekst = s.osiagniety
    ? '<b>Cel osiągnięty.</b> Możesz go zmienić albo usunąć.'
    : (s.tempo
      ? (s.tempo.zostaloDni < 0
        ? `Termin minął ${odKiedy(cel.termin)}. Do celu zostało ${kg1(s.zostalo)} kg.`
        : ({
            przed: `<b>${kg1(Math.abs(s.tempo.przewaga))} kg przed planem.</b> Na dziś tempo przewidywało ${kg1(s.tempo.oczekiwana)} kg.`,
            tyl: `<b>${kg1(Math.abs(s.tempo.przewaga))} kg za wolno.</b> Na dziś tempo przewidywało ${kg1(s.tempo.oczekiwana)} kg.`,
            rowno: '<b>Zgodnie z planem.</b>',
          })[s.tempo.stan])
      : `Do celu zostało ${kg1(s.zostalo)} kg. Bez terminu nie liczę tempa.`);
  const klasaStanu = s.osiagniety ? 'przed'
    : (s.tempo && s.tempo.zostaloDni >= 0 ? ({ przed: 'przed', tyl: 'tyl', rowno: '' })[s.tempo.stan] : '');

  return `<div class="karta">
    <div class="cel-gl">
      <h2>Cel</h2>
      <button class="cel-edytuj" type="button" id="cel-ustaw">Zmień</button>
    </div>
    <div class="cel-liczby">
      <div class="cel-poz"><b>${kg1(cel.cel)} kg</b><span>waga docelowa</span></div>
      <div class="cel-poz"><b>${s.osiagniety ? '—' : kg1(s.zostalo) + ' kg'}</b><span>zostało</span></div>
      ${cel.termin ? `<div class="cel-poz"><b>${dataPl(cel.termin)}</b><span>${
        s.tempo && s.tempo.zostaloDni >= 0
          ? `za ${s.tempo.zostaloDni} ${odmien(s.tempo.zostaloDni, 'dzień', 'dni', 'dni')}`
          : 'termin'}</span></div>` : ''}
    </div>
    <div class="pasek"><i style="width:${Math.round(s.postep * 100)}%"></i></div>
    <div class="cel-stan ${klasaStanu}">${stanTekst}</div>
    <div class="kom">Start: ${kg1(cel.start_wartosc)} kg, ${dataPl(cel.start_data)}.</div>
  </div>`;
}

function rysuj() {
  const ostatni = punkty.length ? punkty[punkty.length - 1] : null;
  const poprzedni = punkty.length > 1 ? punkty[punkty.length - 2] : null;
  const zm = ostatni && poprzedni ? roznica(ostatni.wartosc_liczba, poprzedni.wartosc_liczba) : null;

  box().innerHTML = `
    <div class="gora"><h1>Masa ciała</h1></div>
    ${osoby.length > 1 ? `<div class="filtry" id="osoby">
      ${osoby.map((o) => `<button class="chip" type="button" data-o="${o.id}"
          aria-pressed="${o.id === osobaId}">${esc(o.imie)}</button>`).join('')}
    </div>` : ''}

    <div class="karta">
      ${ostatni ? `<div class="teraz">
          <span class="kg">${kg1(ostatni.wartosc_liczba)}</span><span class="jedn">kg</span>
          ${zm ? `<span class="zmiana ${zm.klasa}">${zm.tekst}</span>` : ''}
        </div>
        <div class="teraz-kiedy">Ostatni pomiar ${odKiedy(ostatni.data_badania)}${
          poprzedni ? ` · poprzedni ${odKiedy(poprzedni.data_badania)}` : ''}</div>`
      : `<div class="pusto"><b>Jeszcze żadnego pomiaru</b>
          Wpisz pierwszą wagę — wykres i cel pojawią się same.</div>`}
      <div class="wpis">
        <input type="date" id="w-data" value="${dzisISO()}" max="${dzisISO()}" aria-label="Dzień">
        <input type="text" id="w-kg" inputmode="decimal" autocomplete="off"
               placeholder="${ostatni ? kg1(ostatni.wartosc_liczba) : 'np. 82,4'}" aria-label="Kilogramy">
        <button type="button" id="w-zapisz">Zapisz</button>
      </div>
      <div id="kom" class="kom"></div>
    </div>

    ${punkty.length ? kartaCelu() : ''}

    ${punkty.length > 1 ? `<div class="karta">
      <h2>Przebieg</h2>
      <div id="plotno"></div>
      <div class="wyk-podpis" id="podpis">Stuknij punkt, żeby zobaczyć szczegóły.</div>
      <div class="filtry" style="margin:10px 0 0">
        <button class="chip" type="button" id="wygladz" aria-pressed="${wygladz}">
          Wygładź (średnia 7 dni)</button>
      </div>
      <div class="legenda">
        <span>● pomiar własny</span>
        <span>○ z dokumentu</span>
        ${cel ? '<span>– – cel</span>' : ''}
        ${cel && cel.termin ? '<span>· · tempo</span>' : ''}
      </div>
    </div>` : (punkty.length === 1 ? `<div class="karta">
      <h2>Przebieg</h2>
      <div class="pusto">Wykres pojawi się przy drugim pomiarze — z jednego punktu
        nie da się narysować linii.</div>
    </div>` : '')}

    ${punkty.length ? `<div class="karta">
      <h2>Historia</h2>
      ${punkty.slice().reverse().map((p, i, lista) => {
        const wczesniej = lista[i + 1];
        const r = wczesniej ? roznica(p.wartosc_liczba, wczesniej.wartosc_liczba) : null;
        return `<div class="wiersz">
          <span class="w-data">${dataPl(p.data_badania)}</span>
          ${p.pomiar_id ? '' : '<span class="w-zrodlo">z dokumentu</span>'}
          <span class="w-kg">${kg1(p.wartosc_liczba)} kg</span>
          <span class="w-roz ${r ? r.klasa : ''}">${r ? r.tekst : ''}</span>
          ${p.pomiar_id
            ? `<button class="w-x" type="button" data-usun="${p.pomiar_id}" aria-label="Usuń pomiar">&times;</button>`
            : '<span class="w-x"></span>'}
        </div>`;
      }).join('')}
    </div>` : ''}`;

  const chipy = document.getElementById('osoby');
  if (chipy) chipy.onclick = async (ev) => {
    const b = ev.target.closest('[data-o]');
    if (!b) return;
    osobaId = Number(b.dataset.o);
    await wczytajDane();
    rysuj();
  };

  document.getElementById('w-zapisz').onclick = zapisz;
  document.getElementById('w-kg').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); zapisz(); }
  });

  const ustaw = document.getElementById('cel-ustaw');
  if (ustaw) ustaw.onclick = arkuszCelu;

  const przel = document.getElementById('wygladz');
  if (przel) przel.onclick = () => {
    wygladz = !wygladz;
    przel.setAttribute('aria-pressed', String(wygladz));
    przerysujPlotno();   // samo płótno: zmienia się jedna linia, nie cały ekran
  };

  document.querySelectorAll('[data-usun]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await authFetch('/api/health/pomiary/' + b.dataset.usun, { method: 'DELETE' });
        if (!r.ok) { kom('Nie udało się usunąć.', true); b.disabled = false; return; }
        await wczytajDane();
        rysuj();
      } catch { kom('Błąd połączenia.', true); b.disabled = false; }
    };
  });

  przerysujPlotno();
}

async function zapisz() {
  const btn = document.getElementById('w-zapisz');
  const wartosc = document.getElementById('w-kg').value.trim();
  if (!wartosc) { kom('Wpisz wagę.', true); document.getElementById('w-kg').focus(); return; }
  btn.disabled = true;
  try {
    const r = await authFetch('/api/health/pomiary', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        osoba_id: osobaId, nazwa: POMIAR, jednostka: 'kg',
        data: document.getElementById('w-data').value, wartosc,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { kom(d.detail || 'Nie udało się zapisać.', true); btn.disabled = false; return; }
    await wczytajDane();
    rysuj();
  } catch { kom('Błąd połączenia.', true); btn.disabled = false; }
}

// ── arkusz celu ─────────────────────────────────────────────────────────────

function arkuszCelu() {
  const tlo = document.createElement('div');
  tlo.className = 'ark-tlo';
  tlo.innerHTML = `<div class="ark">
      <h2>${cel ? 'Zmień cel' : 'Ustaw cel'}</h2>
      <div class="pole"><label for="c-kg">Waga docelowa (kg)</label>
        <input type="text" id="c-kg" inputmode="decimal" autocomplete="off"
               value="${cel ? kg1(cel.cel) : ''}" placeholder="np. 78"></div>
      <div class="pole"><label for="c-termin">Do kiedy</label>
        <input type="date" id="c-termin" min="${dzisISO()}"
               value="${cel && cel.termin ? cel.termin : ''}"></div>
      <div class="kom">Termin jest opcjonalny, ale to on daje linię tempa —
        bez niego zostaje sama odległość do celu.</div>
      ${cel ? `<div class="kom">Tempo liczy się od startu: ${kg1(cel.start_wartosc)} kg,
        ${dataPl(cel.start_data)}. Zaznacz poniżej, żeby liczyć od nowa, od dzisiejszej wagi.
        <label style="display:flex;gap:8px;align-items:center;margin-top:8px;color:var(--text)">
          <input type="checkbox" id="c-odnowa" style="width:18px;height:18px">
          Licz tempo od dziś</label></div>` : ''}
      <div id="c-kom" class="kom"></div>
      <div class="akcje">
        <button class="btn-drugi" type="button" id="c-anuluj">Anuluj</button>
        <button class="btn-glowny" type="button" id="c-zapisz">Zapisz</button>
      </div>
      ${cel ? '<button class="btn-usun" type="button" id="c-usun">Usuń cel</button>' : ''}
    </div>`;
  tlo.addEventListener('click', (e) => { if (e.target === tlo) tlo.remove(); });
  document.body.appendChild(tlo);

  const komCel = (t, blad) => {
    const el = tlo.querySelector('#c-kom');
    el.className = 'kom' + (blad ? ' blad' : '');
    el.textContent = t || '';
  };

  tlo.querySelector('#c-anuluj').onclick = () => tlo.remove();
  tlo.querySelector('#c-kg').focus();

  const usun = tlo.querySelector('#c-usun');
  if (usun) usun.onclick = async () => {
    usun.disabled = true;
    try {
      const r = await authFetch(
        `/api/health/cel?osoba_id=${osobaId}&nazwa=${encodeURIComponent(POMIAR)}`,
        { method: 'DELETE' });
      if (!r.ok) { komCel('Nie udało się usunąć.', true); usun.disabled = false; return; }
      tlo.remove();
      await wczytajDane();
      rysuj();
    } catch { komCel('Błąd połączenia.', true); usun.disabled = false; }
  };

  tlo.querySelector('#c-zapisz').onclick = async (ev) => {
    const wartosc = tlo.querySelector('#c-kg').value.trim();
    if (!wartosc) { komCel('Podaj wagę docelową.', true); return; }
    const odNowa = tlo.querySelector('#c-odnowa');
    ev.target.disabled = true;
    try {
      const r = await authFetch('/api/health/cel', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          osoba_id: osobaId, nazwa: POMIAR, cel: wartosc,
          termin: tlo.querySelector('#c-termin').value || null,
          od_nowa: !cel || (odNowa && odNowa.checked),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { komCel(d.detail || 'Nie udało się zapisać.', true); ev.target.disabled = false; return; }
      tlo.remove();
      await wczytajDane();
      rysuj();
    } catch { komCel('Błąd połączenia.', true); ev.target.disabled = false; }
  };
}

// ── start ───────────────────────────────────────────────────────────────────

let czasomierz = null;
addEventListener('resize', () => {
  clearTimeout(czasomierz);
  czasomierz = setTimeout(przerysujPlotno, 150);
});

authRequireHousehold().then(async () => {
  try {
    await wczytajOsoby();
  } catch {
    box().innerHTML = '<div class="kom blad">Nie udało się wczytać listy osób.</div>';
    return;
  }
  if (!osoby.length) {
    box().innerHTML = `<div class="gora"><h1>Masa ciała</h1></div>
      <div class="karta"><div class="pusto"><b>Najpierw dodaj osobę</b>
        Pomiar należy do konkretnej osoby. Osoby zakłada się w Historii zdrowia.</div>
        <div class="akcje" style="margin-top:12px">
          <button class="btn-glowny" type="button" onclick="location.href='/health'">Przejdź do historii</button>
        </div></div>`;
    return;
  }
  await wczytajDane();
  rysuj();
});
