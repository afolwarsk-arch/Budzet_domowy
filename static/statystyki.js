// Statystyki jedzenia — kalorie i białko w czasie plus rozkład ocen.
//
// Oceny są CUDZE i opublikowane: Nutri-Score (a–e, jakość odżywcza) i NOVA
// (1–4, stopień przetworzenia), obie z Open Food Facts. Własnego wskaźnika
// „zdrowe/niezdrowe" świadomie nie liczymy — bez definicji i bez recenzji byłaby
// to liczba, której nikt nie umie obronić, a wyglądająca poważnie. Liczbę
// dodatków pokazujemy jako fakt z opakowania, bez oceniania ich szkodliwości.

const NS_KOLOR = { a: '#038141', b: '#85bb2f', c: '#fecb02', d: '#ee8100', e: '#e63e11' };
const NOVA_KOLOR = { 1: '#038141', 2: '#85bb2f', 3: '#ee8100', 4: '#e63e11' };
const NOVA_OPIS = { 1: 'nieprzetworzone', 2: 'składniki kulinarne',
                    3: 'przetworzone', 4: 'wysoko przetworzone' };

const zaokr = (v) => Math.round(Number(v) || 0);
let okres = 7;
let widok = 'wszystko';   // wszystko | bialko | tluszcz | wegle

// Białko to cel DO OSIĄGNIĘCIA (dobrze być powyżej), a tłuszcz i węglowodany to
// LIMIT (dobrze być poniżej). Bez tego rozróżnienia „dzień w celu" znaczyłoby
// dwie różne rzeczy zależnie od zakładki, a wykres kolorowałby na czerwono
// dzień z dobrym białkiem. Kierunek piszemy na ekranie, żeby nie był ukrytym
// założeniem.
const MAKRA = {
  bialko:  { nazwa: 'Białko',       pole: 'bialko',  cel: 'cel_bialko',  klasa: 'cz-b', minimum: true },
  tluszcz: { nazwa: 'Tłuszcz',      pole: 'tluszcz', cel: 'cel_tluszcz', klasa: 'cz-t', minimum: false },
  wegle:   { nazwa: 'Węglowodany',  pole: 'wegle',   cel: 'cel_wegle',   klasa: 'cz-w', minimum: false },
};

// Procenty liczymy od CAŁOŚCI zjedzonych kalorii, a nie od samych ocenionych,
// i „bez oceny" pokazujemy jako osobny, szary kawałek paska.
//
// Inaczej powstaje liczba alarmująca i nieprawdziwa: przy 17% ocenionych kalorii
// pasek NOVA pokazywał „wysoko przetworzone 97%", co czyta się jako „prawie
// wszystko, co jesz". Naprawdę znaczyło „97% z tych 17%" — a ocenione są głównie
// produkty paczkowane, czyli próbka z założenia przechylona w stronę
// przetworzonych, bo warzywa i dania domowe ocen nie mają.
function pasekOceny(mapa, kolory, opisy, domowe, nieznane) {
  const ocenione = Object.values(mapa).reduce((s, v) => s + Number(v || 0), 0);
  const dom = Number(domowe || 0), niez = Number(nieznane || 0);
  const calosc = ocenione + dom + niez;
  if (!ocenione) return '<div class="stat-legenda">Nic jeszcze nie zostało ocenione.</div>';
  const klucze = Object.keys(mapa).sort();
  const kawalek = (kolor, wartosc, klasa) =>
    `<i class="${klasa || ''}" style="flex:${wartosc};background:${kolor}"></i>`;
  const proc = (v) => Math.round(v / calosc * 100);
  return `<div class="stat-ocena">
      ${klucze.map((k) => kawalek(kolory[k] || 'var(--border)', mapa[k])).join('')}
      ${dom ? kawalek('', dom, 'cz-domowe') : ''}
      ${niez ? kawalek('var(--border)', niez) : ''}
    </div>
    <div class="stat-legenda">${klucze.map((k) =>
      `<em><s style="background:${kolory[k] || 'var(--border)'}"></s>${
        opisy ? (opisy[k] || k) : String(k).toUpperCase()} · ${proc(mapa[k])}%</em>`
    ).join('')}
    ${dom ? `<em><s class="cz-domowe"></s>domowe i surowce · ${proc(dom)}%</em>` : ''}
    ${niez ? `<em><s style="background:var(--border)"></s>bez oceny · ${proc(niez)}%</em>` : ''}
    </div>`;
}

