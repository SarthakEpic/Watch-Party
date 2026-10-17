"""Measure local WebSocket room-control fan-out with independent clients."""

from __future__ import annotations

import argparse
import asyncio
import http.cookiejar
import inspect
import json
import time
import urllib.request
import uuid

import websockets


def new_session(base_url: str) -> tuple[urllib.request.OpenerDirector, str]:
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    with opener.open(base_url.rstrip("/") + "/api/session", timeout=5) as response:
        response.read()
    cookie = "; ".join(item.name + "=" + item.value for item in jar)
    return opener, cookie


def create_room(base_url: str) -> tuple[str, str]:
    opener, cookie = new_session(base_url)
    request = urllib.request.Request(
        base_url.rstrip("/") + "/api/rooms",
        data=json.dumps(
            {
                "title": "Local latency measurement",
                "demo": False,
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with opener.open(request, timeout=5) as response:
        result = json.loads(response.read().decode("utf-8"))
    return result["room"]["code"], cookie


def guest_cookie(base_url: str) -> str:
    _, cookie = new_session(base_url)
    return cookie


async def reader(socket, queue: asyncio.Queue) -> None:
    async for raw_message in socket:
        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError:
            continue
        await queue.put((message, time.perf_counter_ns()))


async def receive_action(queue: asyncio.Queue, action_id: str, timeout: float) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        remaining = max(0.01, deadline - time.monotonic())
        message, received_at = await asyncio.wait_for(queue.get(), timeout=remaining)
        if message.get("type") == "snapshot" and message.get("action_id") == action_id:
            return received_at
    raise TimeoutError("Did not receive action " + action_id + " before timeout.")


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))
    return ordered[index]


async def run(url: str, clients: int, actions: int, timeout: float) -> None:
    if clients < 2:
        raise SystemExit("Use at least 2 clients.")
    base = url.replace("ws://", "http://", 1).replace("wss://", "https://", 1)
    code, host_cookie = await asyncio.to_thread(create_room, base)
    socket_url = url.rstrip("/")
    sockets: list[websockets.ClientConnection] = []
    queues: list[asyncio.Queue] = []
    readers: list[asyncio.Task] = []
    samples_ms: list[float] = []
    try:
        for index in range(clients):
            cookie = host_cookie if index == 0 else await asyncio.to_thread(guest_cookie, base)
            full_url = socket_url + "/ws/rooms/" + code
            header_name = "additional_headers" if "additional_headers" in inspect.signature(websockets.connect).parameters else "extra_headers"
            socket = await websockets.connect(
                full_url,
                ping_interval=None,
                open_timeout=timeout,
                **{header_name: {"Cookie": cookie}},
            )
            queue: asyncio.Queue = asyncio.Queue()
            sockets.append(socket)
            queues.append(queue)
            readers.append(asyncio.create_task(reader(socket, queue)))

        # Drain the initial room snapshots so each measurement matches the
        # action ID sent by the host, rather than the join/presence updates.
        for queue in queues:
            await receive_snapshot(queue, timeout)

        for index in range(actions):
            action_id = "bench-" + str(index) + "-" + uuid.uuid4().hex[:8]
            outgoing = {
                "type": "seek",
                "action_id": action_id,
                "position": float(index % 10),
            }
            start_ns = time.perf_counter_ns()
            await sockets[0].send(json.dumps(outgoing))
            for queue in queues[1:]:
                received_ns = await receive_action(queue, action_id, timeout)
                samples_ms.append((received_ns - start_ns) / 1_000_000)

        p50 = percentile(samples_ms, 0.50)
        p95 = percentile(samples_ms, 0.95)
        p99 = percentile(samples_ms, 0.99)
        print("Local WebSocket playback-control propagation")
        print("Room code: " + code)
        print("Connected clients: " + str(clients))
        print("Actions: " + str(actions))
        print("Sender-to-recipient observations: " + str(len(samples_ms)))
        print("p50: " + format(p50, ".2f") + " ms")
        print("p95: " + format(p95, ".2f") + " ms")
        print("p99: " + format(p99, ".2f") + " ms")
        print("Target p95 <= 250 ms: " + ("PASS" if p95 <= 250 else "NOT MET"))
        print("Note: this loopback run measures server fan-out, not remote-network or video-decoder delay.")
    finally:
        for socket in sockets:
            await socket.close()
        for task in readers:
            task.cancel()
        if readers:
            await asyncio.gather(*readers, return_exceptions=True)


async def receive_snapshot(queue: asyncio.Queue, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        message, _ = await asyncio.wait_for(queue.get(), timeout=max(0.01, deadline - time.monotonic()))
        if message.get("type") == "snapshot":
            return
    raise TimeoutError("Did not receive the room snapshot before timeout.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="ws://127.0.0.1:8000", help="WebSocket base URL for the local app")
    parser.add_argument("--clients", type=int, default=10, help="Number of simultaneous WebSocket clients")
    parser.add_argument("--actions", type=int, default=30, help="Number of seek actions sent by the host")
    parser.add_argument("--timeout", type=float, default=5.0, help="Seconds to wait for each action")
    args = parser.parse_args()
    asyncio.run(run(args.url, args.clients, args.actions, args.timeout))


if __name__ == "__main__":
    main()
