from task_dopasowanie import dopasuj_miejsce, slowa

KANDYDACI = [
    {"id": 1, "tytul": "Remont domu", "projekt": True},
    {"id": 2, "tytul": "Zakup działki", "projekt": True},
    {"id": 3, "tytul": "Wyjazd do Malagi", "projekt": False},
]


def test_slowa_przycina_do_czterech_liter():
    assert slowa("Urlopu w Maladze") == {"urlo", "mala"}


def test_trafia_w_projekt_mimo_odmiany():
    assert dopasuj_miejsce(KANDYDACI, "do remontu domu") == {"id": 1, "tytul": "Remont domu"}


def test_pojedyncze_wspolne_slowo_nie_wystarcza():
    assert dopasuj_miejsce(KANDYDACI, "kup mleko do domu na weekend") is None


def test_brak_frazy():
    assert dopasuj_miejsce(KANDYDACI, None) is None
