"""Watch Party: a small, readable watch-party server.

FastAPI serves the plain HTML/CSS/JavaScript client and owns each room's
canonical playback state. SQLite keeps room snapshots, movie cache entries,
and the group's poll choices between restarts.
"""

from __future__ import annotations

import asyncio
import base64
import difflib
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from dotenv import dotenv_values, load_dotenv


# Configuration and starter catalog
ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATABASE_PATH = ROOT / "watch_party.sqlite3"
UPLOAD_DIR = ROOT / "uploads"
MAX_UPLOAD_BYTES = 3 * 1024 * 1024 * 1024
MAX_MESH_MEDIA_PARTICIPANTS = 4
SESSION_COOKIE = "afterglow_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30
load_dotenv(ROOT / ".env")
OMDB_API_KEY = os.getenv("OMDB_API_KEY", "").strip()
KLIPY_APP_KEY = os.getenv("KLIPY_APP_KEY", "").strip()
TURN_URLS = [url.strip() for url in os.getenv("TURN_URLS", "").split(",") if url.strip()]
TURN_SHARED_SECRET = os.getenv("TURN_SHARED_SECRET", "").strip()
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "").strip()
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "").strip()
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "").strip()
LIVEKIT_ENABLED = bool(LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET)
REDIS_URL = os.getenv("REDIS_URL", "").strip()
S3_BUCKET = os.getenv("S3_BUCKET", "").strip()
S3_REGION = os.getenv("S3_REGION", "").strip() or None
S3_ENDPOINT_URL = os.getenv("S3_ENDPOINT_URL", "").strip() or None
S3_ACCESS_KEY_ID = os.getenv("S3_ACCESS_KEY_ID", "").strip()
S3_SECRET_ACCESS_KEY = os.getenv("S3_SECRET_ACCESS_KEY", "").strip()
S3_PREFIX = "/".join(part for part in os.getenv("S3_PREFIX", "afterglow-media").split("/") if part and part not in {".", ".."})
S3_ENABLED = os.getenv("MEDIA_STORAGE", "local").strip().casefold() == "s3" or bool(S3_BUCKET)
s3_client_cache: Any = None
redis_client: Any = None
redis_listener_task: asyncio.Task | None = None
redis_listener_ready: asyncio.Event | None = None
redis_heartbeat_task: asyncio.Task | None = None
INSTANCE_ID = secrets.token_hex(8)
REDIS_ROOM_PREFIX = "afterglow:room:"
REDIS_EVENT_CHANNEL = "afterglow:room-events"
OMDB_ATTRIBUTION = "Movie details and poster links supplied by OMDb. Ratings are reported by OMDb from IMDb. OMDb is not affiliated with IMDb."


def refresh_omdb_api_key() -> bool:
    """Pick up a local .env key added after the server started, without logging it."""
    global OMDB_API_KEY
    environment_key = os.getenv("OMDB_API_KEY", "").strip()
    file_key = str(dotenv_values(ROOT / ".env").get("OMDB_API_KEY") or "").strip()
    OMDB_API_KEY = environment_key or file_key
    return bool(OMDB_API_KEY)

GENRES = {
    "Action": 28,
    "Adventure": 12,
    "Animation": 16,
    "Comedy": 35,
    "Crime": 80,
    "Documentary": 99,
    "Drama": 18,
    "Family": 10751,
    "Fantasy": 14,
    "History": 36,
    "Horror": 27,
    "Music": 10402,
    "Mystery": 9648,
    "Romance": 10749,
    "Science fiction": 878,
    "TV movie": 10770,
    "Thriller": 53,
    "War": 10752,
    "Western": 37,
}
GENRE_NAMES = {genre_id: name for name, genre_id in GENRES.items()}

# These records keep the app useful before an OMDb key is configured.
# Posters are original CSS treatments; real poster URLs are loaded from OMDb.
STARTER_MOVIES: list[dict[str, Any]] = [
    {
        "id": "starter-arrival",
        "title": "Arrival",
        "year": 2016,
        "overview": "A linguist is asked to communicate with visitors whose arrival changes the shape of the world.",
        "genre_ids": [878, 18, 9648],
        "runtime": 116,
        "poster_path": None,
        "poster_theme": "violet",
        "vote_average": None,
        "popularity": 9.2,
    },
    {
        "id": "starter-perfect-days",
        "title": "Perfect Days",
        "year": 2023,
        "overview": "A quiet portrait of routine, small rituals, and the beauty hiding in an ordinary day.",
        "genre_ids": [18],
        "runtime": 124,
        "poster_path": None,
        "poster_theme": "amber",
        "vote_average": None,
        "popularity": 8.8,
    },
    {
        "id": "starter-wilderpeople",
        "title": "Hunt for the Wilderpeople",
        "year": 2016,
        "overview": "An unlikely pair disappears into the New Zealand bush in a warm, offbeat adventure.",
        "genre_ids": [12, 35, 18],
        "runtime": 101,
        "poster_path": None,
        "poster_theme": "fern",
        "vote_average": None,
        "popularity": 8.5,
    },
    {
        "id": "starter-grand-budapest",
        "title": "The Grand Budapest Hotel",
        "year": 2014,
        "overview": "A hotel concierge and his young protégé get swept into a caper across a changing Europe.",
        "genre_ids": [35, 18, 12],
        "runtime": 100,
        "poster_path": None,
        "poster_theme": "rose",
        "vote_average": None,
        "popularity": 8.7,
    },
    {
        "id": "starter-before-sunrise",
        "title": "Before Sunrise",
        "year": 1995,
        "overview": "Two strangers spend one night walking, talking, and wondering where a brief connection might lead.",
        "genre_ids": [18, 10749],
        "runtime": 101,
        "poster_path": None,
        "poster_theme": "blue",
        "vote_average": None,
        "popularity": 8.1,
    },
    {
        "id": "starter-farewell",
        "title": "The Farewell",
        "year": 2019,
        "overview": "A family gathers around a secret, balancing tenderness, tradition, and an awkward wedding.",
        "genre_ids": [35, 18],
        "runtime": 100,
        "poster_path": None,
        "poster_theme": "coral",
        "vote_average": None,
        "popularity": 8.0,
    },
    {
        "id": "starter-whisper",
        "title": "Whisper of the Heart",
        "year": 1995,
        "overview": "A curious reader follows a trail of library cards and discovers a new creative ambition.",
        "genre_ids": [16, 18, 10749],
        "runtime": 111,
        "poster_path": None,
        "poster_theme": "mint",
        "vote_average": None,
        "popularity": 8.3,
    },
    {
        "id": "starter-fantastic-mr-fox",
        "title": "Fantastic Mr. Fox",
        "year": 2009,
        "overview": "A clever fox tries to balance family life with one last elaborate bit of mischief.",
        "genre_ids": [16, 12, 35, 10751],
        "runtime": 87,
        "poster_path": None,
        "poster_theme": "gold",
        "vote_average": None,
        "popularity": 8.4,
    },
]

_MORE_STARTER_MOVIES = [
    ("Spirited Away", 2001, "A young girl enters a spirit world and must find her way home.", [16, 12, 10751], "mint"),
    ("Everything Everywhere All at Once", 2022, "A laundromat owner is pulled into a multiverse-spanning family adventure.", [878, 12, 35], "violet"),
    ("Knives Out", 2019, "A sharp detective investigates a celebrated novelist's complicated family.", [9648, 35, 80], "gold"),
    ("Moonlight", 2016, "Three chapters trace a young man's search for identity, connection, and home.", [18], "blue"),
    ("Paddington 2", 2017, "A kind bear sets out to find the perfect gift for his aunt.", [12, 35, 10751], "coral"),
    ("The Matrix", 1999, "A hacker discovers that reality is not what it seems.", [878, 28], "fern"),
    ("Parasite", 2019, "Two families become entangled in a tense story of class and ambition.", [35, 53, 18], "rose"),
    ("Lady Bird", 2017, "A restless senior navigates family, friendship, and her final year of school.", [35, 18], "amber"),
    ("Portrait of a Lady on Fire", 2019, "An artist and her subject build a vivid connection on a remote island.", [18, 10749], "rose"),
    ("The Social Network", 2010, "A college idea grows into a company and changes a group of friendships.", [18], "blue"),
    ("Mad Max: Fury Road", 2015, "A high-speed escape across a stark desert becomes a fight for freedom.", [28, 12, 878], "coral"),
    ("Coco", 2017, "A music-loving boy follows a family mystery into the Land of the Dead.", [16, 12, 10751], "gold"),
    ("The Truman Show", 1998, "A cheerful man's ordinary life begins to reveal an extraordinary secret.", [35, 18], "fern"),
    ("The Secret Life of Walter Mitty", 2013, "A daydreaming photo editor sets off on a real-world adventure.", [12, 35, 18], "blue"),
    ("The Banshees of Inisherin", 2022, "A sudden friendship break-up unsettles a small island community.", [35, 18], "amber"),
    ("Spider-Man: Into the Spider-Verse", 2018, "A Brooklyn teenager discovers a new kind of heroism across dimensions.", [16, 28, 12, 878], "violet"),
]
for _title, _year, _overview, _genre_ids, _theme in _MORE_STARTER_MOVIES:
    STARTER_MOVIES.append({
        "id": "starter-" + re.sub(r"[^a-z0-9]+", "-", _title.casefold()).strip("-"),
        "title": _title,
        "year": _year,
        "overview": _overview,
        "genre_ids": _genre_ids,
        "runtime": None,
        "poster_path": None,
        "poster_theme": _theme,
        "vote_average": None,
        "popularity": 6.0,
    })

