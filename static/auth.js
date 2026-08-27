const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAyrSgsNqGLopkZCsa2ZT0AVFBML9XdTgA",
  authDomain: "budzet-domowy-56761.firebaseapp.com",
  projectId: "budzet-domowy-56761",
  storageBucket: "budzet-domowy-56761.firebasestorage.app",
  messagingSenderId: "350559993272",
  appId: "1:350559993272:web:03a4e625c748d52a61234d",
};

firebase.initializeApp(FIREBASE_CONFIG);
const _auth = firebase.auth();

// PWA: rejestracja service workera daje instalację na ekranie głównym
// („Zainstaluj aplikację" na Androidzie, „Do ekranu głównego" na iOS),
// szybszy start z cache'owanej skorupy i ekran offline zamiast błędu
// przeglądarki. Błąd rejestracji nie może wywrócić strony — apka działa
// bez workera tak samo jak dotąd.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ── Paleta wykresów ─────────────────────────────────────────────────────
// Piętnaście barw — każda kategoria ma własną. Kolejność slotów NIE jest
// kosmetyczna: to ona decyduje o rozróżnialności sąsiadów, więc dobrana
// została przez walidator, nie na oko.
//
// Zwalidowane wobec powierzchni kart (#ffffff i #1e2126) — wszystkie bramki
// przechodzą w obu motywach:
//   jasny  — CVD ΔE 9.1, widzenie normalne 19.6, pasmo jasności i chroma OK
//   ciemny — CVD ΔE 8.4, widzenie normalne 19.3, kontrast wszystkich ≥ 3:1
//
// Kilka barw ma kontrast poniżej 3:1 wobec jasnego tła. To dopuszczalne,
// bo legenda pokazuje nazwę i kwotę obok każdej próbki — kolor nigdy nie
// jest jedynym nośnikiem tożsamości.
const PALETA_KAT = {
  jasny: [
    '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4',
    '#008300', '#4a3aa7', '#e34948', '#00879e', '#b5651d',
    '#00967d', '#8e44c4', '#7d8a00', '#4a63b0', '#c2185b',
  ],
  ciemny: [
    '#3987e5', '#d95926', '#199e70', '#c98500', '#d55181',
    '#008300', '#9085e9', '#e66767', '#00a0bd', '#c9761f',
    '#00a88c', '#a45fd6', '#8f9e00', '#6f86d6', '#d94a7e',
  ],
};
// kategorie własne gospodarstwa, spoza stałej listy
const KAT_POZOSTALE = { jasny: '#8a8782', ciemny: '#918d86' };

// Przypisanie jest STAŁE po nazwie kategorii, nie po wielkości wydatku —
// inaczej kolory skakałyby z miesiąca na miesiąc i nie dałoby się ich zapamiętać.
const KAT_SLOT = {
  'Spożywcze': 0,
  'Transport i paliwo': 1,
  'Dom i wyposażenie': 2,
  'Rachunki domowe': 3,
  'Wydatki na dziecko': 4,
  'Zdrowie': 5,
  'Rozrywka i hobby': 6,
  'Higiena i kosmetyki': 7,
  'Odzież i obuwie': 8,
  'Lokal Gałczyńskiego': 9,
  'Edukacja': 10,
  'Elektronika': 11,
  'Używki': 12,
  'Prezenty': 13,
  'Inne': 14,
};

// Kwoty doliczają się od zera przy wejściu — to jedyna animacja, która coś
// komunikuje („dane właśnie doszły"), a nie ozdabia. Przy ustawieniu
// ograniczonego ruchu wartość pojawia się od razu.
function odliczaj(el, docelowa, formatuj, ms = 620) {
  if (!el) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !isFinite(docelowa)) {
    el.textContent = formatuj(docelowa);
    return;
  }
  const start = performance.now();
  function krok(teraz) {
    const p = Math.min(1, (teraz - start) / ms);
    const e = 1 - Math.pow(1 - p, 3);          // wyhamowanie na końcu
    el.textContent = formatuj(docelowa * e);
    if (p < 1) requestAnimationFrame(krok);
  }
  requestAnimationFrame(krok);
}

function motywWykresu() {
  return getComputedStyle(document.documentElement)
    .getPropertyValue('color-scheme').trim() === 'dark' ? 'ciemny' : 'jasny';
}

function tokenCss(nazwa) {
  return getComputedStyle(document.documentElement).getPropertyValue(nazwa).trim();
}

// kolor pojedynczej serii (trend, wykres dzienny) — pierwszy slot palety
function seriaColor(i = 0) {
  const p = PALETA_KAT[motywWykresu()];
  return p[i % p.length];
}

// Chart.js nie czyta zmiennych CSS, więc opisy i siatkę podajemy mu wprost
// i odświeżamy przy zmianie motywu.
function ustawChromWykresow() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = tokenCss('--muted');
  Chart.defaults.borderColor = tokenCss('--border');
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
}
// Chart.js ładuje się z CDN, więc przy parsowaniu tego pliku może go jeszcze
// nie być — ustawiamy chrom także po zbudowaniu dokumentu.
ustawChromWykresow();
window.addEventListener('DOMContentLoaded', ustawChromWykresow);

// ── przekazanie zdjęcia między stronami ──
// File nie przejdzie przez adres URL, a zdjęcie z telefonu ma kilka MB —
// sessionStorage (limit ~5 MB, tylko tekst) się nie nadaje. IndexedDB trzyma
// pliki binarne i ma znacznie większą pojemność.
const _BAZA_ZDJEC = 'wiem-zdjecia';

function _otworzBaze() {
  return new Promise((ok, blad) => {
    const req = indexedDB.open(_BAZA_ZDJEC, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pliki');
    req.onsuccess = () => ok(req.result);
    req.onerror = () => blad(req.error);
  });
}

async function zapiszZdjecieDoPrzekazania(plik) {
  const db = await _otworzBaze();
  await new Promise((ok, blad) => {
    const tx = db.transaction('pliki', 'readwrite');
    tx.objectStore('pliki').put(plik, 'ostatnie');
    tx.oncomplete = ok;
    tx.onerror = () => blad(tx.error);
  });
  db.close();
}

// Odbiór jest jednorazowy — plik kasujemy od razu, żeby odświeżenie strony
// nie wgrało tego samego paragonu drugi raz.
async function odbierzPrzekazaneZdjecie() {
  const db = await _otworzBaze();
  const plik = await new Promise((ok) => {
    const tx = db.transaction('pliki', 'readwrite');
    const st = tx.objectStore('pliki');
    const req = st.get('ostatnie');
    req.onsuccess = () => { st.delete('ostatnie'); ok(req.result || null); };
    req.onerror = () => ok(null);
  });
  db.close();
  return plik;
}

async function authGetToken() {
  const user = _auth.currentUser;
  if (!user) throw new Error("Nie zalogowany");
  return user.getIdToken();
}

async function authLogout() {
  await _auth.signOut();
  window.location.href = "/login";
}

// ── motyw: auto (za systemem) / jasny / ciemny ──
// Wybór zapisany w localStorage, stosowany przed pierwszym malowaniem przez
// skrypt wstrzykiwany w main.py — tutaj tylko przełączanie i pasek statusu.
function _motywBiezacy() {
  try { return localStorage.getItem('motyw') || 'auto'; } catch { return 'auto'; }
}

function _ustawMotyw(m) {
  const root = document.documentElement;
  try {
    if (m === 'auto') localStorage.removeItem('motyw');
    else localStorage.setItem('motyw', m);
  } catch {}
  if (m === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', m === 'ciemny' ? 'dark' : 'light');
  _odswiezPasekStatusu();
  // wykresy nie czytaja zmiennych CSS — musza sie przerysowac same
  window.dispatchEvent(new Event('motyw-zmieniony'));
}

function _odswiezPasekStatusu() {
  // Pasek nawigacji jest atramentowy w obu motywach, więc pasek statusu
  // telefonu zostaje ciemny na stałe — inaczej nad ciemnym paskiem apki
  // świeciłby jasny pas systemu.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', '#1a1d20');
}

function _podepnijMotyw(overlay) {
  const box = overlay.querySelector('#_mtheme');
  if (!box) return;
  const zaznacz = () => {
    const akt = _motywBiezacy();
    box.querySelectorAll('button').forEach((b) => {
      const wybrany = b.dataset.motyw === akt;
      b.style.background = wybrany ? 'var(--primary)' : 'var(--surface)';
      b.style.color = wybrany ? 'var(--on-primary)' : 'var(--text)';
      b.style.fontWeight = wybrany ? '600' : '400';
    });
  };
  box.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { _ustawMotyw(b.dataset.motyw); zaznacz(); };
  });
  zaznacz();
}

window.addEventListener('DOMContentLoaded', _odswiezPasekStatusu);

// Własne escapowanie, bo `esc` z app.js nie jest dostępne wszędzie — ten plik
// rysuje okno profilu na KAŻDEJ stronie, a app.js ładują tylko trzy.
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── awatary ─────────────────────────────────────────────────────────────────
// Dwanaście gotowych: kolor z palety wykresów + znak w stylu reszty ikon.
// Kolejność jest STAŁA — numer wybranego awatara siedzi w bazie jako indeks,
// więc przestawienie tej tablicy przemalowałoby wszystkim domownikom awatary.
const AWATARY = [
  { kolor: '#2a78d6', znak: '<path d="M4 20c0-4 3.6-6.4 8-6.4s8 2.4 8 6.4"/><circle cx="12" cy="8" r="4"/>' },
  { kolor: '#eb6834', znak: '<path d="M4.5 10.5 7 4.6l3.4 3h3.2l3.4-3 2.5 5.9v4.9c0 2.7-3.6 4.6-8 4.6s-8-1.9-8-4.6z"/>' },
  { kolor: '#1baf7a', znak: '<path d="M12 3.5 14.6 9l6 .8-4.4 4.2 1.1 6-5.3-2.9L6.7 20l1.1-6L3.4 9.8 9.4 9z"/>' },
  { kolor: '#eda100', znak: '<path d="M12 20.5c4 0 7-2.6 7-6.6S15.6 3.5 12 3.5 5 9.9 5 13.9s3 6.6 7 6.6z"/><path d="M12 20.5V9.5"/>' },
  { kolor: '#d55181', znak: '<path d="M12 20.5S4.5 15.6 4.5 10.2A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7.5 2.6c0 5.4-7.5 10.3-7.5 10.3z"/>' },
  { kolor: '#008300', znak: '<path d="M12 20V11"/><path d="M12 11c0-3.6 2.6-6.5 6-6.5 0 3.6-2.6 6.5-6 6.5z"/><path d="M12 14c0-2.8-2.1-5-4.8-5 0 2.8 2.1 5 4.8 5z"/>' },
  { kolor: '#4a3aa7', znak: '<path d="M3.5 18.5 9 8l4 6.5 2.5-3.5 5 7.5z"/><circle cx="16.5" cy="6" r="2"/>' },
  { kolor: '#00879e', znak: '<path d="M3.5 14c1.7-2 3.4-2 5 0s3.4 2 5 0 3.4-2 5 0"/><path d="M3.5 18.5c1.7-2 3.4-2 5 0s3.4 2 5 0 3.4-2 5 0"/><circle cx="12" cy="6.5" r="2.6"/>' },
  { kolor: '#b5651d', znak: '<path d="M6 20V9.5L12 4l6 5.5V20z"/><path d="M10 20v-5h4v5"/>' },
  { kolor: '#8e44c4', znak: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2.6M12 17.9v2.6M3.5 12h2.6M17.9 12h2.6M6 6l1.9 1.9M16.1 16.1 18 18M18 6l-1.9 1.9M7.9 16.1 6 18"/>' },
  { kolor: '#7d8a00', znak: '<path d="M20 13.5A8 8 0 0 1 10.5 4a8 8 0 1 0 9.5 9.5z"/>' },
  { kolor: '#00967d', znak: '<path d="M7 17.5h9.5a4 4 0 0 0 .4-8A6 6 0 0 0 5.6 11 3.3 3.3 0 0 0 7 17.5z"/>' },
];

// Kto nic nie wybrał, dostaje awatar wyliczony z własnego id — dzięki temu
// domownicy różnią się od siebie, zanim ktokolwiek cokolwiek ustawi.
function awatarNumer(osoba) {
  if (!osoba) return 0;
  if (osoba.awatar !== null && osoba.awatar !== undefined) return osoba.awatar % AWATARY.length;
  return ((osoba.user_id || osoba.id || 0) * 5 + 1) % AWATARY.length;
}

function awatarHtml(osoba, klasa) {
  const a = AWATARY[awatarNumer(osoba)];
  return `<span class="aw ${klasa || ''}" style="background:${a.kolor}">`
       + `<svg viewBox="0 0 24 24" aria-hidden="true">${a.znak}</svg></span>`;
}
window.awatarHtml = awatarHtml;

// ── powiadomienia push ──────────────────────────────────────────────────────

// Klucz VAPID przychodzi w base64url, a pushManager chce surowych bajtów.
function _kluczNaBajty(b64) {
  const uzup = '='.repeat((4 - (b64.length % 4)) % 4);
  const zwykly = (b64 + uzup).replace(/-/g, '+').replace(/_/g, '/');
  const surowy = atob(zwykly);
  return Uint8Array.from(surowy, (c) => c.charCodeAt(0));
}

// Rodzaje pokazujemy nawet przy wyłączonych powiadomieniach — to preferencja
// konta, nie urządzenia, więc ustawia się ją raz i obowiązuje wszędzie.
function _podepnijRodzaje(overlay, stany) {
  const box = overlay.querySelector('#_mrodzaje');
  if (!box) return;
  box.style.display = 'block';
  box.querySelectorAll('.pf-prze').forEach((p) => {
    const rodzaj = p.dataset.rodzaj;
    p.setAttribute('aria-checked', stany[rodzaj] === false ? 'false' : 'true');
    p.onclick = async () => {
      const nowy = p.getAttribute('aria-checked') !== 'true';
      p.setAttribute('aria-checked', String(nowy));
      try {
        const res = await authFetch('/api/push/rodzaje', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [rodzaj]: nowy }),
        });
        if (!res.ok) throw new Error();
        _zapisano(overlay);
      } catch {
        // cofamy przełącznik, żeby nie pokazywał stanu, którego serwer nie zapisał
        p.setAttribute('aria-checked', String(!nowy));
      }
    };
  });
}

