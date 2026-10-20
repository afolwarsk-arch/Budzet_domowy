// Asystent wiem — przycisk, okno rozmowy i mikrofon.
// Karty propozycji i wszystkie zapisy: asystent-karty.js.
//
// Okno żyje dłużej niż jego widoczność (D1): zamknięcie je CHOWA, a ponowne
// otwarcie w ciągu 10 minut pokazuje te same karty, „Cofnij" i rozmowę.
(function () {
  // Iskra + kropka (wybór Adama 2026-10-19). Kropka w kolorze modułu (--marka).
  const IKONA = '<svg class="ast-ikona" viewBox="0 0 32 32" aria-hidden="true">'
    + '<path class="ast-iskra" d="M15 6c.9 4.6 2.4 6.1 7 7-4.6.9-6.1 2.4-7 7-.9-4.6-2.4-6.1-7-7 4.6-.9 6.1-2.4 7-7z"/>'
    + '<circle class="ast-kropka" cx="23" cy="22" r="2.4"/></svg>';
  const MIK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>';
  const KOD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6v12M7 6v12M10 6v12M14 6v12M16 6v12M20 6v12"/></svg>';
  const PARAGON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>';
  const WYSLIJ = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';

  const ZYCIE_MS = 10 * 60 * 1000;               // D1: po tylu minutach ukrycia — nowa rozmowa
  const MAX_HISTORII = 500;                      // = MAX_DLUGOSC_HISTORII w asystent.py
  const KLUCZ_MIK = 'astMikZablokowany';         // przeglądarka odmówiła mikrofonu
  const KLUCZ_MIK_INFO = 'astMikKomunikat';      // komunikat o blokadzie już był
  // Teksty z recenzji UX (2026-10-19) — źródło prawdy dla treści.
  const T = {
    przyklady: ['dopisz mleko i chleb', 'zjadłem jogurt z bananem', 'zadanie: zadzwonić do mechanika w piątek'],
    mysle: 'Myślę…',
    dluzej: 'Jeszcze chwilę — serwer się rozkręca.',
    wysle: 'Wyślę za chwilę…',
    cisza: 'Nie usłyszałem — stuknij mikrofon albo pisz.',
    mikZablokowany: 'Mikrofon jest zablokowany — pisz w polu. Zgodę włączysz w ustawieniach Chrome dla tej strony.',
    siec: 'Brak połączenia. Polecenie czeka w polu — wyślij, gdy wróci internet.',
    zaDlugo: 'Nie zdążyłem odpowiedzieć. Nic nie zostało zapisane — spróbuj jeszcze raz.',
    limit: 'Na dziś to już 100 poleceń. Asystent wróci po północy — do tego czasu wszystko zrobisz zwykłymi ekranami.',
    przerwane: 'Przerwane — polecenie czeka w polu.',
    niejasne: 'Coś poszło nie tak — spróbuj inaczej sformułować polecenie.',
    wysylam: 'Wysyłam…',
    // Odpowiedź z opcji pytania NIE wraca do pola: wysłana stamtąd jako
    // zwykłe polecenie mogłaby zapisać od razu tekst, który napisał model.
    siecOpcja: 'Brak połączenia. Wybierz odpowiedź jeszcze raz, gdy wróci internet.',
    przerwaneOpcja: 'Przerwane — wybierz odpowiedź jeszcze raz.',
  };

  // { tlo, arkusz, rozmowa, pole, mik, wyslij, stan, stanTekst, popraw, przerwij,
  //   zajete, ukryte, ukryteO, wywolal, kontroler, bezMik }
  let okno = null;
  let historia = [];
  let wysylkaZegar = null;
  // Zamknięcie przyciskiem woła history.back(), a ten działa ASYNCHRONICZNIE.
  // Okno otwarte ponownie, zanim przyjdzie popstate, nie może przez niego
  // zgasnąć (ta sama pułapka co `wrocDoArkusza` w eat.js) — flaga mówi,
  // że najbliższy popstate jest nasz.
  // Ograniczona czasem: popstate, który nie przyszedł, nie może połknąć
  // późniejszego, prawdziwego gestu „wstecz".
  let wsteczOd = 0;
  const WSTECZ_MS = 1500;
  const wsteczTrwa = () => wsteczOd > 0 && Date.now() - wsteczOd < WSTECZ_MS;

  function el(tag, klasa, tekst) {
    const e = document.createElement(tag);
    if (klasa) e.className = klasa;
    if (tekst != null) e.textContent = tekst;
    return e;
  }

  function lokalnyCzas() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const a = Math.abs(off);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
      + `${off >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}:${p(a % 60)}`;
  }

  function dzisLokalnie() {
    return lokalnyCzas().slice(0, 10);
  }

  function listaDomyslna() {
    try { return parseInt(localStorage.getItem('listaSel') || '0', 10) || null; } catch { return null; }
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

  // M4: przed przejściem na inną stronę wpis {ast:1} nie może zostać w historii —
  // „wstecz" z tamtej strony wracałby na wpis, który udaje otwarte okno.
  function zwolnijHistorie() {
    try { if (history.state && history.state.ast) history.replaceState(null, ''); } catch {}
  }

  // ── przyciski wywołania ────────────────────────────────────────────────
  function wstawPrzyciski() {
    document.body.classList.add('ma-asystenta');
    // Telefon: przycisk na stałe przy prawej krawędzi dolnego paska (wariant a2).
    const dok = el('div', 'ast-dok');
    const b = el('button', 'ast-guzik');
    b.type = 'button';
    b.setAttribute('aria-label', 'Otwórz asystenta');
    b.innerHTML = IKONA;
    b.addEventListener('click', otworz);
    dok.append(b);
    document.body.append(dok);
    // Tło pod przyciskiem ma wysokość paska stron (z marginesem bezpiecznym).
    const wysokosc = () => {
      const pasek = document.querySelector('.bottom-nav');
      if (pasek && pasek.offsetHeight) dok.style.height = pasek.offsetHeight + 'px';
    };
    wysokosc();
    window.addEventListener('resize', wysokosc);
    // Komputer: przycisk w górnym pasku, obok profilu.
    const nav = document.querySelector('nav');
    if (nav) {
      const g = el('button', 'ast-nav');
      g.type = 'button';
      g.setAttribute('aria-label', 'Otwórz asystenta');
      g.innerHTML = IKONA + '<span aria-hidden="true">Asystent</span>';
      g.addEventListener('click', otworz);
      const prawa = nav.querySelector('.nav-prawa');
      if (prawa) prawa.prepend(g); else nav.append(g);
    }
  }

  // ── okno ───────────────────────────────────────────────────────────────
  function otworz() {
    if (okno && !okno.ukryte) return;
    // D1: po 10 minutach ukrycia — nowa rozmowa (żadne „Cofnij" już nie żyje).
    if (okno && Date.now() - okno.ukryteO > ZYCIE_MS) zniszcz();
    if (!okno) zbuduj();
    pokazOkno();
  }

  function zbuduj() {
    const tlo = el('div', 'ast-tlo');
    tlo.hidden = true;
    tlo.innerHTML = `
      <div class="ast-arkusz" role="dialog" aria-modal="true" aria-labelledby="ast-tytul">
        <div class="ast-uchwyt" aria-hidden="true"></div>
        <header class="ast-naglowek">${IKONA}<h2 id="ast-tytul">Asystent</h2>
          <button type="button" class="ast-nowa">Nowa rozmowa</button>
          <button type="button" class="ast-zamknij" aria-label="Zamknij">✕</button></header>
        <div class="ast-rozmowa" aria-live="polite"></div>
        <form class="ast-stopka" novalidate>
          <div class="ast-stan" hidden><span class="ast-stan-tekst"></span>
            <button type="button" class="ast-chip ast-popraw" hidden>Popraw</button>
            <button type="button" class="ast-chip ast-przerwij" hidden>Przerwij</button></div>
          <div class="ast-wiersz">
            <button type="button" class="ast-ikonka ast-boczna ast-paragon" aria-label="Zdjęcie paragonu">${PARAGON}</button>
            <button type="button" class="ast-ikonka ast-boczna ast-skan" aria-label="Skanuj kod kreskowy" hidden>${KOD}</button>
            <label class="ast-pole"><span class="ast-schowane">Polecenie</span>
              <input type="text" id="ast-tekst" autocomplete="off" maxlength="600" enterkeyhint="send"
                     placeholder="Mów lub pisz…"></label>
            <button type="button" class="ast-ikonka ast-mik" aria-label="Mów" aria-pressed="false">${MIK}</button>
            <button type="submit" class="ast-ikonka ast-wyslij" aria-label="Wyślij" hidden>${WYSLIJ}</button>
          </div>
        </form>
      </div>`;
    document.body.append(tlo);
    okno = {
      tlo,
      arkusz: tlo.querySelector('.ast-arkusz'),
      rozmowa: tlo.querySelector('.ast-rozmowa'),
      pole: tlo.querySelector('#ast-tekst'),
      mik: tlo.querySelector('.ast-mik'),
      wyslij: tlo.querySelector('.ast-wyslij'),
      stan: tlo.querySelector('.ast-stan'),
      stanTekst: tlo.querySelector('.ast-stan-tekst'),
      popraw: tlo.querySelector('.ast-popraw'),
      przerwij: tlo.querySelector('.ast-przerwij'),
      zajete: false, ukryte: true, ukryteO: 0, wywolal: null, kontroler: null,
      bezMik: !(window.SpeechRecognition || window.webkitSpeechRecognition),
    };
    pustyStan();
    podepnij(tlo);
    przyciskWyslij();
  }

  function zniszcz() {
    if (!okno) return;
    if (okno.kontroler) okno.kontroler.abort();
    okno.tlo.remove();
    okno = null;
    historia = [];
  }

  function podepnij(tlo) {
    // Stuknięcie w tło nie zamyka, gdy żyje „Cofnij" albo stoi niezapisana
    // karta — przypadkowe stuknięcie nie może schować decyzji (D1).
    tlo.addEventListener('click', (e) => {
      if (e.target === tlo && !window.AsystentKarty.cosCzeka(okno.rozmowa)) zamknij();
    });
    tlo.querySelector('.ast-zamknij').addEventListener('click', () => zamknij());
    tlo.querySelector('.ast-nowa').addEventListener('click', nowaRozmowa);
    tlo.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); wyslij(okno.pole.value); });
    tlo.addEventListener('keydown', klawisze);
    okno.mik.addEventListener('click', przelaczMik);
    // Ręczne pisanie albo stuknięcie w pole: mikrofon milknie, a automatyczna
    // wysyłka rozpoznanego tekstu staje — da się go poprawić (R11).
    okno.pole.addEventListener('focus', () => { stopMik(); wstrzymajWysylke(); });
    okno.pole.addEventListener('input', () => { stopMik(); wstrzymajWysylke(); przyciskWyslij(); });
    // „Popraw" zatrzymuje wysyłkę BEZ otwierania klawiatury.
    okno.popraw.addEventListener('click', wstrzymajWysylke);
    okno.przerwij.addEventListener('click', () => { if (okno.kontroler) okno.kontroler.abort(); });
    // Każdy przycisk karty, opcja pytania czy pole na karcie ucisza mikrofon.
    okno.rozmowa.addEventListener('click', (e) => {
      if (e.target.closest('button, label, input, select')) { stopMik(); wstrzymajWysylke(); }
    });
    // M4: karty same zmieniają `location.href` (przejście do widoku, zdjęcie
    // paragonu do /upload). Faza przechwytywania — zanim karta zdąży przejść.
    okno.rozmowa.addEventListener('click', (e) => {
      if (e.target.closest('.ast-karta[data-typ="widok"] .ast-zapisz')) zwolnijHistorie();
    }, true);
    okno.rozmowa.addEventListener('change', (e) => {
      if (e.target.closest('.ast-karta[data-typ="aparat"] input[type="file"]')) zwolnijHistorie();
    }, true);
    // Paragon — karta aparatu po stronie przeglądarki, bez wywołania modelu.
    tlo.querySelector('.ast-paragon').addEventListener('click', () => {
      stopMik(); wstrzymajWysylke(); usunPusty();
      window.AsystentKarty.pokaz({ typ: 'aparat', tryb: 'karta', opis: 'Zrób zdjęcie paragonu', dane: {} },
        okno.rozmowa, null);
      przewin();
    });
    const skan = tlo.querySelector('.ast-skan');
    // Rozpoznawanie kodów ma tylko Chrome na Androidzie — na iPhonie ikony nie ma.
    if ('BarcodeDetector' in window) {
      skan.hidden = false;
      skan.addEventListener('click', () => {
        stopMik(); wstrzymajWysylke(); usunPusty();
        window.AsystentKarty.pokaz({ typ: 'skan', tryb: 'karta', opis: 'Zeskanuj kod kreskowy produktu',
          dane: { data: dzisLokalnie(), posilek: window.AsystentKarty.poraPosilku(new Date()) } },
        okno.rozmowa, null);
        przewin();
      });
    }
    przeciaganie(tlo);
  }

  // Pusty stan: przykłady, które WPISUJĄ się w pole (nie wysyłają same).
  function pustyStan() {
    if (okno.rozmowa.children.length) return;
    const box = el('div', 'ast-pusto');
    box.append(el('p', null, 'Powiedz albo napisz — albo stuknij przykład:'));
    const lista = el('div', 'ast-przyklady');
    for (const t of T.przyklady) {
      const b = el('button', 'ast-chip', '„' + t + '”');
      b.type = 'button';
      b.addEventListener('click', () => {
        okno.pole.value = t;
        przyciskWyslij();
        okno.pole.focus();
      });
      lista.append(b);
    }
    box.append(lista);
    okno.rozmowa.append(box);
  }

  function usunPusty() {
    const p = okno && okno.rozmowa.querySelector('.ast-pusto');
    if (p) p.remove();
  }

  function nowaRozmowa() {
    if (!okno) return;
    stopMik(); wstrzymajWysylke();
    window.AsystentKarty.zatrzymajSkan();
    // Przerwanie z "Nowa rozmowa" jest ciche: żądanie przestaje być "bieżące",
    // więc jego sprzątanie nie wraca do pola ani nie pokazuje "Przerwane".
    if (okno.kontroler) { okno.kontroler.abort(); okno.kontroler = null; }
    okno.zajete = false;
    historia = [];
    okno.rozmowa.replaceChildren();
    ukryjStan();
    okno.pole.value = '';
    przyciskWyslij();
    pustyStan();
    okno.pole.focus();
  }

  function pokazOkno() {
    okno.ukryte = false;
    okno.wywolal = document.activeElement;
    okno.tlo.hidden = false;
    document.body.classList.add('ast-otwarte');
    // „Wstecz" (gest Androida) zamyka okno, nie stronę — jak arkusz w eat.js.
    // Gdy spóźniony popstate z poprzedniego zamknięcia jeszcze idzie, wpis
    // {ast:1} nadal stoi; naWstecz() odłoży go z powrotem zamiast gasić okno.
    try { if (!wsteczTrwa() && !(history.state && history.state.ast)) history.pushState({ ast: 1 }, ''); } catch {}
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', dopasujDoKlawiatury);
      window.visualViewport.addEventListener('scroll', dopasujDoKlawiatury);
    }
    dopasujDoKlawiatury();
    przewin();
    // Mikrofon od razu tylko na telefonie — na komputerze start bez pytania
    // wyskakiwałby prośbą przeglądarki o zgodę przy każdym otwarciu okna.
    if (window.matchMedia('(max-width: 700px)').matches && !okno.bezMik) autoMik();
    else okno.pole.focus();
  }

  function zamknij(zHistorii) {
    if (!okno || okno.ukryte) return;
    stopMik(); wstrzymajWysylke();
    window.AsystentKarty.zatrzymajSkan();      // kamera nie może chodzić pod schowanym oknem
    okno.ukryte = true;
    okno.ukryteO = Date.now();
    okno.tlo.hidden = true;
    okno.arkusz.style.transform = '';
    document.body.classList.remove('ast-otwarte');
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', dopasujDoKlawiatury);
      window.visualViewport.removeEventListener('scroll', dopasujDoKlawiatury);
    }
    if (zHistorii !== true && history.state && history.state.ast) {
      try { wsteczOd = Date.now(); history.back(); } catch { wsteczOd = 0; }
    }
    const w = okno.wywolal;
    okno.wywolal = null;
    if (w && document.contains(w) && typeof w.focus === 'function') w.focus();   // fokus wraca do przycisku
  }

  // Słuchacz stały (nie tylko przy otwartym oknie) — musi przechwycić
  // spóźniony popstate po zamknięciu przyciskiem, także gdy okno już
  // otwarto ponownie.
  function naWstecz() {
    if (wsteczTrwa()) {
      wsteczOd = 0;
      if (okno && !okno.ukryte) { try { history.pushState({ ast: 1 }, ''); } catch {} }
      return;
    }
    if (okno && !okno.ukryte) zamknij(true);
  }

  // Strony bez `interactive-widget=resizes-content` (pulpit, lista, upload):
  // klawiatura nakrywa dół ekranu. Tło dopasowuje się do widocznej części,
  // więc stopka z polem zostaje nad klawiaturą. Meta innych stron bez zmian.
  function dopasujDoKlawiatury() {
    if (!okno || !window.visualViewport) return;
    const vv = window.visualViewport;
    okno.tlo.style.top = vv.offsetTop + 'px';
    okno.tlo.style.height = vv.height + 'px';
  }

  // Esc zamyka; Tab krąży w obrębie okna (aria-modal bez pułapki fokusu
  // wypuszczałby klawiaturę na stronę pod spodem).
  function klawisze(e) {
    if (e.key === 'Escape') { e.preventDefault(); zamknij(); return; }
    if (e.key !== 'Tab') return;
    const f = [...okno.arkusz.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null);
    if (!f.length) return;
    const pierwszy = f[0];
    const ostatni = f[f.length - 1];
    if (e.shiftKey && document.activeElement === pierwszy) { e.preventDefault(); ostatni.focus(); }
    else if (!e.shiftKey && document.activeElement === ostatni) { e.preventDefault(); pierwszy.focus(); }
  }

  // Przeciągnięcie uchwytu albo nagłówka w dół o ponad 80 px zamyka okno.
  function przeciaganie(tlo) {
    let y0 = null;
    let dy = 0;
    const koniec = () => {
      if (y0 == null) return;
      y0 = null;
      okno.arkusz.style.transition = '';
      okno.arkusz.style.transform = '';
      if (dy > 80) zamknij();
    };
    for (const cel of [tlo.querySelector('.ast-uchwyt'), tlo.querySelector('.ast-naglowek')]) {
      cel.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        y0 = e.clientY; dy = 0;
        okno.arkusz.style.transition = 'none';
        try { cel.setPointerCapture(e.pointerId); } catch {}
      });
      cel.addEventListener('pointermove', (e) => {
        if (y0 == null) return;
        dy = Math.max(0, e.clientY - y0);
        okno.arkusz.style.transform = dy ? `translateY(${dy}px)` : '';
      });
      cel.addEventListener('pointerup', koniec);
      cel.addEventListener('pointercancel', koniec);
    }
  }

  function przewin() {
    if (okno) okno.rozmowa.scrollTop = okno.rozmowa.scrollHeight;
  }

  function dymek(kto, tekst) {
    if (!tekst) return;                 // pusta wiadomość nigdy nie robi pustego dymka
    usunPusty();
    const d = el('div', 'ast-dymek ast-' + kto, tekst);
    okno.rozmowa.append(d);
    przewin();
  }

  // Linia stanu nad polem: „Słucham…", „Wyślę za chwilę…" (+ Popraw),
  // „Myślę…" (+ Przerwij). Nie dymek — to stan, nie wypowiedź.
  function pokazStan(tekst, opcje) {
    if (!okno) return;
    const o = opcje || {};
    okno.stanTekst.textContent = tekst;
    okno.popraw.hidden = !o.popraw;
    okno.przerwij.hidden = !o.przerwij;
    okno.stan.hidden = false;
  }

  function ukryjStan() {
    if (!okno) return;
    okno.stan.hidden = true;
    okno.popraw.hidden = true;
    okno.przerwij.hidden = true;
  }

  function wstrzymajWysylke() {
    if (wysylkaZegar) { clearTimeout(wysylkaZegar); wysylkaZegar = null; ukryjStan(); }
  }

  // Strzałka „Wyślij" zamiast mikrofonu, gdy w polu jest tekst. Bez mowy
  // (iPhone) strzałka stoi zawsze.
  function przyciskWyslij() {
    if (!okno) return;
    const jest = okno.pole.value.trim().length > 0;
    okno.wyslij.hidden = !jest && !okno.bezMik;
    okno.mik.hidden = jest || okno.bezMik;
  }

  // ── mikrofon ──────────────────────────────────────────────────────────
  function stopMik() {
    if (window.Dyktowanie && window.Dyktowanie.sluchaMy()) window.Dyktowanie.stop();
  }

  // Drugie stuknięcie zatrzymuje słuchanie.
  function przelaczMik() {
    if (window.Dyktowanie && window.Dyktowanie.sluchaMy()) { stopMik(); return; }
    sluchaj();
  }

  async function mikZablokowany() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const s = await navigator.permissions.query({ name: 'microphone' });
        if (s.state === 'granted') { lsSet(KLUCZ_MIK, ''); return false; }   // zgoda wróciła
        if (s.state === 'denied') return true;
      }
    } catch {}
    return lsGet(KLUCZ_MIK) === '1';
  }

  // Start sam z siebie (telefon) — ale nie wtedy, gdy przeglądarka już raz
  // odmówiła: wtedy pole tekstowe i jednorazowy komunikat.
  async function autoMik() {
    if (await mikZablokowany()) {
      if (!okno || okno.ukryte) return;
      okno.pole.focus();
      if (lsGet(KLUCZ_MIK_INFO) !== '1') { lsSet(KLUCZ_MIK_INFO, '1'); dymek('blad', T.mikZablokowany); }
      return;
    }
    if (!okno || okno.ukryte) return;
    if (document.activeElement !== okno.pole) okno.mik.focus();      // fokus w oknie bez otwierania klawiatury
    sluchaj(true);
  }

  // auto = start sam z siebie przy otwarciu okna.
  async function sluchaj(auto) {
    try { await zaladujSkrypt('dyktowanie.js'); } catch { return; }
    if (!okno || okno.ukryte) return;
    // K1: w czasie ładowania skryptu ktoś mógł zacząć pisać — rozpoznana mowa
    // nie może nadpisać wpisanego tekstu ani wysłać go sama.
    if (auto && (document.activeElement === okno.pole || okno.pole.value)) return;
    if (!window.Dyktowanie.dostepne()) { okno.bezMik = true; przyciskWyslij(); return; }
    wstrzymajWysylke();
    window.Dyktowanie.start({
      // Rozpoznany tekst najpierw stoi w polu; wysyłka po 1,5 s, chyba że
      // użytkownik stuknie „Popraw" albo pole.
      onTekst: (t) => {
        if (!okno || okno.ukryte || !t) return;
        wstrzymajWysylke();               // poprzedni zegar nie wyśle starego tekstu
        okno.pole.value = t;
        przyciskWyslij();
        pokazStan(T.wysle, { popraw: true });
        wysylkaZegar = setTimeout(() => {
          wysylkaZegar = null;
          ukryjStan();
          if (okno && !okno.ukryte) wyslij(okno.pole.value);
        }, 1500);
      },
      onStan: (s) => {
        if (!okno) return;
        okno.mik.classList.toggle('slucha', s);
        okno.mik.setAttribute('aria-pressed', s ? 'true' : 'false');
        okno.mik.setAttribute('aria-label', s ? 'Przestań słuchać' : 'Mów');
        if (s) pokazStan('Słucham…');
        else if (!wysylkaZegar && okno.stanTekst.textContent === 'Słucham…') ukryjStan();
      },
      onBlad: (t, kod) => {
        if (!okno) return;
        // Cisza to nie awaria — cicha linia stanu, nie czerwony dymek.
        if (kod === 'no-speech') { pokazStan(T.cisza); return; }
        if (kod === 'not-allowed' || kod === 'service-not-allowed') {
          lsSet(KLUCZ_MIK, '1');
          lsSet(KLUCZ_MIK_INFO, '1');
          dymek('blad', T.mikZablokowany);
          okno.pole.focus();
          return;
        }
        dymek('blad', t);
      },
    });
  }

  function pytanie(p) {
    if (!p || !p.tekst || !Array.isArray(p.opcje)) return;
    const box = el('div', 'ast-pytanie');
    box.append(el('div', 'ast-pytanie-tekst', p.tekst));
    const opcje = el('div', 'ast-opcje');
    for (const o of p.opcje) {
      const b = el('button', 'ast-opcja', o);
      b.type = 'button';
      b.addEventListener('click', async () => {
        const wszystkie = opcje.querySelectorAll('button');
        wszystkie.forEach((x) => { x.disabled = true; });
        b.classList.add('wybrana');
        // z opcji: serwer nie dopisze niczego od razu. M9: gdy nic nie poszło
        // (zajęte, brak sieci, błąd) — opcje znów czynne, wybór od nowa.
        const poszlo = await wyslij(o, true);
        if (!poszlo) {
          wszystkie.forEach((x) => { x.disabled = false; });
          b.classList.remove('wybrana');
        }
      });
      opcje.append(b);
    }
    box.append(opcje);
    okno.rozmowa.append(box);
    przewin();
  }

  // I3: odpowiedź bez tekstu (same karty) i tak trafia do historii — inaczej
  // „tak, ta druga" w następnym poleceniu nie miałoby do czego się odnieść.
  function wpisHistorii(d) {
    if (d.wiadomosc) return d.wiadomosc;
    const opisy = (d.propozycje || []).map((p) => p && p.opis).filter(Boolean);
    if (!opisy.length) return '';
    return ('Propozycje: ' + opisy.join('; ')).slice(0, MAX_HISTORII);
  }

  // Zwraca true, gdy polecenie dostało odpowiedź; false — gdy nie poszło
  // (puste, zajęte, brak sieci, przerwane, błąd serwera).
  async function wyslij(tekst, zOpcji) {
    wstrzymajWysylke();
    stopMik();
    tekst = (tekst || '').trim();
    if (!okno || !tekst || okno.zajete) return false;
    if (!navigator.onLine) {
      // Bez sieci nie wysyłamy wcale — polecenie zostaje w polu.
      if (zOpcji) { dymek('blad', T.siecOpcja); return false; }
      okno.pole.value = tekst;
      przyciskWyslij();
      dymek('blad', T.siec);
      return false;
    }
    okno.zajete = true;
    if (!zOpcji) { okno.pole.value = ''; przyciskWyslij(); }
    dymek('ja', tekst);
    const mysli = el('div', 'ast-mysli');
    mysli.innerHTML = '<div class="ai-spinner orbita"><i></i><i></i></div>';
    okno.rozmowa.append(mysli);
    przewin();
    // „Myślę…" po 3 s, po 15 s zdanie o rozkręcającym się serwerze (cold
    // start Railway); od 3 s jest też „Przerwij".
    const kontroler = new AbortController();
    okno.kontroler = kontroler;
    pokazStan(T.wysylam);          // L4: stan od razu, "Myślę…" dopiero po 3 s
    const z3 = setTimeout(() => pokazStan(T.mysle, { przerwij: true }), 3000);
    const z15 = setTimeout(() => pokazStan(T.dluzej, { przerwij: true }), 15000);
    // Bieżące = nie zastąpione przez "Nowa rozmowa" (ani nowe żądanie).
    const biezace = () => !!okno && okno.kontroler === kontroler;
    const sprzataj = () => {
      clearTimeout(z3); clearTimeout(z15);
      mysli.remove();
      if (biezace()) { ukryjStan(); okno.zajete = false; okno.kontroler = null; }
    };
    // Polecenie wraca do pola — ale nie odpowiedź z opcji (patrz T.siecOpcja).
    const wroc = () => { if (!zOpcji) { okno.pole.value = tekst; przyciskWyslij(); } };
    let r;
    let d = {};
    try {
      r = await authFetch('/api/asystent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tekst, historia, teraz: lokalnyCzas(), lista_domyslna_id: listaDomyslna(),
          z_opcji: !!zOpcji }),
        signal: kontroler.signal,
      });
      // K3: przerwanie w trakcie czytania treści to przerwanie, nie pusta odpowiedź.
      d = await r.json().catch((e) => { if (kontroler.signal.aborted) throw e; return {}; });
    } catch (e) {
      const zastapione = !biezace();
      sprzataj();
      if (!okno || zastapione) return false;
      wroc();
      if (kontroler.signal.aborted || (e && e.name === 'AbortError')) { pokazStan(zOpcji ? T.przerwaneOpcja : T.przerwane); return false; }
      dymek('blad', zOpcji ? T.siecOpcja : T.siec);   // TypeError „Failed to fetch" — nigdy surowy tekst
      return false;
    }
    const zastapione = !biezace();
    sprzataj();
    if (!okno || zastapione) return false;
    if (!r.ok) {
      wroc();
      let t = T.zaDlugo;
      if (r.status === 429) t = T.limit;
      else if (r.status < 500) t = typeof d.detail === 'string' ? d.detail : T.niejasne;   // 400/403 — tekst serwera; 422 (lista) — ogólnie
      dymek('blad', t);
      return false;
    }
    historia.push({ kto: 'user', tekst });
    const wpis = wpisHistorii(d);
    if (wpis) historia.push({ kto: 'asystent', tekst: wpis });
    historia = historia.slice(-12);
    // Przy pytaniu jego treść stoi w ramce z opcjami — w dymku tylko reszta (np. uwaga).
    const reszta = d.pytanie && d.pytanie.tekst
      ? (d.wiadomosc || '').replace(d.pytanie.tekst, '').trim() : (d.wiadomosc || '').trim();
    if (reszta) dymek('on', reszta);
    // I6: odpowiedź, która przyszła do SCHOWANEGO okna, niczego nie wykonuje
    // sama — każda propozycja (też przejście) staje jako karta i czeka na
    // ponowne otwarcie (D1 trzyma stan 10 min).
    const schowane = okno.ukryte;
    for (const p of d.propozycje || []) {
      if (!p) continue;
      const prop = schowane ? { ...p, tryb: 'karta' } : p;
      if (prop.tryb === 'od_razu' && prop.typ === 'widok') zwolnijHistorie();   // M4: zaraz przejście
      window.AsystentKarty.pokaz(prop, okno.rozmowa, d.log_id);
    }
    if (d.pytanie) pytanie(d.pytanie);
    przewin();
    return true;
  }

  // ── filtry pulpitu po przejściu z asystenta ──────────────────────────────
  // Pulpit nie czyta filtrów z adresu, więc ustawiamy pola sami i wołamy
  // `change` — dokładnie to, co robi użytkownik, zmieniając je ręcznie.
  // Miesiąc widać w polu od razu; przeładowanie pulpitu jest JEDNO — dopiero,
  // gdy wiadomo, czy osoba się znalazła (`loadDashboard` czyta oba pola).
  // Wcześniej `change` na miesiącu i potem na osobie ładowały pulpit dwa razy.
  function filtryPulpitu(q) {
    const m = q.get('asystent_month');
    const o = q.get('asystent_osoba');
    if (location.pathname !== '/' || (!m && !o)) return;
    history.replaceState(null, '', '/');
    const koniec = Date.now() + 5000;
    (function proba() {
      const mi = document.getElementById('filter-month');
      const os = document.getElementById('filter-osoba');
      if (!mi) { if (Date.now() < koniec) setTimeout(proba, 200); return; }
      if (m) mi.value = m;
      if (!o) { mi.dispatchEvent(new Event('change')); return; }
      const szukana = o.toLowerCase();
      // Serwer podaje etykietę z filtra (te same nazwy co loadOsobaOptions);
      // porównanie początkiem zostaje na wypadek osoby wirtualnej z gwiazdką.
      const opcja = os && [...os.options].find((x) => x.value
        && (x.value.toLowerCase() === szukana || x.text.toLowerCase().startsWith(szukana)));
      if (opcja) { os.value = opcja.value; os.dispatchEvent(new Event('change')); return; }
      if (Date.now() < koniec) { setTimeout(proba, 200); return; }
      // Osoby nie ma w filtrze — pokazujemy miesiąc dla wszystkich i mówimy to wprost.
      mi.dispatchEvent(new Event('change'));
      const [r, mm] = (mi.value || '').split('-').map(Number);
      const miesiac = r && mm
        ? new Date(r, mm - 1, 15).toLocaleDateString('pl-PL', { month: 'long' }) : 'bieżący miesiąc';
      toast(`Nie znalazłem osoby „${o}” — pokazuję ${miesiac} dla wszystkich.`);
    })();
  }

  function start(me) {
    if (!me || !me.asystent || document.querySelector('.ast-dok')) return;
    // M4: strona wczytana na nowo na wpisie {ast:1} (odświeżenie, powrót
    // z innej strony) — okna nie ma, więc wpis nie może udawać, że jest.
    zwolnijHistorie();
    window.addEventListener('popstate', naWstecz);
    // Adres czytamy raz: filtry pulpitu same czyszczą go z parametrów.
    const q = new URLSearchParams(location.search);
    wstawPrzyciski();
    filtryPulpitu(q);
    if (q.has('asystent')) {
      try { history.replaceState(null, '', location.pathname); } catch {}
      otworz();
    }
  }

  window.Asystent = { start, otworz };
})();