for _movie in STARTER_MOVIES:
    _movie.setdefault("genre_names", [
        GENRE_NAMES[genre_id] for genre_id in _movie.get("genre_ids", []) if genre_id in GENRE_NAMES
    ])

OMDB_DISCOVERY_TITLES = [(movie["title"], movie["year"]) for movie in STARTER_MOVIES]

# Local database and account helpers
database = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
database.row_factory = sqlite3.Row
database_lock = threading.RLock()
rooms: dict[str, dict[str, Any]] = {}
connections: dict[str, dict[str, WebSocket]] = {}


def initialize_database() -> None:
    with database_lock:
        database.execute("PRAGMA journal_mode = WAL")
        database.execute("PRAGMA busy_timeout = 5000")
        database.executescript(
            """
            CREATE TABLE IF NOT EXISTS room_snapshots (
                code TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS catalog_cache (
                cache_key TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                saved_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS movie_votes (
                room_code TEXT NOT NULL,
                user_id TEXT NOT NULL,
                movie_id TEXT NOT NULL,
                title TEXT NOT NULL,
                genre_ids TEXT NOT NULL,
                vote INTEGER NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY(room_code, user_id, movie_id)
            );
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                username TEXT COLLATE NOCASE UNIQUE,
                password_salt BLOB,
                password_hash BLOB,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at REAL NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
            CREATE TABLE IF NOT EXISTS auth_attempts (
                ip_hash TEXT NOT NULL,
                action TEXT NOT NULL,
                attempted_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS auth_attempts_window_idx
                ON auth_attempts(ip_hash, action, attempted_at);
            """
        )
        database.commit()


def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def user_from_token(token: str) -> dict[str, Any] | None:
    if not token or len(token) > 200:
        return None
    now = time.time()
    with database_lock:
        row = database.execute(
            """SELECT users.id, users.display_name, users.username, sessions.expires_at
               FROM sessions JOIN users ON users.id = sessions.user_id
               WHERE sessions.token_hash = ?""",
            (hash_session_token(token),),
        ).fetchone()
        if row and row["expires_at"] <= now:
            database.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_session_token(token),))
            database.commit()
            return None
    if not row:
        return None
    return {
        "id": row["id"],
        "name": row["display_name"],
        "username": row["username"],
        "is_guest": row["username"] is None,
    }


def user_from_request(request: Request) -> dict[str, Any] | None:
    return user_from_token(request.cookies.get(SESSION_COOKIE, ""))


def require_user(request: Request) -> dict[str, Any]:
    user = user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="Your session expired. Refresh the page to continue.")
    return user


def issue_session(response: Response, request: Request, user_id: str) -> None:
    token = secrets.token_urlsafe(40)
    now = time.time()
    with database_lock:
        database.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        database.execute(
            "INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (hash_session_token(token), user_id, now + SESSION_MAX_AGE, now),
        )
        database.commit()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
    )


def create_guest(response: Response, request: Request) -> dict[str, Any]:
    user_id = "usr_" + secrets.token_urlsafe(18)
    name = "Guest " + secrets.token_hex(2).upper()
    with database_lock:
        database.execute(
            "INSERT INTO users(id, display_name, created_at) VALUES (?, ?, ?)",
            (user_id, name, time.time()),
        )
        database.commit()
    issue_session(response, request, user_id)
    return {"id": user_id, "name": name, "username": None, "is_guest": True}


def require_same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin:
        parsed = urllib.parse.urlparse(origin)
        host = request.headers.get("host", "").casefold()
        if parsed.netloc.casefold() != host or parsed.scheme not in {"http", "https"}:
            raise HTTPException(status_code=403, detail="This request did not come from this site.")


def auth_ip_hash(request: Request) -> str:
    address = request.client.host if request.client else "unknown"
    return hashlib.sha256(address.encode("utf-8")).hexdigest()


def auth_attempt_count(request: Request, action: str, window_seconds: int) -> int:
    ip_hash = auth_ip_hash(request)
    cutoff = time.time() - window_seconds
    with database_lock:
        database.execute("DELETE FROM auth_attempts WHERE attempted_at < ?", (time.time() - 86400,))
        row = database.execute(
            "SELECT COUNT(*) AS count FROM auth_attempts WHERE ip_hash = ? AND action = ? AND attempted_at >= ?",
            (ip_hash, action, cutoff),
        ).fetchone()
        database.commit()
    return int(row["count"] if row else 0)


def record_auth_attempt(request: Request, action: str) -> None:
    with database_lock:
        database.execute(
            "INSERT INTO auth_attempts(ip_hash, action, attempted_at) VALUES (?, ?, ?)",
            (auth_ip_hash(request), action, time.time()),
        )
        database.commit()


def password_hash(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)


# Uploaded media storage
def get_s3_client() -> Any:
    global s3_client_cache
    if s3_client_cache is None:
        try:
            import boto3
            from botocore.config import Config
        except ImportError as error:
            raise RuntimeError("Install the project requirements to use S3 media storage.") from error
        if bool(S3_ACCESS_KEY_ID) != bool(S3_SECRET_ACCESS_KEY):
            raise RuntimeError("Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or leave both empty to use the AWS credential chain.")
        client_options: dict[str, Any] = {"region_name": S3_REGION, "endpoint_url": S3_ENDPOINT_URL}
        if S3_ENDPOINT_URL:
            # Supabase expects path-style URLs and AWS Signature Version 4,
            # including for the temporary URLs used to stream private videos.
            client_options["config"] = Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
            )
        if S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY:
            client_options["aws_access_key_id"] = S3_ACCESS_KEY_ID
            client_options["aws_secret_access_key"] = S3_SECRET_ACCESS_KEY
        s3_client_cache = boto3.client("s3", **client_options)
    return s3_client_cache


def s3_media_key(media_id: str) -> str:
    return (S3_PREFIX + "/" if S3_PREFIX else "") + media_id


# Room state and multi-worker coordination
def new_room(
    code: str,
    host_id: str,
    host_name: str,
    title: str,
    current_movie: dict[str, Any] | None = None,
) -> dict[str, Any]:
    now = time.time()
    return {
        "code": code,
        "title": title,
        "host_id": host_id,
        "members": {
            host_id: {
                "id": host_id,
                "name": host_name,
                "joined_at": now,
                "last_seen": now,
                "connected": False,
            }
        },
        "current_movie": current_movie,
        "playback": {"position": 0.0, "is_playing": False, "updated_at": now},
        "screen_sharer": None,
        "video_members": set(),
        "playlist": [],
        "chat": [],
        "poll": None,
        "version": 1,
        "last_action_id": None,
        "seen_actions": set(),
        "ended": False,
        "lock": asyncio.Lock(),
    }


def room_to_record(room: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": room["code"],
        "title": room["title"],
        "host_id": room["host_id"],
        "members": list(room["members"].values()),
        "current_movie": room["current_movie"],
        "playback": room["playback"],
        "playlist": room["playlist"],
        "chat": room["chat"][-40:],
        "poll": room["poll"],
        "version": room["version"],
        "screen_sharer": room.get("screen_sharer"),
        "video_members": sorted(room.get("video_members", set())),
        "last_action_id": room.get("last_action_id"),
        "seen_actions": list(room.get("seen_actions", set()))[-4096:],
    }


def save_room(room: dict[str, Any]) -> None:
    with database_lock:
        database.execute(
            "INSERT OR REPLACE INTO room_snapshots(code, payload, updated_at) VALUES (?, ?, ?)",
            (room["code"], json.dumps(room_to_record(room)), time.time()),
        )
        database.commit()


def delete_room_snapshot(code: str) -> None:
    with database_lock:
        database.execute("DELETE FROM room_snapshots WHERE code = ?", (code,))
        database.commit()


def read_room_record_snapshot(code: str) -> dict[str, Any] | None:
    with database_lock:
        row = database.execute(
            "SELECT payload FROM room_snapshots WHERE code = ?", (code.upper(),)
        ).fetchone()
    if not row:
        return None
    try:
        record = json.loads(row["payload"])
    except (TypeError, json.JSONDecodeError):
        return None
    return record if isinstance(record, dict) else None


def load_room_record(record: dict[str, Any], existing: dict[str, Any] | None = None) -> dict[str, Any]:
    room = existing or new_room(
        record["code"], record["host_id"], "Host", record.get("title") or "Late show",
        record.get("current_movie"),
    )
    room["code"] = record["code"]
    room["title"] = record.get("title") or "Late show"
    room["host_id"] = record["host_id"]
    room["members"] = {
        member["id"]: {**member, "connected": bool(member.get("connected"))}
        for member in record.get("members", [])
    }
    if room["host_id"] not in room["members"]:
        now = time.time()
        room["members"][room["host_id"]] = {
            "id": room["host_id"], "name": "Host", "joined_at": now,
            "last_seen": now, "connected": False,
        }
    room["current_movie"] = record.get("current_movie")
    room["playback"] = record.get("playback") or room["playback"]
    room["playlist"] = record.get("playlist") or []
    room["chat"] = record.get("chat") or []
    room["poll"] = record.get("poll")
    room["version"] = int(record.get("version") or 1)
    room["screen_sharer"] = record.get("screen_sharer")
    room["video_members"] = set(record.get("video_members") or [])
    room["last_action_id"] = record.get("last_action_id")
    room["seen_actions"] = set(record.get("seen_actions") or [])
    room["ended"] = False
    return room


