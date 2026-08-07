// Service worker aplikacji „Wiem".
//
// Serwowany z / (trasa w main.py), bo z /static obejmowałby zasięgiem tylko ten
// katalog. __BUILD__ podmieniane jest przy serwowaniu na hasz commita — dzięki
// temu plik zmienia się przy każdym deployu, przeglądarka wykrywa aktualizację
// i stary cache leci do kosza. Bez tego apka potrafiłaby serwować stary kod
// jeszcze długo po wdrożeniu.

const BUILD = '__BUILD__';
const CACHE = 'budzet-' + BUILD;

// „Skorupa" aplikacji — wygląd i logika, nie dane. Wersjonowane tak samo jak
// w HTML-u, żeby żądanie ze strony trafiało dokładnie w ten wpis w cache.
const PRECACHE = [
  '/static/style.css?v=' + BUILD,
  '/static/app.js?v=' + BUILD,
  '/static/auth.js?v=' + BUILD,
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/static/manifest.json',
  '/static/offline.html',
];

self.addEventListener('install', (e) => {
  // addAll jest atomowe — gdy jeden plik padnie, instalacja się nie powiedzie
  // i zostaje stary, działający worker. Lepiej niż połowiczny cache.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((klucze) => Promise.all(klucze.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── powiadomienia push ──────────────────────────────────────────────────────
// Ładunek przychodzi jako JSON: {tytul, tresc, url, tag}. Gdyby przyszło coś
// innego (albo nic — niektóre usługi wysyłają puste pobudki), pokazujemy
// komunikat zastępczy zamiast milczeć: powiadomienie, którego nie da się
// wyświetlić, w Chrome kończy się ostrzeżeniem systemowym.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = {}; }
  const tytul = d.tytul || 'Wiem';
  e.waitUntil(self.registration.showNotification(tytul, {
    body: d.tresc || '',
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    tag: d.tag || 'wiem',
    renotify: false,          // ten sam tag podmienia wpis, nie dzwoni drugi raz
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const cel = (e.notification.data && e.notification.data.url) || '/';
  // Jeśli apka jest już gdzieś otwarta, przenosimy JĄ na właściwy ekran zamiast
  // otwierać drugą kartę — inaczej po tygodniu użytkownik ma ich pięć.
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((okna) => {
    for (const o of okna) {
      if (new URL(o.url).origin === self.location.origin && 'focus' in o) {
        if ('navigate' in o) o.navigate(cel);
        return o.focus();
      }
    }
    return clients.openWindow(cel);
  }));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Obce domeny (Firebase) zostawiamy przeglądarce. Chart.js i Sortable
  // serwujemy z własnego serwera właśnie po to, żeby wpadły w cache poniżej.
  if (url.origin !== self.location.origin) return;

  // Dane finansowe NIGDY nie trafiają do cache — ani wydatki, ani salda.
  // Offline pokazujemy pustą apkę, nie nieaktualne kwoty.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // Strony: najpierw sieć (HTML jest no-store i zależny od zalogowania),
  // a gdy jej nie ma — ekran offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/static/offline.html')));
    return;
  }

  // Statyki: najpierw cache (są wersjonowane, więc nie zwietrzeją),
  // przy pudle dokładamy odpowiedź do cache'u na później.
  e.respondWith(
    caches.match(req).then((trafienie) => trafienie || fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const kopia = res.clone();
        caches.open(CACHE).then((c) => c.put(req, kopia));
      }
      return res;
    }))
  );
});
