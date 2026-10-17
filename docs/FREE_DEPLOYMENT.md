# Deploy a public demo on Render

This guide covers a single-instance Render deployment. Provider plans, limits, and dashboard labels can change, so check the linked provider documentation before deploying. The app uses SQLite for accounts and room data; this setup is intended for a demo, not durable production storage.

## Before you begin

- Put the project in a Git repository that Render can access.
- Create a Render account and choose a service plan that fits your use.
- Create accounts for optional services only if you need their features: OMDb for catalog data, LiveKit for larger media calls, and an S3-compatible provider for uploaded files.
- Keep credentials in your local `.env` file or the hosting provider's environment settings. Never commit `.env`, credentials, or local database files.

## 1. Create the web service

1. In the [Render dashboard](https://dashboard.render.com/), create a **Web Service** and connect the Git repository that contains this project.
2. Configure the service:

   - **Runtime:** Python
   - **Build command:** `pip install -r requirements.txt`
   - **Start command:** `uvicorn app:app --host 0.0.0.0 --port $PORT`
   - **Health check path:** `/health`

3. Choose a plan after reviewing Render's current [service limits and pricing](https://render.com/docs/free). The included [Blueprint](../render.yaml) provides the same build, start, and health-check settings.

## 2. Configure optional services

Add only the variables for services you intend to use. Enter credentials in Render's environment settings; do not upload the local `.env` file.

For private S3-compatible upload storage, set:

- `MEDIA_STORAGE=s3`
- `S3_PREFIX=watchparty-media`
- `S3_BUCKET`
- `S3_REGION`
- `S3_ENDPOINT_URL`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

For catalog metadata and stickers, set `OMDB_API_KEY` and `KLIPY_APP_KEY` respectively. For LiveKit media calls, set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. See [External services setup](EXTERNAL_SERVICES_SETUP.md) for provider-specific configuration.

Redis is not needed for a single app process. The current Redis coordination path supports multiple workers sharing one machine and one SQLite file; it does not make separate app instances share accounts or room data.

## 3. Deploy and verify

1. Create the service and wait for Render to report a successful deployment.
2. Open `https://YOUR-SERVICE.onrender.com/health`. Confirm `status` is `ok`. Configured services appear in the response; for example, LiveKit reports `media_mode: livekit-sfu` and S3 storage reports `upload_storage: s3`.
3. Open the site in two browsers. Create or join a room, test chat and playback controls, then test each optional media or upload feature that you configured.
4. Check the provider dashboards for errors and usage. Review plan limits and billing settings before sharing the deployment widely.

Deployment behavior depends on how the repository is connected. Check the service's deploy settings to see whether pushes deploy automatically or a manual deploy is required.

## Storage and availability limits

- The app stores accounts, sessions, room state, polls, and cached catalog data in SQLite. The project does not include a PostgreSQL adapter, so the database is not shared between independent Render instances.
- A Render filesystem may be temporary unless persistent storage is configured for the selected service plan. Data on a temporary filesystem can be lost during restarts or redeploys.
- S3-compatible storage keeps uploaded videos separate from the app filesystem. It does not store accounts or room state, and provider storage and transfer limits still apply.
- Hosting and media providers can sleep, restart, suspend, or limit services according to their current plans. Review the current [Render documentation](https://render.com/docs/free), [LiveKit quotas](https://docs.livekit.io/deploy/admin/quotas-and-limits/), and [storage pricing](https://supabase.com/pricing) before relying on the demo.

This setup does not provide durable multi-instance accounts or rooms. A production deployment needs a shared transactional database, persistent object storage, backups, monitoring, and tested media services.