def redis_room_key(code: str) -> str:
    return REDIS_ROOM_PREFIX + code.upper()


def redis_instance_key(instance_id: str = INSTANCE_ID) -> str:
    return "afterglow:instance:" + instance_id


async def redis_instance_heartbeat() -> None:
    while redis_client:
        try:
            await redis_client.set(redis_instance_key(), "online", ex=30)
        except Exception:
            await asyncio.sleep(2)
            continue
        await asyncio.sleep(10)


async def reconcile_stale_members(room: dict[str, Any]) -> bool:
    if not redis_client:
        return False
    workers = {
        member.get("connection_worker")
        for member in room["members"].values()
        if member.get("connected")
    }
    stale_workers = set()
    for worker_id in workers:
        if worker_id and not await redis_client.exists(redis_instance_key(str(worker_id))):
            stale_workers.add(worker_id)
        elif not worker_id:
            stale_workers.add(None)
    if not stale_workers:
        return False
    now = time.time()
    stale_users = set()
    for user_id, member in room["members"].items():
        worker_id = member.get("connection_worker")
        if (
            member.get("connected")
            and worker_id in stale_workers
            and (worker_id is not None or now - float(member.get("last_seen") or 0) > 30)
        ):
            stale_users.add(user_id)
    if not stale_users:
        return False
    for user_id in stale_users:
        member = room["members"][user_id]
        member["connected"] = False
        member["last_seen"] = now
        member.pop("connection_id", None)
        member.pop("connection_worker", None)
    room["video_members"] = set(room.get("video_members", set())) - stale_users
    if room.get("screen_sharer") in stale_users:
        room["screen_sharer"] = None
    return True


async def refresh_room_from_redis(room: dict[str, Any]) -> dict[str, Any]:
    if not redis_client:
        return room
    raw = await redis_client.get(redis_room_key(room["code"]))
    if not raw:
        record = read_room_record_snapshot(room["code"])
        if record is None:
            raise HTTPException(status_code=404, detail="That room has ended or no longer exists.")
        await redis_client.set(redis_room_key(room["code"]), json.dumps(record), nx=True)
        raw = await redis_client.get(redis_room_key(room["code"]))
        if not raw:
            return load_room_record(record, room)
    return load_room_record(json.loads(raw), room)


async def get_room_shared(code: str) -> dict[str, Any]:
    normalized = code.upper()
    if redis_client:
        raw = await redis_client.get(redis_room_key(normalized))
        if not raw:
            record = read_room_record_snapshot(normalized)
            if record is None:
                raise HTTPException(status_code=404, detail="That room code was not found.")
            room = load_room_record(record, rooms.get(normalized))
            rooms[normalized] = room
            return room
        room = load_room_record(json.loads(raw), rooms.get(normalized))
        rooms[normalized] = room
        return room
    return get_room(normalized)


@asynccontextmanager
async def room_mutation_lock(room: dict[str, Any]):
    async with room["lock"]:
        distributed_lock = None
        try:
            if redis_client:
                distributed_lock = redis_client.lock(
                    "afterglow:room-lock:" + room["code"], timeout=30, blocking_timeout=10
                )
                if not await distributed_lock.acquire():
                    raise RuntimeError("The shared room lock timed out.")
                await refresh_room_from_redis(room)
                if await reconcile_stale_members(room):
                    room["version"] += 1
                    room["last_action_id"] = None
                    await publish_room(room)
                    await broadcast_snapshot(room)
            yield room
        finally:
            if distributed_lock:
                try:
                    await distributed_lock.release()
                except Exception:
                    pass


async def publish_room(room: dict[str, Any]) -> None:
    save_room(room)
    if not redis_client:
        return
    record = room_to_record(room)
    await redis_client.set(redis_room_key(room["code"]), json.dumps(record))
    await redis_client.publish(
        REDIS_EVENT_CHANNEL,
        json.dumps({"instance_id": INSTANCE_ID, "type": "snapshot", "room": record}),
    )


async def send_room_ended(room: dict[str, Any], sockets: list[WebSocket]) -> None:
    rooms.pop(room["code"], None)
    for socket in sockets:
        try:
            await socket.send_json({"type": "room.ended", "message": "The host ended this screening room."})
        except Exception:
            pass
        try:
            await socket.close(code=4001, reason="The host ended this screening room.")
        except Exception:
            pass


async def redis_event_listener() -> None:
    if not redis_client:
        return
    while True:
        pubsub = redis_client.pubsub()
        try:
            await pubsub.subscribe(REDIS_EVENT_CHANNEL)
            if redis_listener_ready:
                redis_listener_ready.set()
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                try:
                    event = json.loads(message.get("data") or "{}")
                except (TypeError, json.JSONDecodeError):
                    continue
                if event.get("instance_id") == INSTANCE_ID:
                    continue
                event_type = event.get("type")
                code = str(event.get("code") or (event.get("room") or {}).get("code") or "").upper()
                if not code:
                    continue
                if event_type == "snapshot" and isinstance(event.get("room"), dict):
                    record = event["room"]
                    room = rooms.get(code)
                    if room:
                        async with room["lock"]:
                            if int(record.get("version") or 0) >= room["version"]:
                                load_room_record(record, room)
                    else:
                        room = load_room_record(record)
                        rooms[code] = room
                    if int(record.get("version") or 0) >= room["version"]:
                        await broadcast_snapshot(room, record.get("last_action_id"))
                elif event_type == "ended":
                    room = rooms.pop(code, None)
                    sockets = list(connections.pop(code, {}).values())
                    if room:
                        room["ended"] = True
                    await send_room_ended(room or {"code": code}, sockets)
                elif event_type == "replace":
                    user_id = str(event.get("user_id") or "")
                    socket = connections.get(code, {}).pop(user_id, None)
                    if socket:
                        try:
                            await socket.close(code=4002, reason="This account joined from another tab or device.")
                        except Exception:
                            pass
                elif event_type == "rtc.signal":
                    target_id = str(event.get("target_id") or "")
                    socket = connections.get(code, {}).get(target_id)
                    if socket:
                        try:
                            await socket.send_json(event.get("payload") or {})
                        except Exception:
                            pass
            await asyncio.sleep(1)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Redis Pub/Sub is at-most-once; room snapshots remain stored in Redis.
            await asyncio.sleep(1)
        finally:
            try:
                await pubsub.unsubscribe(REDIS_EVENT_CHANNEL)
                await pubsub.aclose()
            except Exception:
                pass


async def delete_shared_room(code: str) -> None:
    delete_room_snapshot(code)
    if redis_client:
        await redis_client.delete(redis_room_key(code))
        await redis_client.publish(
            REDIS_EVENT_CHANNEL,
            json.dumps({"instance_id": INSTANCE_ID, "type": "ended", "code": code}),
        )


def restore_rooms() -> None:
    with database_lock:
        records = database.execute("SELECT payload FROM room_snapshots").fetchall()
    for row in records:
        try:
            record = json.loads(row["payload"])
            room = new_room(
                record["code"],
                record["host_id"],
                "Host",
                record.get("title") or "Late show",
                record.get("current_movie"),
            )
            room["members"] = {
                member["id"]: {**member, "connected": False}
                for member in record.get("members", [])
            }
            if room["host_id"] not in room["members"]:
                room["members"][room["host_id"]] = {
                    "id": room["host_id"],
                    "name": "Host",
                    "joined_at": time.time(),
                    "last_seen": time.time(),
                    "connected": False,
                }
            room["playback"] = record.get("playback") or room["playback"]
            room["playlist"] = record.get("playlist") or []
            room["chat"] = record.get("chat") or []
            room["poll"] = record.get("poll")
            room["version"] = int(record.get("version") or 1)
            room["screen_sharer"] = None
            room["video_members"] = set()
            room["last_action_id"] = record.get("last_action_id")
            room["seen_actions"] = set(record.get("seen_actions") or [])
            rooms[room["code"]] = room
        except (KeyError, TypeError, json.JSONDecodeError):
            continue


def current_position(room: dict[str, Any], now: float | None = None) -> float:
    playback = room["playback"]
    position = float(playback["position"])
    if playback["is_playing"]:
        position += max(0.0, (now or time.time()) - float(playback["updated_at"]))
    return max(0.0, position)


def room_snapshot(room: dict[str, Any]) -> dict[str, Any]:
    now = time.time()
    playback = room["playback"]
    position = current_position(room, now)
    duration = (room.get("current_movie") or {}).get("runtime_seconds")
    if duration:
        position = min(position, float(duration))
    return {
        "code": room["code"],
        "title": room["title"],
        "host_id": room["host_id"],
        "members": sorted(
            [
                {
                    key: member.get(key)
                    for key in ("id", "name", "joined_at", "last_seen", "connected")
                }
                for member in room["members"].values()
            ],
            key=lambda member: (not member.get("connected", False), member["joined_at"]),
        ),
        "current_movie": room["current_movie"],
        "playback": {
            "position": position,
            "is_playing": playback["is_playing"],
            "updated_at": playback["updated_at"],
        },
        "screen_sharer": room.get("screen_sharer"),
        "video_members": sorted(room.get("video_members", set())),
        "playlist": room["playlist"],
        "chat": room["chat"][-40:],
        "poll": room["poll"],
        "version": room["version"],
        "server_time": now,
    }


