#!/usr/bin/env python3
"""Живий монітор усіх метрик рукавиці для пентаміно: що ти бачиш, коли повертаєш пристрій на 90°.

    python3 tools/live_metrics.py [--url ws://127.0.0.1:5555/ws] [--left]

Клавіші (у терміналі):
    b  — запам'ятати ПОТОЧНУ позу як базову (normal) і далі показувати відхилення від неї (Δ)
    r  — почати/зупинити запис у CSV (tools/recordings/live_<час>.csv)
    c  — скинути симулятор повороту деталі
    q  — вийти (Ctrl+C теж працює)

Секції:
    RAW       — те, що приходить з рукавиці (euler, кватерніон, гравітація, гіроскоп, магнітометр)
    ПОЗА      — крен рукавиці за гравітацією, висота й азимут осі Z, чи вважає гра пози 'отвернутою'
    ВІД БАЗИ  — Δ від позначеної пози (клавіша b): як змінюються величини при повороті
    ПЕНТАМІНО — ті самі величини, що рахує гра: gyro Z для повороту деталі, вісь flip, симулятор кута деталі, пальці
Пороги й коефіцієнти нижче збігаються з src/components/PentominoGame.tsx та src/utils/imuController.ts.
"""
import argparse, csv, json, math, os, select, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from monitor import ws_connect, ws_messages, RAW_THR, NORM_THR, ADC_FULL  # noqa: E402

# --- константи гри (синхронізувати з кодом) ---
TWIST_DIFFICULTY = 1.5
TWIST_DEADZONE_DPS = 100
TWIST_DOMINANCE = 2
TWIST_SAMPLE_MS = 100
TWIST_COMMIT_IDLE_MS = 700
TWIST_BOOST_FROM, TWIST_BOOST_SLOPE = 70, 1
FLIP_DEADZONE_DPS = 50
FLIP_DOMINANCE = 1.6
ROLLED_ROLL_MAX_DEG, ROLLED_ROLL_MIN_DEG = 20, -120   # imuController.ts


# ---------- математика ----------
def qmul(a, b):
    return (a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3], a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],
            a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1], a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0])


def qconj(q):
    return (q[0], -q[1], -q[2], -q[3])


def qrot(q, v):
    return qmul(qmul(q, (0.0, *v)), qconj(q))[1:]


def rotvec(q):
    """Вектор повороту (вісь·кут) у градусах."""
    if q[0] < 0:
        q = tuple(-c for c in q)
    n = math.sqrt(q[1]**2 + q[2]**2 + q[3]**2)
    if n < 1e-9:
        return (0.0, 0.0, 0.0)
    a = 2 * math.atan2(n, q[0])
    return tuple(c / n * math.degrees(a) for c in q[1:])


def wrap180(a):
    while a > 180:
        a -= 360
    while a < -180:
        a += 360
    return a


def g(d, k):
    try:
        v = d.get(k)
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def derive(imu):
    """Похідні величини з кватерніона."""
    w, x, y, z = (g(imu, k) for k in ("quatW", "quatX", "quatY", "quatZ"))
    if None in (w, x, y, z):
        return None
    n = math.sqrt(w*w + x*x + y*y + z*z) or 1.0
    q = (w/n, x/n, y/n, z/n)
    up = qrot(qconj(q), (0.0, 0.0, 1.0))        # "вгору" в осях сенсора
    p = qrot(q, (0.0, 0.0, 1.0))                # вісь Z сенсора у світі
    return {
        "q": q,
        "up": up,
        "roll": math.degrees(math.atan2(up[1], up[0])),        # крен рукавиці (за гравітацією)
        "elev": math.degrees(math.asin(max(-1, min(1, p[2])))),  # висота осі Z над горизонтом
        "az": math.degrees(math.atan2(p[1], p[0])),            # азимут осі Z
        "pxy": math.hypot(p[0], p[1]),
    }


def is_rolled(roll):
    return ROLLED_ROLL_MIN_DEG < roll < ROLLED_ROLL_MAX_DEG


def pressed_flags(adc, left):
    fr = [float(v or 0) for v in adc[1:6]]
    fr = fr if left else fr[::-1]
    return [abs(v) > RAW_THR or abs(v) / ADC_FULL > NORM_THR for v in fr], fr


