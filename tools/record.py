#!/usr/bin/env python3
"""Guided recorder: you perform scripted gestures, I tune the game thresholds from the data.

    python3 tools/record.py

For each step an instruction is shown. After a short countdown recording starts
automatically; do the gesture, then press ENTER -> next step appears.
  r + ENTER = redo this step      s + ENTER = skip step      q + ENTER = save & quit

Output: tools/recordings/<timestamp>/samples.jsonl (every raw sample, tagged with the step)
        tools/recordings/<timestamp>/summary.json  (per-step stats + simulation of the game's twist logic)
Send me that folder path (or just say "done") and I'll tune the constants.
"""
import argparse, json, os, statistics as st, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from monitor import ws_connect, ws_messages, RAW_THR, NORM_THR, ADC_FULL  # noqa: E402

# (id, instruction)
STEPS = [
    ("rest_open",      "Рука розслаблена, пальці НЕ стиснуті, тримай рукy НЕРУХОМО (~5 с)."),
    ("rest_grip",      "Стисни ВСІ пальці (кулак) і тримай руку НЕРУХОМО (~5 с). Нічого не крути."),
    ("squeeze_x3",     "Стисни і відпусти кулак 3 рази поспіль, рука нерухома (як тап/подвійний тап)."),
    ("twist_cw_slow",  "Кулак. ПОВІЛЬНО поверни зап'ястя на ~90° ПО ГОДИННИКОВІЙ, повернись назад. 3 рази, з паузою між."),
    ("twist_ccw_slow", "Кулак. ПОВІЛЬНО поверни зап'ястя на ~90° ПРОТИ годинникової, повернись назад. 3 рази."),
    ("twist_cw_fast",  "Кулак. ШВИДКО поверни зап'ястя на ~90° по годинниковій і назад. 3 рази."),
    ("twist_ccw_fast", "Кулак. ШВИДКО поверни зап'ястя на ~90° проти годинникової і назад. 3 рази."),
    ("twist_tiny",     "Кулак. Дуже малі випадкові повороти зап'ястя (~10-20°), НЕ хочеш щоб деталь крутилась. ~8 с."),
    ("twist_nogrip",   "БЕЗ стискання. Крути зап'ястя туди-сюди як хочеш (~6 с). Деталь крутитись не має."),
    ("move_lr",        "Кулак. Рухай руку ВЛІВО-ВПРАВО (нахилом), БЕЗ повороту зап'ястя. ~8 с."),
    ("move_ud",        "Кулак. Рухай руку ВГОРУ-ВНИЗ (нахил вперед/назад), БЕЗ повороту. ~8 с."),
    ("move_circle",    "Кулак. Роби нахилом колові рухи, кулак тримай. ~8 с."),
    ("flip",           "Кулак. Перевертай кисть (флип, вісь вздовж руки) туди-назад. 3 рази."),
    ("tap_each",       "Натискай по одному пальцю по черзі (малий, безіменний, середній, вказівний, великий), без кулака."),
    ("grip_release_moving", "Рухай рукою і ПОСЕРЕД руху стискай/відпускай кулак 3-4 рази (як реальна гра)."),
    ("free_play",      "Вільна гра ~15 с: бери деталь, пересувай, крути як зазвичай."),
]

# keep in sync with PentominoGame.tsx
TWIST_STEP_DEG, TWIST_DIFFICULTY, TWIST_SAMPLE_MS, TWIST_DEADZONE_DPS = 90, 1.5, 100, 45


def pressed_list(adc, left):
    fr = [float(v or 0) for v in adc[1:6]]
    fr = fr if left else fr[::-1]
    return [abs(v) > RAW_THR or abs(v) / ADC_FULL > NORM_THR for v in fr], fr


def simulate_twist(rows, step, diff, sample_ms, dz):
    acc, tw, fired, peak, grip_prev = 0.0, 0.0, 0, 0.0, False
    for r in rows:
        if not r["grip"]:
            acc, tw = 0.0, 0.0
            continue
        t = r["t"]
        if (t - tw) * 1000 >= sample_ms:
            dt = min(0.25, t - tw)
            if tw > 0 and abs(r["gz"]) > dz:
                acc += r["gz"] * dt / diff
            tw = t
        peak = max(peak, abs(acc))
        if abs(acc) >= step:
            fired += 1
            acc = 0.0
    return {"rotations_fired": fired, "peak_acc_deg": round(peak, 1)}