def get_room(code: str) -> dict[str, Any]:
    room = rooms.get(code.upper())
    if room is None:
        raise HTTPException(status_code=404, detail="That room code was not found.")
    return room


def clean_name(value: str) -> str:
    name = re.sub(r"\s+", " ", value).strip()
    return name[:28] or "Guest"


def clean_user_id(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "", value)[:48]
    return cleaned or secrets.token_urlsafe(12)


# Movie catalog and recommendations
def read_cached_catalog(cache_key: str, allow_stale: bool = False) -> list[dict[str, Any]] | None:
    with database_lock:
        row = database.execute(
            "SELECT payload, saved_at FROM catalog_cache WHERE cache_key = ?", (cache_key,)
        ).fetchone()
    if not row:
        return None
    if not allow_stale and time.time() - row["saved_at"] > 60 * 60 * 12:
        return None
    try:
        return json.loads(row["payload"])
    except json.JSONDecodeError:
        return None


def write_cached_catalog(cache_key: str, movies: list[dict[str, Any]]) -> None:
    with database_lock:
        database.execute(
            "INSERT OR REPLACE INTO catalog_cache(cache_key, payload, saved_at) VALUES (?, ?, ?)",
            (cache_key, json.dumps(movies), time.time()),
        )
        database.commit()


def omdb_request(params: dict[str, str]) -> dict[str, Any]:
    if not OMDB_API_KEY:
        raise RuntimeError("OMDb API key is not configured.")
    query = {**params, "apikey": OMDB_API_KEY}
    url = "https://www.omdbapi.com/?" + urllib.parse.urlencode(query)
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def normalize_omdb_movie(movie: dict[str, Any]) -> dict[str, Any]:
    title = movie.get("Title") or "Untitled film"
    year_text = str(movie.get("Year") or "")
    year_match = re.search(r"\b(\d{4})\b", year_text)
    genres = [
        name.strip() for name in str(movie.get("Genre") or "").split(",")
        if name.strip() and name.strip().casefold() != "n/a"
    ]
    genre_ids_by_name = {name.casefold(): genre_id for name, genre_id in GENRES.items()}
    genre_ids_by_name["sci-fi"] = GENRES["Science fiction"]
    genre_ids = list(dict.fromkeys(
        genre_ids_by_name[name.casefold()] for name in genres if name.casefold() in genre_ids_by_name
    ))
    rating_text = str(movie.get("imdbRating") or "")
    rating = float(rating_text) if re.fullmatch(r"\d+(?:\.\d+)?", rating_text) else None
    votes_text = re.sub(r"[^\d]", "", str(movie.get("imdbVotes") or ""))
    vote_count = int(votes_text) if votes_text else 0
    runtime_match = re.search(r"\d+", str(movie.get("Runtime") or ""))
    imdb_id = str(movie.get("imdbID") or "")
    poster = str(movie.get("Poster") or "")
    return {
        "id": "imdb-" + (imdb_id or re.sub(r"[^a-z0-9]+", "-", title.casefold()).strip("-")),
        "imdb_id": imdb_id or None,
        "title": title,
        "year": int(year_match.group(1)) if year_match else None,
        "overview": movie.get("Plot") if movie.get("Plot") not in {None, "N/A"} else "No synopsis is available yet.",
        "genre_ids": genre_ids,
        "genre_names": genres,
        "runtime": int(runtime_match.group()) if runtime_match else None,
        "poster_path": poster if poster.startswith(("https://", "http://")) and poster != "N/A" else None,
        "poster_theme": "violet",
        "vote_average": rating,
        "imdb_rating": rating,
        "vote_count": vote_count,
        "popularity": vote_count,
    }


def starter_for_title(title: str, year: int | None = None) -> dict[str, Any] | None:
    normalized = re.sub(r"[^a-z0-9]+", " ", title.casefold()).strip()
    return next((movie for movie in STARTER_MOVIES
                 if re.sub(r"[^a-z0-9]+", " ", movie["title"].casefold()).strip() == normalized
                 and (year is None or movie.get("year") == year)), None)


def merge_starter_details(movie: dict[str, Any]) -> dict[str, Any]:
    starter = starter_for_title(str(movie.get("title") or ""), movie.get("year"))
    if not starter:
        return movie
    merged = {**starter, **movie}
    if not movie.get("genre_ids"):
        merged["genre_ids"] = starter.get("genre_ids", [])
        merged["genre_names"] = starter.get("genre_names") or [
            GENRE_NAMES[value] for value in starter.get("genre_ids", []) if value in GENRE_NAMES
        ]
    if not movie.get("overview") or movie.get("overview") == "No synopsis is available yet.":
        merged["overview"] = starter.get("overview")
    merged["poster_theme"] = starter.get("poster_theme", "violet")
    return merged


async def fetch_omdb_movie(imdb_id: str) -> dict[str, Any]:
    cache_key = "omdb:movie:" + imdb_id
    cached = read_cached_catalog(cache_key)
    if cached:
        return cached[0]
    response = await asyncio.to_thread(omdb_request, {"i": imdb_id, "plot": "short"})
    if response.get("Response") == "False":
        raise RuntimeError(str(response.get("Error") or "OMDb could not find that film."))
    movie = merge_starter_details(normalize_omdb_movie(response))
    write_cached_catalog(cache_key, [movie])
    return movie


async def fetch_omdb_title(title: str, year: int | None) -> dict[str, Any]:
    cache_key = "omdb:title:" + re.sub(r"[^a-z0-9]+", "-", title.casefold()).strip("-") + ":" + str(year or "")
    cached = read_cached_catalog(cache_key)
    if cached:
        return cached[0]
    params = {"t": title, "plot": "short"}
    if year:
        params["y"] = str(year)
    response = await asyncio.to_thread(omdb_request, params)
    if response.get("Response") == "False":
        raise RuntimeError(str(response.get("Error") or "OMDb could not find that film."))
    movie = merge_starter_details(normalize_omdb_movie(response))
    write_cached_catalog(cache_key, [movie])
    imdb_id = movie.get("imdb_id")
    if imdb_id:
        write_cached_catalog("omdb:movie:" + str(imdb_id), [movie])
    return movie


async def fetch_omdb_seed_catalog() -> list[dict[str, Any]]:
    cache_key = "omdb:seed-catalog"
    cached = read_cached_catalog(cache_key)
    if cached is not None:
        return cached
    if not OMDB_DISCOVERY_TITLES:
        return STARTER_MOVIES

    # Validate the configured key with one request before starting the batch.
    first_title, first_year = OMDB_DISCOVERY_TITLES[0]
    first_movie = await fetch_omdb_title(first_title, first_year)
    semaphore = asyncio.Semaphore(5)

    async def fetch_limited(title: str, year: int) -> dict[str, Any] | None:
        async with semaphore:
            try:
                return await fetch_omdb_title(title, year)
            except (OSError, urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError):
                return None

    remaining = await asyncio.gather(*(
        fetch_limited(title, year) for title, year in OMDB_DISCOVERY_TITLES[1:]
    ))
    movies = [first_movie, *(movie for movie in remaining if movie)]
    if len(movies) < 8:
        raise RuntimeError("OMDb did not return enough film details to build the catalog.")
    write_cached_catalog(cache_key, movies)
    return movies


async def fetch_omdb_search(query: str) -> list[dict[str, Any]]:
    cache_key = "omdb:search:" + query.casefold().strip()
    results = read_cached_catalog(cache_key)
    if results is None:
        response = await asyncio.to_thread(omdb_request, {"s": query.strip(), "type": "movie", "page": "1"})
        if response.get("Response") == "False":
            error = str(response.get("Error") or "")
            if "api key" in error.casefold() or "limit" in error.casefold():
                raise RuntimeError(error)
            results = []
        else:
            results = response.get("Search", [])
        write_cached_catalog(cache_key, results)

    semaphore = asyncio.Semaphore(5)

    async def fetch_limited(item: dict[str, Any]) -> dict[str, Any]:
        imdb_id = str(item.get("imdbID") or "")
        if imdb_id:
            async with semaphore:
                try:
                    return await fetch_omdb_movie(imdb_id)
                except (OSError, urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError):
                    pass
        return merge_starter_details(normalize_omdb_movie(item))

    return await asyncio.gather(*(fetch_limited(item) for item in results[:10]))


