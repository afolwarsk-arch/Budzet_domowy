#!/usr/bin/env python3
"""Eksport wszystkich gospodarstw domowych do JSON — używany przez GitHub Actions."""
import json
import os
from datetime import datetime
from pathlib import Path

import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ["DATABASE_PUBLIC_URL"]


def export_all() -> dict:
    conn = psycopg2.connect(DATABASE_URL, sslmode="require")
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("SELECT current_database()")
    db_name = cur.fetchone()["current_database"]
    cur.execute("SELECT COUNT(*) AS c FROM wydatki")
    wydatki_total = cur.fetchone()["c"]
    print(f"[DIAGNOSTYKA] Baza: {db_name} | wydatki w bazie: {wydatki_total}")

    cur.execute("SELECT id, name FROM households ORDER BY id")
    households = cur.fetchall()
    print(f"[DIAGNOSTYKA] Gospodarstwa: {len(households)}")

    result: dict = {
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "households": [],
    }

    def export_wydatki(cur, hid):
        if hid is None:
            where = "WHERE w.household_id IS NULL"
            params = ()
        else:
            where = "WHERE w.household_id = %s"
            params = (hid,)
        cur.execute(
            f"""SELECT w.*, json_agg(row_to_json(p.*)) FILTER (WHERE p.id IS NOT NULL) AS pozycje
               FROM wydatki w LEFT JOIN pozycje p ON p.wydatek_id = w.id
               {where}
               GROUP BY w.id ORDER BY w.data DESC, w.created_at DESC""",
            params,
        )
        wydatki = []
        for row in cur.fetchall():
            r = dict(row)
            pozycje_raw = r.get("pozycje") or []
            r["pozycje"] = [p if isinstance(p, dict) else json.loads(p) for p in pozycje_raw]
            wydatki.append(r)
        return wydatki

    for h in households:
        hid = h["id"]
        wydatki = export_wydatki(cur, hid)

        cur.execute("SELECT * FROM konta WHERE household_id = %s ORDER BY created_at", (hid,))
        konta = [dict(r) for r in cur.fetchall()]

        cur.execute(
            "SELECT * FROM wplywy WHERE household_id = %s ORDER BY data DESC", (hid,)
        )
        wplywy = [dict(r) for r in cur.fetchall()]

        cur.execute(
            """SELECT i.* FROM inwentaryzacje i
               JOIN konta k ON k.id = i.konto_id
               WHERE k.household_id = %s ORDER BY i.data DESC""",
            (hid,),
        )
        inwentaryzacje = [dict(r) for r in cur.fetchall()]

        cur.execute(
            "SELECT hierarchia_json FROM household_kategorie WHERE household_id = %s", (hid,)
        )
        row = cur.fetchone()
        hierarchia = json.loads(row["hierarchia_json"]) if row else None

        result["households"].append(
            {
                "id": hid,
                "name": h["name"],
                "wydatki_count": len(wydatki),
                "wydatki": wydatki,
                "konta": konta,
                "wplywy": wplywy,
                "inwentaryzacje": inwentaryzacje,
                "hierarchia": hierarchia,
            }
        )

    # Wydatki bez przypisanego gospodarstwa (household_id = NULL)
    orphaned = export_wydatki(cur, None)
    print(f"[DIAGNOSTYKA] Wydatki bez gospodarstwa (NULL): {len(orphaned)}")
    if orphaned:
        result["households"].append(
            {
                "id": None,
                "name": "_bez_gospodarstwa",
                "wydatki_count": len(orphaned),
                "wydatki": orphaned,
                "konta": [],
                "wplywy": [],
                "inwentaryzacje": [],
                "hierarchia": None,
            }
        )

    cur.close()
    conn.close()
    return result


if __name__ == "__main__":
    Path("backups").mkdir(exist_ok=True)
    data = export_all()
    date_str = datetime.utcnow().strftime("%Y-%m-%d")
    filename = f"backups/backup_{date_str}.json"
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, default=str)
    total = sum(h["wydatki_count"] for h in data["households"])
    print(f"Backup: {filename} | {len(data['households'])} gospodarstw | {total} wydatków")
