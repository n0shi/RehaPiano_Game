// ==================== MAPOVAČ VSTUPU (INPUT MAPPER) ====================
// Mapuje IMU vstupy a ADC hodnoty prstov na herné akcie

import { IMUSpacePointer } from './IMUSpacePointer';
import { GyroRotateDetector } from './GyroRotateDetector';
import { AccelDropController } from './AccelDropController';

export const BTN_LEFT = 'LEFT';
export const BTN_RIGHT = 'RIGHT';
export const BTN_UP = 'UP';
export const BTN_DOWN = 'DOWN';
export const BTN_ROTATE = 'ROTATE';
export const BTN_SPAWN = 'SPAWN';
export const BTN_PLACE = 'PLACE';
export const BTN_DROP = 'DROP';

const FINGER_TO_BTN: Record<number, string> = {
  0: BTN_PLACE,
  1: BTN_ROTATE,
  2: BTN_LEFT,
  3: BTN_RIGHT,
  4: BTN_SPAWN,
};

class ButtonState {
  name: string;
  isDown: boolean = false;
  lastChange: number = 0;
  lastRepeat: number = 0;

  constructor(name: string) {
    this.name = name;
  }

  update(pressed: boolean, now: number): void {
    if (pressed !== this.isDown) {
      this.isDown = pressed;
      this.lastChange = now;
      this.lastRepeat = 0;
    }
  }

  shouldFire(
    now: number,
    repeatDelay: number = 0.18,
    repeatRate: number = 0.08
  ): boolean {
    if (!this.isDown) return false;

    // Prvé stlačenie: aktivovať okamžite, ak ešte nebolo spustené
    if (this.lastRepeat === 0) {
      this.lastRepeat = now;
      return true;
    }

    // Počiatočné oneskorenie opakovania: počkaj, kým neuplynie repeatDelay od začiatku stlačenia
    if (now - this.lastChange < repeatDelay) {
      return false;
    }

    // Neustále opakovanie: vykonávaj každých repeatRate
    if (now - this.lastRepeat >= repeatRate) {
      this.lastRepeat = now;
      return true;
    }

    return false;
  }
}

export class InputMapper {
  spacePtr: IMUSpacePointer;
  gyroRot: GyroRotateDetector;
  dropCtrl: AccelDropController;

  private thFingers: number[] = [1000, 1000, 1000, 1000, 1000];
  private enableAdcButtons: boolean = true;
  private btns: Record<string, ButtonState> = {};
  private lastAdcPressed: boolean[] = [];
  private lastTs: number | null = null;
  private lastImu: any = null;

  constructor(
    config: {
      fingerThresholds?: number[];
      posEnable?: boolean;
      posEma?: number;
      posDeadzoneA?: number;
      posLeak?: number;
      posSatAcc?: number;
      posSatVel?: number;
      posScaleX?: number;
      posScaleY?: number;
      posHyst?: number;
      gyroRotate?: boolean;
      gyroThreshold?: number;
      gyroCooldown?: number;
      gyroAlpha?: number;
      dropEnable?: boolean;
      dropSoft?: number;
      dropHard?: number;
      dropAlpha?: number;
      dropArm?: number;
    } = {}
  ) {
    for (const btnName of Object.values(FINGER_TO_BTN)) {
      this.btns[btnName] = new ButtonState(btnName);
    }

    // Inicializovať prahy prstov z konfigurácie ak sú k dispozícii, inak použiť predvolené hodnoty
    if (Array.isArray(config.fingerThresholds) && config.fingerThresholds.length >= 5) {
      this.thFingers = config.fingerThresholds.slice(0,5).map((v) => Number(v) || 1000);
    }

    this.spacePtr = new IMUSpacePointer({
      emaAlpha: config.posEma ?? 0.1,
      deadzoneA: config.posDeadzoneA ?? 0.01,
      leak: config.posLeak ?? 0.2,
      satAcc: config.posSatAcc ?? 8.0,
      satVel: config.posSatVel ?? 2.5,
      scaleX: config.posScaleX ?? 0.9,
      scaleY: config.posScaleY ?? 0.9,
      hysteresis: config.posHyst ?? 0.7,
    });
    this.spacePtr.enabled = config.posEnable ?? true;

    this.gyroRot = new GyroRotateDetector(
      config.gyroRotate ?? true,
      config.gyroThreshold ?? 18.0,
      config.gyroCooldown ?? 0.5,
      config.gyroAlpha ?? 0.22
    );

    this.dropCtrl = new AccelDropController({
      enabled: config.dropEnable ?? true,
      softThreshold: config.dropSoft ?? -30,
      hardThreshold: config.dropHard ?? -58,
      alpha: config.dropAlpha ?? 0.18,
      armThreshold: config.dropArm ?? 15.0,
    });
  }

  feedAdc(adc: number[]): void {
    const now = Date.now() / 1000;
    const cur: boolean[] = [];

    for (let i = 0; i < Math.min(adc.length, 5); i++) {
      const btnName = FINGER_TO_BTN[i];
      if (!btnName) {
        cur.push(false);
        continue;
      }

      const fval = parseFloat(adc[i]?.toString() || '0');
      const thr = this.thFingers[i];
      const pressed = Math.abs(fval) >= thr;
      cur.push(pressed);

      if (this.enableAdcButtons) {
        this.btns[btnName].update(pressed, now);
      }
    }

    this.lastAdcPressed = cur;
  }

  allFingersPressed(): boolean {
    return (
      this.lastAdcPressed.length > 0 && this.lastAdcPressed.every((p) => p)
    );
  }

  feedImu(imu: any, ts?: number): void {
    this.lastImu = imu;

    const now = Date.now() / 1000;
    if (this.lastTs === null) {
      this.lastTs = now;
    }
    const dt = Math.max(0, Math.min(0.05, now - this.lastTs));
    this.lastTs = now;

    this.spacePtr.feed(imu, dt, this.allFingersPressed());
    this.gyroRot.feed(imu);
    this.dropCtrl.feed(imu);
  }

  pollActions(): string[] {
    const now = Date.now() / 1000;
    const fires: string[] = [];

    const allFingers = this.allFingersPressed();

    if (!allFingers) {
      for (const [name, bs] of Object.entries(this.btns)) {
        if (name === BTN_ROTATE) continue;
        if (bs.shouldFire(now)) {
          fires.push(name);
        }
      }
    }

    if (this.gyroRot.pop()) {
      if (allFingers) {
        fires.push(BTN_ROTATE);
      }
    }

    const drops = this.dropCtrl.popAll();
    if (allFingers) {
      fires.push(...drops);
    }

    return fires;
  }

  getLastImu(): any {
    return this.lastImu;
  }

  calibrateSpacePointer(): void {
    if (this.lastImu) {
      this.spacePtr.calibrateZero(this.lastImu);
    }
  }
}
