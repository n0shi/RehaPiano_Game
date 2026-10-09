export type ShapeName = 'I' | 'O' | 'T' | 'L' | 'J' | 'S' | 'Z';

export interface Cell {
  x: number;
  y: number;
}

export const SHAPES: Record<ShapeName, Cell[]> = {
  I: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 3, y: 0 },
  ],
  O: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ],
  T: [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ],
  L: [
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: 2 },
    { x: 1, y: 2 },
  ],
  J: [
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 1, y: 2 },
    { x: 0, y: 2 },
  ],
  S: [
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ],
  Z: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ],
};

export enum GameState {
  IDLE = 'IDLE',
  GRABBED = 'GRABBED',
  MOVING = 'MOVING',
  PLACED = 'PLACED',
}

export interface Block {
  shapeName: ShapeName;
  cells: Cell[];
  x: number;
  y: number;
  rotation: number;
}

export interface FingerCalibration {
  threshold: number;
  avgTime: number;
  totalTime: number;
  uses: number;
}

export const LEFT_HAND_KEYS = ['q', 'w', 'e', 'r', 't'];
export const LEFT_HAND_NAMES = [
  'Malíček',
  'Prstenník',
  'Prostredník',
  'Ukazovák',
  'Palec',
];

export const RIGHT_HAND_KEYS = ['z', 'u', 'i', 'o', 'p'];
export const RIGHT_HAND_NAMES = [
  'Palec',
  'Ukazovák',
  'Prostredník',
  'Prstenník',
  'Malíček',
];

// Preddefinované farby obrysov (Tailwind triedy)
export const OUTLINE_COLORS = [
  {
    border: 'border-blue-400',
    bg: 'bg-blue-300',
    hex: '#60a5fa',
    bgHex: '#93c5fd',
  },
  {
    border: 'border-green-400',
    bg: 'bg-green-300',
    hex: '#4ade80',
    bgHex: '#86efac',
  },
  {
    border: 'border-red-400',
    bg: 'bg-red-300',
    hex: '#f87171',
    bgHex: '#fca5a5',
  },
  {
    border: 'border-orange-400',
    bg: 'bg-orange-300',
    hex: '#fb923c',
    bgHex: '#fdba74',
  },
  {
    border: 'border-purple-400',
    bg: 'bg-purple-300',
    hex: '#c084fc',
    bgHex: '#d8b4fe',
  },
  {
    border: 'border-cyan-400',
    bg: 'bg-cyan-300',
    hex: '#22d3ee',
    bgHex: '#67e8f9',
  },
  {
    border: 'border-yellow-400',
    bg: 'bg-yellow-300',
    hex: '#facc15',
    bgHex: '#fde047',
  },
  {
    border: 'border-pink-400',
    bg: 'bg-pink-300',
    hex: '#f472b6',
    bgHex: '#f9a8d4',
  },
  {
    border: 'border-indigo-400',
    bg: 'bg-indigo-300',
    hex: '#818cf8',
    bgHex: '#a5b4fc',
  },
  {
    border: 'border-emerald-400',
    bg: 'bg-emerald-300',
    hex: '#34d399',
    bgHex: '#6ee7b7',
  },
];