async function _podepnijPush(overlay) {
  const box = overlay.querySelector('#_mpushbox');
  const btn = overlay.querySelector('#_mpush');
  const info = overlay.querySelector('#_mpushinfo');
  if (!box) return;

  // Bez service workera albo bez PushManagera nie ma o czym rozmawiać — tak
  // wygląda m.in. Safari na iPhonie otwarte jako zwykła zakładka.
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    box.style.display = 'block';
    btn.style.display = 'none';
    info.textContent = 'Ta przeglądarka nie obsługuje powiadomień. Na iPhonie działają dopiero po dodaniu aplikacji do ekranu początkowego.';
    return;
  }

  let stan;
  try {
    stan = await (await authFetch('/api/push/stan')).json();
  } catch { return; }
  // Wcześniej sekcja po prostu znikała, gdy serwer nie miał kluczy. Wyglądało to
  // identycznie jak niewdrożony kod i kosztowało godzinę szukania — więc teraz
  // mówi wprost, czego brakuje, zamiast chować się po cichu.
  if (!stan || !stan.dostepne) {
    box.style.display = 'block';
    btn.style.display = 'none';
    const brak = ((stan && stan.brakuje) || []).join(', ');
    info.textContent = 'Powiadomienia nie są skonfigurowane na serwerze'
      + (brak ? ' — brakuje: ' + brak + '.' : '.');
    return;
  }
  box.style.display = 'block';
  btn.style.display = '';
  _podepnijRodzaje(overlay, stan.rodzaje || {});

  const rejestracja = await navigator.serviceWorker.ready.catch(() => null);
  if (!rejestracja) return;

  async function subskrypcjaTegoUrzadzenia() {
    try { return await rejestracja.pushManager.getSubscription(); } catch { return null; }
  }

  async function rysuj() {
    const sub = await subskrypcjaTegoUrzadzenia();
    if (Notification.permission === 'denied') {
      btn.disabled = true;
      btn.style.opacity = '.6';
      btn.textContent = 'Powiadomienia zablokowane';
      info.textContent = 'Zablokowałeś je kiedyś dla tej strony — odblokować można tylko w ustawieniach przeglądarki (kłódka przy adresie → Powiadomienia).';
      return;
    }
    btn.disabled = false;
    btn.style.opacity = '1';
    if (sub) {
      btn.textContent = 'Wyłącz na tym urządzeniu';
      btn.style.color = 'var(--danger)';
      info.innerHTML = 'Włączone na tym urządzeniu. <a href="#" id="_mpushtest" style="color:var(--accent)">Wyślij próbne</a>';
      const t = info.querySelector('#_mpushtest');
      if (t) t.onclick = async (e) => {
        e.preventDefault();
        t.textContent = 'wysyłam…';
        try {
          const r = await authFetch('/api/push/test', { method: 'POST' });
          t.textContent = r.ok ? 'wysłane' : 'nie poszło';
        } catch { t.textContent = 'nie poszło'; }
      };
    } else {
      btn.textContent = 'Włącz powiadomienia';
      btn.style.color = 'var(--text)';
      info.textContent = stan.wlaczone
        ? 'Masz je włączone na innym urządzeniu. Zgoda jest osobna dla każdego telefonu i przeglądarki.'
        : 'Przypomnienie o przelewach rano, nowe pozycje na liście zakupów i gotowy raport miesięczny.';
    }
  }

  btn.onclick = async () => {
    const sub = await subskrypcjaTegoUrzadzenia();
    btn.disabled = true;
    try {
      if (sub) {
        await authFetch('/api/push/subskrypcja?endpoint=' + encodeURIComponent(sub.endpoint), { method: 'DELETE' });
        await sub.unsubscribe().catch(() => {});
      } else {
        // requestPermission MUSI wyjść z kliknięcia — stąd wywołanie tutaj,
        // a nie przy otwieraniu okna profilu.
        const zgoda = await Notification.requestPermission();
        if (zgoda !== 'granted') { await rysuj(); btn.disabled = false; return; }
        const nowa = await rejestracja.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: _kluczNaBajty(stan.klucz),
        });
        const res = await authFetch('/api/push/subskrypcja', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nowa.toJSON()),
        });
        // Gdy serwer nie przyjmie zapisu, cofamy zgodę w przeglądarce — inaczej
        // przycisk mówiłby „włączone", a nic by nie przychodziło.
        if (!res.ok) await nowa.unsubscribe().catch(() => {});
      }
    } catch (e) {
      info.textContent = 'Nie udało się: ' + (e && e.message ? e.message : 'nieznany błąd');
    }
    btn.disabled = false;
    await rysuj();
  };

  await rysuj();
}

// ── zapis bez przycisku ─────────────────────────────────────────────────────
// Wszystko w tym oknie zapisuje się samo. Nie ma „Zapisz", bo przy awatarze
// i przełącznikach i tak go nie było — a jego obecność przy pseudonimie kazała
// szukać akcji, której dla reszty nie istnieje.

function _zapisano(overlay) {
  const el = overlay.querySelector('#_mzap');
  if (!el) return;
  el.style.opacity = '1';
  clearTimeout(el._znika);
  el._znika = setTimeout(() => { el.style.opacity = '0'; }, 1500);
}

function _podepnijPseudonim(overlay) {
  const pole = overlay.querySelector('#_mn');
  const blad = overlay.querySelector('#_me');
  let ostatni = pole.value.trim();

  async function zapisz() {
    const nowy = pole.value.trim();
    if (nowy === ostatni) return;
    if (!nowy) { pole.value = ostatni; return; }   // pusty = rezygnacja, nie błąd
    try {
      const res = await authFetch('/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: nowy }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        blad.textContent = e.detail || 'Nie udało się zapisać.';
        blad.style.display = 'block';
        return;
      }
      blad.style.display = 'none';
      ostatni = nowy;
      overlay._pseudonimZmieniony = true;   // przy zamknięciu odświeżamy stronę
      if (window._currentUser) window._currentUser.display_name = nowy;
      const naglowek = overlay.querySelector('.pf-gora h3');
      if (naglowek) naglowek.textContent = nowy;
      const wPasku = document.getElementById('nav-profile-name');
      if (wPasku) wPasku.textContent = nowy;
      _wypelnijDomownikow(overlay);
      _zapisano(overlay);
    } catch {
      blad.textContent = 'Błąd połączenia.';
      blad.style.display = 'block';
    }
  }

  pole.addEventListener('blur', zapisz);
  pole.addEventListener('keydown', (e) => { if (e.key === 'Enter') pole.blur(); });
}

// Pseudonim widnieje przy wydatkach na innych ekranach, więc po jego zmianie
// odświeżamy stronę — ale dopiero przy zamknięciu okna, żeby nie wyrywać
// użytkownika w trakcie ustawiania czegokolwiek innego.
function _zamknijProfil(overlay) {
  const trzeba = overlay._pseudonimZmieniony;
  overlay.remove();
  if (trzeba) location.reload();
}

// ── lewa kolumna: domownicy ─────────────────────────────────────────────────

async function _wypelnijDomownikow(overlay) {
  const box = overlay.querySelector('#_mdom');
  const mojeId = (window._currentUser || {}).user_id;
  try {
    const dane = await (await authFetch('/api/household')).json();
    const wiersze = [];
    (dane.members || []).forEach((m) => {
      const ja = m.id === mojeId;
      wiersze.push(`<div class="pf-czlonek${ja ? ' ja' : ''}">${awatarHtml(m)}
        <span><span class="pf-imie">${_esc(m.display_name || (m.name || '').split(' ')[0])}</span>
        ${ja ? '<br><span class="pf-rola">to Ty</span>'
             : (m.role === 'owner' ? '<br><span class="pf-rola">właściciel</span>' : '')}</span></div>`);
    });
    (dane.virtual_members || []).forEach((m) => {
      // osoba bez konta nie ma id użytkownika — awatar dobieramy z nazwy, żeby
      // był stały między wejściami, a nie losowy przy każdym otwarciu
      const ziarno = String(m.name || '').split('').reduce((s, z) => s + z.charCodeAt(0), 0);
      wiersze.push(`<div class="pf-czlonek">${awatarHtml({ awatar: ziarno })}
        <span><span class="pf-imie">${_esc(m.name)}</span><br>
        <span class="pf-rola">bez konta</span></span></div>`);
    });
    box.innerHTML = wiersze.join('') || '<div class="pf-rola">Tylko Ty.</div>';
  } catch {
    box.innerHTML = '<div class="pf-rola">Nie udało się wczytać domowników.</div>';
  }

  overlay.querySelector('#_minvite').onclick = () => _oknoZaproszenia();
  overlay.querySelector('#_mvm').onclick = () => _oknoBezKonta(overlay);
}

// ── wybór awatara ───────────────────────────────────────────────────────────

function _podepnijAwatary(overlay, ja) {
  const box = overlay.querySelector('#_mav');
  const biezacy = awatarNumer(ja);
  box.innerHTML = AWATARY.map((a, i) =>
    `<button class="aw" style="background:${a.kolor}" data-nr="${i}" aria-pressed="${i === biezacy}" aria-label="Awatar ${i + 1}">`
    + `<svg viewBox="0 0 24 24" aria-hidden="true">${a.znak}</svg></button>`).join('');

  box.onclick = async (e) => {
    const b = e.target.closest('.aw');
    if (!b) return;
    const nr = parseInt(b.dataset.nr, 10);
    box.querySelectorAll('.aw').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    // podmieniamy od razu, nie czekając na serwer — wybór awatara ma być natychmiastowy
    if (window._currentUser) window._currentUser.awatar = nr;
    overlay.querySelector('#_mavbig').innerHTML = awatarHtml({ awatar: nr }, 'aw-duzy');
    const wPasku = document.querySelector('#nav-profile-btn .aw');
    if (wPasku) wPasku.outerHTML = awatarHtml({ awatar: nr }, 'aw-maly');
    _wypelnijDomownikow(overlay);
    try {
      await authFetch('/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ awatar: nr }),
      });
      _zapisano(overlay);
    } catch {}
  };
}

// ── zapraszanie i osoby bez konta ───────────────────────────────────────────
// Mieszkają tutaj, a nie w index.html, bo okno profilu otwiera się z każdej
// strony — a tamte funkcje były przywiązane do znaczników pulpitu.

function _nakladka(html) {
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:10000;padding:14px';
  o.innerHTML = `<div style="background:var(--surface);border-radius:14px;padding:22px;width:380px;max-width:100%;box-shadow:var(--shadow-lg)">${html}</div>`;
  o.addEventListener('click', (e) => { if (e.target === o) o.remove(); });
  document.body.appendChild(o);
  return o;
}

async function _oknoZaproszenia() {
  const o = _nakladka(`
    <h3 style="margin:0 0 6px;font-size:1.05rem;color:var(--heading)">Zaproś osobę</h3>
    <p style="font-size:12.5px;color:var(--muted);margin:0 0 12px;line-height:1.5">Wyślij ten link osobie, która ma dołączyć do gospodarstwa. Działa 7 dni.</p>
    <div id="_zlink" style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px;word-break:break-all;color:var(--text)">Generowanie…</div>
    <div id="_zok" style="display:none;font-size:12px;color:var(--good);margin-top:7px">Skopiowano.</div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button id="_zkop" style="flex:1;padding:9px;background:var(--primary);color:var(--on-primary);border:none;border-radius:8px;cursor:pointer;font-size:0.85rem">Kopiuj link</button>
      <button id="_zzam" style="flex:1;padding:9px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:0.85rem">Zamknij</button>
    </div>`);
  o.querySelector('#_zzam').onclick = () => o.remove();
  let link = '';
  try {
    const d = await (await authFetch('/api/household/invite', { method: 'POST' })).json();
    link = d.link || '';
    o.querySelector('#_zlink').textContent = link;
  } catch (e) {
    o.querySelector('#_zlink').textContent = 'Nie udało się utworzyć zaproszenia.';
  }
  o.querySelector('#_zkop').onclick = () => {
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => { o.querySelector('#_zok').style.display = 'block'; });
  };
}