def fuzzy_matches(movies: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    normalized = re.sub(r"[^a-z0-9]+", " ", query.casefold()).strip()
    if not normalized:
        return movies

    query_words = normalized.split()

    def match_score(movie: dict[str, Any]) -> float:
        title = re.sub(r"[^a-z0-9]+", " ", str(movie.get("title") or "").casefold()).strip()
        if normalized in title:
            return 1.0

        title_words = title.split()
        whole_title = difflib.SequenceMatcher(None, normalized, title).ratio()
        compact_title = difflib.SequenceMatcher(None, normalized.replace(" ", ""), title.replace(" ", "")).ratio()
        word_matches = []
        for query_word in query_words:
            if query_word in title_words:
                word_matches.append(1.0)
            elif len(query_word) <= 3:
                word_matches.append(0.0)
            else:
                word_matches.append(max(
                    (difflib.SequenceMatcher(None, query_word, title_word).ratio() for title_word in title_words),
                    default=0.0,
                ))
        title_word_score = sum(word_matches) / max(1, len(word_matches))
        title_score = max(whole_title, compact_title, title_word_score * 0.96)

        # Searching a phrase from the synopsis or a genre is useful too, but
        # title matches stay ahead of these looser contextual matches.
        context = " ".join([
            title,
            str(movie.get("overview") or "").casefold(),
            " ".join(str(name) for name in movie.get("genre_names", [])),
        ])
        context_score = 0.58 if normalized in context else 0.0
        return max(title_score, context_score)

    ranked = [(match_score(movie), movie) for movie in movies]
    return [movie for score, movie in sorted(ranked, key=lambda item: item[0], reverse=True) if score >= 0.44]


def recommend_for_room(movies: list[dict[str, Any]], room_code: str | None) -> list[dict[str, Any]]:
    genre_weights: dict[int, int] = {}
    positive_votes = 0
    if room_code:
        with database_lock:
            rows = database.execute(
                "SELECT genre_ids, vote FROM movie_votes WHERE room_code = ?",
                (room_code.upper(),),
            ).fetchall()
        for row in rows:
            if row["vote"] <= 0:
                continue
            positive_votes += 1
            for genre_id in json.loads(row["genre_ids"] or "[]"):
                genre_weights[int(genre_id)] = genre_weights.get(int(genre_id), 0) + 1

    scored: list[tuple[float, dict[str, Any]]] = []
    for original in movies:
        movie = dict(original)
        matches = [
            (genre_id, genre_weights[genre_id])
            for genre_id in movie.get("genre_ids", [])
            if genre_id in genre_weights
        ]
        taste_score = sum(weight for _, weight in matches)
        popularity = min(10.0, float(movie.get("popularity") or 0) / 20.0)
        movie["recommendation_score"] = round(taste_score * 2 + popularity * 0.2, 2)
        if positive_votes and matches:
            best_genre = max(matches, key=lambda match: match[1])[0]
            movie["recommendation_reason"] = "Leans into the room's " + GENRE_NAMES.get(best_genre, "top") + " picks"
        elif positive_votes:
            movie["recommendation_reason"] = "A different mood for your shortlist"
        else:
            movie["recommendation_reason"] = "A hand-picked starting point for tonight"
        scored.append((movie["recommendation_score"], movie))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [movie for _, movie in scored]


# API models and application lifecycle
class RoomCreate(BaseModel):
    demo: bool = False
    title: str = Field(default="A little Friday cinema club", max_length=60)


class RenameRoom(BaseModel):
    title: str = Field(min_length=1, max_length=60)


class ProfileUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=28)


class AccountCredentials(BaseModel):
    username: str = Field(min_length=3, max_length=24)
    password: str = Field(min_length=10, max_length=128)


class LoginCredentials(BaseModel):
    username: str = Field(min_length=1, max_length=24)
    password: str = Field(min_length=1, max_length=128)


class LiveKitTokenRequest(BaseModel):
    room_code: str = Field(min_length=4, max_length=8)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global redis_client, redis_listener_task, redis_listener_ready, redis_heartbeat_task
    initialize_database()
    restore_rooms()
    if REDIS_URL:
        try:
            import redis.asyncio as redis
        except ImportError as error:
            raise RuntimeError("REDIS_URL is set, but redis is missing. Install requirements.txt.") from error
        redis_client = redis.from_url(REDIS_URL, decode_responses=True)
        await redis_client.ping()
        await redis_client.set(redis_instance_key(), "online", ex=30)
        redis_heartbeat_task = asyncio.create_task(redis_instance_heartbeat())
        for code, room in list(rooms.items()):
            key = redis_room_key(code)
            raw = await redis_client.get(key)
            if raw:
                load_room_record(json.loads(raw), room)
            else:
                await redis_client.set(key, json.dumps(room_to_record(room)), nx=True)
        redis_listener_ready = asyncio.Event()
        redis_listener_task = asyncio.create_task(redis_event_listener())
        await redis_listener_ready.wait()
    yield
    if redis_listener_task:
        redis_listener_task.cancel()
        try:
            await redis_listener_task
        except asyncio.CancelledError:
            pass
        redis_listener_task = None
    if redis_heartbeat_task:
        redis_heartbeat_task.cancel()
        try:
            await redis_heartbeat_task
        except asyncio.CancelledError:
            pass
        redis_heartbeat_task = None
    if redis_client:
        await redis_client.delete(redis_instance_key())
        await redis_client.aclose()
        redis_client = None


# HTTP API
app = FastAPI(title="Watch Party", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/health")
async def health() -> dict[str, Any]:
    redis_status = "single-process"
    status = "ok"
    if redis_client:
        try:
            await redis_client.ping()
            redis_status = "redis"
            if redis_listener_task and redis_listener_task.done():
                redis_status = "redis-listener-stopped"
                status = "degraded"
        except Exception:
            redis_status = "redis-unavailable"
            status = "degraded"
    livekit_values = (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    livekit_configuration = "configured" if LIVEKIT_ENABLED else "partial" if any(livekit_values) else "not-configured"
    if livekit_configuration == "partial":
        status = "degraded"

    upload_status = "s3" if S3_ENABLED and S3_BUCKET else "local"
    if S3_ENABLED and not S3_BUCKET:
        upload_status = "s3-misconfigured"
        status = "degraded"
    if S3_ENABLED and bool(S3_ACCESS_KEY_ID) != bool(S3_SECRET_ACCESS_KEY):
        upload_status = "s3-misconfigured"
        status = "degraded"
    return {
        "status": status,
        "room_sharing": redis_status,
        "media_mode": "livekit-sfu" if LIVEKIT_ENABLED else "peer-mesh",
        "livekit_configuration": livekit_configuration,
        "upload_storage": upload_status,
    }


@app.get("/api/session")
async def session_info(request: Request, response: Response) -> dict[str, Any]:
    user = user_from_request(request)
    if user:
        return {"user": user}
    return {"user": create_guest(response, request)}


@app.get("/api/client-config")
async def client_config(response: Response) -> dict[str, str]:
    # KLIPY's sticker API is designed to be called directly by the browser.
    # Its app key is consequently public; it is never a server-side secret.
    response.headers["Cache-Control"] = "no-store"
    return {"klipy_app_key": KLIPY_APP_KEY}


@app.patch("/api/profile")
async def update_profile(payload: ProfileUpdate, request: Request) -> dict[str, Any]:
    require_same_origin(request)
    user = require_user(request)
    name = clean_name(payload.name)
    with database_lock:
        database.execute("UPDATE users SET display_name = ? WHERE id = ?", (name, user["id"]))
        database.commit()
    return {"user": {**user, "name": name}}


@app.post("/api/auth/register")
async def register_account(payload: AccountCredentials, request: Request) -> dict[str, Any]:
    require_same_origin(request)
    user = require_user(request)
    username = payload.username.strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,24}", username):
        raise HTTPException(status_code=400, detail="Use 3–24 letters, numbers, dots, underscores, or hyphens for your username.")
    if not user["is_guest"]:
        raise HTTPException(status_code=409, detail="This browser is already signed in.")
    if auth_attempt_count(request, "register", 60 * 60) >= 5:
        raise HTTPException(status_code=429, detail="Too many account attempts. Try again in an hour.")
    record_auth_attempt(request, "register")
    salt = secrets.token_bytes(16)
    digest = password_hash(payload.password, salt)
    try:
        with database_lock:
            database.execute(
                "UPDATE users SET username = ?, password_salt = ?, password_hash = ? WHERE id = ?",
                (username, salt, digest, user["id"]),
            )
            database.commit()
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="That username is already taken.") from error
    return {"user": {"id": user["id"], "name": user["name"], "username": username, "is_guest": False}}


@app.post("/api/auth/login")
async def login(payload: LoginCredentials, request: Request, response: Response) -> dict[str, Any]:
    require_same_origin(request)
    if auth_attempt_count(request, "login", 15 * 60) >= 8:
        raise HTTPException(status_code=429, detail="Too many sign-in attempts. Try again in 15 minutes.")
    username = payload.username.strip()
    with database_lock:
        row = database.execute(
            "SELECT id, display_name, username, password_salt, password_hash FROM users WHERE username = ?",
            (username,),
        ).fetchone()
    # Run the same expensive hash for unknown users to reduce username probing.
    salt = bytes(row["password_salt"]) if row and row["password_salt"] else bytes(16)
    expected = bytes(row["password_hash"]) if row and row["password_hash"] else bytes(32)
    valid = hmac.compare_digest(password_hash(payload.password, salt), expected)
    if not row or not row["password_hash"] or not valid:
        record_auth_attempt(request, "login")
        raise HTTPException(status_code=401, detail="Username or password is incorrect.")
    old_token = request.cookies.get(SESSION_COOKIE, "")
    if old_token:
        with database_lock:
            database.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_session_token(old_token),))
            database.commit()
    issue_session(response, request, row["id"])
    return {"user": {"id": row["id"], "name": row["display_name"], "username": row["username"], "is_guest": False}}


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response) -> dict[str, Any]:
    require_same_origin(request)
    token = request.cookies.get(SESSION_COOKIE, "")
    if token:
        with database_lock:
            database.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_session_token(token),))
            database.commit()
    return {"user": create_guest(response, request)}


