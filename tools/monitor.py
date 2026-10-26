#!/usr/bin/env python3
"""Live IMU/ADC monitor for the Pentomino game (stdlib only, no pip needed).

Connects to the same streamer as the game and mirrors the grip + twist
accumulator logic from PentominoGame.tsx, so you can see why a piece rotates
or "flies away" when you squeeze your fingers.

Usage:
    python3 tools/monitor.py                      # live view
    python3 tools/monitor.py --csv run.csv        # + log every sample to CSV
    python3 tools/monitor.py --step 90 --deadzone 45 --left

Keep TWIST_STEP / DEADZONE in sync with PentominoGame.tsx (TWIST_STEP_DEG,
TWIST_DEADZONE_DPS,
TWIST_DIFFICULTY, TWIST_SAMPLE_MS).
"""
import argparse, base64, csv, json, os, socket, struct, sys, time
from urllib.parse import urlparse

RAW_THR, NORM_THR, ADC_FULL = 2000, 12, 128  # same as config.ts / imuNormalize.ts


def ws_connect(url):
    u = urlparse(url)
    s = socket.create_connection((u.hostname, u.port or 80), timeout=5)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET {u.path or '/'} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\n"
               f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            raise ConnectionError("handshake failed")
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    if b" 101 " not in head.split(b"\r\n")[0]:
        raise ConnectionError(head.decode(errors="replace"))
    s.settimeout(None)
    return s, rest


