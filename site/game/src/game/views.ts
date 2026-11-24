// The only place the game touches character art. Swap implementations here.
import type { BodyState, CharacterView, LoaderState } from '../rig/api';
import { InspectorView } from '../rig/inspector';
import { LoaderView } from '../rig/loader';

export interface LoaderViewLike extends CharacterView<LoaderState> {
  roofAnchor(): { x: number; y: number };
  /** Draws loader and climbing inspector together; replaces both draws for the frame. */
  drawBoarding(ctx: CanvasRenderingContext2D, u: number, inspectorX: number, time: number): void;
  onStomp?: () => void;
  onLand?: () => void;
}

export interface Views {
  inspector: CharacterView<BodyState>;
  loader: LoaderViewLike;
}

export function makeViews(): Views {
  return { inspector: new InspectorView(), loader: new LoaderView() };
}
