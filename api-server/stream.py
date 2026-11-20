"""Live sensor stream for the Studio's Debug tab.

While a Studio has the stream open for a device, the telemetry reply tells
that device "live", and it sends raw sensors over UDP (port 8001) at 25 Hz:
    {"d": "<mac>", "t": <device ms>, "s": [mx, my, mz, ax, ay, az]}
Each packet is pushed straight to the open streams (server-sent events) as
[t, mx, my, mz, ax, ay, az], the same shape as a telemetry sensor sample.
"""

import asyncio
import json
import time

UDP_PORT = 8001
HOLD = 3.0  # s: keep saying "live" this long after the last viewer left

_subs: dict[str, set[asyncio.Queue]] = {}
_left: dict[str, float] = {}  # device -> when its last viewer left


class _Udp(asyncio.DatagramProtocol):
    def datagram_received(self, data: bytes, addr) -> None:
        try:
            p = json.loads(data)
            sample = [int(p["t"]), *(int(v) for v in p["s"])]
        except (ValueError, KeyError, TypeError):
            return
        for q in _subs.get(str(p.get("d")), ()):
            if q.qsize() < 500:  # a stalled viewer doesn't grow memory
                q.put_nowait(sample)


async def start() -> asyncio.DatagramTransport | None:
    loop = asyncio.get_running_loop()
    try:
        transport, _ = await loop.create_datagram_endpoint(_Udp, local_addr=("0.0.0.0", UDP_PORT))
    except OSError as e:  # another server already has the port (e.g. a second one for testing)
        print(f"Live sensor stream off: UDP port {UDP_PORT} unavailable ({e})")
        return None
    return transport


def wanted(device: str) -> bool:
    """Should this device stream? (asked from the telemetry handler)"""
    return bool(_subs.get(device)) or time.time() - _left.get(device, 0) < HOLD


async def events(device: str):
    """Server-sent events: one message per burst of samples, a comment every 2 s when idle."""
    q: asyncio.Queue = asyncio.Queue()
    _subs.setdefault(device, set()).add(q)
    try:
        yield "retry: 1000\n\n"
        while True:
            try:
                batch = [await asyncio.wait_for(q.get(), 2.0)]
            except asyncio.TimeoutError:
                yield ": idle\n\n"
                continue
            while not q.empty():
                batch.append(q.get_nowait())
            yield f"data: {json.dumps(batch, separators=(',', ':'))}\n\n"
    finally:
        _subs[device].discard(q)
        _left[device] = time.time()
