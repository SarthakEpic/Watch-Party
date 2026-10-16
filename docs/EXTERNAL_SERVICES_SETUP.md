# Set up LiveKit, Redis, and cloud file storage

This guide prepares Afterglow to use all three hosted services. The app reads their settings from the server-side `.env` file. Keep the file private, do not put secrets in browser code, and do not send the secret values in chat.

## What each service does

- **LiveKit Cloud** carries camera and screen-share video through an SFU. LiveKit Cloud also provides managed TURN relay ([connection docs](https://docs.livekit.io/intro/basics/connect/)), so you do not need a separate coturn account/server while using it.
- **Upstash Redis** shares room state and WebSocket events between multiple FastAPI workers on the same machine. It does not improve movie playback or YouTube buffering.
- **Cloud storage** stores uploaded MP4/WebM files outside this computer. Afterglow keeps the bucket private and creates temporary download links. Supabase Storage is the suggested free option if you cannot provide payment details; local storage remains available with no account.

The movie itself still comes from its source. YouTube videos are streamed separately by each viewer's browser; these services cannot make YouTube's network deliver video faster.

## 1. Create the LiveKit project

1. Create a project in [LiveKit Cloud](https://cloud.livekit.io/).
2. In the project dashboard, copy its server URL, API key, and API secret.
3. Keep the API secret private. The app uses it on the server to sign short-lived room tokens.
   LiveKit project setup uses those three values to connect to a deployment ([LiveKit project docs](https://docs.livekit.io/reference/developer-tools/livekit-cli/projects/)).

## 2. Create the Upstash Redis database

1. Create a Redis database in the [Upstash Console](https://console.upstash.com/), choosing a region close to the computer/server that will run Afterglow.
2. Copy the TLS connection string from the database details. Upstash shows this as `rediss://...` ([Upstash connection troubleshooting](https://upstash.com/docs/redis/troubleshooting/no_auth)).
3. Redis is useful when Afterglow runs more than one Uvicorn worker. All workers must still share this same computer's SQLite database file. It is not a multi-server database setup.

## 3. Choose where uploaded files will be stored

### Option A: Supabase Storage Free

Supabase provides an S3-compatible endpoint, so the app can use the same upload and playback flow as R2. The current Free plan includes 1 GB of file storage and 5 GB of egress; free projects pause after one week without activity. This is suitable for a small demo, but video playback can use the egress allowance quickly. Check the [current Supabase pricing](https://supabase.com/pricing) before signing up.

1. Create an account at [Supabase](https://supabase.com/) and create a project on the Free plan. If the signup flow asks you to add a payment method and you cannot provide one, stop there and use Option C below; do not upgrade.
2. In the project, open **Storage** and create a bucket named `afterglow-media`. Keep it **private**.
3. In the Storage settings, enable the **S3 protocol** connection. Create an S3 access key and secret, then copy the endpoint and region shown there. Save the secret somewhere private; Supabase only shows it once. These credentials are server-only and grant broad access to storage, so never put them in HTML/JavaScript or send them in chat. See [Supabase S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication).
4. Keep the project on the Free plan. Do not enter billing details or enable a paid plan just to use the demo.

### Option B: Cloudflare R2

Use this only if you can complete Cloudflare's account/payment setup. If Cloudflare asks for card or UPI details, skip it and use Supabase Free or local storage.

1. In [Cloudflare R2](https://developers.cloudflare.com/r2/get-started/s3/), create an R2 bucket. Leave public bucket access disabled.
2. Create S3 API credentials scoped to this bucket with permission to read and write objects. Copy the access key ID and secret access key when they are shown; the secret may only be displayed once.
3. Find the Cloudflare account ID. The S3 endpoint is `https://ACCOUNT_ID.r2.cloudflarestorage.com`.
4. Existing uploads in the local `uploads/` folder do not move automatically. Upload them again after enabling R2 if you need them in the bucket.

Cloudflare's current R2 authentication instructions say R2 must be activated/purchased before creating S3 API credentials. Check [current R2 pricing](https://developers.cloudflare.com/r2/pricing/) before enabling it.

### Option C: Keep uploads on this computer

This needs no external account or payment details. Leave `MEDIA_STORAGE` unset (or set it to `local`) and leave `S3_BUCKET` empty. Uploaded files stay in the project's local `uploads/` folder and are only available while this app runs on this computer.

## 4. Add the settings to `.env`

Open the existing `.env` in a text editor and add the following settings, replacing every example value with the value from the matching provider. Keep any settings already in the file. Do not copy this example over the whole file, because that could remove your other keys.

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret

REDIS_URL=rediss://default:your-password@your-database.upstash.io:6379

MEDIA_STORAGE=s3
S3_BUCKET=afterglow-media
S3_REGION=copy-the-region-shown-by-your-provider
S3_PREFIX=watchparty-media
S3_ENDPOINT_URL=https://your-project.storage.supabase.co/storage/v1/s3
S3_ACCESS_KEY_ID=your-s3-access-key-id
S3_SECRET_ACCESS_KEY=your-s3-secret-access-key
```

The example above is for **Supabase**. Copy the endpoint and region exactly from Supabase's S3 settings. If you chose **R2**, use your R2 bucket name, set `S3_REGION=auto`, set `S3_ENDPOINT_URL=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com`, and use your R2 access keys instead. Choose one provider only. Do not replace the other settings already in `.env`.

When using LiveKit Cloud, leave `TURN_URLS` and `TURN_SHARED_SECRET` unset. LiveKit Cloud supplies the TURN relay for its calls. Those two settings are only for a separately operated coturn server when using the app's peer-to-peer mesh mode.

## 5. Restart and check the app

Install dependencies if needed:

```powershell
pip install -r requirements.txt
```

Stop the current server with `Ctrl+C`. Start four workers so Redis is sharing room coordination between processes:

```powershell
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --workers 4
```

Do not use `--reload` with this multi-worker command. To go back to simple one-worker development, stop it and run `python -m uvicorn app:app --reload` instead; Redis is not needed for that mode.

Open `http://127.0.0.1:8000/health`. With all settings accepted, the response should report:

- `room_sharing`: `redis`
- `media_mode`: `livekit-sfu`
- `livekit_configuration`: `configured`
- `upload_storage`: `s3`

The health response confirms the selected configuration. It does not prove that LiveKit can connect from every network or that storage credentials have bucket permissions. Verify those by joining a call from two browsers and uploading then playing a small MP4/WebM. The Redis status checks the database connection.

## What this setup does not provide

- Redis plus SQLite supports workers on one machine. For multiple app servers, the project still needs a shared transactional database such as PostgreSQL; that adapter is not implemented.
- LiveKit only carries camera and screen-share media. It does not proxy YouTube or improve YouTube buffering.
- Object storage stores uploaded files but does not transcode them or change their quality. The current upload limit remains 500 MB. Supabase Free has a 1 GB storage and 5 GB egress allowance, so use small test videos and monitor usage.
- A public deployment still needs HTTPS for the app, backups, usage limits, and service billing/usage monitoring.
