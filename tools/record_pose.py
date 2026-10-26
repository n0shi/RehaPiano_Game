#!/usr/bin/env python3
"""Запис руху рукавиці в двох позах (звичайна і перевернута на 90°) з автоматичним аналізом.

    python3 tools/record_pose.py [--url ws://127.0.0.1:5555/ws] [--left]

Усе йде САМЕ за таймером (ENTER не потрібен): перед кожним кроком 3 с підготовки з текстом інструкції,
потім звуковий сигнал і запис. Ctrl+C у будь-який момент = зупинитись і зберегти те, що вже є.

Надійність:
  * кожна вибірка одразу пишеться на диск (samples.jsonl), нічого не губиться при збої;
  * якщо стрімер розірве з'єднання, скрипт сам перепідключиться і напише про це;
  * будь-яка помилка з повним трасуванням іде в run.log; аналіз у кінці виконується окремо від запису.

Результат: tools/recordings/pose_<час>/{samples.jsonl, run.log, analysis.json, analysis.txt}
Після завершення просто скажи "done" і шлях до теки.
"""
import argparse, json, math, os, sys, threading, time, traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from monitor import ws_connect, ws_messages  # noqa: E402

PREP_S = 3.0
DIRS = [("right", "ВПРАВО"), ("left", "ВЛІВО"), ("up", "ВГОРУ"), ("down", "ВНИЗ")]


def pose_steps(p, pose):
    out = [
        (f"{p}_rest", 5, f"{pose}: рука НЕРУХОМО, пальці розслаблені."),
        (f"{p}_grip", 4, f"{pose}: стисни ВСІ пальці в кулак і тримай НЕРУХОМО (це 'рекалібрація')."),
    ]
    for d, label in DIRS:
        out.append((f"{p}_{d}", 9, f"{pose}: нахили кисть {label} так, як хочеш щоб рухався курсор. "
                                    f"Дійди до краю, затримайся ~1 с, поверни в центр. 3 рази."))
    out.append((f"{p}_circle", 9, f"{pose}: повільно намалюй нахилом кисті коло, 2-3 рази."))
    return out


STEPS = (
    pose_steps("A", "ПОЗА A (звичайна)")
    + [("turn", 8, "ПЕРЕВЕРНИ рукавицю на ~90° (повільно, як там, де ламається логіка) і тримай нерухомо в кінці.")]
    + pose_steps("B", "ПОЗА B (перевернута на 90°)")
)


# ---------- математика (лише stdlib) ----------
def qmul(a, b):
    return (a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3], a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],
            a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1], a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0])


def qconj(q):
    return (q[0], -q[1], -q[2], -q[3])


def qrot(q, v):
    return qmul(qmul(q, (0.0, *v)), qconj(q))[1:]


def num(d, k):
    try:
        v = d.get(k)
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def up_vector(imu):
    """Одиничний вектор 'вгору' в осях сенсора: з кватерніона, інакше з gravX/Y/Z (перевірено, що вони збігаються)."""
    w, x, y, z = (num(imu, k) for k in ("quatW", "quatX", "quatY", "quatZ"))
    if None not in (w, x, y, z):
        n = math.sqrt(w*w + x*x + y*y + z*z)
        if n > 1e-6:
            return qrot(qconj((w/n, x/n, y/n, z/n)), (0.0, 0.0, 1.0))
    g = [num(imu, k) for k in ("gravX", "gravY", "gravZ")]
    if None not in g:
        n = math.sqrt(sum(c*c for c in g))
        if n > 1e-6:
            return tuple(c/n for c in g)
    return None


def wrap180(a):
    while a > 180:
        a -= 360
    while a < -180:
        a += 360
    return a


def angles(u):
    """roll = кут вектора 'вгору' у площині X/Y сенсора (°), elev = нахил осі Z до горизонту (°), xy = довжина проєкції на X/Y."""
    return math.degrees(math.atan2(u[1], u[0])), math.degrees(math.asin(max(-1, min(1, u[2])))), math.hypot(u[0], u[1])


def beep():
    sys.stdout.write("\a")
    sys.stdout.flush()


