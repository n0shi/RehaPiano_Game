# RehaPiano

## Súbory
- [Gameboard.tsx](src/components/GameBoard.tsx)
   - Súbor obsahujúci hru "Presúvanie blokov"
- [PentominoGame.tsx](src/components/PentominoGame.tsx)
   - Súbor obsahujúci hru "Pentomino"
- [Tetris.tsx](src/components/Tetris.tsx)
   - Súbor obsahujúci hru "Tetris"
- [CalibrationModal.tsx](src/components/CalibrationModal.tsx)
   - Tento súbor obsahuje modal, ktorý sa zobrazuje len ak je pripojený WebSocket (zariadenie), Pri prvotnom spustení hry je kalibrácia nutná z dôvodu nastavenia 0 gravitačného bodu
- [WebSocketStatus.tsx](src/components/WebSocketStatus.tsx)
   - Súbor obsahuje pripojenie na WebSocket, ako aj badge + badge kalibrácie
- [HandVisualization.tsx](src/components/HandVisualization.tsx)
   - Vykreslenie SVG ruky pre hru "Presúvanie blokov" 

- [game.ts](src/types/game.ts)
   - Modul kde sú definície typov a konštánt

---
#### Pentomino
- [level_editor.py](level_editor.py)
   - Tento skript slúži na vytváranie úrovní pre hru "Pentomino"

- [pentominoLevels.json](src/data/pentominoLevels.json)
   - V tomto json súbore sú všetky úrovne. Pri použití 'level_editor.py' sa daná úroveň automaticky zapíše sem

- [pentominoShapes.ts](src/data/pentominoShapes.ts)
   - Definícia tvarov v hre "Pentomino"

---
#### Konfiguračný súbor
- [configuration.json](public/configuration.json)
   - Konfiguračný súbor na definovanie premenných (veľa vecí je aj rozhádzaných v kóde (nebol čas to meniť)) 


---

## Spústenie aplikácie

Krátky návod ako spustiť aplikáciu lokálne alebo v Docker kontejnery.

**Predpoklady**
- Docker (alebo Docker Compose) ak chcete spúšťať kontajner.
- Node.js 18+ a `npm` ak chcete spúšťať manuálne.

**Súbory pre Docker**
- [Dockerfile](Dockerfile)
- [nginx.conf](nginx.conf)
- [.dockerignore](.dockerignore)
- [docker-compose.yml](docker-compose.yml)

1) Spustiť cez Docker

```bash
docker build -t rehapiano:latest .
docker run --rm -p 8080:80 rehapiano:latest
```
Alebo (odporúčané)
```bash
docker compose up --build
```

2) Zastavenie a odstránenie

```bash
docker compose down
```

Otvoríte prehliadač na http://localhost:8080

Poznámky:
- Multi-stage `Dockerfile` používa `npm run build` a kopíruje výstup `build/` do nginx.
- Ak váš projekt generuje výstup do iného adresára než `build/`, upravte `Dockerfile`.
- Ak frontend potrebuje backend, upravte `nginx.conf` proxy_pass alebo pridajte službu do `docker-compose.yml`.

2) Spustiť manuálne (vývoj)

```bash
# inštalácia závislostí
npm ci

# spustenie v režime development (vite)
npm run dev
```

V dev režime pravdepodobne beží na http://localhost:5173 (štandard Vite). Skontrolujte výstup `npm run dev`.

3) Manuálne — produkčný build a lokálne servovanie

```bash
npm ci
npm run build

# rýchle lokálne servovanie z build (npx serve používa statický server)
npx serve -s build -l 8080
```

## Inštalácia

1. Uistite sa, že máte nainštalovaný Node.js a npm.
2. V koreňovom adresári projektu spustite:
   ```bash
   npm install
   ```
3. Pre spustenie vývojového servera použite:
   ```bash
   npm run dev
   ```
4. Pre produkčnú verziu:
   ```bash
   npm run build
   ```

## Štruktúra projektu

- `src/` – zdrojové kódy aplikácie
  - `components/` – React komponenty (herné obrazovky, UI prvky)
  - `config/` – konfiguračné súbory
  - `guidelines/` – odporúčania a dokumentácia
  - `styles/` – globálne štýly
  - `types/` – typy pre TypeScript
  - `utils/` – pomocné funkcie
- `public/` – statické súbory
- `build/` – produkčný build

## Závislosti

Používajú sa knižnice React, Vite, ESLint, Prettier a ďalšie (viac v `package.json`).

## Beh kódu

`npm i` na inštaláciu dependencies

`npm run dev` na spustenie dev servera
