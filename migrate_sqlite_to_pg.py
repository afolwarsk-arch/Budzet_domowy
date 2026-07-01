#!/usr/bin/env python3
"""Jednorazowa migracja: SQLite (data/budget.db) → PostgreSQL (DATABASE_URL)"""
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

import psycopg2
import psycopg2.extras

SQLITE_PATH = Path(os.environ.get("DATA_DIR", "data")) / "budget.db"
DATABASE_URL = os.environ["DATABASE_URL"]


@contextmanager
def pg():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


def cols(sq, table):
    return {r[1] for r in sq.execute(f"PRAGMA table_info({table})").fetchall()}


def fix_seq(cur, table, col="id"):
    cur.execute(f"SELECT setval('{table}_{col}_seq', COALESCE((SELECT MAX({col}) FROM {table}), 1))")


def migrate():
    if not SQLITE_PATH.exists():
        print(f"BŁĄD: Nie znaleziono {SQLITE_PATH}")
        return

    sq = sqlite3.connect(SQLITE_PATH)
    sq.row_factory = sqlite3.Row
    tables = {r[0] for r in sq.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    print(f"Tabele SQLite: {sorted(tables)}")

    with pg() as cur:
        cur.execute("SELECT COUNT(*) AS c FROM wydatki")
        if cur.fetchone()["c"] > 0:
            print("PostgreSQL ma już dane — przerywam (uruchom ponownie tylko na pustej bazie).")
            return

    # --- households ---
    if "households" in tables:
        rows = sq.execute("SELECT * FROM households").fetchall()
        with pg() as cur:
            for r in rows:
                cur.execute(
                    "INSERT INTO households (id,name,created_at) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                    (r["id"], r["name"], r["created_at"]),
                )
            fix_seq(cur, "households")
        print(f"  households: {len(rows)}")

    # --- users ---
    if "users" in tables:
        c = cols(sq, "users")
        rows = sq.execute("SELECT * FROM users").fetchall()
        with pg() as cur:
            for r in rows:
                cur.execute(
                    """INSERT INTO users (id,firebase_uid,email,name,picture,display_name,last_login,created_at)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (r["id"], r["firebase_uid"], r["email"], r["name"], r["picture"],
                     r["display_name"] if "display_name" in c else None,
                     r["last_login"] if "last_login" in c else None,
                     r["created_at"]),
                )
            fix_seq(cur, "users")
        print(f"  users: {len(rows)}")

    # --- memberships ---
    if "memberships" in tables:
        rows = sq.execute("SELECT * FROM memberships").fetchall()
        with pg() as cur:
            for r in rows:
                cur.execute(
                    "INSERT INTO memberships (user_id,household_id,role) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                    (r["user_id"], r["household_id"], r["role"]),
                )
        print(f"  memberships: {len(rows)}")

    # --- wydatki ---
    if "wydatki" in tables:
        c = cols(sq, "wydatki")
        rows = sq.execute("SELECT * FROM wydatki").fetchall()
        with pg() as cur:
            for r in rows:
                cur.execute(
                    """INSERT INTO wydatki
                       (id,data,sklep,suma,osoba,notatki,zdjecie,waluta,kurs,household_id,
                        created_at,okazja,kontekst_kategoria,kontekst_podkategoria,konto_id)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (r["id"], r["data"], r["sklep"], r["suma"], r["osoba"], r["notatki"],
                     r["zdjecie"],
                     r["waluta"] if "waluta" in c else "PLN",
                     r["kurs"] if "kurs" in c else 1.0,
                     r["household_id"] if "household_id" in c else None,
                     r["created_at"],
                     r["okazja"] if "okazja" in c else None,
                     r["kontekst_kategoria"] if "kontekst_kategoria" in c else None,
                     r["kontekst_podkategoria"] if "kontekst_podkategoria" in c else None,
                     r["konto_id"] if "konto_id" in c else None),
                )
            fix_seq(cur, "wydatki")
        print(f"  wydatki: {len(rows)}")

    # --- pozycje ---
    if "pozycje" in tables:
        c = cols(sq, "pozycje")
        rows = sq.execute("SELECT * FROM pozycje").fetchall()
        with pg() as cur:
            for r in rows:
                cur.execute(
                    """INSERT INTO pozycje (id,wydatek_id,nazwa,cena,ilosc,kategoria_glowna,kategoria,poza_kontekstem)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (r["id"], r["wydatek_id"], r["nazwa"], r["cena"], r["ilosc"],
                     r["kategoria_glowna"] if "kategoria_glowna" in c else "Inne",
                     r["kategoria"],
                     bool(r["poza_kontekstem"]) if "poza_kontekstem" in c else False),
                )
            fix_seq(cur, "pozycje")
        print(f"  pozycje: {len(rows)}")

    # --- konta ---
    if "konta" in tables:
        rows = sq.execute("SELECT * FROM konta").fetchall()
        with pg() as cur:
            for r in rows:
                cur.execute(
                    """INSERT INTO konta (id,household_id,nazwa,typ,osoba,waluta,saldo_poczatkowe,aktywne,created_at)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (r["id"], r["household_id"], r["nazwa"], r["typ"], r["osoba"],
                     r["waluta"], r["saldo_poczatkowe"], bool(r["aktywne"]), r["created_at"]),
                )
            fix_seq(cur, "konta")
        print(f"  konta: {len(rows)}")

    # --- wplywy ---
    if "wplywy" in tables:
        rows = sq.execute("SELECT * FROM wplywy").fetchall()
        with pg() as cur:
            for r in rows:
                cur.execute(
                    """INSERT INTO wplywy (id,household_id,data,kwota,osoba,kategoria,opis,konto_id,created_at)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (r["id"], r["household_id"], r["data"], r["kwota"], r["osoba"],
                     r["kategoria"], r["opis"], r["konto_id"], r["created_at"]),
                )
            fix_seq(cur, "wplywy")
        print(f"  wplywy: {len(rows)}")

    # --- inwentaryzacje ---
    if "inwentaryzacje" in tables:
        rows = sq.execute("SELECT * FROM inwentaryzacje").fetchall()
        with pg() as cur:
            for r in rows:
                cur.execute(
                    """INSERT INTO inwentaryzacje
                       (id,konto_id,data,saldo_rzeczywiste,saldo_obliczone,roznica,notatki,created_at)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (r["id"], r["konto_id"], r["data"], r["saldo_rzeczywiste"],
                     r["saldo_obliczone"], r["roznica"], r["notatki"], r["created_at"]),
                )
            fix_seq(cur, "inwentaryzacje")
        print(f"  inwentaryzacje: {len(rows)}")

    # --- virtual_members ---
    if "virtual_members" in tables:
        rows = sq.execute("SELECT * FROM virtual_members").fetchall()
        with pg() as cur:
            for r in rows:
                cur.execute(
                    "INSERT INTO virtual_members (id,household_id,name,created_at) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                    (r["id"], r["household_id"], r["name"], r["created_at"]),
                )
            fix_seq(cur, "virtual_members")
        print(f"  virtual_members: {len(rows)}")

    # --- analiza_state ---
    if "analiza_state" in tables:
        rows = sq.execute("SELECT * FROM analiza_state").fetchall()
        with pg() as cur:
            for r in rows:
                cur.execute(
                    """INSERT INTO analiza_state (household_id,groups_json,pool_json,updated_at)
                       VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (r["household_id"], r["groups_json"], r["pool_json"], r["updated_at"]),
                )
        print(f"  analiza_state: {len(rows)}")

    # --- household_kategorie ---
    if "household_kategorie" in tables:
        rows = sq.execute("SELECT * FROM household_kategorie").fetchall()
        with pg() as cur:
            for r in rows:
                cur.execute(
                    "INSERT INTO household_kategorie (household_id,hierarchia_json) VALUES (%s,%s) ON CONFLICT DO NOTHING",
                    (r["household_id"], r["hierarchia_json"]),
                )
        print(f"  household_kategorie: {len(rows)}")

    # --- konto_domyslne ---
    if "konto_domyslne" in tables:
        rows = sq.execute("SELECT * FROM konto_domyslne").fetchall()
        with pg() as cur:
            for r in rows:
                cur.execute(
                    "INSERT INTO konto_domyslne (user_id,konto_id) VALUES (%s,%s) ON CONFLICT DO NOTHING",
                    (r["user_id"], r["konto_id"]),
                )
        print(f"  konto_domyslne: {len(rows)}")

    sq.close()
    print("\nMigracja zakończona pomyślnie!")


if __name__ == "__main__":
    migrate()
