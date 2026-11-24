// Contract between the game and the character art.
// The game owns physics; these adapters own playback, facing, jump pose and
// visual offsets. Replacing the art means reimplementing this file's exports.
//
// Coordinates: 1280x720 logical canvas space, y grows downward.
// `x` is the body's horizontal centre, `y` is the ground contact line (feet).

export type FileColor = 'red' | 'blue' | 'green' | 'purple';

export const FILE_HEX: Record<FileColor, string> = {
  red: '#e8483f',
  blue: '#3f8ff0',
  green: '#4fcf63',
  purple: '#9a5cf0',
};

export interface BodyState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  facing: 1 | -1;
  /** File held in the hands / loader grip, if any. */
  carrying: FileColor | null;
  /** Something other than a file in hand (the inspector's tea). */
  holding?: 'tea' | null;
}

export interface LoaderState extends BodyState {
  /** Inspector seated in the cage. */
  piloted: boolean;
  /** 0 = parked and powered down, 1 = running. */
  power: number;
}

/** Collision sizes the art is drawn to fit (width, height above `y`). */
export const INSPECTOR_BODY = { w: 30, h: 94 };
export const LOADER_BODY = { w: 92, h: 150 };

export interface CharacterView<S> {
  /** Advance playback. Called once per fixed step with the physics state. */
  update(dt: number, state: S): void;
  /** Draw at the last updated state. `time` is seconds since start (for idle flicker). */
  draw(ctx: CanvasRenderingContext2D, time: number): void;
}

/**
 * Boarding / dismount choreography.
 * u runs 0 -> 1 over BOARDING_SECONDS. At u=0 the inspector stands at
 * `inspectorX` on the ground; at u=1 they are seated in the loader.
 * Dismount plays the same with u running 1 -> 0.
 */
export const BOARDING_SECONDS = 1.4;
