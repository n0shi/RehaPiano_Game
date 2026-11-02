# Рухи рукавички: що змінено і як перенести в іншу гру

Документ описує лише керування курсором (контролер `src/utils/imuController.ts` і спосіб, яким його підключають). Усе перевірено на записах `tools/recordings/pose_*` (поза A = звичайна, поза B = рукавичка повернута приблизно на 90°, «як тримаєш келих»), на самій рукавичці — вручну користувачем.

## 1. Проблеми, які були, і чому

| Симптом | Причина | Рішення |
|---|---|---|
| Курсор «липне» до центра | Мертва зона нахилу 0,05 рад (~3°) | Для малювання вимкнена (`tiltDeadzone = 0`) |
| «Невидимі стіни» біля краю | Нахил обрізався на межі (`min(1, …)`), положення обрізалось на ±1; на краю екрана нахил накопичувався «у запас» | `tiltMax`/`posLimit` (див. п. 2) + рухомий якір (п. 3) |
| Курсор застряг біля правої стінки | Абсолютне положення від калібровочної пози + насичення | Відносний курсор від якоря (п. 3) |
| Діагональ при русі в звичайній позі (вниз йшло вліво) | Поворот осей датчика 46°, підібраний за старим записом; за новим ~62° | `TILT_ROTATION_RIGHT_DEG = 62` |
| Закручування вліво при русі вгору (звичайна поза) | Корекція `SHEAR_UP_RIGHT_HAND = 0,23`, підібрана під 46°, після зміни на 62° переправляла | `SHEAR_UP_RIGHT_HAND = 0` |
| Діагональ при русі вгору/вниз у повернутій позі | (а) вертикальне підсилення ×2,6 у `ROLLED_PROFILE` розтягувало вісь; (б) бічний перекіс, якого немає в записі | (а) `gains.up/down = 1`; (б) `ROLLED_SHEAR_VERT` (п. 4) |
| Курсор «блукає» у спокої | Мертва зона 0 + тремор руки (~110 px у записі, з 0,05 лише ~12 px) | Для меню та ігор мертва зона 0,05, нуль лише в малюванні |
| Керування «розбігається» через дрейф/зміну пози | Нуль нахилу береться раз при вході | Калібрація утриманням (п. 5) |
| Скидання стану під час гри | Стример кожні ~40 с рве зв'язок на ~1 с, а поріг втрати даних був 1000 мс | Поріг 2000 мс (п. 6) |

## 2. Зміни в `imuController.ts`

Усі зміни в одному файлі, нові властивості мають значення за замовчуванням, що **не змінюють поведінку існуючих ігор**.

- **`tiltMax`** (за замовчуванням 1): верхня межа довжини вектора нахилу у формулі `Math.min(this.tiltMax, (mag - dzr) / (1 - dzr)) / mag` (замінено у трьох місцях: лінійний режим, профіль осей, вбудований профіль повернутої руки). 1 = насичення на краю діапазону; 4 = практично без насичення.
- **`posLimit`** (за замовчуванням 1): межа `posNorm` після фільтра (було жорстко ±1).
- **`ROLLED_PROFILE.gains.up/down`**: 2,6 → **1**. Старе значення походило із запису, де вертикальний хід кисті був ±11°; новий запис показав ±20–28° (як по горизонталі). Осі `eH`/`eV` залишено старі.
- **`TILT_ROTATION_RIGHT_DEG`**: 46 → **62** (поворот осей датчика правої рукавички; діє на звичайну позу).
- **`SHEAR_UP_RIGHT_HAND`**: 0,23 → **0** (діє на звичайну позу, правий рукав).
- **`ROLLED_SHEAR_VERT`** (нове, 0,2): у повернутій позі в екранних координатах `x += k · y` (y вниз), застосовується у блоці `builtin` перед `ny`. Значення можна підібрати без перебудови:
  ```js
  localStorage.setItem('rehapiano.rolledShearVert', '0.3')   // потім оновити сторінку
  ```
  Кладе значення в діапазон −1…1; кешується на 1 с. Збільшуйте k, якщо діагональ зберігається в той самий бік.

