import json, base64

with open("C:/Szkolenie/Budżet_domowy/migration_data.json", "r", encoding="utf-8") as f:
    data = f.read()

b64 = base64.b64encode(data.encode("utf-8")).decode("ascii")

script = f'python3 -c "import base64,json,sqlite3; raw=base64.b64decode(\'{b64}\').decode(); d=json.loads(raw); conn=sqlite3.connect(\'budget.db\'); conn.execute(\'PRAGMA foreign_keys=ON\'); [conn.execute(\'INSERT INTO wydatki (data,sklep,suma,osoba,notatki,zdjecie,waluta,kurs,household_id) VALUES (?,?,?,?,?,?,?,?,?)\', (w[\'data\'],w.get(\'sklep\'),w[\'suma\'],w.get(\'osoba\',\'Adam\'),w.get(\'notatki\'),None,w.get(\'waluta\',\'PLN\'),w.get(\'kurs\',1.0),1)) or None for w in d[\'wydatki\']]; print(\'wydatki OK\'); conn.commit(); conn.close(); print(\'DONE\')"'

with open("C:/Szkolenie/Budżet_domowy/_terminal_cmd.txt", "w", encoding="utf-8") as f:
    f.write(script)

print(f"Wygenerowano komendę, {len(script)} znaków")