def twist_piece_angle(acc):
    a = abs(acc)
    b = a if a <= TWIST_BOOST_FROM else TWIST_BOOST_FROM + (a - TWIST_BOOST_FROM) * TWIST_BOOST_SLOPE
    return math.copysign(min(270, b), acc)


# ---------- стан ----------
class State:
    def __init__(self, left):
        self.left = left
        self.lock = threading.Lock()
        self.msg = None
        self.t = 0.0
        self.count = 0
        self.rate = 0
        self.base = None            # похідні базової пози
        self.base_rv_q = None       # кватерніон базової пози
        self.acc = 0.0              # симулятор накопичення повороту деталі
        self.acc_ts = 0.0
        self.acc_active = 0.0
        self.committed = None       # останній прикріплений поворот (°)
        self.csv = None
        self.csv_w = None
        self.alive = True
        self.err = ""
        self._ts = []

    def on_sample(self, m):
        now = time.time()
        imu = m.get("imu") or {}
        d = derive(imu)
        flags, fr = pressed_flags(m.get("adc") or [], self.left)
        grip = sum(flags) == 5
        gx, gy, gz = (g(imu, k) or 0.0 for k in ("gyroX", "gyroY", "gyroZ"))
        twist = gz if (abs(gz) > TWIST_DEADZONE_DPS and abs(gz) > TWIST_DOMINANCE * max(abs(gx), abs(gy))) else 0.0
        with self.lock:
            self.msg, self.t = m, now
            self.count += 1
            self._ts.append(now)
            self._ts = [t for t in self._ts if now - t < 1.0]
            self.rate = len(self._ts)
            # симулятор повороту деталі: рахує тільки при стиснутому кулаці (як у грі)
            if grip:
                if now - self.acc_ts >= TWIST_SAMPLE_MS / 1000:
                    dt = min(0.25, now - self.acc_ts) if self.acc_ts else 0
                    if self.acc_ts and twist != 0:
                        self.acc = max(-200, min(200, self.acc + twist * dt / TWIST_DIFFICULTY))
                        self.acc_active = now
                    self.acc_ts = now
                    if self.acc != 0 and now - self.acc_active > TWIST_COMMIT_IDLE_MS / 1000:
                        self.committed = round(twist_piece_angle(self.acc) / 90) * 90
                        self.acc = 0.0
            else:
                if self.acc != 0:
                    self.committed = round(twist_piece_angle(self.acc) / 90) * 90
                self.acc, self.acc_ts = 0.0, 0.0
            if self.csv_w:
                row = [f"{now:.3f}"] + [m.get("imu", {}).get(k) for k in CSV_IMU] + list(map(lambda v: v, (m.get("adc") or [None]*6)[:6]))
                row += [round(d[k], 2) if d else None for k in ("roll", "elev", "az")] + [int(grip), round(twist, 1), round(self.acc, 1)]
                self.csv_w.writerow(row)


CSV_IMU = ["pitch", "roll", "yaw", "quatW", "quatX", "quatY", "quatZ", "gravX", "gravY", "gravZ",
           "linAccX", "linAccY", "linAccZ", "gyroX", "gyroY", "gyroZ", "magX", "magY", "magZ"]
CSV_HEAD = ["t"] + CSV_IMU + [f"adc{i}" for i in range(6)] + ["roll_g", "elev_z", "az_z", "grip", "gzTwist", "twistAcc"]


def reader(url, st):
    while st.alive:
        try:
            s, rest = ws_connect(url)
            st.err = ""
            for raw in ws_messages(s, rest):
                if not st.alive:
                    return
                try:
                    m = json.loads(raw)
                except ValueError:
                    continue
                if m.get("kind") == "sample" or m.get("adc"):
                    st.on_sample(m)
        except Exception as e:  # noqa
            st.err = f"з'єднання втрачено: {e!r} — перепідключаюсь…"
            time.sleep(1.0)


# ---------- відмалювання ----------
def f(v, w=7, p=1):
    return " " * (w - 1) + "–" if v is None else f"{v:{w}.{p}f}"


