#!/usr/bin/env python3
"""Запис для діагностики орієнтації: звичайне положення рукавиці -> поворот на 90° -> рух у чотири сторони.

    python3 tools/record_orient.py [--left] [--url ws://127.0.0.1:5555/ws]

Стрімер має працювати (як для гри). На кожному кроці показується інструкція, після відліку йде запис,
ENTER = крок виконано.  r + ENTER = повторити,  s = пропустити,  q = зберегти і вийти.

Кроки йдуть самі за таймером (чути дзвінок \\a на початку кожного); ENTER = завершити крок раніше.
Не склеюй пози в один крок: перша поза — кроки A_*, поворот на 90° — B_rotating, друга поза — B_*.

Пишеться КОЖНЕ повідомлення стрімера повністю (кватерніон, euler, grav, linAcc, gyro, adc), позначене кроком:
  tools/recordings/orient_<час>/samples.jsonl   — усі сирі повідомлення
  tools/recordings/orient_<час>/summary.json    — середні кватерніон/гравітація по кроках і напрямок руху в світі
Потім просто скажи "done" і шлях до теки.
"""
import argparse, json, math, os, select, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from monitor import ws_connect, ws_messages, RAW_THR, NORM_THR, ADC_FULL  # noqa: E402

DIRS = [("right", "ВПРАВО"), ("left", "ВЛІВО"), ("up", "ВГОРУ (від себе / вперед)"), ("down", "ВНИЗ (до себе / назад)")]


def tilt_steps(prefix, pose_text):
    out = []
    for d, label in DIRS:
        out.append((f"{prefix}_{d}", f"{pose_text}. Нахили кисть {label} так, як хочеш щоб рухався курсор, "
                                     f"затримайся на кінці ~1 с, поверни в центр. Повтори 3 рази."))
    out.append((f"{prefix}_circle", f"{pose_text}. Повільно намалюй нахилом кисті коло (2-3 кола)."))
    return out


STEPS = [
    ("A_rest", "ПОЗА A (звичайна, як при калібруванні в грі). Рука НЕРУХОМО ~5 с."),
    ("A_grip", "ПОЗА A. Стисни ВСІ пальці (кулак) і тримай нерухомо ~3 с (це 'рекалібрація')."),
    *tilt_steps("A", "ПОЗА A (звичайна)"),
    ("B_rotating", "Тепер ПЕРЕВЕРНИ рукавицю на 90° (там, де в тебе ламається логіка). Рухайся повільно, ~4 с. "
                   "Запам'ятай: у який бік крутив (за годинниковою чи проти) і навколо чого (вісь передпліччя?)."),
    ("B_rest", "ПОЗА B (перевернута на 90°). Рука НЕРУХОМО ~5 с. БЕЗ стискання."),
    ("B_grip", "ПОЗА B. Стисни ВСІ пальці і тримай нерухомо ~3 с (рекалібрація, яка в тебе не допомагає)."),
    *tilt_steps("B", "ПОЗА B (перевернута на 90°)"),
]


def duration(sid, default):
    if sid.endswith("_rest"):
        return 6.0
    if sid.endswith("_grip"):
        return 5.0
    if sid.endswith("_rotating"):
        return 7.0
    if sid.endswith("_circle"):
        return 9.0
    return default


def wait_step(seconds):
    """Чекає ENTER, але не довше seconds. Повертає введений рядок ('' = ENTER або кінець часу)."""
    r, _, _ = select.select([sys.stdin], [], [], seconds)
    return sys.stdin.readline().strip().lower() if r else ""


def fnum(d, k):
    try:
        return float(d.get(k) or 0)
    except (TypeError, ValueError):
        return 0.0


def qmul(a, b):
    return (a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3], a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],
            a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1], a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0])


def qconj(q):
    return (q[0], -q[1], -q[2], -q[3])


def qnorm(q):
    n = math.sqrt(sum(c*c for c in q)) or 1.0
    return tuple(c/n for c in q)


