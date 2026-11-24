// Static local MP3s only. A missing or blocked clip is silently skipped.
export type Cue =
  | 'jump' | 'stomp' | 'pickup' | 'feed' | 'deposit' | 'wrong'
  | 'blip' | 'learned' | 'beam' | 'board' | 'chapter';

const CUES: Cue[] = ['jump', 'stomp', 'pickup', 'feed', 'deposit', 'wrong', 'blip', 'learned', 'beam', 'board', 'chapter'];
const VOLUME: Partial<Record<Cue, number>> = { blip: 0.3, stomp: 0.45, feed: 0.5, jump: 0.95 };
const KEY = 'power-loader-muted';

export class Audio {
  muted: boolean;
  private clips = new Map<Cue, HTMLAudioElement>();
  private broken = new Set<Cue>();
  private lastPlayed = new Map<Cue, number>();

  constructor() {
    this.muted = localStorage.getItem(KEY) === '1';
    for (const cue of CUES) {
      const el = new window.Audio();
      el.preload = 'auto';
      el.src = `${import.meta.env.BASE_URL}audio/${cue}.mp3`;
      el.addEventListener('error', () => this.broken.add(cue));
      this.clips.set(cue, el);
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    localStorage.setItem(KEY, m ? '1' : '0');
  }

  play(cue: Cue, minGap = 0.06) {
    if (this.muted || this.broken.has(cue)) return;
    const now = performance.now() / 1000;
    if (now - (this.lastPlayed.get(cue) ?? -1) < minGap) return;
    this.lastPlayed.set(cue, now);
    const base = this.clips.get(cue);
    if (!base) return;
    try {
      const el = base.cloneNode() as HTMLAudioElement;
      el.volume = VOLUME[cue] ?? 0.7;
      el.play().catch(() => {});
    } catch {
      /* audio is optional */
    }
  }
}