Усі інші параметри (`ROLLED_SHEAR_RIGHT`, осі `ROLLED_PROFILE.eH/eV`, `axisCalibration` за замовчуванням) — без змін. Якщо в браузері збережена «Kalibrácia osí» (`rehapiano.axisCalibration.v1`), вона замінює значення за замовчуванням.

## 3. Як підключати контролер (шаблон для нової гри)

Налаштування, спільні для меню, малювання і Pentomino:

```ts
const c = new SingleIMUController();
c.gyroDivisor = 1;        // стример шле гіро вже в °/с
c.linearTilt = true;      // діагоналі без блокування осей
c.angleTilt = true;       // лінійний кут нахилу (без обернення при великому куті)
c.precisionScale = 1;     // стиск пальців не змінює чутливість
c.tiltMax = 4;            // без насичення біля краю
c.posLimit = 4;
// c.tiltDeadzone: 0 для малювання; 0,05 (за замовчуванням) для меню і ігор, де потрібен стабільний курсор
```

На кожну вибірку (`imu-sample`) у такому порядку:

```ts
ctrl.setReferenceQuat(globalNeutralQuat);        // кут закручування: звідси береться «повернута поза»
applyAxisCorr(ctrl, left ? 'left' : 'right');    // збережена/типова корекція осей
const seq = ctrl.recenterSeq;
const out = ctrl.update({ imu, adc, ts }, dt);
if (ctrl.recenterSeq !== seq) { anchor = { ...cursor }; }  // контролер сам обнулив нуль (розпізнав повернуту руку) — курсор не стрибає
const nx = left ?  out.posNorm.x : -out.posNorm.x;         // дзеркалення: права x інвертується, ліва — y
const ny = left ? -out.posNorm.y :  out.posNorm.y;
```

**Відносний курсор з рухомим якорем.** Курсор = якір + нахил × півширини/піввисоти. Біля краю якір зсувається разом із курсором, тому нахил не накопичується і курсор завжди можна відвести від стіни:

```ts
let tx = anchor.x + nx * (w / 2) * GAIN;
let ty = anchor.y + ny * (h / 2) * GAIN;
const cx = clamp(tx, 0, w), cy = clamp(ty, 0, h);
anchor.x += cx - tx;  anchor.y += cy - ty;       // якір «ковзає» по стіні
tx = cx; ty = cy;
cursor.x += SMOOTH * (tx - cursor.x);            // SMOOTH = 0.35
cursor.y += SMOOTH * (ty - cursor.y);
```

- На вході на екран: `ctrl.recenter(imu); anchor = cursor;` (нуль нахилу береться в поточній позі, а не в калібровочній).
- У Pentomino те саме зроблено в нормованих координатах −1…1 (`anchor` + `lastPos`), а початковий якір 0 відповідає калібровочній позі, бо там нуль береться з глобальної калібровки.

## 4. Повернута поза: що важливо знати

- Поза розпізнається за **абсолютним кутом закручування** (`rho` вектора «вгору»): `ROLLED_ROLL_MAX_DEG = 20`, `ROLLED_ROLL_MIN_DEG = −120`. Базова поза має ~+52°, поворот на 67° дає ~−23° (всередині діапазону). Поворот в інший бік може не розпізнатись.
- Розпізнавання відбувається в `update`: якщо рука стоїть ~0,7 с без стиску й розпізнана поза змінилась, контролер сам викликає `recenter` (тому потрібна обробка `recenterSeq`, див. п. 3).
- Запис не відтворює вашу реальну руку: перекіс вертикалі в повернутій позі довелось визначати за відчуттям, а не за записом. Для стабільного результату в майбутньому потрібне автонавчання осей (не зроблено).

## 5. Калібрація утриманням (меню і малювання)