async function rysuj() {
  const box = document.getElementById('tresc');
  box.innerHTML = '<div class="laduje">Wczytuję…</div>';
  let d;
  try {
    const r = await authFetch('/api/eat/statystyki?dni=' + okres);
    if (!r.ok) throw new Error('brak');
    d = await r.json();
  } catch {
    box.innerHTML = '<div class="laduje">Nie udało się wczytać statystyk.</div>';
    return;
  }

  const m = MAKRA[widok];   // null przy widoku „wszystko"
  if (m) { box.innerHTML = kartaMakro(d, m); podepnijSlupki(box, d); return; }

  const cel = Number(d.cel_kcal) || 0;
  // Skala wspólna dla kalorii zapisanych i policzonych z makro — inaczej słupki
  // i linia celu opisywałyby dwie różne osie.
  const maks = Math.max(cel, ...d.seria.map(
    (s) => Math.max(s.kcal, s.kcal_bialko + s.kcal_tluszcz + s.kcal_wegle))) || 1;

  // Słupek dzielimy na białko / tłuszcz / węglowodany. Dzień oznaczony jako
  // niekompletny rysujemy w paski i wyszarzony — jest widoczny, ale od razu
  // widać, że nie liczy się do średnich.
  const slupki = d.seria.map((s) => {
    const czesci = [
      { kl: 'b', v: s.kcal_bialko }, { kl: 't', v: s.kcal_tluszcz }, { kl: 'w', v: s.kcal_wegle },
    ].filter((x) => x.v > 0);
    const suma = czesci.reduce((a, x) => a + x.v, 0);
    const wysokosc = Math.max(2, (suma || s.kcal) / maks * 100);
    const opis = `${s.data}: ${zaokr(s.kcal)} kcal`
      + (suma ? ` — B ${zaokr(s.kcal_bialko)} · T ${zaokr(s.kcal_tluszcz)} · W ${zaokr(s.kcal_wegle)}` : '')
      + (s.niepelny ? ' (dzień niekompletny — pominięty w średnich)' : '');
    const srodek = czesci.length
      ? czesci.map((x) => `<i class="cz-${x.kl}" style="flex:${x.v}"></i>`).join('')
      // Wpis bez rozbicia na makro (np. danie z opisu) — jeden neutralny słupek,
      // żeby dzień nie zniknął z wykresu tylko dlatego, że nie znamy składu.
      : '<i class="cz-nieznane" style="flex:1"></i>';
    // Słupek jest PRZYCISKIEM: `title` działa tylko pod kursorem, a na telefonie
    // kursora nie ma — bez stuknięcia liczby byłyby niedostępne tam, gdzie apka
    // jest najczęściej używana.
    return `<button class="stat-slupek${s.niepelny ? ' niepelny' : ''}${!s.kcal ? ' pusty' : ''}"
                 type="button" data-i="${d.seria.indexOf(s)}"
                 style="height:${wysokosc}%" title="${opis}"
                 aria-label="${opis}">${s.kcal ? srodek : ''}</button>`;
  }).join('');

  const linia = cel ? `<div class="stat-cel" style="bottom:${cel / maks * 100}%"
        title="Cel ${zaokr(cel)} kcal"></div>` : '';

  const pierwszy = d.seria[0] ? d.seria[0].data.slice(8) + '.' + d.seria[0].data.slice(5, 7) : '';
  const suma = Object.values(d.nutriscore_kcal).reduce((s, v) => s + v, 0) + d.bez_oceny_kcal;
  const pokrycie = suma ? Math.round((suma - d.bez_oceny_kcal) / suma * 100) : 0;

  box.innerHTML = `
    <div class="stat-kafle">
      <div class="stat-kafel"><b>${zaokr(d.srednia_kcal)}</b><span>kcal średnio na dzień</span></div>
      <div class="stat-kafel"><b>${zaokr(d.srednia_bialko)}</b><span>g białka średnio</span></div>
      <div class="stat-kafel"><b>${d.dni_w_celu}/${d.dni_z_wpisami}</b><span>dni w celu (z kompletnych)</span></div>
    </div>

    <div class="stat-slupki">${linia}${slupki}</div>
    <div class="stat-osie"><span>${pierwszy}</span><span>dziś</span></div>
    <div id="szczegoly-dnia"></div>
    <div class="stat-legenda" style="margin-bottom:16px">
      <em><s class="cz-b"></s>białko ${zaokr(d.srednia_bialko)} g${
        d.cel_bialko ? ' / ' + zaokr(d.cel_bialko) : ''}</em>
      <em><s class="cz-t"></s>tłuszcz ${zaokr(d.srednia_tluszcz)} g${
        d.cel_tluszcz ? ' / ' + zaokr(d.cel_tluszcz) : ''}</em>
      <em><s class="cz-w"></s>węglowodany ${zaokr(d.srednia_wegle)} g${
        d.cel_wegle ? ' / ' + zaokr(d.cel_wegle) : ''}</em>
      ${cel ? `<em><s style="background:var(--muted)"></s>kreska = cel ${zaokr(cel)} kcal</em>` : ''}
      ${d.dni_niepelnych ? `<em><s class="cz-niepelny"></s>${d.dni_niepelnych} dni
        oznaczonych jako niekompletne — pominięte w średnich</em>` : ''}
    </div>

    <div class="sek-tyt">Jakość odżywcza (Nutri-Score)</div>
    ${pasekOceny(d.nutriscore_kcal, NS_KOLOR, null, d.domowe_ns_kcal, d.nieznane_ns_kcal)}

    <div class="sek-tyt">Stopień przetworzenia (NOVA)</div>
    ${pasekOceny(d.nova_kcal, NOVA_KOLOR, NOVA_OPIS, d.domowe_nova_kcal, d.nieznane_nova_kcal)}

    <div class="stat-stopka">
      ${d.srednio_dodatkow !== null && d.srednio_dodatkow !== undefined
        ? `Średnio <b>${d.srednio_dodatkow}</b> dodatków (numerów E) na to, co jesz —
           liczba z opakowań, bez oceniania czy to źle.<br>` : ''}
      Oceniono <b>${pokrycie}%</b> kalorii. NOVA i Nutri-Score dostają wyłącznie produkty
      z kodem kreskowym, a kody mają rzeczy paczkowane — pomidor, Twój przepis i obiad
      opisany słowami kodu nie mają, więc trafiają do „domowe i surowce". To nie znaczy,
      że są gorsze; znaczy, że ta skala ich nie obejmuje.
      <br><small>Nutri-Score i NOVA pochodzą z Open Food Facts. To cudze, opublikowane skale —
      nie liczymy własnego wskaźnika „zdrowe/niezdrowe".</small>
    </div>`;

  podepnijSlupki(box, d);
}

