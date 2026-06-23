"""Jednorazowy skrypt: re-kategoryzuje wszystkie pozycje w bazie danych."""
import json
import sqlite3
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "budget.db"

from dotenv import load_dotenv
load_dotenv(BASE_DIR / ".env")

from ai_processor import KATEGORIE
import anthropic

def recategorize(pozycje: list[dict]) -> list[str]:
    """Wysyła listę nazw produktów do Claude, dostaje listę kategorii."""
    client = anthropic.Anthropic()

    names = [f"{i+1}. {p['nazwa']}" for i, p in enumerate(pozycje)]
    prompt = (
        f"Przypisz kategorię do każdego produktu z listy. "
        f"Użyj wyłącznie kategorii z tej listy: {json.dumps(KATEGORIE, ensure_ascii=False)}\n\n"
        f"Produkty:\n" + "\n".join(names) +
        f"\n\nZwróć TYLKO tablicę JSON z kategoriami w tej samej kolejności co produkty. "
        f"Przykład dla 3 produktów: [\"Napoje\", \"Owoce i warzywa\", \"Nabiał i jaja\"]"
    )

    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = msg.content[0].text.strip()
    import re
    raw = re.sub(r"```(?:json)?|```", "", raw).strip()
    kategorie = json.loads(raw)
    # walidacja
    return [k if k in KATEGORIE else "Inne" for k in kategorie]


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    pozycje = conn.execute("SELECT id, nazwa, kategoria FROM pozycje").fetchall()

    if not pozycje:
        print("Brak pozycji w bazie.")
        conn.close()
        return

    print(f"Znaleziono {len(pozycje)} pozycji do re-kategoryzacji.")

    # grupuj po 50 pozycji żeby nie przekroczyć limitu tokenu
    BATCH = 50
    updated = 0
    for i in range(0, len(pozycje), BATCH):
        batch = pozycje[i:i + BATCH]
        print(f"  Przetwarzam pozycje {i+1}–{i+len(batch)}...", end=" ", flush=True)
        try:
            nowe_kategorie = recategorize([dict(p) for p in batch])
            for poz, kat in zip(batch, nowe_kategorie):
                if poz["kategoria"] != kat:
                    conn.execute(
                        "UPDATE pozycje SET kategoria = ? WHERE id = ?",
                        (kat, poz["id"])
                    )
                    updated += 1
            conn.commit()
            print(f"OK ({len(batch)} pozycji)")
        except Exception as e:
            print(f"BŁĄD: {e}")

    conn.close()
    print(f"\nGotowe. Zaktualizowano {updated} z {len(pozycje)} pozycji.")


if __name__ == "__main__":
    main()