def render(st):
    with st.lock:
        m, t, count, rate = st.msg, st.t, st.count, st.rate
        base, acc, committed, csv_on = st.base, st.acc, st.committed, st.csv_w is not None
    L = []
    age = time.time() - t if t else 99
    status = "● ПОТІК ЖИВИЙ" if age < 1.0 else "○ НЕМАЄ ДАНИХ"
    L.append(f"LIVE METRICS  {status}  {int(rate):3d} Гц  n={count}   {'● REC CSV  ' if csv_on else ''}{st.err}")
    L.append("клавіші: b = базова поза   r = запис CSV   c = скинути симулятор   q = вийти")
    if not m:
        return "\n".join(L + ["", "чекаю на дані зі стрімера…"])
    imu = m.get("imu") or {}
    d = derive(imu)
    adc = m.get("adc") or []
    gx, gy, gz = (g(imu, k) or 0.0 for k in ("gyroX", "gyroY", "gyroZ"))

    L.append("")
    L.append("── RAW ─────────────────────────────────────────────────────────────────────")
    pitch = g(imu, "pitch")
    warn = "   ⚠ pitch біля ±90° — euler виродиться (yaw/roll стрибають), не довіряй їм" if pitch is not None and abs(pitch) > 75 else ""
    L.append(f" euler   pitch {f(pitch)}  roll {f(g(imu,'roll'))}  yaw {f(g(imu,'yaw'))}{warn}")
    L.append(f" quat    w {f(g(imu,'quatW'),7,3)}  x {f(g(imu,'quatX'),7,3)}  y {f(g(imu,'quatY'),7,3)}  z {f(g(imu,'quatZ'),7,3)}")
    gr = [g(imu, k) for k in ("gravX", "gravY", "gravZ")]
    gn = math.sqrt(sum(c*c for c in gr if c is not None)) if None not in gr else None
    L.append(f" grav    x {f(gr[0],7,2)}  y {f(gr[1],7,2)}  z {f(gr[2],7,2)}   |g|={f(gn,5,2)}")
    L.append(f" linAcc  x {f(g(imu,'linAccX'),7,2)}  y {f(g(imu,'linAccY'),7,2)}  z {f(g(imu,'linAccZ'),7,2)}")
    L.append(f" gyro    x {f(gx,7,1)}  y {f(gy,7,1)}  z {f(gz,7,1)}  °/с")
    L.append(f" mag     x {f(g(imu,'magX'),7,1)}  y {f(g(imu,'magY'),7,1)}  z {f(g(imu,'magZ'),7,1)}")

    L.append("")
    L.append("── ПОЗА (з кватерніона/гравітації; не залежить від euler) ──────────────────")
    if d:
        rolled = is_rolled(d["roll"])
        L.append(f" «вгору» в осях сенсора  X {d['up'][0]:+.2f}  Y {d['up'][1]:+.2f}  Z {d['up'][2]:+.2f}")
        L.append(f" крен рукавиці (кут вгору в X/Y)  {d['roll']:7.1f}°     → гра вважає: {'ОТОЧЕНА ◄◄◄' if rolled else 'звичайна'}  "
                 f"(оточена, якщо {ROLLED_ROLL_MIN_DEG}° < крен < {ROLLED_ROLL_MAX_DEG}°)")
        L.append(f" вісь Z у світі: азимут {d['az']:7.1f}°   висота {d['elev']:6.1f}°   |проєкція|={d['pxy']:.2f}")
    else:
        L.append(" кватерніона немає в потоці")

    L.append("")
    L.append("── ВІД БАЗИ  (натисни b у звичайній позі, потім поверни рукавицю) ────────────")
    if d and base:
        dr, de, da = wrap180(d["roll"] - base["roll"]), d["elev"] - base["elev"], wrap180(d["az"] - base["az"])
        rv = rotvec(qmul(qconj(base["q"]), d["q"]))
        L.append(f" Δкрен {dr:+7.1f}°   Δвисота Z {de:+6.1f}°   Δазимут Z {da:+7.1f}°")
        L.append(f" поворот від бази в осях сенсора  X {rv[0]:+7.1f}°  Y {rv[1]:+7.1f}°  Z {rv[2]:+7.1f}°   (|rv|={math.sqrt(sum(c*c for c in rv)):.0f}°)")
        main = max(range(3), key=lambda i: abs(rv[i]))
        L.append(f" головна вісь повороту: {'XYZ'[main]}   (поворот навколо передпліччя ≈ навколо Z)")
    else:
        L.append(" база не задана — натисни b у звичайній позі")

    L.append("")
    L.append("── ПЕНТАМІНО (так це бачить гра) ────────────────────────────────────────────")
    flags, fr = pressed_flags(adc, st.left)
    names = ["великий", "вказівний", "середній", "безіменний", "мізинець"] if not st.left else ["мізинець", "безіменний", "середній", "вказівний", "великий"]
    L.append(" пальці (adc[1:6], порядок гри)  " + "  ".join(f"{('■' if fl else '□')}{v:7.0f}" for fl, v in zip(flags, fr)) + f"   стиснуто {sum(flags)}/5  grip={'ТАК' if sum(flags)==5 else 'ні'}")
    dom = abs(gz) > TWIST_DOMINANCE * max(abs(gx), abs(gy))
    above = abs(gz) > TWIST_DEADZONE_DPS
    tw = gz if (above and dom) else 0.0
    why = "рахується" if tw else ("gyro Z під мертвою зоною %d°/с" % TWIST_DEADZONE_DPS if not above else "gyro Z не домінує (|Z| < %d×max(|X|,|Y|))" % TWIST_DOMINANCE)
    L.append(f" поворот деталі: gyro Z = {gz:+7.1f}°/с   врахований: {tw:+7.1f}   ({why})")
    gf = (gy - gx) / math.sqrt(2)
    gp = (gy + gx) / math.sqrt(2)
    fdom = abs(gf) > FLIP_DOMINANCE * abs(gp) and abs(gf) > FLIP_DOMINANCE * abs(gz) and abs(gf) > FLIP_DEADZONE_DPS
    L.append(f" flip (кивок до себе/від себе): вісь (gy−gx)/√2 = {gf:+7.1f}   перпендикуляр {gp:+7.1f}   {'домінує → рахується' if fdom else 'не рахується'}")
    ang = twist_piece_angle(acc)
    bar_n = int(max(-27, min(27, ang / 10)))
    bar = (" " * (27 + min(0, bar_n)) + "█" * abs(bar_n)) if bar_n < 0 else (" " * 27 + "█" * bar_n)
    L.append(f" симулятор кута деталі: накопичено {acc:+6.1f} → деталь {ang:+6.1f}°   прикріпиться на {round(ang/90)*90:+d}°   останній крок: {committed if committed is not None else '–'}")
    L.append("   -270°" + "·" * 21 + "0" + "·" * 21 + "+270°")
    L.append("        " + bar)
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:5555/ws")
    ap.add_argument("--left", action="store_true", help="ліва рукавиця (інший порядок пальців)")
    ap.add_argument("--snapshot", action="store_true", help="лише один кадр і вихід (для перевірки)")
    a = ap.parse_args()

    st = State(a.left)
    threading.Thread(target=reader, args=(a.url, st), daemon=True).start()

    if a.snapshot:
        time.sleep(1.5)
        print(render(st))
        return

    tty = sys.stdin.isatty()
    old = None
    if tty:
        import termios, tty as ttymod
        old = termios.tcgetattr(sys.stdin)
        ttymod.setcbreak(sys.stdin.fileno())
    sys.stdout.write("\x1b[2J")
    try:
        while True:
            if tty and select.select([sys.stdin], [], [], 0)[0]:
                k = sys.stdin.read(1).lower()
                if k == "q":
                    break
                if k == "b":
                    with st.lock:
                        if st.msg:
                            d = derive(st.msg.get("imu") or {})
                            if d:
                                st.base = d
                elif k == "c":
                    with st.lock:
                        st.acc, st.acc_ts, st.committed = 0.0, 0.0, None
                elif k == "r":
                    with st.lock:
                        if st.csv:
                            st.csv.close(); st.csv = st.csv_w = None
                        else:
                            path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings", "live_" + time.strftime("%Y%m%d_%H%M%S") + ".csv")
                            os.makedirs(os.path.dirname(path), exist_ok=True)
                            st.csv = open(path, "w", newline="")
                            st.csv_w = csv.writer(st.csv)
                            st.csv_w.writerow(CSV_HEAD)
                            st.err = f"запис у {path}"
            frame = render(st)
            sys.stdout.write("\x1b[H" + "\n".join(line + "\x1b[K" for line in frame.split("\n")) + "\x1b[J")
            sys.stdout.flush()
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        st.alive = False
        if st.csv:
            st.csv.close()
        if old is not None:
            import termios
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)
        print("\nГотово.")


if __name__ == "__main__":
    main()
