import json
import os

import firebase_admin
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials

import database

ADMIN_EMAILS = {"a.folwarsk@gmail.com"}

_bearer = HTTPBearer(auto_error=False)


def _init_firebase():
    if firebase_admin._apps:
        return
    sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
    if sa_json:
        cred = credentials.Certificate(json.loads(sa_json))
    else:
        cred = credentials.Certificate("firebase-service-account.json")
    firebase_admin.initialize_app(cred)


_init_firebase()


def user_from_token(token: str) -> dict | None:
    """Waliduje token Firebase i zwraca kontekst użytkownika (lub None).
    Używane przez get_current_user (REST) oraz uwierzytelnianie WebSocketa,
    który nie może wysłać nagłówka Authorization — token leci w query param."""
    try:
        decoded = firebase_auth.verify_id_token(token)
    except Exception:
        return None

    firebase_uid = decoded["uid"]
    email = decoded.get("email", "")
    name = decoded.get("name", "") or email.split("@")[0]
    picture = decoded.get("picture", "")

    user_id, display_name = database.create_or_update_user(firebase_uid, email, name, picture)
    household = database.get_user_household(user_id)

    return {
        "firebase_uid": firebase_uid,
        "email": email,
        "name": name,
        "picture": picture,
        "display_name": display_name,
        "user_id": user_id,
        "household_id": household["id"] if household else None,
        "role": household["role"] if household else None,
    }


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    if not creds:
        raise HTTPException(status_code=401, detail="Brak tokenu autoryzacji")
    user = user_from_token(creds.credentials)
    if not user:
        raise HTTPException(status_code=401, detail="Nieprawidłowy token")
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["email"] not in ADMIN_EMAILS:
        raise HTTPException(status_code=403, detail="Brak uprawnień administratora")
    return user