function podepnijSlupki(box, d) {
  box.querySelectorAll('.stat-slupek[data-i]').forEach((b) => {
    b.onclick = () => pokazDzien(d.seria[Number(b.dataset.i)], b, d);
  });
}

// Widok jednego makroskładnika: ile było, ile brakło albo o ile przekroczone.
function kartaMakro(d, m) {
  const cel = Number(d[m.cel]) || 0;
  const dni = d.seria.filter((s) => s.kcal > 0 && !s.niepelny);
  const maks = Math.max(cel, ...d.seria.map((s) => s[m.pole])) || 1;
  const srednia = dni.length
    ? dni.reduce((a, s) => a + s[m.pole], 0) / dni.length : 0;
  const wCelu = cel
    ? dni.filter((s) => (m.minimum ? s[m.pole] >= cel : s[m.pole] <= cel)).length : 0;

  // Część słupka PONAD cel rysujemy osobno — przy limicie na czerwono (przekroczony),
  // przy minimum w kolorze makra (nadwyżka jest w porządku).
  const slupki = d.seria.map((s, i) => {
    const v = s[m.pole];
    const doCelu = cel ? Math.min(v, cel) : v;
    const ponad = cel ? Math.max(0, v - cel) : 0;
    const roznica = cel ? v - cel : 0;
    const opis = `${s.data}: ${zaokr(v)} g`
      + (cel ? (roznica >= 0 ? ` (+${zaokr(roznica)} ponad cel)` : ` (brakuje ${zaokr(-roznica)})`) : '')
      + (s.niepelny ? ' — dzień niekompletny' : '');
    const srodek = v > 0
      ? `<i class="${m.klasa}" style="flex:${doCelu || 0.001}"></i>`
        + (ponad ? `<i class="${m.minimum ? m.klasa + ' nadwyzka' : 'cz-ponad'}" style="flex:${ponad}"></i>` : '')
      : '';
    return `<button class="stat-slupek${s.niepelny ? ' niepelny' : ''}${!v ? ' pusty' : ''}"
              type="button" data-i="${i}" title="${opis}" aria-label="${opis}"
              style="height:${Math.max(2, v / maks * 100)}%">${srodek}</button>`;
  }).join('');

  const pierwszy = d.seria[0] ? d.seria[0].data.slice(8) + '.' + d.seria[0].data.slice(5, 7) : '';
  const kierunek = m.minimum ? 'co najmniej' : 'najwyżej';

  return `
    <div class="stat-kafle">
      <div class="stat-kafel"><b>${zaokr(srednia)}</b><span>g średnio na dzień</span></div>
      <div class="stat-kafel"><b>${cel ? zaokr(cel) : '—'}</b><span>cel: ${kierunek} tyle</span></div>
      <div class="stat-kafel"><b>${wCelu}/${dni.length}</b><span>dni w celu (z kompletnych)</span></div>
    </div>
    <div class="stat-slupki">
      ${cel ? `<div class="stat-cel" style="bottom:${cel / maks * 100}%"></div>` : ''}
      ${slupki}
    </div>
    <div class="stat-osie"><span>${pierwszy}</span><span>dziś</span></div>
    <div id="szczegoly-dnia"></div>
    <div class="stat-legenda" style="margin-bottom:16px">
      <em><s class="${m.klasa}"></s>${m.nazwa.toLowerCase()} do celu</em>
      <em><s class="${m.minimum ? m.klasa + ' nadwyzka' : 'cz-ponad'}"></s>${
        m.minimum ? 'ponad cel (w porządku)' : 'ponad limit'}</em>
      ${cel ? `<em><s style="background:var(--muted)"></s>kreska = ${zaokr(cel)} g</em>` : ''}
      ${d.dni_niepelnych ? `<em><s class="cz-niepelny"></s>${d.dni_niepelnych} dni
        niekompletnych — pominięte</em>` : ''}
    </div>
    <div class="stat-stopka">
      ${m.minimum
        ? `Białko traktujemy jako cel <b>do osiągnięcia</b> — dzień liczy się jako udany,
           gdy zjadłeś co najmniej ${zaokr(cel)} g.`
        : `${m.nazwa} traktujemy jako <b>limit</b> — dzień liczy się jako udany, gdy zmieściłeś
           się w ${zaokr(cel)} g.`}
      Stuknij słupek, żeby zobaczyć konkretny dzień.
    </div>`;
}