Стиснути всі 5 пальців і тримати ~1 с без руху → `ctrl.recenter(imu)`, курсор у центр, якір у центр, ознака «вже відкалібровано», щоб при відпусканні не було кліку. Параметри:

| Константа | Значення | Сенс |
|---|---|---|
| `CALIB_HOLD_MS` | 1000 | скільки тримати |
| `CALIB_STILL_PX` | 40 (меню) / 30 (малювання) | зсув цілі, після якого відлік починається знову |
| `CALIB_SHOW_MS` | 250 | показувати прогрес лише після цього часу |

У меню клік виконується **при відпусканні** (якщо стискали менше `CALIB_HOLD_MS`), а позиція кліку береться з історії курсора за ~250 мс **до** стиску (`CLICK_LOOKBACK_MS`), бо стиск сам рухає рукою. У малювання перед штрихом є ще `PEN_SETTLE_MS = 180`: після стиску чекаємо, поки рука заспокоїться, потім `recenter`.

## 6. Втрата даних

Стример рве з'єднання приблизно кожні 40 с і відновлює його за ~1,02 с. Поріг «втрата даних» (`DATA_LOSS_MS`/`SAMPLE_TIMEOUT_MS` у малюванні та Pentomino) зведено до **2000 мс**, щоб розрив не скидав перо/жест. Меню приховує курсор після 1500 мс.

## 7. Як перевіряти нові зміни

1. Записати поведінку: `python3 tools/record_pose.py` (поза A, поворот, поза B, по 4 напрямки й коло). Результат — `tools/recordings/pose_*/{samples.jsonl, analysis.txt}`.
2. Прогнати запис через контролер офлайн (esbuild вже є в `node_modules/@esbuild/linux-x64/bin/esbuild`; `.bin/esbuild` зі збірки Mac не запуститься): зібрати невеликий скрипт, який створює `SingleIMUController`, викликає `recenter`, `setReferenceQuat`, `applyAxisCorr` і `update` для кожного рядка запису та виводить `posNorm` (екран: x = −posNorm.x для правої руки). Центр брати в **робочій позі**, а не в «спокої»: різниця 10–20° дає зсув, що ховає справжні ефекти.
3. Перебудувати образ: `docker compose up -d --build`.

## 8. Як саме знайдено кожне рішення (метод і докази)

Спільний метод для всього, що стосується осей: записи `tools/recordings/pose_*` прогонялись через **той самий** `SingleIMUController` (`recenter` → `setReferenceQuat` → `applyAxisCorr` → `update`), а кожен напрямок (вправо/вліво/вгору/вниз) оцінювався за **бічним відхиленням**: для вертикальних кроків — середній `x`, для горизонтальних — середній `y` (екранні координати, `x = −posNorm.x` для правої руки). «Центр» брався як **медіанна поза кроку** (робоча поза), а не поза «спокій»: вони відрізняються на 10–20°, і це само дає зсув 0,3–0,4 від ходу, який ховає справжні ефекти.

### Мертва зона (залипання біля центра і тремтіння)
Виміряно на `A_rest` (рука нерухома): блукання курсора за час запису при мертвій зоні 0,05 / 0,02 / 0 = **12 / 60 / 110 px**. Звідси: 0 лишається тільки там, де користувач просив прибрати «притягування» (малювання), для меню та Pentomino — 0,05. Спроба «0 в меню» погіршила звичайну позу і була відкочена.

### Поворот осей 46° → 62° (звичайна поза)
Перебір на кроках пози A: `rot` від −90 до 90 з кроком 10°, потім уточнення; `shearUp`, `shearRight` у діапазоні ±0,4. Мінімізувався середньоквадратичний бічний зсув. Результат: оптимум `rot ≈ 60–62`, зсув 0,092 → 0,064, а дрейф вліво при русі **вниз** (було −0,45 від довжини руху) → −0,04. `shearUp/Right` з підгонки не брались (виграш лише 0,005 при ризику підгонки під одну сесію).

