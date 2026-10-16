# Performance and reliability notes

## Targets from the brief

- At least 10 simultaneous users in one room.
- Playback control propagation under 250 ms at p95 on a local network.
- Drift no greater than 500 ms after client correction.

## Measurement method

Run the app on one machine with:

    python -m uvicorn app:app --host 127.0.0.1 --port 8000

Then, in another terminal, run:

    python benchmark.py --url ws://127.0.0.1:8000 --clients 10 --actions 30

The script creates separate server-issued guest sessions for 10 independent WebSocket clients. One client sends 30 seek-control actions. For each action, it records the time from the sender's WebSocket send to receipt of that version by the other nine clients. The p95 is computed from those 270 sender-to-recipient observations. The script prints the actual percentiles; rerun it on the machine and network used for the interview.

This is a local loopback measurement: it measures Python server fan-out and local WebSocket delivery, not Wi-Fi variation, remote internet latency, or video hosting latency. HTML5 video is corrected above 500 ms drift. YouTube uses a 1.5 second threshold and a five second cooldown to avoid repeated iframe seeks interrupting its adaptive buffering. A YouTube stall with no detected progress for ten seconds gets one resume nudge; prolonged buffering still depends on the viewer's network, device, and YouTube's selected quality. Browser decoder and network buffering can affect visible video independently of control delivery.

## Results

Measured 2026-10-16 on Windows 11, Python 3.13.5, one Uvicorn worker bound to 127.0.0.1:

| Clients | Actions | Peer observations | p50 | p95 | p99 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 30 | 270 | 12.40 ms | 14.09 ms | 14.56 ms |

The measured local p95 is below the 250 ms target. This does not establish Wi-Fi or internet performance. HTML5 playback seeks to the server's current position when measured drift exceeds 500 ms. YouTube waits for at least 1.5 seconds of drift and limits automatic correction to one seek per five seconds. A real browser playback check is still needed for decoder and remote-source behavior; the WebSocket benchmark does not measure decoded-frame drift.

This result was recorded before server-issued sessions, optional Redis coordination, and the latest room actions. It has not yet been rerun against the current code; treat 14.09 ms as historical until a fresh run confirms the updated app.

## Failure handling

- If the OMDb request fails or times out, the app uses cached metadata when available and otherwise falls back to the local starter catalog. Movie data is not required for an existing watch room to stay open.
- If a participant's WebSocket closes, the browser reconnects and receives a new snapshot. The room retains disconnected members for the current session.
- If the host leaves while others are online, host controls pass to the earliest connected participant.
- Duplicate action IDs are ignored; concurrent room mutations are serialized with a per-room lock.
- If a media URL is blocked or unavailable to a participant, that participant sees a playback error and can reconnect or use a different accessible source. A webpage that blocks iframe embedding needs screen sharing instead.

## Current limits

Without Redis, room connections and state synchronization are process-local; run one worker. With Redis configured, multiple workers on one machine share room snapshots, distributed locks, WebSocket fan-out, and signaling. All workers still need the same local SQLite file. This multi-worker path has not been benchmarked. Multi-host coordination, a shared transactional database, email verification, recovery, MFA, moderation, and operational cleanup still need work before a public deployment.

The added YouTube, upload, screen-share, and camera paths have not been benchmarked as media pipelines. The 14.09 ms p95 number still applies only to WebSocket control-message delivery. See [STREAMING_AND_LATENCY.md](STREAMING_AND_LATENCY.md) for the per-source routes and deployment plan.
