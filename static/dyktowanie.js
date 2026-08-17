// Dyktowanie głosem — bez wiedzy o tym, do czego trafi tekst.
//
// Web Speech API bywa kapryśne, a jego błędy nazywają się tak, że użytkownik
// nic z nich nie wyczyta. Cała wiedza o tych powodach siedzi tutaj, żeby każdy
// ekran, który dodaje mikrofon, dostawał od razu sensowne komunikaty zamiast
// jednego „nie usłyszałem" na wszystkie awarie naraz.
//
// Wołający dostaje gotowy tekst i sam decyduje, co z nim zrobić.
(function () {
  let sluchacz = null;

  // Bez „kłódki przy adresie": na Androidzie jej nie ma, a w aplikacji
  // uruchamianej z ekranu początkowego nie ma nawet paska adresu.
  const POWODY = {
    'not-allowed': 'Brak zgody na mikrofon. Chrome → ⋮ → Ustawienia → Ustawienia witryn → '
      + 'Mikrofon → ta strona → Zezwalaj. Sprawdź też, czy sam Chrome ma zgodę na mikrofon '
      + 'w ustawieniach telefonu.',
    'service-not-allowed': 'System nie zezwolił na rozpoznawanie mowy. Sprawdź w ustawieniach '
      + 'telefonu, czy Chrome ma dostęp do mikrofonu.',
    'no-speech': 'Nic nie usłyszałem. Stuknij mikrofon i mów wyraźniej.',
    'audio-capture': 'Nie znalazłem mikrofonu.',
    'network': 'Rozpoznawanie mowy wymaga internetu i właśnie go nie ma.',
  };

  function dostepne() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  function stop() {
    if (sluchacz) { try { sluchacz.abort(); } catch {} sluchacz = null; }
  }

  // opcje: { onTekst, onStan, onBlad, jezyk }
  //   onStan(sluchaMy)  — true przy starcie, false przy końcu; do podświetlenia guzika
  function start(opcje) {
    const { onTekst, onStan, onBlad, jezyk } = opcje || {};
    const blad = (t) => { if (onBlad) onBlad(t); };
    if (sluchacz) return;              // drugie stuknięcie nie tworzy drugiego nasłuchu

    const Rozpoznawanie = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rozpoznawanie) {
      blad('Ta przeglądarka nie obsługuje dyktowania. Na iPhonie działa tylko klawiaturowy '
        + 'mikrofon iOS — stuknij pole i użyj go. Na Androidzie użyj Chrome.');
      return;
    }

    const r = new Rozpoznawanie();
    r.lang = jezyk || 'pl-PL';
    r.interimResults = false;
    sluchacz = r;
    if (onStan) onStan(true);

    r.onresult = (ev) => {
      const tekst = (ev.results[0][0].transcript || '').trim();
      if (onTekst) onTekst(tekst);
    };
    r.onerror = (ev) => {
      const kod = (ev && ev.error) || '';
      if (kod === 'aborted') return;   // sami przerwaliśmy, to nie błąd
      blad(POWODY[kod] || ('Dyktowanie nie zadziałało (' + (kod || 'nieznany błąd') + ').'));
    };
    r.onend = () => { sluchacz = null; if (onStan) onStan(false); };

    try {
      r.start();
    } catch (err) {
      sluchacz = null;
      if (onStan) onStan(false);
      blad('Nie udało się uruchomić dyktowania: ' + ((err && err.message) || err));
    }
  }

  window.Dyktowanie = { start, stop, dostepne, sluchaMy: () => !!sluchacz };
})();
