#!/usr/bin/env python3
"""Простий тест осей: скрипт сам просить зробити 3 рухи і каже, яка вісь гіро який рух дає.
Запуск:  python3 tools/axis_test.py [--hand left|right]
"""
import json, os, sys, threading, time
HAND = sys.argv[sys.argv.index("--hand") + 1] if "--hand" in sys.argv else None  # left | right (pre dve zariadenia)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from monitor import ws_connect, ws_messages  # noqa: E402

MOVES = [
    ("ПОВОРОТ ЗАП'ЯСТЯ (як щоб покрутити деталь)", "twist"),
    ("РУХ КИСТІ ВПРАВО-ВЛІВО", "leftright"),
    ("РУХ КИСТІ ДО СЕБЕ / ВІД СЕБЕ (кивок кистю вперед-назад)", "toward"),
]
SECONDS = 5

s, rest = ws_connect("ws://127.0.0.1:5555/ws")
cur = {"on": False, "rows": []}


def reader():
    for raw in ws_messages(s, rest):
        try:
            m = json.loads(raw)
        except ValueError:
            continue
        imu = m.get("imu") or {}
        if HAND and m.get("hand") != HAND:
            continue
        if cur["on"] and imu:
            cur["rows"].append(tuple(float(imu.get(k) or 0) for k in ("gyroX", "gyroY", "gyroZ")))


threading.Thread(target=reader, daemon=True).start()
time.sleep(0.5)

print("\nТест осей. Тримай кулак стиснутим (як у грі) і роби рух, який попросить скрипт.")
print(f"Кожен рух триває {SECONDS} секунд, роби його кілька разів туди-сюди.\n")
result = {}
corr = {}
for title, key in MOVES:
    input(f"--> Далі: {title}\n    Натисни ENTER і одразу роби рух...")
    cur["rows"] = []
    cur["on"] = True
    for i in range(SECONDS, 0, -1):
        print(f"    роби рух... {i}", end="\r", flush=True)
        time.sleep(1)
    cur["on"] = False
    rows = cur["rows"]
    # середня абсолютна швидкість по кожній осі
    avg = [sum(abs(r[i]) for r in rows) / max(1, len(rows)) for i in range(3)]
    result[key] = avg
    sxx = sum(r[0] * r[0] for r in rows); syy = sum(r[1] * r[1] for r in rows); sxy = sum(r[0] * r[1] for r in rows)
    corr[key] = sxy / ((sxx * syy) ** 0.5) if sxx and syy else 0.0
    print(f"    готово ({len(rows)} семплів): середня швидкість  x={avg[0]:.0f}  y={avg[1]:.0f}  z={avg[2]:.0f} °/с\n")

names = "xyz"
print("=" * 60)
for title, key in MOVES:
    a = result[key]
    if max(a) < 15:
        print(f"{title}\n   -> рух НЕ помічено (швидкість < 15 °/с). Роби рух різкіше й довше.")
        continue
    best = max(range(3), key=lambda i: a[i])
    second = sorted(a)[-2]
    ratio = a[best] / second if second else 99
    print(f"{title}\n   -> головна вісь: {names[best]}  (у {ratio:.1f} раза більша за другу)")
print("=" * 60)
if max(result["toward"]) < 15 or max(result["twist"]) < 15:
    print("Рухи майже не зафіксовані — запусти тест ще раз і рухай рукою активніше.")
    sys.exit()
toward = max(range(3), key=lambda i: result["toward"][i])
twist = max(range(3), key=lambda i: result["twist"][i])
if names[toward] == "y":
    print("ВИСНОВОК: «до себе / від себе» = вісь y. Флип зараз налаштований правильно.")
else:
    print(f"ВИСНОВОК: «до себе / від себе» = вісь {names[toward]}, а не y. Напиши мені це — переключу флип.")
if toward == twist:
    print("УВАГА: поворот зап'ястя і рух до себе дають ТУ САМУ вісь — флип конфліктуватиме з поворотом.")
print(f"\nЗв'язок x і y під час руху до себе: {corr['toward']:+.2f}  "
      f"({'x і y рухаються в ОДИН бік' if corr['toward'] > 0 else 'x і y рухаються в ПРОТИЛЕЖНІ боки'})")
print("\nСкопіюй цей текст (від рядків '====') і надішли мені.")