// Szczegóły jednego dnia pod wykresem: liczby i przełącznik kompletności.
// Zmiana oznaczenia przerysowuje CAŁY wykres, bo wpływa na średnie, na dni
// w celu i na rozkład ocen — pokazywanie starych liczb obok nowego znaczka
// byłoby myleniem samego siebie.
let wybranyDzien = null;

function pokazDzien(s, przycisk, d) {
  const box = document.getElementById('szczegoly-dnia');
  if (!box) return;
  document.querySelectorAll('.stat-slupek.wybrany').forEach((x) => x.classList.remove('wybrany'));
  // Drugie stuknięcie w ten sam słupek zamyka panel.
  if (wybranyDzien === s.data) { wybranyDzien = null; box.innerHTML = ''; return; }
  wybranyDzien = s.data;
  if (przycisk) przycisk.classList.add('wybrany');

  const dzien = new Date(s.data + 'T12:00:00')
    .toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
  const zMakro = s.kcal_bialko + s.kcal_tluszcz + s.kcal_wegle;

  // Różnica względem celu — to po nią się tu zagląda. Dla białka „brakuje",
  // dla limitów „ponad".
  const roznica = (klucz) => {
    const mm = MAKRA[klucz];
    const cel = Number((d || {})[mm.cel]) || 0;
    if (!cel) return '';
    const r = s[mm.pole] - cel;
    if (Math.abs(r) < 0.5) return ' <b>= cel</b>';
    return mm.minimum
      ? (r > 0 ? ` <b>+${zaokr(r)} ponad cel</b>` : ` <b>brakuje ${zaokr(-r)}</b>`)
      : (r > 0 ? ` <b>+${zaokr(r)} ponad limit</b>` : ` <b>${zaokr(-r)} zapasu</b>`);
  };

  box.innerHTML = `
    <div class="dzien-karta">
      <div class="dk-gl"><b>${dzien}</b><span>${zaokr(s.kcal)} kcal</span></div>
      ${s.kcal ? `<div class="dk-makro">
        <em><s class="cz-b"></s>białko ${zaokr(s.bialko)} g${roznica('bialko')}</em>
        <em><s class="cz-t"></s>tłuszcz ${zaokr(s.tluszcz)} g${roznica('tluszcz')}</em>
        <em><s class="cz-w"></s>węglowodany ${zaokr(s.wegle)} g${roznica('wegle')}</em>
      </div>
      ${Math.abs(zMakro - s.kcal) > Math.max(40, s.kcal * 0.08) ? `<div class="dk-uwaga">
        Z makroskładników wychodzi ${zaokr(zMakro)} kcal — część pozycji nie ma kompletu wartości.
      </div>` : ''}` : '<div class="dk-uwaga">Nic nie zapisano tego dnia.</div>'}
      <label class="dk-przel">
        <input type="checkbox" id="dk-niepelny" ${s.niepelny ? 'checked' : ''}>
        <span>Dzień niekompletny — nie licz go do średnich ani do dni w celu</span>
      </label>
    </div>`;

  box.querySelector('#dk-niepelny').onchange = async (ev) => {
    const chce = ev.target.checked;
    ev.target.disabled = true;
    try {
      const r = await authFetch('/api/eat/dzien/niepelny', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: s.data, niepelny: chce }),
      });
      if (!r.ok) throw new Error();
      wybranyDzien = null;      // rysuj() zbuduje panel od nowa, już z aktualnych danych
      await rysuj();
      const nowy = [...document.querySelectorAll('.stat-slupek[data-i]')]
        .find((b) => b.title.startsWith(s.data));
      if (nowy) nowy.click();   // wracamy na ten sam dzień, żeby nie gubić kontekstu
    } catch {
      ev.target.checked = !chce;
      ev.target.disabled = false;
    }
  };
}

authRequireHousehold().then(() => {
  document.getElementById('okres').onclick = (ev) => {
    const b = ev.target.closest('[data-dni]');
    if (!b) return;
    document.querySelectorAll('#okres [data-dni]')
      .forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    okres = Number(b.dataset.dni);
    wybranyDzien = null;
    rysuj();
  };
  document.getElementById('widok').onclick = (ev) => {
    const b = ev.target.closest('[data-widok]');
    if (!b) return;
    document.querySelectorAll('#widok [data-widok]')
      .forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    widok = b.dataset.widok;
    wybranyDzien = null;      // panel dnia dotyczy poprzedniego widoku
    rysuj();
  };
  rysuj();
});