### `SHEAR_UP_RIGHT_HAND` 0,23 → 0 (закручування вліво при русі вгору)
Побудовано криву «середній x по бінах y» для кроку «вгору»: при `shearUp = 0,23` на y = −0,25 було `x = −0,19`. Порівняння варіантів при `rot = 62`: `shearUp` 0,23 / 0 / −0,2 дають x(y = −0,45) = −0,11 / +0,03 / +0,10 і загальну похибку 0,080 / 0,071 / 0,070. Вибрано 0 (нейтральне значення; −0,2 мало б вигляд підгонки, виграш мінімальний).

### Вертикальне підсилення повернутої пози 2,6 → 1
Крок вгору/вниз у позі B при підсиленні 2,6: діапазон `y` ≈ −1,26…+1,18, при тому, що горизонталь має ±0,5. Порівняно підсилення 2,6 / 1,4 / 1,0: діапазон −1,26…+1,18 / −0,68…+0,62 / **−0,48…+0,44**. 1,0 вирівнює вертикаль і горизонталь. Старе 2,6 було підібране за записом, де вертикальний хід кисті був ±11°; новий запис дає ±20–28°.

### Стіни біля краю (меню, малювання, Pentomino)
Це **не** виміряно на записах, а знайдено читанням коду: (1) формула нахилу обрізала вектор на `min(1, …)`, (2) `posNorm` обрізався на ±1, (3) положення курсора обрізалось на краю екрана, а нахил далі накопичувався. Рішення — параметри `tiltMax`/`posLimit` + якір, що ковзає по стіні. Перевірено компіляцією та ручним тестом користувача.

### Перекіс вертикалі в повернутій позі (`ROLLED_SHEAR_VERT`)
Тут запис **не допоміг**: за ним вертикаль виходила рівною, а користувач бачив діагональ (вгору — вправо, вниз — вліво). Спроба переорієнтувати осі `eH`/`eV` за новим записом (усереднення зі старими + ортогоналізація) покращила похибку на записі 0,046 → 0,038, але в реальному використанні діагональ посилилась, і це було відкочено. Тому додано пряму корекцію `x += k·y` з підбором через `localStorage` за відчуттям користувача.

### Втрата даних
У `run.log` розрив `closed by server` повторюється кожні 40–41 с, `ws_connect` перепідключається через 1 с; у `samples.jsonl` це видно двома проміжками по 1,02–1,04 с (кроки `turn` і `B_left`). Поріг 1000 мс майже збігався з розривом, тому його піднято до 2000.

### Що пробувалось і було відкинуте
- **`pointerTilt`** (курсор «як лазерна указка» за напрямком осі Z): на тих самих записах результат гірший, ніж у поточній моделі (кути +/−50…150° замість очікуваних).
- **Два режими в меню** (звичайна поза = налаштування малювання, повернута = стара): відкочено за запитом користувача.
- **Нова мертва зона 0 у меню:** відкочено через блукання курсора.
- **Усереднення осей `eH`/`eV`:** див. вище, відкочено.

### Обмеження, про які варто пам'ятати
- Записи — це одна людина й кілька сесій; поворот осей змінився з 46° до 62° між сесіями, бо рукавичка сідає на руку по-різному. Фіксовані числа працюють «в середньому», найнадійніше — автонавчання осей для кожного користувача (не зроблено).
- Усі зміни в п. 2 для звичайної пози стосуються **правої руки**; для лівої `DEFAULT_AXIS_CORR.left` не чіпалось.


## 9. Automatické učenie osí pre otočenú polohu (`autoAxes`)

Nahrádza ručné ladenie `ROLLED_SHEAR_VERT` a pevné `eH`/`eV`. Zapína sa po inštancii: `ctrl.autoAxes = true` (predvolene vypnuté, ostatné hry sa nemenia). Zapnuté je v menu, v skúške kreslenia a v Pentomino.