async function _oknoBezKonta(rodzic) {
  const o = _nakladka(`
    <h3 style="margin:0 0 6px;font-size:1.05rem;color:var(--heading)">Osoba bez konta</h3>
    <p style="font-size:12.5px;color:var(--muted);margin:0 0 12px;line-height:1.5">Dla kogoś, kto nie loguje się do aplikacji (np. dziecko). Będzie można przypisywać jej wydatki.</p>
    <div id="_blista" style="margin-bottom:12px"></div>
    <div style="display:flex;gap:8px">
      <input id="_binp" type="text" maxlength="30" placeholder="Imię" style="flex:1;min-width:0">
      <button id="_bdod" style="padding:8px 16px;background:var(--primary);color:var(--on-primary);border:none;border-radius:8px;cursor:pointer;font-size:0.85rem">Dodaj</button>
    </div>
    <div id="_berr" style="display:none;color:var(--danger);font-size:12px;margin-top:8px"></div>
    <button id="_bzam" style="width:100%;margin-top:12px;padding:9px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:0.85rem">Zamknij</button>`);

  async function odswiez() {
    const lista = o.querySelector('#_blista');
    try {
      const d = await (await authFetch('/api/household')).json();
      const vms = d.virtual_members || [];
      lista.innerHTML = vms.length ? vms.map((m) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:var(--surface-2);border-radius:8px;margin-bottom:6px">
          <span style="font-size:13.5px">${_esc(m.name)}</span>
          <button data-usun="${m.id}" style="padding:3px 10px;border:1px solid var(--danger-border);border-radius:6px;background:var(--surface);color:var(--danger);cursor:pointer;font-size:12px">Usuń</button>
        </div>`).join('') : '<div style="font-size:12.5px;color:var(--muted)">Nikogo takiego jeszcze nie ma.</div>';
      lista.querySelectorAll('[data-usun]').forEach((b) => {
        b.onclick = async () => {
          if (!confirm('Usunąć tę osobę? Jej dotychczasowe wydatki zostaną w gospodarstwie.')) return;
          await authFetch('/api/household/virtual-members/' + b.dataset.usun, { method: 'DELETE' });
          await odswiez();
          if (rodzic) _wypelnijDomownikow(rodzic);
        };
      });
    } catch { lista.innerHTML = '<div style="font-size:12.5px;color:var(--danger)">Błąd ładowania.</div>'; }
  }
  await odswiez();

  o.querySelector('#_bzam').onclick = () => o.remove();
  o.querySelector('#_bdod').onclick = async () => {
    const inp = o.querySelector('#_binp');
    const err = o.querySelector('#_berr');
    err.style.display = 'none';
    const name = inp.value.trim();
    if (!name) return;
    try {
      const res = await authFetch('/api/household/virtual-members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        err.textContent = e.detail || 'Nie udało się dodać.'; err.style.display = 'block';
        return;
      }
      inp.value = '';
      await odswiez();
      if (rodzic) _wypelnijDomownikow(rodzic);
    } catch {
      err.textContent = 'Błąd połączenia.'; err.style.display = 'block';
    }
  };
}

function _showProfileModal() {
  const current = (window._currentUser || {}).display_name || '';
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999;';
  const ja = window._currentUser || {};
  const RODZAJE_OPIS = [
    ['przelew',  'Przelew do zrobienia',  'Gdy czeka płatność, którą robisz ręcznie'],
    ['pobranie', 'Nadchodzące pobranie',  'Zapewnij środki — coś ściągnie się samo'],
    ['lista',    'Lista zakupów',         'Ktoś z domu dopisał nowe pozycje'],
    ['raport',   'Raport miesięczny',     'Gdy doradca podsumuje zamknięty miesiąc'],
  ];
  overlay.innerHTML = `
    <div class="pf-okno">
      <div class="pf-dom">
        <div class="pf-tyt">Gospodarstwo</div>
        <div class="pf-lista" id="_mdom"></div>
        <div class="pf-akcje">
          <button id="_minvite" type="button">+ Zaproś osobę</button>
          <button id="_mvm" type="button">+ Osoba bez konta</button>
        </div>
      </div>
      <div class="pf-ust">
        <div class="pf-gora">
          <span id="_mavbig">${awatarHtml(ja, 'aw-duzy')}</span>
          <span>
            <h3>${_esc(current || ja.name || '')}</h3>
            <span class="pf-mail">${_esc(ja.email || '')}</span>
          </span>
          <span id="_mzap" style="margin-left:auto;align-self:flex-start;font-size:11.5px;color:var(--good);opacity:0;transition:opacity .2s">Zapisano</span>
          <button id="_mc" type="button" title="Zamknij" style="align-self:flex-start;background:none;border:none;color:var(--muted);font-size:22px;line-height:1;cursor:pointer;padding:0 2px">&times;</button>
        </div>

        <div class="pf-etyk">Pseudonim</div>
        <input id="_mn" type="text" value="${_esc(current)}" maxlength="30" placeholder="np. Adam, Ola, Mama" style="width:100%">
        <div id="_me" style="color:var(--danger);font-size:0.8rem;margin-top:8px;display:none"></div>

        <div class="pf-grupa">
          <div class="pf-etyk">Awatar</div>
          <div class="pf-wybor" id="_mav"></div>
        </div>

        <div class="pf-grupa">
          <div class="pf-etyk">Wygląd</div>
          <div id="_mtheme" style="display:flex;gap:6px">
            <button data-motyw="auto" style="flex:1;padding:7px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);cursor:pointer;font-size:0.8rem">Auto</button>
            <button data-motyw="jasny" style="flex:1;padding:7px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);cursor:pointer;font-size:0.8rem">Jasny</button>
            <button data-motyw="ciemny" style="flex:1;padding:7px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);cursor:pointer;font-size:0.8rem">Ciemny</button>
          </div>
        </div>

        <div class="pf-grupa" id="_mpushbox" style="display:none">
          <div class="pf-etyk">Powiadomienia na telefon</div>
          <button id="_mpush" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);cursor:pointer;font-size:0.85rem">Włącz powiadomienia</button>
          <div id="_mpushinfo" style="font-size:0.72rem;color:var(--muted);margin:7px 0 2px;line-height:1.45"></div>
          <div id="_mrodzaje" style="display:none">
            ${RODZAJE_OPIS.map(([k, t, o]) => `
              <div class="pf-poz">
                <span><span class="pf-poz-t">${t}</span><div class="pf-poz-o">${o}</div></span>
                <button class="pf-prze" role="switch" aria-checked="true" data-rodzaj="${k}" aria-label="${t}"></button>
              </div>`).join('')}
          </div>
        </div>

        <div class="pf-grupa">
          <button id="_mout" style="width:100%;padding:10px;background:var(--primary);color:var(--on-primary);border:none;border-radius:9px;cursor:pointer;font-size:0.9rem;font-weight:500;margin-bottom:10px">Wyloguj się</button>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button id="_mleave" style="flex:1;min-width:150px;padding:9px;background:var(--surface);color:var(--warn);border:1px solid var(--warn-border);border-radius:8px;cursor:pointer;font-size:0.82rem">Wypisz się z gospodarstwa</button>
            <button id="_mdel" style="flex:1;min-width:150px;padding:9px;background:var(--surface);color:var(--danger);border:1px solid var(--danger-border);border-radius:8px;cursor:pointer;font-size:0.82rem">Usuń moje konto</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _zamknijProfil(overlay); });
  _wypelnijDomownikow(overlay);
  _podepnijAwatary(overlay, ja);
  _podepnijMotyw(overlay);
  _podepnijPush(overlay);
  // ŻADNEGO focus() na polu pseudonimu — na telefonie wyskakiwała od tego
  // klawiatura przy każdym otwarciu, a to okno służy dziś głównie do rzeczy,
  // których się nie wpisuje.
  _podepnijPseudonim(overlay);
  overlay.querySelector('#_mc').onclick = () => _zamknijProfil(overlay);
  // Wylogowanie przeniosło się tu z górnego paska — pasek musiał zrobić miejsce
  // na nazwę modułu i przełącznik, a wylogowanie to sprawa konta, nie nawigacji.
  // W menu „⋯" na pulpicie być nie mogło: tamto menu istnieje tylko na pulpicie.
  overlay.querySelector('#_mout').onclick = () => authLogout();
  overlay.querySelector('#_mleave').onclick = async () => {
    let ilu = 0, nazwa = '';
    try {
      const h = await (await authFetch('/api/household')).json();
      ilu = (h.members || []).length;
      nazwa = h.name || '';
    } catch { alert('Nie udało się sprawdzić gospodarstwa.'); return; }

    const ostatni = ilu <= 1;
    const wstep = ostatni
      ? `Jesteś ostatnią osobą w gospodarstwie „${nazwa}". Po wyjściu nikt nie będzie miał dostępu do jego danych — wydatków, wpływów, kont i celów.\n\nDane poczekają 30 dni, po czym zostaną usunięte bezpowrotnie. Zanim wyjdziesz, pobierz kopię z menu „⋯" na dashboardzie („Pobierz kopię danych").\n\nWypisać się?`
      : `Wypisać się z gospodarstwa „${nazwa}"? Twoje konto zostanie — od razu będziesz mógł założyć własne gospodarstwo na tym samym mailu.\n\nWspólne dane zostają u pozostałych osób, a Twoje wydatki dalej będą podpisane Twoim pseudonimem.`;
    if (!confirm(wstep)) return;

    // domyślnie 30 dni karencji; natychmiastowe kasowanie tylko na wyraźne żądanie
    let natychmiast = false;
    if (ostatni) {
      natychmiast = confirm(
        'Usunąć dane OD RAZU, bez czekania 30 dni?\n\n' +
        'OK — kasuję teraz, nieodwracalnie.\n' +
        'Anuluj — zostawiam 30 dni na rozmyślenie się (zalecane).'
      );
      if (natychmiast && !confirm('Na pewno? Tej operacji nie da się cofnąć.')) return;
    }

    try {
      const res = await authFetch('/api/me/leave-household', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ natychmiast }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.detail || 'Nie udało się wypisać.'); return; }
      window.location.href = '/onboarding';
    } catch { alert('Błąd połączenia.'); }
  };

  overlay.querySelector('#_mdel').onclick = async () => {
    if (!confirm('Usunąć Twoje konto? Stracisz dostęp do aplikacji (logowanie). Twoje wydatki ZOSTANĄ w gospodarstwie — staniesz się „osobą bez konta", więc dla pozostałych nic nie znika. Tej operacji nie da się cofnąć.')) return;
    try {
      const res = await authFetch('/api/me', { method: 'DELETE' });
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.detail || 'Nie udało się usunąć konta.'); return; }
      await _auth.signOut();
      window.location.href = '/login';
    } catch { alert('Błąd połączenia.'); }
  };
}

const _ADMIN_EMAILS = ['a.folwarsk@gmail.com'];

function authIsAdmin(me) {
  return me && _ADMIN_EMAILS.includes(me.email);
}
window.authIsAdmin = authIsAdmin;

function _injectProfileButton(me) {
  const nav = document.querySelector('nav');
  if (!nav) return;

  // Wszystko po prawej trafia do jednej grupy. Wcześniej każdy element
  // wstawiał się przed nav.querySelector('button') — a po dodaniu „❓" to on
  // stawał się pierwszym przyciskiem, więc kolejność wychodziła przypadkowa
  // i pseudonim lądował daleko od „Wyloguj".
  // Celujemy w „Wyloguj" po jego akcji, a nie po kolejności — od kiedy pasek
  // buduje się z kodu, pierwszym przyciskiem jest przełącznik modułów.
  const wyloguj = nav.querySelector('button[onclick*="authLogout"]');
  const grupa = document.createElement('div');
  grupa.className = 'nav-prawa';
  nav.appendChild(grupa);

  if (_ADMIN_EMAILS.includes(me.email)) {
    const adminLink = document.createElement('a');
    adminLink.href = '/admin';
    adminLink.textContent = 'Admin';
    adminLink.style.cssText = 'font-size:0.85rem;color:var(--muted);';
    grupa.appendChild(adminLink);
  }

  // „❓" czytało się jak pomoc techniczna — to jest samouczek, więc mówimy
  // to wprost. Na wąskim ekranie zostaje sama książka (patrz .nav-etykieta).
  const help = document.createElement('button');
  help.className = 'nav-samouczek';
  help.innerHTML = ikonaSvg('ksiazka') + '<span class="nav-etykieta">Samouczek</span>';
  help.title = 'Samouczek — jak korzystać z aplikacji';
  help.onclick = () => pokazSamouczek(false);
  grupa.appendChild(help);

  const btn = document.createElement('button');
  btn.id = 'nav-profile-btn';
  // Awatar obok imienia — pod nim ludzie odruchowo szukają ustawień konta.
  btn.innerHTML = awatarHtml(me, 'aw-maly')
    + `<span id="nav-profile-name">${_esc(me.display_name || (me.name || '').split(' ')[0])}</span>`;
  btn.title = 'Twój profil i gospodarstwo';
  // --marka, a nie --accent: plakietka siedzi w pasku obok znaku, więc ma
  // trzymać kolor modułu. Przy turkusowym wiem.health koralowa obwódka była
  // jedynym elementem paska w kolorze innego modułu.
  btn.style.cssText = 'display:flex;align-items:center;gap:7px;padding:4px 12px 4px 5px;cursor:pointer;border:1px solid var(--marka);border-radius:20px;background:var(--surface);color:var(--marka);font-size:0.85rem;font-weight:500;';
  btn.onclick = _showProfileModal;
  grupa.appendChild(btn);

  if (wyloguj) {
    wyloguj.style.marginLeft = '';   // odsuwanie robi teraz grupa
    grupa.appendChild(wyloguj);
  }
}

