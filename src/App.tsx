import React, { useState, useEffect, useRef } from 'react';
import { useCalibration } from './context/CalibrationContext';
import { useConfig } from './config/ConfigContext';
import { GameBoard } from './components/GameBoard';
import { PentominoGame } from './components/PentominoGame';
import { TetrisGame } from './components/TetrisGame';
import { Puzzle, Shapes, Hand, Blocks } from 'lucide-react';
import { Target, Settings, Plus, Minus } from 'lucide-react';
import { WebSocketStatus } from './components/WebSocketStatus';
import {
  FingerCalibration,
  LEFT_HAND_KEYS,
  LEFT_HAND_NAMES,
  RIGHT_HAND_KEYS,
  RIGHT_HAND_NAMES,
} from './types/game';
import './animations.css';

type Screen = 'menu' | 'calibration' | 'gameSelection' | 'game';
type GameType = 'original' | 'energy' | 'pentomino' | 'tetris';

export default function App() {
  // Dostupné počty levelov (maximálne 15 pre pentomino)
  const levelOptions = [5, 10, 15];
  const [screen, setScreen] = useState<Screen>('menu');
  const [useLeftHand, setUseLeftHand] = useState(true);
  const [gameType, setGameType] = useState<GameType>('original');
  const [calibrations, setCalibrations] = useState<FingerCalibration[]>([]);
  const cfg = useConfig();
  const { setActiveHand, isCalibrated } = useCalibration();
  // Hodnota slidera pre počet úrovní. Predvolene zvolíme stred konfigurovaného maxima.
  // Ak používateľ posunie slider, neprepíšeme jeho voľbu pri opätovnom načítaní configu —
  // stav sledujeme cez `userAdjusted`.
  const [levelsCount, setLevelsCount] = useState<number>(() => {
    const max = cfg?.MAX_PUZZLE_BLOCKS ?? 10;
    // Vybrať horný stred tak, aby párne počty (napr. 14) mapovali na vyšší stred (14 -> 8)
    return Math.ceil((Math.max(1, max) + 1) / 2);
  });
  const [userAdjusted, setUserAdjusted] = useState(false);

  useEffect(() => {
    if (!cfg) return;
    const max = Math.max(1, cfg.MAX_PUZZLE_BLOCKS);
    // Ak používateľ už upravil slider, neprepíšeme jeho voľbu.
    if (!userAdjusted) {
      // Použiť horný stred tak, aby párne maximum posunulo výsledok nahor (14 -> 8)
      setLevelsCount(Math.ceil((max + 1) / 2));
    } else {
      // Upraviť na nové maximum, ak sa konfig znížil
      setLevelsCount((prev) => Math.min(prev, max));
    }
  }, [cfg, cfg?.MAX_PUZZLE_BLOCKS, userAdjusted]);

  const fingerKeys = useLeftHand ? LEFT_HAND_KEYS : RIGHT_HAND_KEYS;
  const fingerNames = useLeftHand ? LEFT_HAND_NAMES : RIGHT_HAND_NAMES;

  // Klávesové skratky v menu
  useEffect(() => {
    if (screen !== 'menu') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();

      if (key === 'l') {
        setUseLeftHand(true);
        setActiveHand('left');
        setScreen('gameSelection');
      } else if (key === 'r') {
        setUseLeftHand(false);
        setActiveHand('right');
        setScreen('gameSelection');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [screen, setActiveHand]);

  // Klávesové skratky pre výber hry
  useEffect(() => {
    if (screen !== 'gameSelection') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();

      if (key === 'l') {
        // Pattern / original
        setGameType('original');
        setScreen('game');
      } else if (key === 'p') {
        // Pentomino puzzle
        setGameType('pentomino');
        setScreen('game');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [screen]);

  const handleHandSelection = (leftHand: boolean) => {
    setUseLeftHand(leftHand);
    setActiveHand(leftHand ? 'left' : 'right');
    setScreen('gameSelection');
  };

  const handleCalibrationComplete = (newCalibrations: FingerCalibration[]) => {
    setCalibrations(newCalibrations);
    setScreen('gameSelection');
  };

  const handleCalibrationSkip = () => {
    // Použiť predvolené kalibrácie
    const defaultThr = cfg?.TENSOMETER_RAW_THRESHOLD ?? 2000;
    const defaultCalibrations: FingerCalibration[] = fingerKeys.map(() => ({
      threshold: defaultThr,
      avgTime: 0,
      totalTime: 0,
      uses: 0,
    }));
    setCalibrations(defaultCalibrations);
    setScreen('gameSelection');
  };

  // Inline GameMenu component (user-provided design)
  type HandType = 'left' | 'right';
  function GameMenu({ onSelectGame, hand, onChangeSettings }: { onSelectGame: (game: 'pattern' | 'pentominoes' | 'tetris', maxLevels: number) => void; hand: HandType; onChangeSettings: () => void; }) {
    const handEmoji = hand === 'left' ? '🤚' : '🤚';
    // Separate level selectors per card so adjusting one doesn't affect the other
    const [patternLevelIndex, setPatternLevelIndex] = useState<number>(1);
    const [pentoLevelIndex, setPentoLevelIndex] = useState<number>(1);
    const getLevelDescription = (level: number) => {
      switch (level) {
        case 5: return 'Krátka relácia';
        case 10: return 'Stredná relácia';
        case 15: return 'Dlhá relácia';
        case 20: return 'Intenzívna relácia';
        default: return '';
      }
    };

    // Scaling logic
    const [scale, setScale] = useState(1);
    const contentRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const handleResize = () => {
        if (!contentRef.current) return;
        const padding = 48;
        const availableHeight = window.innerHeight - padding;
        const contentHeight = 900; // Increased to ensure fit
        const availableWidth = window.innerWidth - padding;
        const contentWidth = 1200;

        const scaleH = Math.min(1, availableHeight / contentHeight);
        const scaleW = Math.min(1, availableWidth / contentWidth);
        
        setScale(Math.min(scaleH, scaleW));
      };

      handleResize();
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, []);

    return (
      <div className="fixed inset-0 h-screen w-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 overflow-hidden">
        <div 
          ref={contentRef}
          className="max-w-7xl w-full transition-transform duration-200 ease-out origin-center flex flex-col items-center"
          style={{ transform: `scale(${scale})` }}
        >
          <div className="grid md:grid-cols-3 gap-6">
            <div className="md:col-span-3 mb-8 bg-white rounded-2xl shadow-xl p-6">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-3">
                  <div className="bg-blue-100 w-10 h-10 rounded-lg flex items-center justify-center">
                    <Hand className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-slate-600 text-md">Aktívna ruka</p>
                    <p className="text-slate-800 flex items-center gap-2 text-lg font-bold">
                      {hand === 'left' ? 'Ľavá' : 'Pravá'}
                    </p>
                  </div>
                </div>

                <button
                  onClick={onChangeSettings}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl transition-colors"
                >
                  <Settings className="w-4 h-4" />
                  <span>Zmeniť ruku</span>
                </button>
              </div>
            </div>
            <button
              onClick={() => onSelectGame('pattern', levelOptions[patternLevelIndex])}
              className="bg-white rounded-2xl shadow-xl p-8 hover:shadow-2xl transition-all hover:scale-105 text-left group"
            >
              <div className="bg-blue-100 w-16 h-16 rounded-xl flex items-center justify-center mb-6 group-hover:bg-blue-200 transition-colors">
                <Puzzle className="w-8 h-8 text-blue-600" />
              </div>
              <h2 className="text-slate-800 mb-3 font-semibold">Presúvanie blokov</h2>
              <p className="text-slate-600 mb-4">
                Skladajte obrazy z tetrisových blokov. Každý blok má svoju farbu a pozíciu.
                Umiestnené bloky sa stávajú prekážkami.
              </p>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                  <p className="text-slate-600">Postupné zvyšovanie obtiažnosti</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  <p className="text-slate-600">Každý prst ovláda iný blok</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-orange-500"></div>
                  <p className="text-slate-600">Tetrisové bloky</p>
                </div>
              </div>
              <div className="mt-6 pt-6 border-t border-slate-200">
                <div className="bg-blue-50 rounded-xl p-4 mb-4">
                  <div className="text-center mb-3">
                    <span className="text-2xl font-bold text-slate-800">{levelOptions[patternLevelIndex]}</span>
                    <p className="text-xs text-slate-600">{getLevelDescription(levelOptions[patternLevelIndex])}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); if (patternLevelIndex > 0) setPatternLevelIndex(patternLevelIndex - 1); }}
                      disabled={patternLevelIndex === 0}
                      className="w-10 h-10 rounded-lg flex items-center justify-center transition-all bg-blue-600 hover:bg-blue-700 disabled:opacity-30 disabled:bg-blue-300 text-white shadow-md flex-shrink-0"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <div className="flex-1">
                      <div className="relative h-2 bg-slate-200 rounded-full">
                        <div className="absolute h-full bg-blue-600 rounded-full transition-all duration-300" style={{ width: `${((patternLevelIndex) / (levelOptions.length - 1)) * 100}%` }} />
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (patternLevelIndex < levelOptions.length - 1) setPatternLevelIndex(patternLevelIndex + 1); }}
                      disabled={patternLevelIndex === levelOptions.length - 1}
                      className="w-10 h-10 rounded-lg flex items-center justify-center transition-all bg-blue-600 hover:bg-blue-700 disabled:opacity-30 disabled:bg-blue-300 text-white shadow-md flex-shrink-0"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex justify-between mt-1" style={{ paddingLeft: '52px', paddingRight: '52px' }}>
                    {levelOptions.map((level, idx) => (
                      <span key={level} className={`text-xs transition-colors ${idx === patternLevelIndex ? 'text-blue-600 font-bold' : 'text-slate-400'}`}>{level}</span>
                    ))}
                  </div>
                </div>
                <p className="text-blue-600 text-center">Kliknite pre štart →</p>
              </div>
            </button>

            <button
              onClick={() => onSelectGame('pentominoes', levelOptions[pentoLevelIndex])}
              className="bg-white rounded-2xl shadow-xl p-8 hover:shadow-2xl transition-all hover:scale-105 text-left group"
            >
              <div className="bg-purple-100 w-16 h-16 rounded-xl flex items-center justify-center mb-6 group-hover:bg-purple-200 transition-colors">
                <Shapes className="w-8 h-8 text-purple-600" />
              </div>
              <h2 className="text-slate-800 mb-3 font-semibold">Pentomino</h2>
              <p className="text-slate-600 mb-4">
                Vyplňte cieľovú oblasť pentomino dielikmi. Obtiažnosť tvarov sa zvyšuje.
                Rotujte a umiestňujte ich bez medzier.
              </p>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-purple-500"></div>
                  <p className="text-slate-600">12 unikátnych pentomino tvarov</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                  <p className="text-slate-600">Vyplňte cieľovú oblasť úplne</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-orange-500"></div>
                  <p className="text-slate-600">Rastúca veľkosť oblasti</p>
                </div>
              </div>
              <div className="mt-6 pt-6 border-t border-slate-200">
                <div className="bg-purple-50 rounded-xl p-4 mb-4">
                  <div className="text-center mb-3">
                    <span className="text-2xl font-bold text-slate-800">{levelOptions[pentoLevelIndex]}</span>
                    <p className="text-xs text-slate-600">{getLevelDescription(levelOptions[pentoLevelIndex])}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); if (pentoLevelIndex > 0) setPentoLevelIndex(pentoLevelIndex - 1); }}
                      disabled={pentoLevelIndex === 0}
                      className="w-10 h-10 rounded-lg flex items-center justify-center transition-all bg-purple-600 hover:bg-purple-700 disabled:opacity-30 disabled:bg-purple-300 text-white shadow-md flex-shrink-0"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <div className="flex-1">
                      <div className="relative h-2 bg-slate-200 rounded-full">
                        <div className="absolute h-full bg-purple-600 rounded-full transition-all duration-300" style={{ width: `${((pentoLevelIndex) / (levelOptions.length - 1)) * 100}%` }} />
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (pentoLevelIndex < levelOptions.length - 1) setPentoLevelIndex(pentoLevelIndex + 1); }}
                      disabled={pentoLevelIndex === levelOptions.length - 1}
                      className="w-10 h-10 rounded-lg flex items-center justify-center transition-all bg-purple-600 hover:bg-purple-700 disabled:opacity-30 disabled:bg-purple-300 text-white shadow-md flex-shrink-0"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex justify-between mt-1" style={{ paddingLeft: '52px', paddingRight: '52px' }}>
                    {levelOptions.map((level, idx) => (
                      <span key={level} className={`text-xs transition-colors ${idx === pentoLevelIndex ? 'text-purple-600 font-bold' : 'text-slate-400'}`}>{level}</span>
                    ))}
                  </div>
                </div>
                <p className="text-purple-600 text-center">Kliknite pre štart →</p>
              </div>
            </button>

            <div className="bg-white rounded-2xl shadow-xl p-8 text-left hover:shadow-2xl transition-all hover:scale-105">
              <div className="bg-green-100 hover:bg-green-200 w-16 h-16 rounded-xl flex items-center justify-center mb-6">
                <Blocks className="w-8 h-8 text-green-600" />
              </div>
              <h2 className="text-slate-800 mb-3 font-semibold">Tetris</h2>
              <p className="text-slate-600 mb-4">
                Klasická hra Tetris ovládana pomocou ruky.
                Použite pohyb ruky a stisk prstov na ovládanie.
                2 úrovne obtiažnosti pre rôznorodosť tréningu.
              </p>
              <div className="space-y-2 mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  <p className="text-slate-600">Trénovanie jemnej motoriky</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                  <p className="text-slate-600">2 úrovne obtiažnosti</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-orange-500"></div>
                  <p className="text-slate-600">Napínavé momenty</p>
                </div>
              </div>
              <div className="mt-6 pt-6 border-t border-slate-200">
                <div className="flex flex-col gap-3">
                  <button
                    onClick={() => onSelectGame('tetris', 1)}
                    className="px-4 py-3 bg-green-100 hover:bg-green-200 text-green-800 rounded-xl transition-all hover:scale-105 font-medium text-left flex items-center justify-between group"
                  >
                    <div>
                      <span className="block font-bold">Úroveň 1</span>
                      <span className="text-xs text-green-600">Bez gravitácie</span>
                    </div>
                    <span className="opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                  </button>
                  <button
                    onClick={() => onSelectGame('tetris', 2)}
                    className="px-4 py-3 bg-green-100 hover:bg-green-200 text-green-800 rounded-xl transition-all hover:scale-105 font-medium text-left flex items-center justify-between group"
                  >
                    <div>
                      <span className="block font-bold">Úroveň 2</span>
                      <span className="text-xs text-green-600">S gravitáciou</span>
                    </div>
                    <span className="opacity-0 group-hover:opacity-100 transition-opacity">→</span>

                  </button>

                  <p className="text-green-600 text-center">Vyberte úroveň pre štart →</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  const handleBackToMenu = () => {
    setScreen('gameSelection');
  };

  return (
    <>
      <WebSocketStatus
        hideCalibrationButton={screen === 'menu' || (screen === 'gameSelection' && !isCalibrated)}
        showCalibratedLabel={screen === 'gameSelection'}
      />

      {screen === 'menu' && (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 p-4 overflow-auto" style={{ fontFamily: '\'Poppins\', ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial' }}>
          <div className="max-w-4xl w-full">
            {/* Header */}
            <div className="text-center mb-12">
              <h1 className="text-4xl font-bold text-slate-800 mb-3">Rehabilitačný systém hier</h1>
            </div>

            {/* Hand Selection */}
            <div className="bg-white rounded-3xl shadow-2xl p-8">
              <div className="flex items-center gap-3 mb-6">
                <div className="bg-blue-100 w-12 h-12 rounded-xl flex items-center justify-center">
                  <Hand className="w-6 h-6 text-blue-600" />
                </div>
                <div>
                  <h2 className="text-2xl font-semibold text-slate-800">Výber ruky</h2>
                  <p className="text-slate-600">Ktorou rukou budete trénovať?</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Left Hand */}
                <button
                  onClick={() => handleHandSelection(true)}
                  className="relative p-8 rounded-2xl border-2 border-slate-200 hover:border-blue-300 hover:shadow-md transition-all hover:scale-105"
                >
                  <div className="flex flex-col items-center gap-4">
                    <div className="text-6xl">🤚</div>
                    <div className="text-center">
                      <p className="text-xl font-semibold text-slate-800 mb-1">ĽAVÁ</p>
                    </div>
                  </div>
                </button>

                {/* Right Hand */}
                <button
                  onClick={() => handleHandSelection(false)}
                  className="relative p-8 rounded-2xl border-2 border-slate-200 hover:border-blue-300 hover:shadow-md transition-all hover:scale-105"
                >
                  <div className="flex flex-col items-center gap-4">
                    <div className="text-6xl transform scale-x-[-1]">✋</div>
                    <div className="text-center">
                      <p className="text-xl font-semibold text-slate-800 mb-1">PRAVÁ</p>
                    </div>
                  </div>
                </button>
              </div>
            </div>

            {/* Slider for level count removed per UX request */}

            {/* Info Section */}
            <div className="mt-8 bg-blue-50 rounded-2xl p-6">
              <div className="flex items-start gap-3">
                <div className="bg-blue-100 w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="font-bold text-lg text-blue-900 mb-2">Informácie o tréningu</p>
                  <ul className="space-y-1 text-blue-700 text-lg">
                    <li>• Každá hra je navrhnutá pre rehabilitáciu jednej ruky</li>
                    <li>• Používa sa rehabilitačné zariadenie RehaPiáno</li>
                    <li>• Obtiažnosť sa postupne zvyšuje s každým levelom</li>
                    <li>• Môžete kedykoľvek prepnúť medzi hrami</li>
                    <li>• Vaše nastavenia budú zachované počas celej relácie</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {screen === 'gameSelection' && (
        <GameMenu
          hand={useLeftHand ? 'left' : 'right'}
          onChangeSettings={() => setScreen('menu')}
          onSelectGame={(game, maxLevels) => {
            if (game === 'pattern') setGameType('original');
            if (game === 'pentominoes') setGameType('pentomino');
            if (game === 'tetris') setGameType('tetris');
            setLevelsCount(maxLevels);
            setScreen('game');
          }}
        />
      )}

      {screen === 'game' && gameType === 'original' && (
        <GameBoard
          useLeftHand={useLeftHand}
          fingerKeys={fingerKeys}
          fingerNames={fingerNames}
          calibrations={calibrations}
          onBackToMenu={handleBackToMenu}
          maxLevels={levelsCount}
        />
      )}

      {screen === 'game' && gameType === 'pentomino' && (
        <PentominoGame
          useLeftHand={useLeftHand}
          fingerKeys={fingerKeys}
          fingerNames={fingerNames}
          calibrations={calibrations}
          onBackToMenu={handleBackToMenu}
          maxLevels={levelsCount}
        />
      )}

      {screen === 'game' && gameType === 'tetris' && (
        <TetrisGame
          onBackToMenu={handleBackToMenu}
          level={levelsCount} // Using levelsCount as level selector for Tetris (1 or 2)
          useLeftHand={useLeftHand}
        />
      )}
    </>
  );
}