**Princíp.** Vstavaný profil mapuje rotačný vektor `rv` ruky na obrazovku cez dve osi: `rx = rv·eH`, `ry = rv·eV`. Diagonála vzniká, keď reálny zvislý pohyb ruky nie je kolmý na `eH` (alebo vodorovný na `eV`). Kontrolér preto za chodu:
1. Sleduje "ťahy": okno 250 ms, posun v `rv` aspoň 0,07 rad a priamosť (posun/dráha) aspoň 0,85. Nepriame a krátke pohyby sa ignorujú; učí sa len mimo stisku prstov.
2. Ťah je vodorovný, ak je jeho zložka pozdĺž `eV` pod 60 % zložky pozdĺž `eH` (~31°); zvislý analogicky; diagonálne sa nepočítajú. Smer ťahu `D` sa sčíta do `h` (vodorovné, so znamienkom podľa `eH`) alebo `v` (zvislé). Zhluky majú rozpad 0,97 na ťah.
3. Keď je aspoň 5 ťahov oboch typov (vážené), po každých 4 nových vypočíta: `eH'` = `eH0` kolmé na `v`, `eV'` = `eV0` kolmé na `h` (tam, kde `eH0`/`eV0` je vstavaná os), s dorovnaním dĺžky tak, aby zosilnenie pozdĺž zamýšľaného smeru ostalo ako vo vstavanom profile (rozsah 0,5–2).
4. Odmietne výsledok, ak sa líši od vstavanej osi o viac ako 40°, ak `h` a `v` ležia takmer na jednej osi (|h·v| > 0,9), alebo ak ruka nie je blízko nulového bodu (`|rv| > 0,2`, aby kurzor pri zmene neskočil). Aplikuje s vyhladením 50 %.
5. Po prvej aplikácii sa `ROLLED_SHEAR_VERT` vypne (os už perekos rieši). **`ROLLED_SHEAR_RIGHT` ostáva vždy zapnutý**: oblúk zápästia je jednostranný (len doprava, sklon dy/dx ≈ 0,32 vpravo vs ≈ 0 vľavo), takže ho lineárne osi nevedia nahradiť; vypnutie ho zhoršilo na ~0,45 (pravá strana šikmo). Učenie preto pracuje v priestore *po* tejto korekcii (z ťahu sa odpočíta jej posun) a korekcia používa hladké `smoothPos` namiesto `max(x, 0)`, aby v nule nebola hrana.

**Ukladanie.** Naučené osi sú spoločné pre všetky kontroléry v stránke a ukladajú sa do `localStorage['rehapiano.autoAxes.v2']` (podľa ruky, najviac raz za 5 s). Nové dáta ich prepíšu v priebehu ~10 ťahov. Reset: `resetAutoAxes('right')` z `imuController.ts`, alebo v konzole `localStorage.removeItem('rehapiano.autoAxes.v2')` a obnoviť stránku.

**Čo sa nemení.** Ručná "Kalibrácia osí" (profil s `mx`/`my`) má prednosť a automatika ju neprepisuje. Platí len pre pravú aj ľavú ruku v otočenej polohe (`builtin`), nie pre zvyčajnú polohu.

**Overenie na zázname `pose_20261102` (poloha B, 2 kolá po 8 krokoch, stredy v pracovnej polohe).** Priemerná bočná odchýlka (rms): základné osi 0,061 → **0,039**. Keď sme osi úmyselne pokrivili (`eV` o 20°/35° alebo `eH` o −20°/−35°), bez automatiky 0,063 / 0,084 / 0,039 / 0,049, s automatikou po 2–3 kolách **0,040 / 0,041 / 0,037 / 0,030**, takže sa vrátia k rovnakému výsledku. Dosah (percentily 2–98) zostal rovnaký (±0,6–0,7).


## 10. Vyrovnanie dosahu medzi smermi a polohami (`autoReach`)