// Samouczek NIE JEST JEDEN — jest osobny dla każdego modułu. Wcześniej stała
// tu jedna tablica o paragonach i kontach, więc na dzienniku jedzenia apka
// tłumaczyła, jak sfotografować paragon, a na historii zdrowia — jak prowadzić
// budżet. Zestaw wybiera `_modulBiezacy()`, ten sam mechanizm co kolor paska
// i dopisek „wiem.eat" przy znaku.
const _SAMOUCZEK_SLAJDY = {
  finance: [
  { znak: true, tytul: 'Witaj w <span class="logo">w<span class="lg-i">ı<i class="lg-kropka"></i></span>em<i class="lg-kropka"></i></span>',
    opis: 'To wspólny budżet całego gospodarstwa: dodajesz wydatki (zdjęciem paragonu, notatką albo ręcznie), a apka pokazuje statystyki, pilnuje płatności i podpowiada, gdzie oszczędzić. Wiem ma kilka modułów — jedzenie i zdrowie przełączysz kwadracikami obok logo, a każdy ma własny samouczek. Do tego wrócisz kiedy chcesz przyciskiem „Samouczek" na górnym pasku.' },
  { ikona: 'aparat', tytul: 'Paragon = zdjęcie',
    opis: 'W „Dodaj wydatek" zrób zdjęcie paragonu — Claude AI sam odczyta sklep, datę, wszystkie pozycje z cenami i przypisze kategorie. Możesz wrzucić kilka paragonów naraz: każdy stanie się osobnym wydatkiem. Przed zapisem wszystko sprawdzisz i poprawisz.' },
  { ikona: 'recznie', tytul: 'Nie chcesz AI? Wpisz ręcznie',
    opis: 'W „Dodaj wydatek" jest zakładka „Ręcznie (bez AI)" — wpisujesz wydatek sam, bez wysyłania do Claude i bez kosztów. Jest też „Notatka tekstowa": wypisujesz wydatki listą, a AI rozbije je na osobne wpisy. Wybierasz to, co Ci pasuje.' },
  { ikona: 'pulpit', tytul: 'Dashboard — wszystko na oku',
    opis: 'Filtruj po miesiącu, osobie i kategorii (albo po dowolnym zakresie dat). Kliknij segment wykresu kołowego, żeby zejść do podkategorii, a potem do konkretnych produktów. Wykres trendów przełączysz na „Osobno / Łącznie", a każdy wydatek rozwiniesz do pozycji.' },
  { ikona: 'lupa', tytul: 'Wyszukiwarka i ceny produktów',
    opis: 'Pole <span class="ikona"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.6 15.6l4.6 4.6"/><circle class="kropka" cx="10.8" cy="10.8" r="1.8"/></svg></span> na dashboardzie przeszukuje CAŁĄ historię — produkt, sklep, notatkę („ile wydaliśmy na kawę?"). Po wyszukaniu produktu kliknij „<span class="ikona"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 3.6v17h17"/><path d="M6.6 16.4l4.4-5 3.9 3.3 4.3-5.9"/><circle class="kropka" cx="18.6" cy="8.4" r="1.9"/></svg></span> Pokaż zmiany cen": zobaczysz gdzie kupujesz taniej i jak cena rosła w czasie.' },
  { ikona: 'kategorie', tytul: 'Kategorie po Twojemu',
    opis: 'W „Kategorie" ułożysz własną hierarchię kategorii i podkategorii. Przy wydatku możesz dodać „okazję" (np. urodziny) — taki zakup nie zaburzy statystyk Waszych zwykłych nawyków. „Kontekst kategorii" wrzuci cały paragon do jednej kategorii (np. całą imprezę do Rozrywki).' },
  { ikona: 'konta', tytul: 'Konta i salda',
    opis: 'W „Konta" prowadzisz konta (bank, gotówka, oszczędności) z aktualnymi saldami. Robisz przelewy między nimi, a inwentaryzacją (spisem rzeczywistego stanu) pilnujesz, czy wszystko się zgadza. Przypisując wydatek do konta, saldo liczy się samo.' },
  { ikona: 'wplywy', tytul: 'Wpływy i płatności cykliczne',
    opis: 'Dodawaj wpływy (np. pensję), żeby bilans był pełny. Subskrypcje, rachunki i raty ustaw jako wydatki cykliczne — naliczą się automatycznie (z limitem naliczeń albo datą końca). Cykliczny przelew na oszczędności też ustawisz w Kontach.' },
  { ikona: 'alerty', tytul: 'Przypomnienia o płatnościach',
    opis: 'O ręcznych przelewach apka przypomni z wyprzedzeniem — po zrobieniu klikasz „Zrobione". Przy automatycznych obciążeniach dostaniesz znać, żeby zapewnić środki. Całe archiwum jest w „Powiadomieniach", a pojedyncze przypomnienie schowasz ✕ na bieżącą sesję.' },
  { ikona: 'robot', tytul: 'Doradca budżetowy AI',
    opis: 'W „Analiza" Claude przeanalizuje Wasze wydatki i wskaże konkretnie, gdzie da się zaoszczędzić — z kwotami. Odpowiadaj na jego pytania: buduje profil gospodarstwa i z każdą analizą zna Was lepiej. Raporty zapisują się w historii.' },
  { ikona: 'lista', tytul: 'Listy zakupów na żywo',
    opis: 'W „Lista" tworzysz wiele nazwanych list (np. „Biedronka", „Leroy"). Są wspólne i synchronizują się NA ŻYWO — jak odhaczysz mleko, druga osoba w sklepie od razu to widzi. Tap = kupione, przeciągnij za ⠿ = kolejność (np. wg alejek), a listę wstrzymasz, zamkniesz lub usuniesz.' },
  { ikona: 'osoby', tytul: 'Wspólne gospodarstwo',
    opis: 'Zaproś drugą osobę do gospodarstwa linkiem — kliknij swój pseudonim na górnym pasku, a w oknie profilu wybierz „Zaproś osobę”. Budżet prowadzicie razem. Kogoś bez konta Google (np. dziecko) dodasz tam samo, przyciskiem „Osoba bez konta". Każdy może też usunąć własne konto — jego wydatki zostają, bo należą do gospodarstwa.' },
  { ikona: 'dysk', tytul: 'Twoje dane są bezpieczne',
    opis: 'Cały budżet pobierzesz w każdej chwili z menu „⋯" na dashboardzie — pozycja „Pobierz kopię danych". Statystyki, filtry i pseudonimy dostosujesz pod siebie — kliknij swój pseudonim na górnym pasku, żeby go zmienić.' },
  { ikona: 'telefon', tytul: 'Miej budżet w kieszeni',
    opis: 'Na telefonie wybierz w przeglądarce „Dodaj do ekranu głównego" — apka działa jak natywna: dolny pasek nawigacji i aparat do paragonów zawsze pod ręką. To wszystko — miłego oszczędzania!' },
  ],

  eat: [
  { znak: true, tytul: 'Witaj w <span class="logo">w<span class="lg-i">ı<i class="lg-kropka"></i></span>em<i class="lg-kropka"></i></span><span style="font-size:.62em;font-weight:600;letter-spacing:0">eat</span>',
    opis: 'Dziennik jedzenia dla całego gospodarstwa. Zapisujesz, co zjadłeś, a apka liczy kalorie i makroskładniki, pokazuje jakość jedzenia i pilnuje celu dziennego. Ten przewodnik dotyczy modułu jedzenia — finanse i zdrowie mają własne, pod tym samym przyciskiem.' },
  { ikona: 'aparat', tytul: 'Cztery drogi do produktu',
    opis: 'Możesz zeskanować kod kreskowy, poszukać po nazwie, zrobić zdjęcie <b>przodu opakowania</b> (apka dopasuje produkt w bazie Open Food Facts) albo zdjęcie <b>tabeli wartości odżywczych</b>, gdy produktu nigdzie nie ma. Cztery drogi, bo w sklepie działa co innego niż w kuchni.' },
  { ikona: 'lista', tytul: 'Wróć do tego, co jesz często',
    opis: '„Z dziennika" podsuwa produkty, które już jadłeś, a serce oznacza ulubione — jedno stuknięcie i wpis jest gotowy. Codzienne jedzenie powtarza się bardziej, niż się wydaje, i to jest najszybsza droga.' },
  { ikona: 'przelicz', tytul: 'Porcje, gramy, sztuki',
    opis: 'Wybierasz jednostkę, w której naprawdę myślisz: porcja, gram albo sztuka. Waga sztuki to waga <b>jednej sztuki</b>, nie całego opakowania zbiorczego — przy jajkach czy batonikach to różnica dziesięciokrotna.' },
  { ikona: 'analiza', tytul: 'Cel dzienny i niepełny dzień',
    opis: 'Ustawiasz cel kaloryczny, a apka pokazuje, ile zostało. Dzień, w którym zapisałeś tylko śniadanie, oznaczysz jako <b>niekompletny</b> — nie zaniży wtedy średnich, bo inaczej każdy pominięty obiad wyglądałby jak dzień pod celem.' },
  { ikona: 'ksiazka', tytul: 'Przepisy — gotujesz raz, wpisujesz wiele razy',
    opis: 'Przepis dodasz na cztery sposoby: opisując słowami, zdjęciem przepisu, ręcznie albo składając go z tego, co już masz w dzienniku. Jednostką jest <b>porcja</b>, bo kalorie się nie gotują — a rozpiska składników zostaje zamrożona przy wpisie, więc późniejsza zmiana przepisu nie przepisuje historii.' },
  { ikona: 'lupa', tytul: 'Statystyki i oceny',
    opis: 'Na „Statystykach" zobaczysz Nutri-Score (a–e) i NOVA (1–4) z Open Food Facts. To <b>oceny cudze i opublikowane</b> — apka nie wymyśla własnego wskaźnika „zdrowe", bo taki wskaźnik byłby naszą opinią udającą fakt. Procenty liczą się od całości dnia, nie tylko od produktów, które ocenę mają.' },
  ],

  health: [
  { znak: true, tytul: 'Witaj w <span class="logo">w<span class="lg-i">ı<i class="lg-kropka"></i></span>em<i class="lg-kropka"></i></span><span style="font-size:.62em;font-weight:600;letter-spacing:0">health</span>',
    opis: 'Miejsce na wyniki badań i dokumentację medyczną całej rodziny. Robisz zdjęcie albo wgrywasz PDF, a apka przepisuje wyniki, normy i oznaczenia do bazy — żeby za dwa lata dało się sprawdzić, jak zmieniało się żelazo, a nie szukać kartki w szufladzie.' },
  { ikona: 'osoby', tytul: 'Zacznij od osoby',
    opis: 'Każdy wynik zapisujesz przy konkretnej osobie — także takiej, która nie ma konta w aplikacji, na przykład dziecka. Data urodzenia jest nieobowiązkowa, ale przy wynikach dziecka pozwala odczytać normę właściwą dla wieku w dniu badania.' },
  { ikona: 'aparat', tytul: 'PDF czyta się dokładniej niż zdjęcie',
    opis: 'Wynik z laboratorium ma warstwę tekstową, więc model czyta znaki, a nie piksele — znika cała klasa błędów: zgubiony przecinek, „0,05" odczytane jako „0,06". Papierową kartę wizyty sfotografuj; jeśli ma kilka stron, dołóż je wszystkie, a przeczytam je <b>jako jeden dokument</b>.' },
  { ikona: 'recznie', tytul: 'Sprawdzasz Ty, nie apka',
    opis: 'Po odczycie zobaczysz wszystko do sprawdzenia i nic nie zapisuje się bez Twojej zgody. To nie jest wygoda, tylko warunek: wynik zapisany błędnie i niezauważony jest gorszy niż brak wyniku, bo za pół roku nikt nie będzie pamiętał, że tej liczby nie sprawdzał.' },
  { ikona: 'kategorie', tytul: 'Normy są przepisane, nie wyliczone',
    opis: 'Zakres normy i oznaczenia (H, L, klasa alergiczna, centyl, BI-RADS) apka <b>przepisuje z dokumentu</b>, nigdy nie liczy sama — bo każde laboratorium ma własne normy i własną metodę. Wynik typu „&lt;0,005" zostaje z tym znakiem, bo sama liczba znaczyłaby co innego.' },
  { ikona: 'analiza', tytul: 'Oś czasu i przebieg parametru',
    opis: 'Badania układają się na osi czasu, z odstępami proporcjonalnymi do upływu czasu — widać zagęszczenie przy chorobie i ciszę przy zdrowiu. Suwak zmienia gęstość, a wpisy przefiltrujesz po problemie zdrowotnym. Klikając parametr, zobaczysz jego przebieg na wykresie, z pasmem normy <b>schodkowym</b>, bo norma bywa inna w każdym laboratorium.' },
  { ikona: 'dysk', tytul: 'Oryginały nie zostają',
    opis: 'Zdjęcie ani PDF nie trafiają do bazy — plik służy wyłącznie do odczytu i ginie razem z żądaniem. Zostają tylko przepisane dane. Zatrzymaj oryginał u siebie, jeśli będzie potrzebny u lekarza.' },
  ],
  task: [
  { znak: true, tytul: 'Witaj w <span class="logo">w<span class="lg-i">ı<i class="lg-kropka"></i></span>em<i class="lg-kropka"></i></span><span style="font-size:.62em;font-weight:600;letter-spacing:0">task</span>',
    opis: 'Miejsce na wszystko, co macie do zrobienia — od „oddać PIT" po remont łazienki. Zapisujesz sprawę w sekundę, a szczegóły dopisujesz wtedy, kiedy masz chwilę.' },
  // `ptaszek`, a nie `zadania`: slajdy rysują ikony kreską, a znak modułu jest
  // bryłą i w tym trybie wyszłyby z niego same obrysy kresek.
  { ikona: 'ptaszek', tytul: 'Wpisz i zapomnij',
    opis: 'Pole na górze listy przyjmuje samo zdanie — piszesz, naciskasz Enter i sprawa jest zapisana. Termin, wykonawcę i przypomnienie dodasz później, jeśli w ogóle będą potrzebne.' },
  { ikona: 'osoby', tytul: 'Kto się tym zajmie',
    opis: 'Zadanie możesz przypisać domownikowi — także takiemu, który nie ma konta w aplikacji. Sprawy, których nie chcesz nikomu pokazywać, oznacz jako „tylko dla mnie".' },
  { ikona: 'alerty', tytul: 'Przypomnienie o wybranej porze',
    opis: 'Ustaw termin i godzinę, a apka odezwie się powiadomieniem dokładnie wtedy. Przesuniesz termin — przypomni się ponownie.' },
  { ikona: 'lista', tytul: 'Duże sprawy dziel na kroki',
    opis: 'Do każdego zadania dopiszesz kroki, a do kroków kolejne — tak głęboko, jak potrzebujesz. Na liście widzisz postęp i to, co jest do zrobienia jako następne.' },
  { ikona: 'cele', tytul: 'Zaznacz to, co nieprzesuwalne',
    opis: 'Termin oddania dokumentów albo odbiór mieszkania oznacz jako kamień milowy. Takie punkty wyróżniają się na liście, żeby nie zginęły między drobiazgami.' },
  ],
};

