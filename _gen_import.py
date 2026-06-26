import json

with open("C:/Szkolenie/Budżet_domowy/migration_data.json", "r", encoding="utf-8") as f:
    data = json.load(f)

data_json = json.dumps(data, ensure_ascii=False)
js = (
    "authFetch('/api/admin/import-data',{"
    "method:'POST',"
    "headers:{'Content-Type':'application/json'},"
    "body:JSON.stringify(" + data_json + ")"
    "}).then(r=>r.json()).then(d=>console.log('IMPORT OK',d)).catch(e=>console.error('BLAD',e))"
)

with open("C:/Szkolenie/Budżet_domowy/_import_cmd.txt", "w", encoding="utf-8") as f:
    f.write(js)

print(f"OK {len(js)} znakow")
