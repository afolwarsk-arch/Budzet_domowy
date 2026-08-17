// Czytanie kodu kreskowego z kamery — bez wiedzy o tym, gdzie wynik trafi.
//
// Wydzielone z eat.js, żeby edytor przepisu dostał tę samą drogę co dziennik.
// Moduł nie zna ani arkusza, ani ekranu produktu: dostaje element <video>,
// element do pokazania podglądu i wywołania zwrotne. Dzięki temu jedna poprawka
// (nowy format kodu, inna obsługa błędu) trafia od razu w obie strony.
//
// UWAGA przy migracji eat.js na ten moduł: skanera nie da się sprawdzić
// automatem — pytanie o zgodę na kamerę blokuje kartę, a w środowisku testowym
// nie ma obrazu. Dlatego dziennik korzysta na razie z własnej kopii, a przejście
// na ten moduł wymaga sprawdzenia na prawdziwym telefonie.
(function () {
  let strumien = null;
  let skanuje = false;
  let uruchamiam = false;

  function stop() {
    skanuje = false;
    if (strumien) {
      strumien.getTracks().forEach((t) => t.stop());
      strumien = null;
    }
  }

  // opcje: { video, wrap, onKod, onBlad, onPodglad, onCisza }
  //   onBlad(tekst)  — komunikat dla użytkownika; ZAWSZE oznacza koniec skanowania
  //   onCisza()      — 10 s bez trafienia; kamera nadal chodzi
  async function start(opcje) {
    if (strumien || skanuje || uruchamiam) return;   // straż przed drugim uruchomieniem
    uruchamiam = true;
    try {
      await _start(opcje);
    } finally {
      uruchamiam = false;
    }
  }

  async function _start({ video, wrap, onKod, onBlad, onPodglad, onCisza }) {
    const blad = (t) => { if (onBlad) onBlad(t); };
    const schowaj = () => { if (wrap) wrap.style.display = 'none'; };

    if (!('BarcodeDetector' in window)) {
      blad('Ta przeglądarka nie umie czytać kodów. Zrób zdjęcie etykiety albo wpisz cyfry spod kreskówki.');
      return;
    }
    // Sam fakt, że BarcodeDetector istnieje, nie znaczy, że działa na tym
    // telefonie ani że obsłuży wybrane formaty — konstruktor potrafi rzucić.
    let detektor;
    try {
      let obslugiwane = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
      if (BarcodeDetector.getSupportedFormats) {
        const dostepne = await BarcodeDetector.getSupportedFormats();
        obslugiwane = obslugiwane.filter((f) => dostepne.includes(f));
      }
      if (!obslugiwane.length) throw new Error('brak formatów');
      detektor = new BarcodeDetector({ formats: obslugiwane });
    } catch {
      blad('Ten telefon nie umie czytać kodów kreskowych w przeglądarce. Zrób zdjęcie etykiety albo wpisz cyfry ręcznie.');
      return;
    }

    try {
      strumien = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch {
      blad('Nie mam dostępu do aparatu. Sprawdź uprawnienia strony.');
      return;
    }
    if (wrap) wrap.style.display = 'block';
    video.srcObject = strumien;
    await video.play().catch(() => {});
    if (onPodglad) onPodglad();

    // Po dziesięciu sekundach bez trafienia warto zaproponować wpisanie cyfr —
    // przy słabym świetle albo pogniecionym opakowaniu inaczej zostaje
    // wpatrywanie się w podgląd bez końca.
    const cisza = setTimeout(() => { if (skanuje && onCisza) onCisza(); }, 10000);

    skanuje = true;
    (async function petla() {
      let bledy = 0;
      while (skanuje) {
        try {
          const kody = await detektor.detect(video);
          // Obok EAN-13 bywa na opakowaniu drugi kod (partia, waga). Bierzemy
          // pierwszy, który wygląda na kod produktu, a nie pierwszy z brzegu.
          const trafienie = kody.find((k) => /^\d{6,14}$/.test(String(k.rawValue || '').trim()));
          if (trafienie) {
            clearTimeout(cisza);
            stop();
            schowaj();
            if (onKod) await onKod(String(trafienie.rawValue).trim());
            return;
          }
        } catch {
          // Gdy detect() sypie przy każdej klatce, nie kręcimy się w nieskończoność
          if (++bledy > 20) {
            clearTimeout(cisza);
            stop();
            schowaj();
            blad('Odczyt kodu nie działa na tym telefonie. Wpisz cyfry albo zrób zdjęcie etykiety.');
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      clearTimeout(cisza);
    })();
  }

  window.Skaner = { start, stop, dziala: () => skanuje };
})();