function pokazSamouczek(pierwszyRaz) {
  // Zestaw wybiera strona, na której stoisz. `_modulBiezacy()` dla ścieżek
  // spoza modułów (np. /admin) zwraca finanse, więc zapasowa gałąź jest tylko
  // na wypadek modułu bez własnych slajdów — lepiej pokazać cokolwiek niż nic.
  const slajdy = _SAMOUCZEK_SLAJDY[_modulBiezacy().id] || _SAMOUCZEK_SLAJDY.finance;
  let idx = 0;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,20,40,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;';
  const zamknij = () => {
    overlay.remove();
    if (pierwszyRaz) authFetch('/api/me/samouczek', { method: 'POST' }).catch(() => {});
  };
  overlay.addEventListener('click', e => { if (e.target === overlay) zamknij(); });
  const render = () => {
    const s = slajdy[idx];
    const ostatni = idx === slajdy.length - 1;
    overlay.innerHTML = `
      <div class="sam-karta">
        <div class="sam-naglowek" style="--kat:${130 + idx * 7}deg"><span class="sam-emoji">${s.znak ? '<span class="sam-znak"><span class="logo"><span class="lg-lit">w</span><span class="lg-i"><span class="lg-lit">ı</span><i class="lg-kropka"></i></span><span class="lg-lit">em</span><i class="lg-kropka"></i></span></span>' : ikonaSvg(s.ikona)}</span></div>
        <div style="padding:22px 26px 18px">
          <h3 style="font-size:1.15rem;margin:0 0 8px;color:var(--text)">${s.tytul}</h3>
          <p style="font-size:14px;line-height:1.6;color:var(--text);margin:0 0 16px">${s.opis}</p>
          <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-bottom:14px">
            ${slajdy.map((_, i) => `<span class="sam-kropka${i === idx ? ' jest' : ''}"></span>`).join('')}
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button data-t="pomin" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;padding:8px 4px">Pomiń</button>
            <span style="flex:1"></span>
            ${idx > 0 ? '<button data-t="wstecz" style="background:var(--surface-3);border:none;border-radius:8px;padding:10px 18px;cursor:pointer;font-size:14px;color:var(--text)">Wstecz</button>' : ''}
            <button data-t="dalej" style="background:var(--primary);border:none;border-radius:8px;padding:10px 22px;cursor:pointer;font-size:14px;color:var(--on-primary);font-weight:600">${ostatni ? 'Zaczynamy!' : 'Dalej'}</button>
          </div>
        </div>
      </div>`;
    overlay.querySelector('[data-t="pomin"]').onclick = zamknij;
    const w = overlay.querySelector('[data-t="wstecz"]');
    if (w) w.onclick = () => { idx--; render(); };
    overlay.querySelector('[data-t="dalej"]').onclick = () => { if (ostatni) zamknij(); else { idx++; render(); } };
  };
  render();
  document.body.appendChild(overlay);
}
window.pokazSamouczek = pokazSamouczek;

const IKONY_SVG = {
  pulpit: '<rect x="3" y="12" width="4.5" height="8" rx="1.4"/><rect x="9.7" y="7" width="4.5" height="13" rx="1.4"/><rect x="16.4" y="10" width="4.5" height="10" rx="1.4"/><circle class="kropka" cx="18.65" cy="5.4" r="1.9"/>',
  dodaj: '<circle cx="12" cy="12" r="8.6"/><path class="akc" d="M12 8.2v7.6M8.2 12h7.6"/>',
  lista: '<path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9"/><circle class="kropka" cx="18.6" cy="17.5" r="1.9"/>',
  konta: '<rect x="2.8" y="5.5" width="18.4" height="13" rx="2.4"/><path d="M2.8 10h18.4"/><circle class="kropka" cx="17.4" cy="14.6" r="1.7"/>',
  wplywy: '<circle cx="12" cy="12" r="8.6"/><path class="akc" d="M12 7.6v8.8M9.2 13.6l2.8 2.8 2.8-2.8"/>',
  cele: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="4.4"/><circle class="kropka" cx="12" cy="12" r="1.9"/>',
  kategorie: '<path d="M11.2 3.4H20v8.8l-8.8 8.4L3 12z"/><circle class="kropka" cx="16.1" cy="7.6" r="1.7"/>',
  analiza: '<path d="M3.4 3.6v17h17"/><path d="M6.6 16.4l4.4-5 3.9 3.3 4.3-5.9"/><circle class="kropka" cx="18.6" cy="8.4" r="1.9"/>',
  alerty: '<path d="M6.2 10.4a5.8 5.8 0 0111.6 0c0 4.2 1.6 5.6 1.6 5.6H4.6s1.6-1.4 1.6-5.6z"/><circle class="kropka" cx="12" cy="19.2" r="1.9"/>',
  admin: '<path d="M4 7.5h16M4 12h16M4 16.5h16"/><circle class="kropka" cx="9" cy="7.5" r="2"/><circle class="kropka" cx="15.6" cy="16.5" r="2"/>',
  // Krzyż w karcie, a nie serce ani puls: moduł jest o dokumentacji i wynikach,
  // nie o kondycji. Karta obrysowana, żeby nie mylił się z „dodaj" (kółko z plusem).
  // ── znaki modułów ──────────────────────────────────────────────────────
  // Rysowane w wersji pełnej (kafelek przełącznika, dolny pasek), więc liczy
  // się sylwetka, a nie kreska: ikona bywa tam jednolicie pokolorowana i
  // wszystko w środku znika. Kształty są zamknięte i rozpoznawalne z samego
  // obrysu — poprzednie („koło ze strzałką" dla finansów, „karta z krzyżem"
  // dla zdrowia) zamieniały się w gołą kropkę i goły prostokąt.
  // UWAGA: `ikonaPelna` czyta najpierw IKONY_PELNE, a dopiero potem tę mapę.
  // Znak, który ma tam swoją wersję, trzeba zmienić w OBU miejscach.
  zdrowie: '<path d="M9.4 3.2h5.2v6.2h6.2v5.2h-6.2v6.2H9.4v-6.2H3.2V9.4h6.2z"/>',
  // Stos monet, nie pojedyncza moneta: krążek z otworem czytał się jak
  // dowolne kółko i nie miał gdzie pomieścić koloru modułu. Wierzchnia
  // moneta jest akcentem — tak samo jak listek przy jabłku dziennika.
  moneta: '<ellipse cx="12" cy="17.8" rx="7.4" ry="2.7"/><ellipse cx="12" cy="13.5" rx="7.4" ry="2.7"/><ellipse class="kropka" cx="12" cy="9.2" rx="7.4" ry="2.7"/>',
  jablko: '<path d="M12 7.6c-1.5-1.7-4.2-2-5.9-.3-2 2-1.7 5.7.4 8.6 1.3 1.8 2.7 3.2 3.8 3.2.6 0 1.1-.3 1.7-.3s1.1.3 1.7.3c1.1 0 2.5-1.4 3.8-3.2 2.1-2.9 2.4-6.6.4-8.6-1.7-1.7-4.4-1.4-5.9.3z"/><path class="kropka" d="M12.4 7c-.3-2.4 1.3-4.2 3.8-4.5.3 2.4-1.3 4.2-3.8 4.5z"/>',
  zadania: '<path d="M4 5.6h9v2H4zM4 11h9v2H4zM4 16.4h6v2H4z"/><path class="kropka" d="M14.6 15.4l2.3 2.3 4.5-4.8 1.2 1.3-5.7 6-3.5-3.5z"/>',
  osoby: '<circle cx="9.2" cy="8.4" r="3.4"/><path d="M3.4 19.4c0-3.2 2.6-5.4 5.8-5.4s5.8 2.2 5.8 5.4"/><path d="M16.6 6.2a3.2 3.2 0 010 6.2M17.6 14.6c2.1.6 3.4 2.4 3.4 4.8"/>',
  osoba_plus: '<circle cx="10" cy="8.4" r="3.4"/><path d="M4.2 19.4c0-3.2 2.6-5.4 5.8-5.4 1 0 2 .2 2.8.6"/><path class="akc" d="M17.6 13.4v6.2M14.5 16.5h6.2"/>',
  pobierz: '<path class="akc" d="M12 3.6v10.2M8.4 10.6l3.6 3.6 3.6-3.6"/><path d="M4.2 16.4v2.2a1.8 1.8 0 001.8 1.8h12a1.8 1.8 0 001.8-1.8v-2.2"/>',
  wczytaj: '<path class="akc" d="M12 14.2V4M8.4 7.2L12 3.6l3.6 3.6"/><path d="M4.2 16.4v2.2a1.8 1.8 0 001.8 1.8h12a1.8 1.8 0 001.8-1.8v-2.2"/>',
  telefon: '<rect x="6.6" y="2.6" width="10.8" height="18.8" rx="2.4"/><circle class="kropka" cx="12" cy="18.2" r="1.5"/>',
  przelicz: '<path d="M20 12a8 8 0 01-13.7 5.6M4 12a8 8 0 0113.7-5.6"/><path d="M4 6.4V12h5.6M20 17.6V12h-5.6"/><circle class="kropka" cx="12" cy="12" r="1.7"/>',
  powitanie: '<path d="M12 20.6a8.6 8.6 0 100-17.2 8.6 8.6 0 000 17.2z"/><path d="M8.4 14.2a4.6 4.6 0 007.2 0"/><circle class="kropka" cx="9" cy="9.8" r="1.4"/><circle class="kropka" cx="15" cy="9.8" r="1.4"/>',
  aparat: '<path d="M3.4 8.4a2 2 0 012-2h2.2l1.4-2.2h5.6l1.4 2.2h2.6a2 2 0 012 2v9.2a2 2 0 01-2 2H5.4a2 2 0 01-2-2z"/><circle cx="12" cy="12.6" r="3.8"/><circle class="kropka" cx="12" cy="12.6" r="1.4"/>',
  recznie: '<path d="M4 20l1.2-4.2L15.6 5.4a2.2 2.2 0 013.1 3.1L8.2 18.8z"/><path d="M14 7l3 3"/><circle class="kropka" cx="5.2" cy="18.8" r="1.5"/>',
  lupa: '<circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.6 15.6l4.6 4.6"/><circle class="kropka" cx="10.8" cy="10.8" r="1.8"/>',
  robot: '<rect x="4" y="8" width="16" height="11.6" rx="2.6"/><path d="M12 8V4.6"/><circle class="kropka" cx="12" cy="3.4" r="1.5"/><circle class="kropka" cx="9" cy="13.4" r="1.5"/><circle class="kropka" cx="15" cy="13.4" r="1.5"/>',
  dysk: '<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="2.4"/><path d="M7.6 3.4v6h8.8v-6"/><rect x="7.6" y="13" width="8.8" height="7.6" rx="1.2"/><circle class="kropka" cx="14.6" cy="6.2" r="1.3"/>',
  ksiazka: '<path d="M3.6 5.2A2 2 0 015.6 3.4H11v16.4H5.6a2 2 0 01-2-2z"/><path d="M20.4 5.2a2 2 0 00-2-1.8H13v16.4h5.4a2 2 0 002-2z"/><circle class="kropka" cx="12" cy="12" r="1.5"/>',
  limit: '<path d="M12 3.4v3M12 17.6v3M3.4 12h3M17.6 12h3"/><circle cx="12" cy="12" r="5.6"/><path class="akc" d="M12 9.2v3.4l2.4 1.4"/>',
  przeplyw: '<path d="M3 8.4c2.6-2.4 5.2-2.4 7.8 0s5.2 2.4 7.8 0"/><path d="M3 13.2c2.6-2.4 5.2-2.4 7.8 0s5.2 2.4 7.8 0"/><path class="akc" d="M3 18c2.6-2.4 5.2-2.4 7.8 0s5.2 2.4 7.8 0"/>',
  osiagniete: '<path d="M5.4 20.6V3.6"/><path d="M5.4 4.6h12.2l-2.4 3.8 2.4 3.8H5.4"/><circle class="kropka" cx="5.4" cy="20.6" r="1.6"/>',
  kosz: '<path d="M4.4 6.6h15.2"/><path d="M9.4 6.6V4.8a1.4 1.4 0 011.4-1.4h2.4a1.4 1.4 0 011.4 1.4v1.8"/><path d="M6.2 6.6l.9 12.4a1.8 1.8 0 001.8 1.6h6.2a1.8 1.8 0 001.8-1.6l.9-12.4"/><path class="akc" d="M10.4 10.6v6M13.6 10.6v6"/>',
  zarowka: '<path d="M9 17.4h6M9.8 20.6h4.4"/><path d="M12 3.4a5.8 5.8 0 013.6 10.3c-.6.5-.9 1.1-.9 1.8H9.3c0-.7-.3-1.3-.9-1.8A5.8 5.8 0 0112 3.4z"/><circle class="kropka" cx="12" cy="9" r="1.5"/>',
  trend_dol: '<path d="M3.4 3.6v17h17"/><path d="M6.6 8l4.4 5 3.9-3.3 4.3 5.9"/><circle class="kropka" cx="18.6" cy="15.6" r="1.9"/>',
  mozg: '<path d="M9.4 4.2a3 3 0 00-3 3 2.8 2.8 0 00-1.6 5 3 3 0 001.9 5.2 3 3 0 003 2.4h.7V4.2z"/><path d="M14.6 4.2a3 3 0 013 3 2.8 2.8 0 011.6 5 3 3 0 01-1.9 5.2 3 3 0 01-3 2.4h-.7V4.2z"/><circle class="kropka" cx="12" cy="12" r="1.5"/>',
  kompas: '<circle cx="12" cy="12" r="8.6"/><path class="akc" d="M15.2 8.8l-1.9 4.5-4.5 1.9 1.9-4.5z"/>',
  sygnal: '<path d="M5.6 15.6a8 8 0 010-11.2M18.4 4.4a8 8 0 010 11.2"/><path d="M8.6 12.6a4 4 0 010-5.2M15.4 7.4a4 4 0 010 5.2"/><circle class="kropka" cx="12" cy="10" r="1.9"/><path d="M12 12.4V20.6"/>',
  notatka: '<path d="M6 3.4h8.4L19.4 8v12.6H6z"/><path d="M14.2 3.4V8h5"/><path class="akc" d="M9 12.6h6M9 16h4"/>',
  sukces: '<circle cx="12" cy="12" r="8.6"/><path class="akc" d="M8.2 12.2l2.6 2.6 5-5.4"/>',
  olowek: '<path d="M4 20l1.2-4.2L15.6 5.4a2.2 2.2 0 013.1 3.1L8.2 18.8z"/><path d="M14 7l3 3"/>',
  ptaszek: '<path d="M4.8 12.4l4.6 4.6 9.8-10.4"/>',
  krzyzyk: '<path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6"/>',
  pauza: '<path d="M9.4 5.4v13.2M14.6 5.4v13.2"/>',
  uchwyt: '<circle cx="9" cy="6.4" r="1.5"/><circle cx="15" cy="6.4" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="17.6" r="1.5"/><circle cx="15" cy="17.6" r="1.5"/>',
  uwaga: '<path d="M12 3.8l9 15.6H3z"/><path class="akc" d="M12 9.6v4.2"/><circle class="kropka" cx="12" cy="16.6" r="1.3"/>',
  gwiazdka: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  wymiana: '<path d="M4 8.4h13.2M14 5.2l3.2 3.2-3.2 3.2"/><path d="M20 15.6H6.8M10 12.4l-3.2 3.2 3.2 3.2"/>',
  do_salda: '<path class="akc" d="M12 4v10.4M8.4 11l3.6 3.6L15.6 11"/><path d="M5 19.2h14"/>',
};