**Problém.** Pri rovnakej snahe ruka dosiahne v rôznych smeroch rôzny výklon a po otočení rukavice sa pomer zmení. Na zázname `pose_20261102` (dosah od štartu kroku, vrchol v jednotkách polohy): zvyčajná poloha vpravo/vľavo/hore/dole **0,40 / 0,86 / 0,40 / 0,57**, otočená **0,31 / 1,09 / 0,72 / 0,43**. Časť je v kóde: `DEFAULT_AXIS_CORR.right.gains` (vpravo 0,85, vľavo 1,6) pochádza zo starého záznamu a dnes zosilňuje už silnejšiu ľavú stranu. Pri chorých ľuďoch sa rozsah navyše líši od človeka k človeku, preto sa nerieši pevnými číslami.

**Riešenie.** `ctrl.autoReach = true` (predvolene vypnuté). Po všetkých korekciách osí a pred zosilnením polohy sa pre každý zo štyroch smerov sleduje vrchol každej výchylky (výchylka = výklon nad 0,12, skončí pri poklese pod 35 % vrcholu alebo pod 0,06; diagonálne priechody, kde druhá os je nad 2/3 hlavnej, sa nepočítajú; nie počas stisku prstov). Vrchol sa ukladá ako horná obálka (rastie rýchlo s koeficientom 0,6, klesá pomaly 0,15). Po 3 výchylkách v smere sa zosilnenie posúva (krok 50 %) k `autoReachTarget / P`, v rozsahu `autoReachMin`…`autoReachMax` (0,5…2,5). Zosilnenie sa mení až na konci výchylky, takže kurzor neskáče.

- `autoReachTarget` (predvolene 0,9): výchylka, na ktorú sa zmapuje najväčší bežný výklon (1 = okraj). Pre Pentomino 0,6, lebo ďalej nasleduje `posGain = 1,5`.
- Štatistiky sa držia osobitne pre ruku a polohu (`right:normal`, `right:rolled`, …), takže sa vyrovnáva aj medzi polohami. Ukladajú sa do `localStorage['rehapiano.autoReach.v1']`, zdieľané medzi kontrolérmi.
- Reset: `resetAutoReach('right')` alebo v konzole `localStorage.removeItem('rehapiano.autoReach.v1')` a obnoviť stránku.
- Pri nové recentre sa rozpracovaná výchylka zahodí (meria sa od nového nulového bodu).

**Výsledok na zázname (3–6 kôl po 4 krokoch).** Zvyčajná poloha 0,79 / 0,86 / 1,0 / 1,06, otočená 0,91 / 1,09 / 1,25 / 0,91, teda rozptyl smerov z ~2× (zvyčajná) a ~3,5× (otočená) na ~1,3–1,4×. Známe obmedzenie: ak ruka v zázname zostane na kraji bez návratu (krok `B_left`), vrchol sa nezaznamená; v bežnom používaní sa ruka vracia, takže tam to nevadí.


### Oprava: "stena vpravo" a kolísanie trajektórie v otočenej polohe
Príčina bola v mojom vlastnom kóde: keď sa osi naučili, vypol som `ROLLED_SHEAR_RIGHT`, takže pravá polovica dostala sklon dy/dx ≈ +0,45 (kurzor pri pohybe doprava klesal) a v nule vznikla hrana. Oprava: shear zostáva vždy zapnutý a je hladký (`smoothPos`, zaoblenie 0,08), učenie sa robí po jeho odpočítaní, kľúč úložiska zvýšený na `v2`, aby sa zahodili chybne naučené osi. Meranie na `pose_20261102` (sklon bočnej zložky voči hlavnej, celý rozsah): bez učenia vpravo −0,24 / vľavo −0,09 / hore +0,29 / dole +0,30, s učením (shear zapnutý) **−0,01 / +0,13 / −0,02 / +0,02**. `ROLLED_SHEAR_RIGHT` sa dá ladiť v konzole: `localStorage.setItem('rehapiano.rolledShearRight', '0.3')`.
