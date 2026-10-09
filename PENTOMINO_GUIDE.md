# Pentomino Levely - Návod na tvorbu

## Štruktúra levelu

```json
{
  "id": 1,                    // Číslo levelu (unikátne)
  "name": "Názov levelu",     // Meno, ktoré sa zobrazí hráčovi
  "description": "Popis",     // Inštrukcie pre hráča
  "gridWidth": 20,            // Šírka mriežky (ponechaj 20)
  "gridHeight": 20,           // Výška mriežky (ponechaj 20)
  "targetShape": [...],       // Cieľový tvar (20 riadkov × 20 stĺpcov)
  "availablePieces": [...],   // Zoznam pentomín na použitie
  "startingPositions": [...]  // Kde sa pentomína objavia na začiatku
}
```

## Dôležité pravidlá

### 1. Počet buniek MUSÍ byť deliteľný 5
- Každé pentomino má presne **5 buniek**
- Ak máš 3 pentomína → cieľ musí mať **15 buniek** (true)
- Ak máš 4 pentomína → cieľ musí mať **20 buniek** (true)
- Ak máš 5 pentomín → cieľ musí mať **25 buniek** (true)

### 2. Dostupné pentomíno tvary
```
F, I, L, N, P, T, U, V, W, X, Y, Z
```

### 3. TargetShape
- Pole 20×20 (20 riadkov, každý riadok 20 stĺpcov)
- `true` = bunka patrí do cieľa (hráč ju musí vyplniť)
- `false` = prázdna bunka

### 4. StartingPositions
- Súradnice kde sa pentomína objavia na začiatku hry
- `row`: 0-19 (riadok zhora)
- `col`: 0-19 (stĺpec zľava)
- Počet pozícií MUSÍ byť rovnaký ako počet pentomín v `availablePieces`

## Príklad: Level s 3 pentomínami (15 buniek)

```json
{
  "id": 1,
  "name": "Obdĺžnik 3×5",
  "description": "Vytvor obdĺžnik 3×5",
  "gridWidth": 20,
  "gridHeight": 20,
  "targetShape": [
    // Prvých 7 riadkov prázdne...
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    // Obdĺžnik 3×5 = 15 buniek (true)
    [false,false,false,false,false,false,true,true,true,true,true,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,true,true,true,true,true,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,true,true,true,true,true,false,false,false,false,false,false,false,false,false],
    // Zvyšok prázdny...
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],
    [false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false]
  ],
  "availablePieces": ["I", "L", "P"],
  "startingPositions": [
    {"row": 1, "col": 2},
    {"row": 1, "col": 14},
    {"row": 14, "col": 8}
  ]
}
```

## Overenie levelu

Spusti v terminále:
```bash
node -e "const fs=require('fs'); const p='src/data/pentominoLevels.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.forEach(l=>{ const target=l.targetShape.flat().filter(Boolean).length; const pieces=l.availablePieces.length; console.log('Level', l.id, ':', target, 'buniek |', pieces, 'pentomín =', pieces*5, 'buniek', target===pieces*5 ? '✓':'✗'); });"
```

## Tipy na tvary
- **Obdĺžniky**: 3×5, 4×5, 5×6, 6×10
- **Kríž**: 5 pentomín
- **Schody**: 3-4 pentomína
- **Písmená**: T, L, U
- **Symetrické tvary**: pyramídy, diamanty