// Wersje pelne — tylko do dolnego paska. Przy 23 px cienka kreska jest
// zbyt watla, a paska oglada sie w ruchu.
const IKONY_PELNE = {
  pulpit: '<rect x="3" y="12" width="4.5" height="8" rx="1.4"/><rect x="9.7" y="7" width="4.5" height="13" rx="1.4"/><rect x="16.4" y="10" width="4.5" height="10" rx="1.4"/><circle class="kropka" cx="18.65" cy="5.4" r="2.1"/>',
  dodaj: '<circle cx="12" cy="12" r="9"/><path class="pusto" d="M11 7.4h2v9.2h-2z"/><path class="pusto" d="M7.4 11h9.2v2H7.4z"/>',
  lista: '<rect x="4" y="5.4" width="16" height="2.2" rx="1.1"/><rect x="4" y="10.9" width="16" height="2.2" rx="1.1"/><rect x="4" y="16.4" width="9" height="2.2" rx="1.1"/><circle class="kropka" cx="18.4" cy="17.5" r="2.1"/>',
  konta: '<rect x="2.8" y="5.5" width="18.4" height="13" rx="2.4"/><rect class="pusto" x="2.8" y="9.2" width="18.4" height="2.1"/><circle class="kropka" cx="17.4" cy="14.8" r="1.9"/>',
  wplywy: '<circle cx="12" cy="12" r="9"/><path class="pusto" d="M11 7h2v6.6h-2z"/><path class="pusto" d="M12 17.4l-3.6-3.8h7.2z"/>',
  cele: '<circle cx="12" cy="12" r="9"/><circle class="pusto" cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="3.9"/><circle class="pusto" cx="12" cy="12" r="2.1"/><circle class="kropka" cx="12" cy="12" r="2.1"/>',
  kategorie: '<path d="M11.2 3.2H20.4v9.2l-9.2 8.8L2.6 12.4z"/><circle class="pusto" cx="16.3" cy="7.5" r="2.4"/><circle class="kropka" cx="16.3" cy="7.5" r="1.7"/>',
  analiza: '<path d="M3 19h18v2H3zM3 3h2v18H3z"/><path d="M6.6 15.4l4.4-5 3.9 3.3 4.3-5.7 1.6 1.2-5.6 7.4-4-3.4-3 3.4z"/><circle class="kropka" cx="18.6" cy="8" r="2.3"/>',
  alerty: '<path d="M12 3.2a6 6 0 016 6c0 4.4 1.7 5.9 1.7 5.9H4.3s1.7-1.5 1.7-5.9a6 6 0 016-6z"/><circle class="kropka" cx="12" cy="19" r="2.2"/>',
  admin: '<rect x="3.6" y="6.2" width="16.8" height="2.4" rx="1.2"/><rect x="3.6" y="15.4" width="16.8" height="2.4" rx="1.2"/><circle class="kropka" cx="9" cy="7.4" r="2.4"/><circle class="kropka" cx="15.6" cy="16.6" r="2.4"/>',
  // Krzyż rysowany BRYŁĄ, a nie jako wycięcie w karcie. `pusto` ma kolor
  // dolnego paska wpisany na sztywno, więc na jasnym kafelku przełącznika
  // wycięcie robiło się ciemną plamą i z całego znaku zostawał prostokąt.
  zdrowie: '<path d="M9.4 3.2h5.2v6.2h6.2v5.2h-6.2v6.2H9.4v-6.2H3.2V9.4h6.2z"/>',
};

function ikonaPelna(nazwa) {
  return `<span class="ikona pelna"><svg viewBox="0 0 24 24" aria-hidden="true">${IKONY_PELNE[nazwa] || IKONY_SVG[nazwa] || ''}</svg></span>`;
}

function ikonaSvg(nazwa) {
  return `<span class="ikona"><svg viewBox="0 0 24 24" aria-hidden="true">${IKONY_SVG[nazwa] || ''}</svg></span>`;
}

// ── moduły ──────────────────────────────────────────────────────────────────
// JEDNO miejsce, z którego bierze się cała nawigacja: górny pasek, dolny pasek
// i przełącznik. Wcześniej linki były wpisane na sztywno w dziesięciu plikach
// HTML — dodanie jednej zakładki wymagało dziesięciu edycji.
//
// Dołożenie kolejnego modułu (wiem.health i tak dalej) to dopisanie wpisu tutaj.
const MODULY = [
  {
    id: 'finance',
    nazwa: 'finance',
    // Złoto, nie koral: koral przeszedł do zadań. Odcień dobrany pomiarem
    // kontrastu wobec tła dolnego paska (#1a1d20), bo --marka jest tam kolorem
    // PISMA aktywnej pozycji — 7,82:1 przy wymaganych 4,5:1. Ta sama wartość
    // stoi w palecie ikon apki, więc nie jest to nowy odcień w systemie.
    kolor: '#eda100',
    opis: 'Wydatki, konta, cele',
    ikona: 'moneta',
    strony: [
      { href: '/',              ikona: 'pulpit',    label: 'Pulpit',        pelny: 'Pulpit' },
      { href: '/upload',        ikona: 'dodaj',     label: 'Dodaj',         pelny: 'Dodaj wydatek' },
      { href: '/lista',         ikona: 'lista',     label: 'Lista',         pelny: 'Lista zakupów' },
      { href: '/konta',         ikona: 'konta',     label: 'Konta',         pelny: 'Konta' },
      { href: '/wplywy',        ikona: 'wplywy',    label: 'Wpływy',        pelny: 'Wpływy' },
      { href: '/cele',          ikona: 'cele',      label: 'Cele',          pelny: 'Cele' },
      { href: '/kategorie',     ikona: 'kategorie', label: 'Kategorie',     pelny: 'Kategorie' },
      { href: '/analiza',       ikona: 'analiza',   label: 'Analiza',       pelny: 'Analiza' },
      { href: '/powiadomienia', ikona: 'alerty',    label: 'Alerty',        pelny: 'Powiadomienia' },
    ],
  },
  {
    id: 'eat',
    nazwa: 'eat',
    kolor: '#7cb518',
    opis: 'Dziennik i kalorie',
    ikona: 'jablko',
    strony: [
      { href: '/eat', ikona: 'lista', label: 'Dziennik', pelny: 'Dziennik' },
      { href: '/przepisy', ikona: 'ksiazka', label: 'Przepisy', pelny: 'Przepisy' },
      { href: '/skaner', ikona: 'dodaj', label: 'Sprawdź', pelny: 'Sprawdź produkt' },
      { href: '/statystyki', ikona: 'analiza', label: 'Statystyki', pelny: 'Statystyki i oceny' },
    ],
  },
  {
    id: 'health',
    nazwa: 'health',
    kolor: '#00c4ba',
    opis: 'Historia zdrowia',
    ikona: 'zdrowie',
    strony: [
      { href: '/health', ikona: 'zdrowie', label: 'Historia', pelny: 'Historia zdrowia' },
    ],
  },
  {
    id: 'task',
    nazwa: 'task',
    kolor: '#ff6b6b',
    opis: 'Zadania i projekty',
    ikona: 'zadania',
    strony: [
      { href: '/task', ikona: 'zadania', label: 'Zadania', pelny: 'Zadania' },
    ],
  },
];

