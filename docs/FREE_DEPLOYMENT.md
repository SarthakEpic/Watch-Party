# Put the demo online for free

This guide uses Render for the Python app, plus the LiveKit and S3-compatible services already configured for this project. The app has a Render Blueprint file at the project root: `render.yaml`.

## Before you begin

- You need a GitHub account and a Render account. Render's first-deploy guide says its free deployment flow does not require payment details.
- You need to put the project source in a GitHub repository so Render can build it. The repository may be private.
- Keep `.env`, `watch_party.sqlite3`, and `uploads/` out of GitHub. `.gitignore` already excludes them. Never paste secret values into chat or commit them to the repository.
- In this project folder, there is currently no GitHub repository connection. Render cannot deploy this folder directly from your computer until the source is pushed to GitHub.

## Step 1: Put the project on GitHub

The easiest route is GitHub Desktop:

1. Install GitHub Desktop from [desktop.github.com](https://desktop.github.com/) and sign in.
2. Choose **File → Add Local Repository** and select `D:\Projects\Watch Party`. If Desktop says the folder is not a repository yet, choose its option to create a repository in that folder.
3. Check the changed-files list before publishing. It must not contain `.env`, `watch_party.sqlite3`, `watch_party.sqlite3-shm`, `watch_party.sqlite3-wal`, or files from `uploads/`.
4. Commit the project files and publish the repository to GitHub. A private repository is fine.

You can also use the GitHub website's repository upload page, but take extra care not to upload `.env` or the SQLite database.

## Step 2: Create the free Render service

1. Sign in at [render.com](https://render.com/) and connect your GitHub account.
2. From the Render dashboard choose **New → Blueprint** and select the repository you just published.
3. Render reads `render.yaml` and prepares one Python web service on the **Free** plan. Check the plan before continuing.
4. When Render asks for environment values, copy the values for `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `OMDB_API_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` from your local `.env` into Render's secure form. Do this only in Render; do not send the values here or add them to GitHub.
5. For `S3_PREFIX`, keep `watchparty-media`. If you miss a secret during the first prompt, add it under the service's **Environment** page and save the change to redeploy.
6. Create the Blueprint and wait for the first deploy to finish. Render shows the public `https://....onrender.com` address on the service page.

The Blueprint intentionally does not configure `REDIS_URL`. One Render instance runs one app process, so Redis is not needed for its live room coordination. Your Upstash database can remain configured for local or future multi-worker use.

## Step 3: Check the deployed app

1. Open `https://YOUR-SERVICE.onrender.com/health`. Check that it reports `status: ok`, `media_mode: livekit-sfu`, and `upload_storage: s3`.
2. Open the main site in two separate browsers and create/join a room. Test playback controls and chat.
3. Join video chat from both browsers. Test a small upload, then play it from the room. Supabase Free currently has limited storage and data transfer, so use direct video links or YouTube for larger videos.
4. Watch the Render, LiveKit, and storage dashboards for usage. The free plans have caps; stay within them and do not enable a paid plan.

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
