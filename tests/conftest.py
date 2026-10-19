"""Wspólne przygotowanie testów — bez bazy i bez sieci.

`database.py` czyta DATABASE_URL już przy imporcie. Pula połączeń powstaje
leniwie, więc fałszywy adres wystarcza, dopóki test nie dotknie bazy — a testy,
które jej potrzebują, podmieniają połączenie przez `fake_db.podmien_baze`."""

import os

os.environ.setdefault("DATABASE_URL", "postgresql://test:test@127.0.0.1:1/nieistnieje")