function _modulBiezacy() {
  const sciezka = location.pathname.replace(/\/$/, '') || '/';
  for (const m of MODULY) {
    if (m.strony.some((s) => s.href === sciezka)) return m;
  }
  return MODULY[0];   // strony spoza modułów (np. /admin) trzymamy przy finansach
}

// Znak bierze kolor bieżącego modułu. `--marka` maluje obie kropki w znaku i
// dopisek („wiem.eat"), więc wystarczy ustawić ją raz na <html> — żaden inny
// kawałek CSS nie musi wiedzieć, w którym module jesteśmy. Wartość jest jedna
// dla obu motywów, bo pasek jest atramentowy niezależnie od motywu.
// Wołane od razu przy wczytaniu pliku, a nie w _injectNav: strony bez <nav>
// też mają kropki (np. ekran oczekiwania w eat), a styl wpisany na <html>
// obowiązuje przed pierwszym rysowaniem, więc znak nie mruga kolorem.
function _ustawKolorModulu() {
  const kolor = _modulBiezacy().kolor;
  if (kolor) document.documentElement.style.setProperty('--marka', kolor);
}
_ustawKolorModulu();

function _pozycjaPaska(i) {
  return `<a href="${i.href}" class="${location.pathname === i.href ? 'active' : ''}">
      ${ikonaPelna(i.ikona)}${i.label}
    </a>`;
}

// ── górny pasek ─────────────────────────────────────────────────────────────
// Buduje się z definicji modułu, a nie z HTML-a strony. W plikach HTML zostaje
// samo `<nav>` z logo — resztę dokłada ten kod.
function _injectNav() {
  const nav = document.querySelector('nav');
  if (!nav || nav.dataset.zbudowany) return;
  const modul = _modulBiezacy();

  const przelacznik = document.createElement('button');
  przelacznik.className = 'nav-modul';
  przelacznik.type = 'button';
  przelacznik.title = 'Przełącz moduł';
  // Nazwa modułu siedzi teraz w samym znaku („wiem.finance"), więc przy
  // kropkach byłaby drugi raz. Zostaje sama siatka — z etykietą dla czytników
  // ekranu, bo bez podpisu przycisk nie miałby nazwy.
  przelacznik.setAttribute('aria-label', `Przełącz moduł (teraz: ${modul.nazwa})`);
  przelacznik.innerHTML = '<span class="krata" aria-hidden="true">'
    + '<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>';
  przelacznik.onclick = _pokazPrzelacznik;

  const logo = nav.querySelector('.logo');
  if (logo) {
    // Znak prowadzi do pulpitu WŁASNEGO modułu, a nie na „/". W HTML-u każdej
    // strony stoi href="/", więc stuknięcie w „wiem.eat" wyrzucało z modułu
    // prosto do finansów — czyli znak modułu robił dokładnie to, czego po nim
    // nikt się nie spodziewa. Pierwsza strona modułu jest jego pulpitem.
    const pulpit = (modul.strony && modul.strony[0] && modul.strony[0].href) || '/';
    logo.setAttribute('href', pulpit);
    // Dopisek dokładamy z kodu, a nie w każdym pliku HTML z osobna — inaczej
    // jedenaście stron musiałoby wiedzieć, w którym są module.
    if (!logo.querySelector('.dop-modul')) {
      const dop = document.createElement('span');
      dop.className = 'dop-modul';
      // Dwie wersje w kodzie, przełączane w CSS. Na ekranach do 340 px pełne
      // „wiem.finance" zajmowało pasek co do piksela — zapas wynosił zero,
      // więc każda inna metryka kroju rozsypywała układ. Poniżej tego progu
      // zostaje sama litera; wyżej nikt tego przełączenia nie zobaczy.
      dop.innerHTML = `<span class="dop-pelny"></span><span class="dop-skrot"></span>`;
      dop.querySelector('.dop-pelny').textContent = modul.nazwa;
      dop.querySelector('.dop-skrot').textContent = modul.nazwa.charAt(0);
      logo.appendChild(dop);
    }
    logo.insertAdjacentElement('afterend', przelacznik);
  } else {
    nav.prepend(przelacznik);
  }

  // Linki modułu siedzą we WŁASNYM pasie, który potrafi się skurczyć i przewinąć.
  // Bez tego przy ~1000 px pasek rozpychał całą stronę w bok i ucinał logo —
  // dziewięć linków plus przełącznik, Admin, samouczek i pseudonim się nie mieści.
  const pas = document.createElement('div');
  pas.className = 'nav-linki';
  modul.strony.forEach((s) => {
    const a = document.createElement('a');
    a.href = s.href;
    a.textContent = s.pelny || s.label;
    if (location.pathname === s.href) a.className = 'active';
    pas.appendChild(a);
  });
  przelacznik.insertAdjacentElement('afterend', pas);
  const akt = pas.querySelector('a.active');
  if (akt && akt.scrollIntoView) akt.scrollIntoView({ inline: 'center', block: 'nearest' });
  nav.dataset.zbudowany = '1';
}

// KAŻDY KAFELEK NIESIE WŁASNY KOLOR. `--marka` ustawiona na kafelku obowiązuje
// wszystko w jego środku: kropkę przy nazwie ORAZ akcenty w ikonie (`kropka`
// i `akc` w SVG). Bez tego ikony brały kolor strony, na której akurat stoisz —
// w finansach ptaszek zadań był złoty, a kreski dziennika miały złotą kropkę
// zamiast zielonej. Przełącznik ma pokazywać moduły, a nie miejsce wyjścia.
function _pokazPrzelacznik(ev) {
  const biezacy = _modulBiezacy();
  const o = document.createElement('div');
  o.className = 'przelacznik-tlo';
  o.innerHTML = `<div class="przelacznik">
      <div class="przelacznik-tyt">Moduły</div>
      <div class="przelacznik-siatka">
        ${MODULY.map((m) => `
          <a href="${m.strony[0].href}" class="modul-kafel${m.id === biezacy.id ? ' biezacy' : ''}"
             style="--marka:${m.kolor}">
            ${ikonaPelna(m.ikona)}
            <span class="mk-n">wiem<i class="mk-kropka"></i> ${m.nazwa}</span>
            <span class="mk-o">${m.opis}</span>
          </a>`).join('')}
      </div>
    </div>`;
  o.addEventListener('click', (e) => { if (e.target === o) o.remove(); });
  document.body.appendChild(o);

  // Na szerokim ekranie panel siada dokładnie pod siatką kropek, a nie na
  // środku ekranu — ruch ma wychodzić stamtąd, gdzie się stuknęło. Pozycję
  // bierzemy z faktycznych współrzędnych przycisku, bo jego odległość od
  // lewej krawędzi zależy od szerokości logo i nazwy modułu.
  // Na telefonie zostaje układ z CSS: pełna szerokość tuż pod paskiem.
  const guzik = (ev && ev.currentTarget) || document.querySelector('.nav-modul');
  const panel = o.querySelector('.przelacznik');
  if (guzik && panel && window.innerWidth > 700) {
    const r = guzik.getBoundingClientRect();
    const szer = panel.getBoundingClientRect().width;
    // Przy prawej krawędzi panel musi się cofnąć, żeby nie wyjść poza ekran.
    const lewa = Math.max(8, Math.min(r.left, window.innerWidth - szer - 8));
    o.style.display = 'block';
    o.style.padding = '0';
    panel.style.position = 'absolute';
    panel.style.top = Math.round(r.bottom + 8) + 'px';
    panel.style.left = Math.round(lewa) + 'px';
    panel.style.width = szer + 'px';
  }

  // Escape zamyka tak samo jak stuknięcie w tło — bez tego panel dało się
  // zamknąć wyłącznie myszą.
  const naKlawisz = (e) => {
    if (e.key === 'Escape') { o.remove(); document.removeEventListener('keydown', naKlawisz); }
  };
  document.addEventListener('keydown', naKlawisz);
}

// Pasek rysujemy OD RAZU, nie czekając na potwierdzenie logowania. Wcześniej
// wołane to było dopiero wewnątrz authRequireHousehold, więc przy każdym
// przejściu na inną zakładkę pasek znikał i wracał po dwóch podróżach do sieci
// (Firebase + /api/me). Jego treść i tak nie zależy od użytkownika — poza
// linkiem „Admin", który doklejamy osobno, gdy już wiemy, kto jest zalogowany.
function _injectBottomNav(me) {
  if (!document.querySelector('nav')) return;
  let bar = document.querySelector('.bottom-nav');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'bottom-nav';
    // Tylko strony BIEŻĄCEGO modułu. Przełączenie wymienia dolny pasek w
    // całości — dzięki temu przestał mieć dziewięć pozycji do przewijania.
    // Samego przełącznika tu NIE MA: modułami przełącza się siatką kropek w
    // górnym pasku i dublowanie tego na dole tylko zabierało miejsce.
    bar.innerHTML = _modulBiezacy().strony.map(_pozycjaPaska).join('');
    document.body.appendChild(bar);
    // dosuń aktywną ikonę do widoku (pasek jest przewijany w poziomie)
    const act = bar.querySelector('a.active');
    if (act && act.scrollIntoView) act.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
  // „Admin" dochodzi później i tylko raz — dopisanie go nie przerysowuje paska,
  // więc nie ma mrugnięcia ani przeskoku przewinięcia.
  if (me && authIsAdmin(me) && !bar.querySelector('a[href="/admin"]')) {
    bar.insertAdjacentHTML('beforeend', _pozycjaPaska({ href: '/admin', ikona: 'admin', label: 'Admin' }));
  }
}

// ── Wskazówki kontekstowe (różne per zakładka) ──
const _TIPS_OGOLNE = [
  'Samouczek jest zawsze pod przyciskiem „Samouczek" na górnym pasku — wrócisz do niego kiedy chcesz.',
  'Na telefonie wybierz „Dodaj do ekranu głównego" — apka działa jak natywna, z dolnym paskiem i aparatem.',
  'Kliknij swój pseudonim na górnym pasku, żeby go zmienić.',
  'Budżet prowadzicie wspólnie — kliknij swój pseudonim na górnym pasku i wybierz „Zaproś osobę".',
  'Osobę bez konta Google (np. dziecko) dodasz w oknie profilu — przycisk „Osoba bez konta".',
  'Kopię całego budżetu pobierzesz z menu „⋯" na dashboardzie — to plik, który możesz zachować.',
];
const _TIPS_STRONY = {
  '/': [
    'Kliknij segment wykresu kategorii → zejdziesz do podkategorii, a potem do konkretnych produktów.',
    'Wyszukiwarka u góry przeszukuje całą historię — wpisz produkt, sklep albo fragment notatki.',
    'Po wyszukaniu produktu kliknij „<span class="ikona"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 3.6v17h17"/><path d="M6.6 16.4l4.4-5 3.9 3.3 4.3-5.9"/><circle class="kropka" cx="18.6" cy="8.4" r="1.9"/></svg></span> Pokaż zmiany cen" — zobaczysz gdzie taniej i jak cena rosła w czasie.',
    'Przełącznik Pierwotne / Kontekstowe zmienia sposób liczenia kategorii dla wydatków z okazji.',
    'Filtruj po miesiącu, osobie i kategorii — jest też tryb dowolnego zakresu dat.',
    'Wykres trendów miesięcznych przełączysz między „Osobno" (per osoba) a „Łącznie".',
    'Przypomnienie o płatności możesz zamknąć krzyżykiem na tę sesję — wróci następnym razem, aż je zrobisz.',
    '„Top sklepy" pokazują, gdzie zostawiacie najwięcej pieniędzy.',
  ],
  '/upload': [
    'Zrób zdjęcie paragonu — Claude odczyta sklep, pozycje, ceny i sam przypisze kategorie.',
    'Możesz wrzucić kilka zdjęć naraz — każde stanie się osobnym wydatkiem.',
    'Nie masz paragonu? Wpisz wydatki zwykłą notatką w drugiej zakładce.',
    'Zanim zapiszesz, wszystko poprawisz — pozycje, ceny, ilości i kategorie.',
    'Ustaw „okazję" (np. urodziny) — taki wydatek nie zaburzy statystyk Waszych zwykłych nawyków.',
    '„Kontekst kategorii" wrzuci cały paragon do jednej kategorii (np. całą imprezę do Rozrywki).',
    'Przypisz paragon do konta, żeby saldo tego konta samo się zgadzało.',
  ],
  '/lista': [
    'Tapnięcie na produkcie oznacza go jako kupiony i przenosi do koszyka na dole.',
    'Przeciągnij produkt za uchwyt ⠿, żeby ustawić kolejność — np. wg alejek w Twoim sklepie.',
    'Lista jest wspólna i działa na żywo — druga osoba widzi Twoje zmiany od razu.',
    'Po zakupach kliknij „Usuń kupione", żeby jednym ruchem wyczyścić koszyk.',
    'Zielona kropka = połączenie na żywo. Żółta = łączę ponownie (np. po słabym zasięgu).',
  ],
  '/konta': [
    'Dodaj konta (bank, gotówka, oszczędności) i miej salda zawsze pod ręką.',
    'Subskrypcje i raty ustaw jako wydatki cykliczne — naliczą się same.',
    'Cykliczny przelew na konto oszczędnościowe też ustawisz tutaj (Rodzaj: przelew).',
    'Przelewy między kontami i inwentaryzacje (spis rzeczywistego stanu) robisz na tej stronie.',
    'Dodawaj wpływy (np. pensję), żeby bilans gospodarstwa był pełny.',
    'Wpływ albo przelew edytujesz ikoną ołówka w historii konta — bez usuwania i dodawania od nowa.',
  ],
  '/kategorie': [
    'Dopasuj kategorie i podkategorie do swojego gospodarstwa — apka nie narzuca Ci sztywnej listy.',
    'Zmiany w kategoriach od razu wpływają na wykresy, filtry i analizy.',
  ],
  '/analiza': [
    'Doradca AI przeanalizuje Wasze wydatki i wskaże, gdzie realnie da się zaoszczędzić — z kwotami.',
    'Odpowiadaj na pytania doradcy — buduje profil gospodarstwa i z każdą analizą zna Was lepiej.',
    'Zapisane raporty znajdziesz w historii analiz — możesz wrócić do wcześniejszych wniosków.',
  ],
  '/powiadomienia': [
    'To jest archiwum płatności — potwierdzone ręczne przelewy i automatyczne naliczenia.',
    'Po zrobieniu ręcznego przelewu klikaj „Zrobione", żeby zszedł z aktywnych.',
  ],
};