def summarize(rows, left):
    if not rows:
        return {"n": 0}
    dur = rows[-1]["t"] - rows[0]["t"]
    gz = [r["gz"] for r in rows]
    gx = [r["gx"] for r in rows]
    gy = [r["gy"] for r in rows]
    out = {
        "n": len(rows), "duration_s": round(dur, 2), "rate_hz": round(len(rows) / dur, 1) if dur else 0,
        "grip_fraction": round(sum(r["grip"] for r in rows) / len(rows), 2),
        "gz": {"mean": round(st.fmean(gz), 1), "std": round(st.pstdev(gz), 1), "max_abs": round(max(map(abs, gz)), 1)},
        "gx": {"mean": round(st.fmean(gx), 1), "std": round(st.pstdev(gx), 1), "max_abs": round(max(map(abs, gx)), 1)},
        "gy": {"mean": round(st.fmean(gy), 1), "std": round(st.pstdev(gy), 1), "max_abs": round(max(map(abs, gy)), 1)},
        "pitch_range": [round(min(r["pitch"] for r in rows), 1), round(max(r["pitch"] for r in rows), 1)],
        "roll_range": [round(min(r["roll"] for r in rows), 1), round(max(r["roll"] for r in rows), 1)],
        "yaw_range": [round(min(r["yaw"] for r in rows), 1), round(max(r["yaw"] for r in rows), 1)],
        "finger_max": [round(max(abs(r["fingers"][i]) for r in rows)) for i in range(5)],
        "pressed_counts": {str(k): sum(1 for r in rows if r["pressed"] == k) for k in range(6)},
        # true integral of gz while gripping (no deadzone, no divisor) = how many degrees the wrist really turned
        "true_twist_deg_signed": round(sum(rows[i]["gz"] * (rows[i]["t"] - rows[i - 1]["t"])
                                           for i in range(1, len(rows)) if rows[i]["grip"]), 1),
        "sim_current_constants": simulate_twist(rows, TWIST_STEP_DEG, TWIST_DIFFICULTY, TWIST_SAMPLE_MS, TWIST_DEADZONE_DPS),
    }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:5555/ws")
    ap.add_argument("--left", action="store_true")
    ap.add_argument("--countdown", type=float, default=2.0)
    a = ap.parse_args()

    s, rest = ws_connect(a.url)
    outdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings", time.strftime("%Y%m%d_%H%M%S"))
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
                imu, adc = m.get("imu") or {}, m.get("adc") or []
                num = lambda k: float(imu.get(k) or 0)
                pr, fr = pressed_list(adc, a.left)
                with lock:
                    row = {"t": time.time(), "step": state["step"], "pitch": num("pitch"), "roll": num("roll"),
                           "yaw": num("yaw"), "gx": num("gyroX"), "gy": num("gyroY"), "gz": num("gyroZ"),
                           "fingers": fr, "pressed": sum(pr), "grip": sum(pr) == 5, "adc": adc, "imu": imu}
                    state["last"] = row
                    if state["step"]:
                        state["rows"].append(row)
                        f.write(json.dumps(row) + "\n")
        except Exception as e:  # noqa
            alive["ok"] = False
            print(f"\n[ws] connection lost: {e}")

    threading.Thread(target=reader, daemon=True).start()

    def status_loop():
        while alive["ok"]:
            time.sleep(0.4)
            with lock:
                r, step, n = state["last"], state["step"], len(state["rows"])
            if r and step:
                el = time.time() - state["t0"]
                sys.stdout.write(f"\r   ● REC {el:5.1f}s  n={n:5d}  pressed={r['pressed']}/5  gz={r['gz']:7.1f}  "
                                 f"pitch={r['pitch']:6.1f} roll={r['roll']:6.1f}   (ENTER = готово)   ")
                sys.stdout.flush()

    threading.Thread(target=status_loop, daemon=True).start()

    time.sleep(0.5)
    if not state["last"]:
        print("Не бачу даних зі стрімера (чи ввімкнений пристрій?). Продовжую, але перевір.")

    summary, i = {}, 0
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
        try:
            cmd = input().strip().lower()
        except EOFError:
            cmd = "q"
        with lock:
            state["step"] = None
            rows = list(state["rows"])
        print()
        if cmd == "r":
            continue
        if cmd == "q":
            if rows:
                summary[sid] = summarize(rows, a.left)
            break
        if cmd != "s":
            summary[sid] = summarize(rows, a.left)
            sm = summary[sid]
            if sm.get("n"):
                print(f"   записано {sm['n']} семплів, {sm['duration_s']} с, grip {int(sm['grip_fraction'] * 100)}%, "
                      f"|gz|max {sm['gz']['max_abs']}")
            else:
                print("   !! жодного семпла (перевір стрімер) — натисни r щоб повторити наступного разу")
        i += 1

    f.close()
    json.dump({"hand": "L" if a.left else "R",
               "game_constants": {"TWIST_STEP_DEG": TWIST_STEP_DEG, "TWIST_DIFFICULTY": TWIST_DIFFICULTY,
                                  "TWIST_SAMPLE_MS": TWIST_SAMPLE_MS, "TWIST_DEADZONE_DPS": TWIST_DEADZONE_DPS},
               "steps": summary}, open(os.path.join(outdir, "summary.json"), "w"), indent=2, ensure_ascii=False)
    print(f"\nГотово. Збережено: {outdir}\nНапиши мені «записав» — я проаналізую і підлаштую пороги.")


if __name__ == "__main__":
    main()