def qrot(q, v):
    return qmul(qmul(q, (0.0, *v)), qconj(q))[1:]


def mean_quat(qs):
    """Усереднення кватерніонів (з вирівнюванням знаку по першому)."""
    if not qs:
        return None
    ref = qs[0]
    acc = [0.0] * 4
    for q in qs:
        s = 1 if sum(a*b for a, b in zip(q, ref)) >= 0 else -1
        for i in range(4):
            acc[i] += s * q[i]
    return qnorm(tuple(acc))


def vmean(vs):
    return [sum(v[i] for v in vs) / len(vs) for i in range(3)] if vs else None


def summarize(rows):
    qs = [qnorm((r["qw"], r["qx"], r["qy"], r["qz"])) for r in rows if r["has_quat"]]
    gv = [(r["grx"], r["gry"], r["grz"]) for r in rows if r["has_grav"]]
    s = {"n": len(rows), "mean_quat_wxyz": mean_quat(qs), "mean_grav": vmean(gv),
         "mean_euler_pry": vmean([(r["pitch"], r["roll"], r["yaw"]) for r in rows])}
    return s


def world_tilt_dir(q_rest, q_end):
    """Куди тілт відбувся у СВІТІ: вісь повороту Δ = q_end·q_rest⁻¹ (x,y — горизонтальні осі світу, z — yaw)."""
    d = qnorm(qmul(q_end, qconj(q_rest)))
    if d[0] < 0:
        d = tuple(-c for c in d)
    ang = 2 * math.degrees(math.atan2(math.sqrt(d[1]**2 + d[2]**2 + d[3]**2), d[0]))
    n = math.sqrt(d[1]**2 + d[2]**2 + d[3]**2) or 1.0
    return {"angle_deg": ang, "axis_world": [d[1]/n, d[2]/n, d[3]/n]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:5555/ws")
    ap.add_argument("--left", action="store_true", help="записуєш ліву рукавицю (лише для підпису)")
    ap.add_argument("--countdown", type=float, default=3.0)
    ap.add_argument("--step-seconds", type=float, default=10.0, help="тривалість кроку з нахилами (інші кроки мають свою)")
    a = ap.parse_args()

    s, rest = ws_connect(a.url)
    outdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings", "orient_" + time.strftime("%Y%m%d_%H%M%S"))
    os.makedirs(outdir)
    f = open(os.path.join(outdir, "samples.jsonl"), "w")

    state = {"step": None, "rows": [], "t0": 0.0, "last": None}
    lock = threading.Lock()
    alive = {"ok": True}

    def reader():
        try:
            for raw in ws_messages(s, rest):
                try:
                    m = json.loads(raw)
                except ValueError:
                    continue
                if not (m.get("kind") == "sample" or m.get("adc")):
                    continue
                imu = m.get("imu") or {}
                has_q = imu.get("quatW") is not None
                has_g = imu.get("gravX") is not None
                row = {"t": time.time(), "step": state["step"], "hand": m.get("hand"), "msg": m,
                       "has_quat": has_q, "has_grav": has_g,
                       "qw": fnum(imu, "quatW"), "qx": fnum(imu, "quatX"), "qy": fnum(imu, "quatY"), "qz": fnum(imu, "quatZ"),
                       "grx": fnum(imu, "gravX"), "gry": fnum(imu, "gravY"), "grz": fnum(imu, "gravZ"),
                       "pitch": fnum(imu, "pitch"), "roll": fnum(imu, "roll"), "yaw": fnum(imu, "yaw")}
                with lock:
                    state["last"] = row
                    if state["step"]:
                        state["rows"].append(row)
                        f.write(json.dumps(row) + "\n")
        except Exception as e:  # noqa
            alive["ok"] = False
            print(f"\n[ws] з'єднання втрачено: {e}")

    threading.Thread(target=reader, daemon=True).start()

    def status_loop():
        while alive["ok"]:
            time.sleep(0.4)
            with lock:
                r, step, n = state["last"], state["step"], len(state["rows"])
            if r and step:
                sys.stdout.write(f"\r   ● REC {time.time() - state['t0']:5.1f}s n={n:5d} pitch={r['pitch']:6.1f} roll={r['roll']:6.1f} "
                                 f"yaw={r['yaw']:6.1f}   (ENTER = готово)   ")
                sys.stdout.flush()

    threading.Thread(target=status_loop, daemon=True).start()

    time.sleep(0.6)
    with lock:
        last = state["last"]
    if not last:
        print("Не бачу даних зі стрімера (чи ввімкнений пристрій?). Продовжую, але перевір.")
    else:
        print(f"Поля у вибірці: {sorted((last['msg'].get('imu') or {}).keys())}  hand={last['hand']}")
        if not last["has_quat"]:
            print("УВАГА: кватерніона (quatW..) у вибірці немає!")

    meta = {"url": a.url, "left": a.left, "started": time.strftime("%Y-%m-%d %H:%M:%S")}
    summary = {"meta": meta, "steps": {}}

    def save():
        with open(os.path.join(outdir, "summary.json"), "w") as fh:
            json.dump(summary, fh, indent=2, ensure_ascii=False)

    i = 0
    print(f"\nЗапис у {outdir}\nENTER = крок виконано, r = повторити, s = пропустити, q = зберегти і вийти\n")
    while i < len(STEPS):
        sid, text = STEPS[i]
        print(f"\n[{i + 1}/{len(STEPS)}] {sid}\n   {text}")
        for c in range(int(a.countdown), 0, -1):
            sys.stdout.write(f"   старт через {c}...\r")
            sys.stdout.flush()
            time.sleep(1)
        with lock:
            state["rows"], state["t0"], state["step"] = [], time.time(), sid
        sys.stdout.write("\a")
        cmd = wait_step(duration(sid, a.step_seconds))
        with lock:
            state["step"] = None
            rows = list(state["rows"])
        print()
        if cmd == "r":
            continue
        if cmd == "s":
            i += 1
            continue
        if rows:
            summary["steps"][sid] = summarize(rows)
            st = summary["steps"][sid]
            print(f"   записано {st['n']} вибірок; euler(p,r,y)={[round(v, 1) for v in st['mean_euler_pry']]}")
            save()
        if cmd == "q":
            break
        i += 1

    try:
        meta["rotation_note"] = input("\nУ який бік і навколо чого крутив рукавицю (напр. 'проти годинникової, навколо передпліччя')? ").strip()
        meta["pose_note"] = input("Як сидить сенсор/як тримаєш руку (долоня вниз/убік, пальці вперед)? ").strip()
    except EOFError:
        pass
    save()

    # напрямок рухів у СВІТІ відносно спокою своєї пози (для порівняння A і B)
    for pose in ("A", "B"):
        rest_s = summary["steps"].get(f"{pose}_rest")
        if not rest_s or not rest_s["mean_quat_wxyz"]:
            continue
        for d, _ in DIRS:
            sid = f"{pose}_{d}"
            ss = summary["steps"].get(sid)
            if not ss:
                continue
            ext = [r for r in (json.loads(l) for l in open(os.path.join(outdir, "samples.jsonl")))
                   if r["step"] == sid and r["has_quat"]]
            if not ext:
                continue
            qr = tuple(rest_s["mean_quat_wxyz"])
            # найбільше відхилення від спокою
            best = max(ext, key=lambda r: abs(world_tilt_dir(qr, qnorm((r["qw"], r["qx"], r["qy"], r["qz"])))["angle_deg"]))
            ss["max_tilt_world"] = world_tilt_dir(qr, qnorm((best["qw"], best["qx"], best["qy"], best["qz"])))
            ss["max_tilt_grav"] = [best["grx"], best["gry"], best["grz"]]
    save()
    f.close()
    print(f"\nГотово. Збережено: {outdir}\nНапиши мені 'done' і цей шлях.")


if __name__ == "__main__":
    main()