@app.get("/api/rtc-config")
async def rtc_config(request: Request) -> dict[str, Any]:
    user = require_user(request)
    servers: list[dict[str, Any]] = [{"urls": "stun:stun.l.google.com:19302"}]
    if TURN_URLS and TURN_SHARED_SECRET:
        ttl = max(300, min(86400, int(os.getenv("TURN_CREDENTIAL_TTL", "3600"))))
        username = str(int(time.time()) + ttl) + ":" + user["id"]
        credential = base64.b64encode(
            hmac.new(TURN_SHARED_SECRET.encode("utf-8"), username.encode("utf-8"), hashlib.sha1).digest()
        ).decode("ascii")
        servers.append({"urls": TURN_URLS, "username": username, "credential": credential})
    return {"iceServers": servers, "media_mode": "sfu" if LIVEKIT_ENABLED else "mesh", "sfu_enabled": LIVEKIT_ENABLED}


@app.post("/api/livekit-token")
async def livekit_token(payload: LiveKitTokenRequest, request: Request) -> dict[str, str]:
    require_same_origin(request)
    user = require_user(request)
    if not LIVEKIT_ENABLED:
        raise HTTPException(status_code=503, detail="Group media is using peer-to-peer mode. Configure LiveKit to enable SFU calls.")
    room = await get_room_shared(payload.room_code)
    if user["id"] not in room["members"]:
        raise HTTPException(status_code=403, detail="Join the watch room before connecting media.")
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    claims = {
        "iss": LIVEKIT_API_KEY,
        "sub": user["id"],
        "name": user["name"],
        "nbf": now - 5,
        "exp": now + 300,
        "video": {
            "room": "afterglow-" + room["code"],
            "roomJoin": True,
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": False,
        },
    }
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode("utf-8")).rstrip(b"=").decode("ascii")
    unsigned = encode(header) + "." + encode(claims)
    signature = base64.urlsafe_b64encode(
        hmac.new(LIVEKIT_API_SECRET.encode("utf-8"), unsigned.encode("ascii"), hashlib.sha256).digest()
    ).rstrip(b"=").decode("ascii")
    return {"server_url": LIVEKIT_URL, "participant_token": unsigned + "." + signature}


@app.post("/api/rooms/{code}/media")
async def upload_room_media(
    code: str,
    request: Request,
    file: UploadFile = File(...),
) -> dict[str, Any]:
    require_same_origin(request)
    user = require_user(request)
    room = await get_room_shared(code)
    if room["host_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Only the host can upload a video to this room.")

    suffix = Path(file.filename or "").suffix.casefold()
    allowed_types = {".mp4": "video/mp4", ".webm": "video/webm"}
    if suffix not in allowed_types:
        raise HTTPException(status_code=415, detail="Choose an MP4 or WebM video file.")
    content_type = (file.content_type or "").split(";")[0].casefold()
    if content_type and content_type not in {allowed_types[suffix], "application/octet-stream"}:
        raise HTTPException(status_code=415, detail="The file type does not match an MP4 or WebM video.")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    media_id = secrets.token_hex(16) + suffix
    destination = UPLOAD_DIR / media_id
    total = 0
    try:
        with destination.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Videos must be 3 GB or smaller.")
                output.write(chunk)
    except HTTPException:
        destination.unlink(missing_ok=True)
        raise
    except OSError as error:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="The video could not be saved.") from error
    finally:
        await file.close()

    if total == 0:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="The selected video file is empty.")
    if S3_ENABLED:
        if not S3_BUCKET:
            destination.unlink(missing_ok=True)
            raise HTTPException(status_code=503, detail="S3 media storage is selected but S3_BUCKET is not configured.")
        try:
            client = get_s3_client()
            await asyncio.to_thread(
                client.upload_file,
                str(destination),
                S3_BUCKET,
                s3_media_key(media_id),
                ExtraArgs={"ContentType": allowed_types[suffix], "ContentDisposition": "inline"},
            )
        except Exception as error:
            destination.unlink(missing_ok=True)
            raise HTTPException(status_code=502, detail="The video could not be saved to object storage.") from error
        destination.unlink(missing_ok=True)
    return {
        "url": "/media/" + media_id,
        "name": Path(file.filename or "Shared video").name[:100],
        "size": total,
        "source_kind": "file",
    }