function _injectTip(me) {
  // stan wskazówek trzymany PER UŻYTKOWNIK — to, że jedna osoba je wyłączyła/widziała,
  // nie zabiera ich drugiej (nawet na współdzielonej przeglądarce)
  const uid = (me && me.user_id) ? me.user_id : 'x';
  const kOff = 'tipsOff_' + uid, kIdx = 'tipIdx_' + uid, kSes = 'tipShown_' + uid;
  if (localStorage.getItem(kOff) === '1') return;
  if (sessionStorage.getItem(kSes) === '1') return;  // najwyżej jedna wskazówka na sesję — nie nachalnie
  const main = document.querySelector('main');
  if (!main) return;
  sessionStorage.setItem(kSes, '1');
  const pula = [...(_TIPS_STRONY[location.pathname] || []), ..._TIPS_OGOLNE];
  if (!pula.length) return;
  const i = parseInt(localStorage.getItem(kIdx) || '0', 10) || 0;
  localStorage.setItem(kIdx, String(i + 1));
  const tekst = pula[i % pula.length];
  const el = document.createElement('div');
  el.id = 'tip-dnia';
  el.style.cssText = 'margin-bottom:14px';
  el.innerHTML = `<div style="display:flex;align-items:center;gap:10px;background:var(--surface-3);border:1px solid #d5e5fb;color:#2c5aa0;border-radius:10px;padding:9px 14px;font-size:13.5px">
      <span><span class="ikona"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17.4h6M9.8 20.6h4.4"/><path d="M12 3.4a5.8 5.8 0 013.6 10.3c-.6.5-.9 1.1-.9 1.8H9.3c0-.7-.3-1.3-.9-1.8A5.8 5.8 0 0112 3.4z"/><circle class="kropka" cx="12" cy="9" r="1.5"/></svg></span> ${tekst}</span><span style="flex:1"></span>
      <button onclick="localStorage.setItem('${kOff}','1');this.closest('#tip-dnia').remove()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;white-space:nowrap">nie pokazuj więcej</button>
      <button onclick="this.closest('#tip-dnia').remove()" style="background:none;border:none;color:#2c5aa0;cursor:pointer;font-size:16px;line-height:1;padding:0 2px">✕</button>
    </div>`;
  main.insertBefore(el, main.firstChild);
}

async function authRequireHousehold() {
  return new Promise((resolve, reject) => {
    _auth.onAuthStateChanged(async (user) => {
      if (!user) {
        window.location.href = "/login";
        return reject();
      }
      try {
        const token = await user.getIdToken();
        const res = await fetch("/api/me", {
          headers: { Authorization: "Bearer " + token },
        });
        if (res.status === 403) {
          const d = await res.json().catch(() => ({}));
          document.body.innerHTML = `<div style="max-width:420px;margin:80px auto;padding:0 20px;text-align:center;font-family:system-ui">
            <div class="ikona-duza"><span class="ikona"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path class="akc" d="M6.4 6.4l11.2 11.2"/></svg></span></div>
            <h2 style="margin:0 0 8px;color:var(--text)">Konto zawieszone</h2>
            <p style="color:var(--text);line-height:1.5">${d.detail || 'Twoje konto zostało zawieszone przez administratora.'}</p>
            <button onclick="authLogout()" style="margin-top:18px;padding:9px 18px;border:1px solid var(--border);border-radius:8px;background:var(--surface);cursor:pointer">Wyloguj</button>
          </div>`;
          return reject();
        }
        if (!res.ok) { window.location.href = "/login"; return reject(); }
        const me = await res.json();
        if (!me.household_id) {
          window.location.href = "/onboarding";
          return reject();
        }
        window._currentUser = me;
        _injectProfileButton(me);
        _injectBottomNav(me);
        _injectTip(me);
        if (me.samouczek === false) setTimeout(() => pokazSamouczek(true), 600);
        resolve(me);
      } catch {
        window.location.href = "/login";
        reject();
      }
    });
  });
}

// widoczny stan "Claude pracuje" z rotującymi komunikatami kroków;
// zwraca funkcję stop() czyszczącą interwał
function aiPracaStart(el, tytul, kroki, czasInfo) {
  let i = 0;
  el.innerHTML = `<div class="ai-praca">
      <div class="ai-spinner orbita"><i></i><i></i></div>
      <div class="ai-tytul">${tytul}</div>
      <div class="ai-krok">${kroki[0]}</div>
      ${czasInfo ? `<div class="ai-czas">⏱ ${czasInfo}</div>` : ''}
    </div>`;
  const krokEl = el.querySelector('.ai-krok');
  const t = setInterval(() => {
    i = (i + 1) % kroki.length;
    krokEl.style.opacity = 0;
    setTimeout(() => { krokEl.textContent = kroki[i]; krokEl.style.opacity = 1; }, 250);
  }, 2800);
  if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return () => clearInterval(t);
}
window.aiPracaStart = aiPracaStart;

// ── znak jako wskaźnik pracy ──
// Kropki w logo pulsują, dopóki trwa zapytanie. Licznik, bo zapytań bywa
// kilka naraz — pasek gaśnie dopiero, gdy skończy się ostatnie.
// Zwłoka 260 ms sprawia, że szybkie zapytania nie powodują mignięcia.
let _wPracy = 0;
let _pulsTimer = null;

function _pracaStart() {
  _wPracy++;
  if (_pulsTimer || _wPracy > 1) return;
  _pulsTimer = setTimeout(() => {
    document.querySelectorAll('nav .logo').forEach(el => el.classList.add('pracuje'));
  }, 260);
}

function _pracaKoniec() {
  _wPracy = Math.max(0, _wPracy - 1);
  if (_wPracy) return;
  clearTimeout(_pulsTimer);
  _pulsTimer = null;
  document.querySelectorAll('nav .logo').forEach(el => el.classList.remove('pracuje'));
}

async function authFetch(url, options = {}) {
  const token = await authGetToken();
  _pracaStart();
  try {
    return await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: "Bearer " + token,
      },
    });
  } finally {
    _pracaKoniec();
  }
}

async function loadOsobaOptions(selectId, includeAll = false) {
  try {
    const data = await authFetch('/api/household').then(r => r.json());
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    if (includeAll) sel.appendChild(new Option('Oboje', ''));
    (data.members || []).forEach(m => {
      const label = m.display_name || m.name.split(' ')[0];
      sel.appendChild(new Option(label, label));
    });
    (data.virtual_members || []).forEach(m => {
      const opt = new Option(m.name + ' *', m.name);
      sel.appendChild(opt);
    });
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  } catch {}
}

window.authGetToken = authGetToken;
window.authLogout = authLogout;
window.authRequireHousehold = authRequireHousehold;
window.authFetch = authFetch;
window.loadOsobaOptions = loadOsobaOptions;

// Pasek stawiamy, gdy tylko ten plik się wczyta — a leży w cache service
// workera, więc dzieje się to praktycznie natychmiast. Bez logowania, bez
// czekania na serwer. Strony bez górnej nawigacji (logowanie) same się wykluczą.
function _zbudujNawigacje() {
  _injectNav();
  _injectBottomNav();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _zbudujNawigacje);
} else {
  _zbudujNawigacje();
}

// ── komunikaty i potwierdzenia ──────────────────────────────────────────────
//
// `toast()` zastępuje alert(), `potwierdz()` zastępuje confirm(). Mieszkają
// w auth.js, bo ten plik ładuje każda strona — komunikat wyskakujący tylko
// na połowie apki byłby gorszy niż jednolity alert.
//
// DWIE RZECZY, KTÓRYCH OKNO SYSTEMOWE NIE UMIE, A KTÓRE SĄ TU POWODEM ZMIANY:
// komunikat nie zatrzymuje strony (można czytać dalej, toast sam znika),
// a pytanie o usunięcie ma przycisk nazwany „Usuń" zamiast „OK" — przy
// nieodwracalnej akcji nazwa przycisku jest zabezpieczeniem, nie ozdobą.

function _toastStos() {
  let s = document.getElementById('_toasty');
  if (!s) {
    s = document.createElement('div');
    s.id = '_toasty';
    s.className = 'toast-stos';
    s.setAttribute('role', 'status');       // czytnik ekranu przeczyta sam
    s.setAttribute('aria-live', 'polite');
    document.body.appendChild(s);
  }
  return s;
}

// rodzaj: 'blad' | 'ok' | pominięty (neutralny)
function toast(tekst, rodzaj) {
  if (!tekst) return;
  const el = document.createElement('div');
  el.className = 'toast' + (rodzaj ? ' ' + rodzaj : '');
  const t = document.createElement('span');
  t.textContent = tekst;                    // treść bywa z serwera — nie innerHTML
  const x = document.createElement('button');
  x.className = 'toast-x';
  x.type = 'button';
  x.setAttribute('aria-label', 'Zamknij komunikat');
  x.textContent = '\u00d7';
  el.appendChild(t);
  el.appendChild(x);
  _toastStos().appendChild(el);

  let zegar;
  const zamknij = () => {
    clearTimeout(zegar);
    el.classList.add('znika');
    setTimeout(() => el.remove(), 220);
  };
  x.onclick = zamknij;
  // Błąd stoi dłużej: zwykle trzeba coś poprawić w formularzu, a komunikat,
  // który zniknie w trakcie czytania, każe powtarzać całą akcję.
  zegar = setTimeout(zamknij, rodzaj === 'blad' ? 6500 : 4000);
  return zamknij;
}

// Zwraca Promise<boolean>. Wywołanie: `if (!(await potwierdz({...}))) return;`
function potwierdz(opcje) {
  const o = opcje || {};
  return new Promise((rozstrzygnij) => {
    const tlo = document.createElement('div');
    tlo.className = 'pyt-tlo';
    tlo.innerHTML = `
      <div class="pyt" role="dialog" aria-modal="true" aria-labelledby="_pyt-t">
        <h3 id="_pyt-t"></h3>
        <p></p>
        <div class="pyt-akcje">
          <button class="btn btn-outline" type="button" data-nie></button>
          <button class="btn ${o.groznie ? 'btn-groznie' : 'btn-primary'}" type="button" data-tak></button>
        </div>
      </div>`;
    tlo.querySelector('h3').textContent = o.tytul || 'Na pewno?';
    tlo.querySelector('p').textContent = o.tresc || '';
    if (!o.tresc) tlo.querySelector('p').remove();
    const tak = tlo.querySelector('[data-tak]');
    const nie = tlo.querySelector('[data-nie]');
    tak.textContent = o.tak || 'Potwierdź';
    nie.textContent = o.nie || 'Anuluj';

    const skoncz = (wynik) => {
      document.removeEventListener('keydown', klawisz);
      tlo.remove();
      rozstrzygnij(wynik);
    };
    // Escape i kliknięcie w tło znaczą „nie" — wyjście z pytania nigdy nie
    // może przypadkiem potwierdzić usunięcia.
    const klawisz = (e) => { if (e.key === 'Escape') skoncz(false); };
    document.addEventListener('keydown', klawisz);
    tlo.addEventListener('click', (e) => { if (e.target === tlo) skoncz(false); });
    tak.onclick = () => skoncz(true);
    nie.onclick = () => skoncz(false);

    document.body.appendChild(tlo);
    nie.focus();   // ostrożniejszy przycisk pod Enterem
  });
}

window.toast = toast;
window.potwierdz = potwierdz;
