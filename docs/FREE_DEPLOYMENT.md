# Put the demo online for free

This guide uses Render for the Python app, plus the LiveKit and S3-compatible services already configured for this project. The repository is public, so you can deploy it by URL without connecting a GitHub account. The app also has a Render Blueprint file at the project root for people who use a linked Git provider.

## Before you begin

- You need a Render account. You can sign up with your Gmail address. Render's first-deploy guide says its free deployment flow does not require payment details.
- The project is already in this public repository: [SarthakEpic/Watch-Party](https://github.com/SarthakEpic/Watch-Party).
- Never paste secret values into chat or commit them to the repository. `.env`, `watch_party.sqlite3`, and `uploads/` are excluded from the pushed source.

## Step 1: Sign in to Render

1. Open [Render](https://dashboard.render.com/) and create an account or sign in with Gmail.
2. You do not need to connect a GitHub account for this public repository.

## Step 2: Create the web service from the public repository

1. In the Render dashboard click **New → Web Service**.
2. Under **Source Code**, choose **Public Git Repository**.
3. Paste `https://github.com/SarthakEpic/Watch-Party` and click **Connect**.
4. Enter these settings:

   - **Name:** `afterglow-watch-party` (or another available name)
   - **Branch:** `main`
   - **Language:** `Python 3`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn app:app --host 0.0.0.0 --port $PORT`
   - **Plan:** `Free`

5. Open **Advanced** and set the health check path to `/health`.

This public-repository option does not use the `render.yaml` Blueprint automatically, so enter the commands above in the form.

## Step 3: Enter the service settings privately

In the service form's environment-variable section, add:

- `MEDIA_STORAGE` = `s3`
- `S3_PREFIX` = `watchparty-media`
- `S3_BUCKET`
- `S3_REGION`
- `S3_ENDPOINT_URL`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `OMDB_API_KEY`
- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

For the nine keys without a preset value, copy each matching value from your local `.env` file directly into Render. Do not upload `.env` or send any key here. If the form does not show environment variables, create the service first, then add them under its **Environment** page and redeploy.

Do not add `REDIS_URL` for this setup. One Render instance runs one app process, so Redis is not needed for its live room coordination. Your Upstash database can remain configured for local or future multi-worker use.

## Step 4: Create and check the service

1. Click **Create Web Service** and wait for the deploy status to say **Live**. Render will show the public `https://....onrender.com` address on the service page.
2. Open `https://YOUR-SERVICE.onrender.com/health`. Check that it reports `status: ok`, `media_mode: livekit-sfu`, and `upload_storage: s3`.
3. Open the main site in two separate browsers and create/join a room. Test playback controls and chat.
4. Join video chat from both browsers. Test a small upload, then play it from the room. Supabase Free currently has limited storage and data transfer, so use direct video links or YouTube for larger videos.
5. Watch the Render, LiveKit, and storage dashboards for usage. The free plans have caps; stay within them and do not enable a paid plan.

Because you are using a public repository URL instead of a linked Git provider, Render will not deploy automatically when the repository changes. Use **Manual Deploy** in Render when you want to pull a later change.

## What the free deployment means

This makes the app publicly reachable, but it is a **demo**, not a reliable always-on service:

- Render sleeps after 15 minutes without incoming site or WebSocket traffic. The first visitor after it sleeps may wait about a minute for it to wake.
- Render's filesystem is temporary. The app uses SQLite for accounts, sessions, room state, polls, and its recommendation cache. Those local records disappear after a restart, redeploy, or sleep. People may need to sign in again and create a new room.
- Supabase object storage keeps uploaded media outside Render, but the free plan has limited storage/egress and the project can pause after a week with low database activity.
- LiveKit's free Build plan has a hard usage cap. Calls can stop accepting new sessions if the allowance is exhausted.
- Free service plans can restart or suspend service and do not include a production uptime guarantee. This is suitable for sharing a student project and collecting feedback, not promising uninterrupted service to the public.

The app currently has no PostgreSQL adapter. Moving its accounts and room database to a free cloud database requires a code change; a free Render Postgres database expires after 30 days, and using Supabase Postgres would require an adapter. Until that work exists, do not rely on this deployment to preserve accounts or rooms.

## Free-plan references

- [Render free services and limitations](https://render.com/docs/free)
- [Render's first deployment guide](https://render.com/docs/your-first-deploy)
- [Render WebSocket support](https://render.com/docs/websocket)
- [Supabase pricing](https://supabase.com/pricing)
- [Supabase project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [LiveKit Cloud quotas](https://docs.livekit.io/deploy/admin/quotas-and-limits/)