def ws_messages(s, buf):
    def need(n):
        nonlocal buf
        while len(buf) < n:
            chunk = s.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            buf += chunk
        out, buf = buf[:n], buf[n:]
        return out

    msg = b""
    while True:
        b0, b1 = need(2)
        op, ln = b0 & 0x0F, b1 & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", need(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", need(8))[0]
        mask = need(4) if b1 & 0x80 else None
        data = need(ln)
        if mask:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        if op == 8:
            raise ConnectionError("closed by server")
        if op == 9:  # ping -> pong; pong musí vrátiť rovnaké dáta ako ping (RFC 6455), inak server po ~40 s spojenie zavrie
            pmask = os.urandom(4)
            s.sendall(bytes([0x8A, 0x80 | len(data)]) + pmask + bytes(b ^ pmask[i % 4] for i, b in enumerate(data)))
            continue
        msg += data
        if b0 & 0x80:  # FIN
            if op in (0, 1, 2):
                yield msg.decode(errors="replace")
            msg = b""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:5555/ws")
    ap.add_argument("--step", type=float, default=45.0, help="display only: snap boundary (acc is snapped to nearest 90°)")
    ap.add_argument("--deadzone", type=float, default=45.0, help="TWIST_DEADZONE_DPS")
    ap.add_argument("--difficulty", type=float, default=1.5, help="TWIST_DIFFICULTY")
    ap.add_argument("--sample-ms", type=float, default=100.0, help="TWIST_SAMPLE_MS")
    ap.add_argument("--idle-ms", type=float, default=700.0, help="TWIST_COMMIT_IDLE_MS")
    ap.add_argument("--left", action="store_true", help="left hand (no finger reverse)")
    ap.add_argument("--csv", help="write every sample to this CSV")
    ap.add_argument("--hz", type=float, default=15, help="screen refresh rate")
    a = ap.parse_args()

    s, rest = ws_connect(a.url)
    print(f"connected to {a.url}  step={a.step}° deadzone={a.deadzone}°/s  (Ctrl+C to stop)\n")

    csvf = csv.writer(open(a.csv, "w", newline="")) if a.csv else None
    if csvf:
        csvf.writerow(["t", "pitch", "roll", "yaw", "gx", "gy", "gz", "f0", "f1", "f2", "f3", "f4",
                       "pressed", "grip", "twist_acc"])

    prev_grip = False
    acc, grip, last_ts, last_draw, tw_ts, tw_active = 0.0, False, None, 0.0, 0.0, 0.0
    t0 = time.time()
    n, rate_t, rate_n, rate = 0, t0, 0, 0.0
    peak_acc, grip_start, grip_max_g = 0.0, 0.0, 0.0
    events = []
    win = []            # (t, |gx|, |gy|, |gz|) for the last 2 s
    ang = [0.0, 0.0, 0.0]  # integrated angle per axis while gripping (reset on grip start / key r)

    def log(msg):
        events.append(f"{time.time() - t0:7.2f}s  {msg}")
        del events[:-6]

    try:
        for raw in ws_messages(s, rest):
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            if not (m.get("kind") == "sample" or m.get("adc")):
                continue
            now = time.time()
            dt = max(0.001, now - last_ts) if last_ts else 0.0
            last_ts = now
            imu, adc = m.get("imu") or {}, m.get("adc") or []
            g = lambda k: float(imu.get(k) or 0)
            gx, gy, gz = g("gyroX"), g("gyroY"), g("gyroZ")  # already °/s (game uses divisor 1)

            fr = [float(v or 0) for v in adc[1:6]]
            fingers = fr if a.left else fr[::-1]
            pressed = [abs(v) > RAW_THR or abs(v) / ADC_FULL > NORM_THR for v in fingers]
            cnt = sum(pressed)
            now_grip = cnt == 5

            if now_grip and not grip:
                grip_start, peak_acc, grip_max_g = now, 0.0, 0.0
                log("GRIP start")
            elif grip and not now_grip:
                log(f"GRIP end  {now - grip_start:.2f}s  peak twist {peak_acc:+.0f}°  peak |gz| {grip_max_g:.0f}°/s")
            grip = now_grip

            win.append((now, abs(gx), abs(gy), abs(gz)))
            while win and now - win[0][0] > 2:
                win.pop(0)
            if grip and dt:
                ang[0] += gx * dt; ang[1] += gy * dt; ang[2] += gz * dt
            if grip and not prev_grip:
                ang[:] = [0.0, 0.0, 0.0]
            prev_grip = grip
            if grip:
                grip_max_g = max(grip_max_g, abs(gz))
                if (now - tw_ts) * 1000 >= a.sample_ms:
                    tw_dt = min(0.25, now - tw_ts)
                    if tw_ts > 0 and abs(gz) > a.deadzone:
                        acc = max(-270, min(270, acc + gz * tw_dt / a.difficulty))
                        tw_active = now
                    tw_ts = now
                    if acc != 0 and now - tw_active > a.idle_ms / 1000:
                        steps = round(acc / 90)
                        log(f"SNAP (pauza) acc={acc:+.0f}° -> {steps * 90:+d}°")
                        acc = 0.0
                if abs(acc) > abs(peak_acc):
                    peak_acc = acc
            else:
                if acc != 0:
                    log(f"SNAP (grip pustený) acc={acc:+.0f}° -> {round(acc / 90) * 90:+d}°")
                acc, tw_ts = 0.0, 0.0

            n += 1
            rate_n += 1
            if now - rate_t >= 1:
                rate, rate_t, rate_n = rate_n / (now - rate_t), now, 0

            if csvf:
                csvf.writerow([f"{now - t0:.3f}", g("pitch"), g("roll"), g("yaw"), gx, gy, gz,
                               *fingers, cnt, int(grip), f"{acc:.1f}"])

            if now - last_draw >= 1 / a.hz:
                last_draw = now
                bar_n = 20
                fill = int(min(1, abs(acc) / a.step) * bar_n)
                bar = "#" * fill + "-" * (bar_n - fill)
                fing = " ".join(f"{'█' if p else '·'}{abs(v):5.0f}" for p, v in zip(pressed, fingers))
                out = [
                    "\033[H\033[J",
                    f"samples {n}  rate {rate:4.0f} Hz   hand={'L' if a.left else 'R'}",
                    f"angles  pitch {g('pitch'):7.1f}  roll {g('roll'):7.1f}  yaw {g('yaw'):7.1f}",
                    f"gyro    x {gx:7.1f}  y {gy:7.1f}  z {gz:7.1f} °/s  {'(inside deadzone)' if abs(gz) <= a.deadzone else '(COUNTS)'}",
                    f"fingers {fing}   pressed {cnt}/5",
                    f"grip    {'YES' if grip else 'no '}   twist acc {acc:+7.1f}° / ±{a.step:.0f}°  [{bar}]",
                    f"axis    peak |g| last 2s:  x {max((w[1] for w in win), default=0):6.0f}   y {max((w[2] for w in win), default=0):6.0f}   z {max((w[3] for w in win), default=0):6.0f}   <- biggest = axis you are moving",
                    f"        angle this grip (°):  x {ang[0]:7.0f}   y {ang[1]:7.0f}   z {ang[2]:7.0f}",
                    f"        peak this grip {peak_acc:+.0f}°   peak |gz| {grip_max_g:.0f}°/s",
                    "", "events:", *events,
                ]
                sys.stdout.write("\n".join(out) + "\n")
                sys.stdout.flush()
    except KeyboardInterrupt:
        print("\nstopped")
    except (ConnectionError, OSError) as e:
        print(f"\nconnection lost: {e}")


if __name__ == "__main__":
    main()
