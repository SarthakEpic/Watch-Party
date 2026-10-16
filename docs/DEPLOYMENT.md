# Optional services and deployment

The project is useful locally with no provider credentials. Add a service only when you want its capability. Keep all secrets in the server's `.env` file; never put them in `static/` or browser JavaScript. Restart Uvicorn after changing server settings.

For a single checklist to set up LiveKit Cloud, Upstash Redis, and Cloudflare R2 together, see [EXTERNAL_SERVICES_SETUP.md](EXTERNAL_SERVICES_SETUP.md). LiveKit Cloud supplies managed TURN for LiveKit calls, so a separate coturn server is not needed in that setup.

## Reliable WebRTC paths with TURN

STUN helps browsers find a direct path. TURN relays media when the network blocks that path. The app can issue short-lived coturn REST credentials when both `TURN_URLS` and `TURN_SHARED_SECRET` are set.

1. Run a TURN server on a public host with a stable DNS name. Coturn's sample configuration documents the shared-secret mode; open the configured listener and relay UDP port range in the host firewall.
2. Generate a long random secret and use the same value as coturn's `static-auth-secret` and this server's `TURN_SHARED_SECRET`.
3. Add values like these to the app's `.env`, replacing the example hostname and secret:

   ```dotenv
   TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
   TURN_SHARED_SECRET=replace_with_the_same_long_random_secret_as_coturn
   TURN_CREDENTIAL_TTL=3600
   ```

4. Restart the app and click **Join video chat** from two different networks. A TURN server relays camera/screen media; it does not improve movie-CDN or YouTube buffering.

Credentials are generated per signed-in session with an expiry and an HMAC signature. Without these settings, the mesh uses public STUN only and some restrictive networks cannot connect.

## Larger media rooms with a LiveKit SFU

Peer mesh sends a separate media copy from each participant to every other participant. That is suitable for a small call but grows with the number of peers. LiveKit's SFU receives one published stream and forwards it to subscribers.

1. Create a LiveKit Cloud project or run a LiveKit server. Copy its WebSocket URL, API key, and API secret from the service dashboard.
2. Add them to the server `.env`:

   ```dotenv
   LIVEKIT_URL=wss://your-project.livekit.cloud
   LIVEKIT_API_KEY=your_server_side_api_key
   LIVEKIT_API_SECRET=your_server_side_api_secret
   ```

3. Restart Afterglow. The server returns a five-minute, room-scoped token after checking the user's app session and room membership. The API secret stays on the server. When all three settings are present, video chat and screen share use LiveKit; otherwise they use peer mesh.
4. Test with three or more browsers. Check the LiveKit dashboard for the room and participants. Movie playback remains direct from YouTube or each browser's media URL; the SFU carries only live camera/screen media.

The browser downloads the pinned LiveKit JavaScript client from jsDelivr only when SFU mode is enabled. If the service or SDK cannot connect, video chat does not connect; playback, room controls, and text chat remain available. LiveKit setup and egress costs depend on the selected hosting plan.

## Store uploads away from this computer

Local storage is the default. To store uploaded videos in a private AWS S3 bucket or an S3-compatible service, install requirements and set:

```dotenv
MEDIA_STORAGE=s3
S3_BUCKET=your-private-bucket
S3_REGION=your-bucket-region
S3_PREFIX=afterglow-media
```

For AWS, provide credentials through the standard AWS credential chain, preferably a restricted instance role in a deployment. For an S3-compatible service, set `S3_ENDPOINT_URL`; you can provide its credentials with `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Grant only object read/write access to the configured prefix, keep the bucket private, and enable HTTPS. After upload, Afterglow returns a short-lived presigned download URL through its media route. S3 egress and storage may cost money.

If `MEDIA_STORAGE` is unset and `S3_BUCKET` is empty, files remain in `uploads/` on this machine. Existing local uploads do not move automatically when storage mode changes.

## Multiple workers on one machine

One worker remains the simplest local setup. When REDIS_URL is empty, active room coordination is process-local; use one worker. To use multiple workers on the same machine, run Redis and set REDIS_URL in .env. For hosted Redis such as Upstash, use its TLS URL (`rediss://...`):

    REDIS_URL=redis://127.0.0.1:6379/0

Install the project requirements, then start without --reload:

    python -m uvicorn app:app --host 0.0.0.0 --port 8000 --workers 4

Workers use Redis snapshots for canonical room state, a per-room distributed lock to serialize changes, and Pub/Sub to fan out snapshots, WebRTC signaling, and room-end events. Room snapshots are also saved in SQLite; a join or action can repopulate a missing Redis key from that copy. Pub/Sub is at-most-once, so a reconnect or the next room mutation retrieves the latest snapshot after a missed event. Short worker leases let the next room mutation clear presence left by a crashed worker. The health route reports whether Redis is reachable.

All workers must use the same project folder and SQLite database file on the same machine. SQLite WAL and a busy timeout allow the local workers to share that file. This is an optional multi-process path, not validated production infrastructure; do not put SQLite on a network filesystem or use this setup across multiple hosts. Redis alone does not share accounts, poll votes, or uploads across machines. Multi-host deployment needs a real shared transactional database such as PostgreSQL and a shared object store; those adapters are not implemented.

Accounts are local to the database and currently have hashed passwords, HTTP-only sessions, and basic per-IP attempt limits. They still have no email verification, password reset, MFA, or account recovery. Before public internet use, add those recovery and abuse controls, HTTPS, backups, monitoring, moderation, and retention limits. The webpage source remains a normal iframe; the app does not run remote Chromium or synchronize a remote browser session.

## Measure what changed

The included `benchmark.py` measures room-control WebSocket fan-out only. Run it on the server for a loopback measurement:

```powershell
python benchmark.py --url ws://127.0.0.1:8000 --clients 10 --actions 30
```

For a LAN result, run the same command from another computer using the server's LAN address. Save the date, host/client hardware, Wi-Fi or Ethernet, server address, client count, action count, and p50/p95/p99. This still does not measure video smoothness, startup delay, YouTube buffering, or WebRTC glass-to-glass latency. To measure call quality, record browser WebRTC stats and the LiveKit dashboard metrics under the actual call conditions.

## Provider references

- [coturn shared-secret configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)
- [LiveKit tokens and grants](https://docs.livekit.io/home/server/generating-tokens)
- [LiveKit JavaScript client SDK](https://docs.livekit.io/reference/client-sdk-js/)
- [Boto3 presigned S3 URLs](https://docs.aws.amazon.com/boto3/latest/guide/s3-presigned-urls.html)