# ---------- запис ----------
class Recorder:
    def __init__(self, url, outdir):
        self.url = url
        self.outdir = outdir
        self.lock = threading.Lock()
        self.step = None
        self.last = None
        self.count = 0
        self.stop = False
        self.samples = open(os.path.join(outdir, "samples.jsonl"), "a", buffering=1)
        self.log_f = open(os.path.join(outdir, "run.log"), "a", buffering=1)

    def log(self, msg):
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        self.log_f.write(line + "\n")
        return line

    def say(self, msg):
        print(self.log(msg), flush=True)

    def reader(self):
        """Читає стрімер; при обриві перепідключається. Працює у фоні до stop."""
        attempt = 0
        while not self.stop:
            try:
                s, rest = ws_connect(self.url)
                if attempt:
                    self.say(f"[ws] перепідключено (спроба {attempt})")
                attempt += 1
                for raw in ws_messages(s, rest):
                    if self.stop:
                        break
                    try:
                        m = json.loads(raw)
                    except ValueError:
                        continue
                    if not (m.get("kind") == "sample" or m.get("adc")):
                        continue
                    with self.lock:
                        step = self.step
                        self.last = {"t": time.time(), "imu": m.get("imu") or {}}
                        self.count += 1
                        if step:
                            self.samples.write(json.dumps({"t": time.time(), "step": step, "msg": m}) + "\n")
            except Exception as e:  # noqa
                if self.stop:
                    return
                self.say(f"[ws] з'єднання втрачено: {e!r} — пробую знову через 1 с")
                self.log(traceback.format_exc())
                time.sleep(1.0)


def run_steps(rec, executed):
    for i, (sid, dur, text) in enumerate(STEPS):
        print(f"\n━━ [{i + 1}/{len(STEPS)}] {sid} ━━\n   {text}", flush=True)
        for c in range(int(PREP_S), 0, -1):
            sys.stdout.write(f"   старт через {c}...   \r")
            sys.stdout.flush()
            time.sleep(1)
        with rec.lock:
            rec.step = sid
        t0 = time.time()
        beep()
        while time.time() - t0 < dur:
            time.sleep(0.4)
            with rec.lock:
                last = rec.last
            age = time.time() - last["t"] if last else 99
            if last:
                u = up_vector(last["imu"])
                a = angles(u) if u else (0, 0, 0)
                sys.stdout.write(f"\r   ● ЗАПИС {time.time() - t0:4.1f}/{dur}с   roll={a[0]:7.1f}°  elev={a[1]:6.1f}°"
                                 f"{'   ⚠ немає даних ' + str(int(age)) + 'с' if age > 1.5 else ''}      ")
            else:
                sys.stdout.write(f"\r   ● ЗАПИС {time.time() - t0:4.1f}/{dur}с   ⚠ даних зі стрімера ще немає      ")
            sys.stdout.flush()
        with rec.lock:
            rec.step = None
        executed.append(sid)
        beep()
        print()