@app.get("/media/{media_id}", response_model=None)
async def stream_room_media(media_id: str) -> FileResponse | RedirectResponse:
    if not re.fullmatch(r"[a-f0-9]{32}\.(mp4|webm)", media_id):
        raise HTTPException(status_code=404, detail="Video not found.")
    media_type = "video/mp4" if media_id.endswith(".mp4") else "video/webm"
    if S3_ENABLED:
        if not S3_BUCKET:
            raise HTTPException(status_code=503, detail="S3 media storage is selected but S3_BUCKET is not configured.")
        try:
            client = get_s3_client()
            media_url = await asyncio.to_thread(
                client.generate_presigned_url,
                "get_object",
                Params={
                    "Bucket": S3_BUCKET,
                    "Key": s3_media_key(media_id),
                    "ResponseContentType": media_type,
                    "ResponseContentDisposition": "inline",
                },
                ExpiresIn=3600,
            )
        except Exception as error:
            raise HTTPException(status_code=502, detail="The video could not be opened from object storage.") from error
        return RedirectResponse(media_url, status_code=307, headers={"Cache-Control": "private, no-store"})
    path = UPLOAD_DIR / media_id
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Video not found.")
    return FileResponse(
        path,
        media_type=media_type,
        content_disposition_type="inline",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.post("/api/rooms")
async def create_room(payload: RoomCreate, request: Request) -> dict[str, Any]:
    require_same_origin(request)
    user = require_user(request)
    user_id = user["id"]
    name = user["name"]
    demo_movie = None
    if payload.demo:
        demo_movie = {
            "id": "demo-sample-video",
            "title": "Sample clip",
            "year": None,
            "overview": "A sample YouTube video to try synchronized playback with your watch party.",
            "genre_ids": [16, 28],
            "genre_names": ["Sample clip"],
            "runtime": None,
            "poster_path": None,
            "poster_theme": "rose",
            "source_url": "https://youtu.be/yVndvvCdvU4?si=L0iOdFUS68nKxjS6",
            "source_kind": "youtube",
            "youtube_id": "yVndvvCdvU4",
            "source_label": "Sample video",
        }
    while True:
        code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
        if code in rooms:
            continue
        room = new_room(code, user_id, name, clean_name(payload.title), demo_movie)
        if not redis_client:
            break
        reserved = await redis_client.set(
            redis_room_key(code), json.dumps(room_to_record(room)), nx=True
        )
        if reserved:
            break
    rooms[code] = room
    connections[code] = {}
    await publish_room(room)
    return {"room": room_snapshot(room), "invite_url": "/?room=" + code}


@app.get("/api/rooms/{code}")
async def read_room(code: str, request: Request) -> dict[str, Any]:
    require_user(request)
    return {"room": room_snapshot(await get_room_shared(code))}


@app.patch("/api/rooms/{code}")
async def rename_room(code: str, payload: RenameRoom, request: Request) -> dict[str, str]:
    require_same_origin(request)
    user = require_user(request)
    room = await get_room_shared(code)
    async with room_mutation_lock(room):
        if room["host_id"] != user["id"]:
            raise HTTPException(status_code=403, detail="Only the host can rename this room.")
        room["title"] = clean_name(payload.title)[:60]
        room["version"] += 1
        await publish_room(room)
    await broadcast_snapshot(room)
    return {"title": room["title"]}


@app.get("/api/catalog")
async def catalog(
    query: str = "",
    genre: str = "",
    category: str = "popular",
    room_code: str = "",
) -> dict[str, Any]:
    source = "starter collection"
    movies = STARTER_MOVIES
    api_error = None
    if refresh_omdb_api_key():
        try:
            movies = await fetch_omdb_seed_catalog()
            if query.strip():
                search_movies = await fetch_omdb_search(query)
                candidates = [*search_movies, *movies]
                seen_ids: set[str] = set()
                movies = []
                for movie in candidates:
                    movie_id = str(movie.get("imdb_id") or movie.get("id") or "")
                    if movie_id and movie_id not in seen_ids:
                        seen_ids.add(movie_id)
                        movies.append(movie)
            source = "OMDb"
        except (OSError, urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as error:
            api_error = "OMDb could not refresh the catalog. Showing saved picks instead."
            stale_seed = read_cached_catalog("omdb:seed-catalog", allow_stale=True)
            stale_search = read_cached_catalog("omdb:search:" + query.casefold().strip(), allow_stale=True) if query.strip() else []
            movies = [*(stale_search or []), *(stale_seed or STARTER_MOVIES)]
            source = "saved catalog" if stale_seed or stale_search else "starter collection"
            if not stale_seed and not stale_search:
                api_error = "OMDb could not load. Add a valid key or check your connection; showing the offline collection."
    if query.strip():
        movies = fuzzy_matches(movies, query)
    if genre:
        genre_id = next((value for name, value in GENRES.items() if name.casefold() == genre.casefold()), None)
        if genre_id is not None:
            movies = [movie for movie in movies if genre_id in movie.get("genre_ids", [])]
    if room_code:
        movies = recommend_for_room(movies, room_code)
    if category == "new":
        movies = sorted(movies, key=lambda movie: movie.get("year") or 0, reverse=True)
    elif category == "top":
        movies = sorted(
            movies,
            key=lambda movie: (movie.get("imdb_rating") or movie.get("vote_average") or 0, movie.get("vote_count") or movie.get("popularity") or 0),
            reverse=True,
        )
    elif category == "popular":
        movies = sorted(movies, key=lambda movie: movie.get("vote_count") or movie.get("popularity") or 0, reverse=True)
    elif category == "room" and not room_code:
        movies = sorted(movies, key=lambda movie: movie.get("vote_count") or movie.get("popularity") or 0, reverse=True)
    return {
        "movies": movies[:18],
        "source": source,
        "attribution": OMDB_ATTRIBUTION if source in {"OMDb", "saved catalog"} else None,
        "api_error": api_error,
    }


# Room actions and WebSocket connections
def save_movie_vote(room_code: str, user_id: str, movie: dict[str, Any], vote: int) -> None:
    with database_lock:
        database.execute(
            """INSERT OR REPLACE INTO movie_votes
               (room_code, user_id, movie_id, title, genre_ids, vote, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                room_code,
                user_id,
                str(movie.get("id") or ""),
                str(movie.get("title") or "Untitled"),
                json.dumps(movie.get("genre_ids") or []),
                vote,
                time.time(),
            ),
        )
        database.commit()


async def broadcast_snapshot(room: dict[str, Any], action_id: str | None = None) -> None:
    payload = {
        "type": "snapshot",
        "room": room_snapshot(room),
        "action_id": action_id if action_id is not None else room.get("last_action_id"),
    }
    stale: list[tuple[str, WebSocket]] = []
    for user_id, socket in list(connections.get(room["code"], {}).items()):
        try:
            await socket.send_json(payload)
        except Exception:
            stale.append((user_id, socket))
    for user_id, socket in stale:
        if connections.get(room["code"], {}).get(user_id) is socket:
            connections[room["code"]].pop(user_id, None)


async def end_room(room: dict[str, Any], user_id: str) -> tuple[bool, str | None]:
    code = room["code"]
    room_sockets: list[WebSocket] = []
    async with room_mutation_lock(room):
        if room.get("ended"):
            return True, None
        if room["host_id"] != user_id:
            return False, "Only the host can end this room."

        await delete_shared_room(code)
        room["ended"] = True
        rooms.pop(code, None)
        room_sockets = list(connections.pop(code, {}).values())
    await send_room_ended(room, room_sockets)
    return True, None


def safe_video_url(value: Any) -> str:
    url = str(value or "").strip()
    if len(url) > 2048:
        raise ValueError("That video link is too long.")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise ValueError("Use a direct http or https video link.")
    return url


async def apply_action(
    room: dict[str, Any],
    user_id: str,
    name: str,
    message: dict[str, Any],
) -> tuple[bool, str | None]:
    action = str(message.get("type") or "")
    action_id = str(message.get("action_id") or "")[:96]
    if action_id:
        key = user_id + ":" + action_id
        if key in room["seen_actions"]:
            return False, None
        room["seen_actions"].add(key)
        if len(room["seen_actions"]) > 4096:
            room["seen_actions"] = set(list(room["seen_actions"])[-2048:])

    if action in {"play", "pause", "seek", "movie.select"} and room["host_id"] != user_id:
        return False, "Only the host can control the shared screening."
    if action in {"play", "pause", "seek"} and (room.get("current_movie") or {}).get("source_kind") == "browser":
        return False, "A shared webpage has its own controls; use a video source for synchronized playback."
    now = time.time()
    playback = room["playback"]

    if action == "play":
        if (
            not room.get("current_movie")
            or not room["current_movie"].get("source_url")
            or room["current_movie"].get("source_kind") == "browser"
        ):
            return False, "Choose a playable video link before pressing play."
        playback["position"] = max(0.0, float(message.get("position", current_position(room, now))))
        playback["is_playing"] = True
        playback["updated_at"] = now
    elif action == "pause":
        playback["position"] = max(0.0, float(message.get("position", current_position(room, now))))
        playback["is_playing"] = False
        playback["updated_at"] = now
    elif action == "seek":
        playback["position"] = max(0.0, float(message.get("position", 0)))
        playback["updated_at"] = now
    elif action == "movie.select":
        movie = message.get("movie")
        if not isinstance(movie, dict):
            return False, "That movie selection was not valid."
        try:
            source_url = safe_video_url(movie.get("source_url"))
        except ValueError as error:
            return False, str(error)
        source_kind = str(movie.get("source_kind") or "url").casefold()
        if source_kind not in {"url", "youtube", "file", "browser"}:
            return False, "Choose a supported video source."
        parsed_source = urllib.parse.urlparse(source_url)
        if source_kind == "youtube":
            youtube_hosts = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"}
            video_id = urllib.parse.parse_qs(parsed_source.query).get("v", [""])[0]
            if parsed_source.hostname not in youtube_hosts or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                return False, "Choose a valid YouTube video URL."
        elif source_kind == "file":
            if not re.fullmatch(r"/media/[a-f0-9]{32}\.(mp4|webm)", parsed_source.path):
                return False, "Uploaded videos must use this room's file stream."
        elif source_kind == "browser" and parsed_source.scheme != "https" and parsed_source.hostname not in {"localhost", "127.0.0.1"}:
            return False, "Shared browser pages must use HTTPS."
        current_movie = {
            "id": str(movie.get("id") or "custom-video")[:100],
            "imdb_id": movie.get("imdb_id"),
            "imdb_rating": movie.get("imdb_rating"),
            "title": clean_name(str(movie.get("title") or "Untitled screening"))[:100],
            "year": movie.get("year"),
            "overview": str(movie.get("overview") or "")[:500],
            "genre_ids": movie.get("genre_ids") or [],
            "genre_names": movie.get("genre_names") or [],
            "runtime": movie.get("runtime"),
            "runtime_seconds": movie.get("runtime_seconds"),
            "poster_path": movie.get("poster_path"),
            "poster_theme": movie.get("poster_theme") or "violet",
            "source_url": source_url,
            "source_kind": source_kind,
            "source_label": str(movie.get("source_label") or "Shared video link")[:48],
        }
        room["current_movie"] = current_movie
        playback.update({"position": 0.0, "is_playing": False, "updated_at": now})
    elif action == "screen.start":
        transport = "sfu" if LIVEKIT_ENABLED and str(message.get("media_mode") or "").casefold() == "sfu" else "mesh"
        connected_count = sum(1 for member in room["members"].values() if member.get("connected"))
        if transport != "sfu" and connected_count > MAX_MESH_MEDIA_PARTICIPANTS:
            return False, "Screen sharing in a room this large needs the LiveKit SFU."
        if room.get("screen_sharer") not in {None, user_id}:
            return False, "Someone else is already sharing their screen."
        room["screen_sharer"] = user_id
    elif action == "screen.stop":
        if room.get("screen_sharer") != user_id:
            return False, "Only the person sharing can stop the screen share."
        room["screen_sharer"] = None
    elif action == "video.join":
        video_members = room.setdefault("video_members", set())
        transport = "sfu" if LIVEKIT_ENABLED and str(message.get("media_mode") or "").casefold() == "sfu" else "mesh"
        if user_id not in video_members and transport != "sfu" and len(video_members) >= MAX_MESH_MEDIA_PARTICIPANTS:
            return False, "Peer-to-peer video is limited to four people. Configure LiveKit for larger calls."
        video_members.add(user_id)
    elif action == "video.leave":
        room.setdefault("video_members", set()).discard(user_id)
    elif action == "playlist.add":
        movie = message.get("movie")
        if not isinstance(movie, dict):
            return False, "Choose a movie before adding it."
        movie_id = str(movie.get("id") or "")
        if not movie_id:
            return False, "That movie needs an ID before it can be added."
        if not any(item["id"] == movie_id for item in room["playlist"]):
            room["playlist"].append(
                {
                    "id": movie_id[:100],
                    "imdb_id": movie.get("imdb_id"),
                    "imdb_rating": movie.get("imdb_rating"),
                    "title": clean_name(str(movie.get("title") or "Untitled"))[:100],
                    "year": movie.get("year"),
                    "overview": str(movie.get("overview") or "")[:500],
                    "genre_ids": movie.get("genre_ids") or [],
                    "genre_names": movie.get("genre_names") or [],
                    "runtime": movie.get("runtime"),
                    "poster_path": movie.get("poster_path"),
                    "poster_theme": movie.get("poster_theme") or "violet",
                    "added_by": name,
                }
            )
    elif action == "playlist.remove":
        movie_id = str(message.get("movie_id") or "")
        room["playlist"] = [item for item in room["playlist"] if item["id"] != movie_id]
    elif action == "playlist.move":
        movie_id = str(message.get("movie_id") or "")
        delta = -1 if int(message.get("delta") or 0) < 0 else 1
        index = next((i for i, item in enumerate(room["playlist"]) if item["id"] == movie_id), None)
        if index is not None:
            new_index = max(0, min(len(room["playlist"]) - 1, index + delta))
            room["playlist"][index], room["playlist"][new_index] = (
                room["playlist"][new_index],
                room["playlist"][index],
            )
    elif action == "chat":
        text = re.sub(r"\s+", " ", str(message.get("text") or "")).strip()
        if not text:
            return False, None
        room["chat"].append(
            {
                "id": action_id or secrets.token_hex(8),
                "user_id": user_id,
                "name": name,
                "text": text[:500],
                "created_at": now,
            }
        )
        room["chat"] = room["chat"][-40:]
    elif action == "reaction":
        emoji = str(message.get("emoji") or "")
        if emoji not in {"❤️", "😂", "👏", "😮", "🍿", "✨", "🔥", "🥹", "🙌", "👀"}:
            return False, "That reaction is not supported."
        room["chat"].append(
            {
                "id": action_id or secrets.token_hex(8),
                "user_id": user_id,
                "name": name,
                "text": emoji,
                "reaction": True,
                "created_at": now,
            }
        )
        room["chat"] = room["chat"][-40:]
    elif action == "poll.create":
        title = clean_name(str(message.get("title") or "Choose our next film"))[:100]
        options = message.get("options") or []
        if not isinstance(options, list):
            return False, "Add at least two movie choices to the poll."
        choices = []
        for item in options[:4]:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            choices.append(
                {
                    "id": str(item["id"])[:100],
                    "imdb_id": item.get("imdb_id"),
                    "imdb_rating": item.get("imdb_rating"),
                    "title": clean_name(str(item.get("title") or "Untitled"))[:100],
                    "genre_ids": item.get("genre_ids") or [],
                    "genre_names": item.get("genre_names") or [],
                    "year": item.get("year"),
                    "poster_path": item.get("poster_path"),
                    "poster_theme": item.get("poster_theme") or "violet",
                    "votes": 0,
                }
            )
        if len(choices) < 2:
            return False, "Add at least two movies to the shared playlist first."
        room["poll"] = {
            "id": secrets.token_hex(6),
            "title": title,
            "options": choices,
            "votes": {},
            "closed": False,
            "created_by": name,
        }
    elif action == "poll.vote":
        poll = room.get("poll")
        option_id = str(message.get("option_id") or "")
        if not poll or poll["closed"]:
            return False, "There is no open poll to vote in."
        choice = next((item for item in poll["options"] if item["id"] == option_id), None)
        if choice is None:
            return False, "That poll option is no longer available."
        poll["votes"][user_id] = option_id
        for option in poll["options"]:
            option["votes"] = sum(1 for vote in poll["votes"].values() if vote == option["id"])
        save_movie_vote(room["code"], user_id, choice, 1)
    elif action == "poll.close":
        if room["host_id"] != user_id:
            return False, "Only the host can close this poll."
        if room.get("poll"):
            room["poll"]["closed"] = True
    elif action == "host.transfer":
        target_id = str(message.get("target_id") or "")
        if room["host_id"] != user_id:
            return False, "Only the current host can transfer host controls."
        if target_id not in room["members"] or not room["members"][target_id].get("connected"):
            return False, "That person is not currently in the room."
        room["host_id"] = target_id
    elif action == "room.title":
        if room["host_id"] != user_id:
            return False, "Only the host can rename the room."
        room["title"] = clean_name(str(message.get("title") or ""))[:60]
    elif action == "member.rename":
        room["members"][user_id]["name"] = clean_name(str(message.get("name") or name))
    else:
        return False, "That room action is not recognized."

    room["version"] += 1
    room["last_action_id"] = action_id or None
    await publish_room(room)
    return True, None


@app.websocket("/ws/rooms/{code}")
async def room_socket(websocket: WebSocket, code: str) -> None:
    origin = websocket.headers.get("origin")
    host = websocket.headers.get("host", "").casefold()
    if origin:
        parsed_origin = urllib.parse.urlparse(origin)
        if parsed_origin.netloc.casefold() != host or parsed_origin.scheme not in {"http", "https"}:
            await websocket.close(code=4403, reason="Origin not allowed")
            return
    user = user_from_token(websocket.cookies.get(SESSION_COOKIE, ""))
    if not user:
        await websocket.close(code=4401, reason="Sign in to join this room")
        return
    try:
        room = await get_room_shared(code)
    except HTTPException:
        await websocket.close(code=4404, reason="Room not found")
        return
    user_id = user["id"]
    name = user["name"]
    connection_id = secrets.token_hex(12)
    await websocket.accept()
    try:
        async with room_mutation_lock(room):
            if room.get("ended") or rooms.get(room["code"]) is not room:
                await websocket.close(code=4404, reason="Room not found")
                return
            connections.setdefault(room["code"], {})
            previous_socket = connections[room["code"]].get(user_id)
            if previous_socket and previous_socket is not websocket:
                try:
                    await previous_socket.close(code=4002, reason="This account joined from another tab or device.")
                except Exception:
                    pass
            existing = room["members"].get(user_id)
            if existing:
                existing["name"] = name
                existing["connected"] = True
                existing["last_seen"] = time.time()
                existing["connection_id"] = connection_id
                existing["connection_worker"] = INSTANCE_ID
            else:
                room["members"][user_id] = {
                    "id": user_id,
                    "name": name,
                    "joined_at": time.time(),
                    "last_seen": time.time(),
                    "connected": True,
                    "connection_id": connection_id,
                    "connection_worker": INSTANCE_ID,
                }
            connections[room["code"]][user_id] = websocket
            former_host = room["members"].get(room["host_id"])
            if room["host_id"] != user_id and former_host and not former_host.get("connected"):
                other_online = any(
                    member.get("connected") and member["id"] != user_id
                    for member in room["members"].values()
                )
                if not other_online:
                    room["host_id"] = user_id
            room["version"] += 1
            room["last_action_id"] = None
            await publish_room(room)
        if redis_client:
            await redis_client.publish(
                REDIS_EVENT_CHANNEL,
                json.dumps({"instance_id": INSTANCE_ID, "type": "replace", "code": room["code"], "user_id": user_id}),
            )
    except Exception:
        await websocket.close(code=1013, reason="Room state is temporarily unavailable.")
        return
    await broadcast_snapshot(room)
    try:
        while True:
            message = await websocket.receive_json()
            if room.get("ended"):
                break
            if message.get("type") == "ping":
                await websocket.send_json({"type": "pong", "client_time": message.get("client_time"), "server_time": time.time()})
                continue
            if message.get("type") == "room.end":
                ended, error = await end_room(room, user_id)
                if error:
                    await websocket.send_json({"type": "error", "message": error})
                if ended and not error:
                    break
                continue
            if message.get("type") == "rtc.signal":
                target_id = clean_user_id(str(message.get("target_id") or ""))
                channel = str(message.get("channel") or "")
                signal = message.get("signal")
                if redis_client:
                    await refresh_room_from_redis(room)
                target_socket = connections.get(room["code"], {}).get(target_id)
                authorized = (
                    channel == "video"
                    and user_id in room.get("video_members", set())
                    and target_id in room.get("video_members", set())
                ) or (
                    channel == "screen"
                    and room.get("screen_sharer") in {user_id, target_id}
                )
                if channel in {"video", "screen"} and authorized and isinstance(signal, dict):
                    if len(json.dumps(signal)) <= 64_000:
                        relay = {"type": "rtc.signal", "from_id": user_id, "channel": channel, "signal": signal}
                        if target_socket:
                            await target_socket.send_json(relay)
                        elif redis_client:
                            await redis_client.publish(
                                REDIS_EVENT_CHANNEL,
                                json.dumps({
                                    "instance_id": INSTANCE_ID,
                                    "type": "rtc.signal",
                                    "code": room["code"],
                                    "target_id": target_id,
                                    "payload": relay,
                                }),
                            )
                continue
            if message.get("type") == "member.rename":
                name = user["name"]
            async with room_mutation_lock(room):
                if room.get("ended"):
                    break
                changed, error = await apply_action(room, user_id, name, message)
                if error:
                    await websocket.send_json({
                        "type": "error",
                        "message": error,
                        "action_id": str(message.get("action_id") or "")[:96],
                    })
            if changed:
                await broadcast_snapshot(room, str(message.get("action_id") or ""))
    except WebSocketDisconnect:
        pass
    except Exception:
        # A malformed message should disconnect only that client, not the room.
        pass
    finally:
        should_broadcast = False
        try:
            async with room_mutation_lock(room):
                member = room["members"].get(user_id)
                is_current_connection = (
                    member is not None
                    and member.get("connection_id") == connection_id
                    and connections.get(room["code"], {}).get(user_id) is websocket
                )
                if not room.get("ended") and is_current_connection:
                    connections[room["code"]].pop(user_id, None)
                    member["connected"] = False
                    member["last_seen"] = time.time()
                    member.pop("connection_id", None)
                    member.pop("connection_worker", None)
                    if room["host_id"] == user_id:
                        online = [
                            item
                            for item in room["members"].values()
                            if item.get("connected") and item["id"] != user_id
                        ]
                        if online:
                            next_host = min(online, key=lambda item: item["joined_at"])
                            room["host_id"] = next_host["id"]
                    if room.get("screen_sharer") == user_id:
                        room["screen_sharer"] = None
                    room.setdefault("video_members", set()).discard(user_id)
                    room["version"] += 1
                    room["last_action_id"] = None
                    await publish_room(room)
                should_broadcast = not room.get("ended")
        except Exception:
            pass
        if should_broadcast:
            await broadcast_snapshot(room)


initialize_database()
restore_rooms()