# ---------- аналіз ----------
def analyze(outdir):
    rows = []
    with open(os.path.join(outdir, "samples.jsonl")) as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    by = {}
    for r in rows:
        u = up_vector(r["msg"].get("imu") or {})
        if u:
            by.setdefault(r["step"], []).append((r["t"], u, r["msg"].get("imu") or {}))

    def mean_u(lst):
        v = [sum(x[1][i] for x in lst) / len(lst) for i in range(3)]
        n = math.sqrt(sum(c*c for c in v)) or 1
        return tuple(c/n for c in v)

    res = {"steps": {}, "poses": {}}
    for pose in ("A", "B"):
        rest = by.get(f"{pose}_rest")
        if not rest:
            continue
        half = rest[len(rest) // 3:]  # без початкового вгамування
        u0 = mean_u(half)
        rho0, e0, xy0 = angles(u0)
        res["poses"][pose] = {"rest_up_sensor": [round(c, 3) for c in u0], "rest_roll_deg": round(rho0, 1),
                              "rest_elev_deg": round(e0, 1), "rest_xy": round(xy0, 2)}
        for d, _ in DIRS + [("circle", "")]:
            lst = by.get(f"{pose}_{d}")
            if not lst:
                continue
            dr, de = [], []
            for _, u, _ in lst:
                rho, e, _ = angles(u)
                dr.append(wrap180(rho - rho0))
                de.append(e - e0)
            res["steps"][f"{pose}_{d}"] = {
                "n": len(lst),
                "droll_deg": {"min": round(min(dr), 1), "max": round(max(dr), 1), "extreme": round(max(dr, key=abs), 1)},
                "delev_deg": {"min": round(min(de), 1), "max": round(max(de), 1), "extreme": round(max(de, key=abs), 1)},
            }
    if "A" in res["poses"] and "B" in res["poses"]:
        res["pose_turn_roll_deg"] = round(wrap180(res["poses"]["B"]["rest_roll_deg"] - res["poses"]["A"]["rest_roll_deg"]), 1)

    lines = ["Аналіз (roll = кут 'вгору' у площині X/Y, elev = нахил осі Z до горизонту; Δ відносно спокою своєї пози)", ""]
    for p, v in res["poses"].items():
        lines.append(f"Поза {p}: спокій roll={v['rest_roll_deg']}°  elev={v['rest_elev_deg']}°  |up_xy|={v['rest_xy']}")
    if "pose_turn_roll_deg" in res:
        lines.append(f"Поворот A→B за roll: {res['pose_turn_roll_deg']}°")
    lines.append("")
    lines.append(f"{'крок':10s} {'n':>5s}  {'Δroll min/max (екстремум)':>30s}   {'Δelev min/max (екстремум)':>30s}")
    for k, v in res["steps"].items():
        r, e = v["droll_deg"], v["delev_deg"]
        lines.append(f"{k:10s} {v['n']:5d}  {r['min']:8.1f} /{r['max']:7.1f} ({r['extreme']:7.1f})   {e['min']:8.1f} /{e['max']:7.1f} ({e['extreme']:7.1f})")
    res["text"] = "\n".join(lines)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:5555/ws")
    ap.add_argument("--left", action="store_true", help="лише для підпису в метаданих")
    ap.add_argument("--time-scale", type=float, default=1.0, help=argparse.SUPPRESS)  # лише для тестів
    a = ap.parse_args()
    global PREP_S, STEPS
    PREP_S = max(1.0, PREP_S * a.time_scale)
    STEPS = [(sid, d * a.time_scale, t) for sid, d, t in STEPS]

    outdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings", "pose_" + time.strftime("%Y%m%d_%H%M%S"))
    os.makedirs(outdir)
    rec = Recorder(a.url, outdir)
    rec.say(f"запис у {outdir}")
    rec.log(f"url={a.url} left={a.left}")
    th = threading.Thread(target=rec.reader, daemon=True)
    th.start()

    executed = []
    try:
        for _ in range(50):  # чекаємо перші дані до 5 с
            if rec.count:
                break
            time.sleep(0.1)
        if not rec.count:
            rec.say("Даних зі стрімера поки немає (чи запущений стрімер?) — запис піде, щойно вони з'являться.")
        else:
            imu = rec.last["imu"]
            rec.say(f"поля IMU: {sorted(imu.keys())}")
            if imu.get("quatW") is None:
                rec.say("УВАГА: у вибірці немає кватерніона (quatW)!")
        run_steps(rec, executed)
    except KeyboardInterrupt:
        rec.say("зупинено вручну (Ctrl+C) — зберігаю те, що є")
    except BaseException:
        rec.say("ПОМИЛКА під час запису (деталі в run.log) — зберігаю те, що є")
        rec.log(traceback.format_exc())
        print(traceback.format_exc(), file=sys.stderr)
    finally:
        rec.stop = True
        with rec.lock:
            rec.step = None
        try:
            rec.samples.flush()
        except Exception:
            pass

    rec.log(f"виконано кроків: {len(executed)}/{len(STEPS)}: {executed}")
    try:
        res = analyze(outdir)
        with open(os.path.join(outdir, "analysis.json"), "w") as f:
            json.dump(res, f, indent=2, ensure_ascii=False)
        with open(os.path.join(outdir, "analysis.txt"), "w") as f:
            f.write(res["text"] + "\n")
        print("\n" + res["text"], flush=True)
    except BaseException:
        rec.say("аналіз не вдався, але сирі дані збережено (деталі в run.log)")
        rec.log(traceback.format_exc())
    print(f"\nГотово. Папка: {outdir}\nНапиши мені 'done' і цей шлях.", flush=True)


if __name__ == "__main__":
    main()
