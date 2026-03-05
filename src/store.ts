/**
 * Module-level shared state store (pub/sub).
 * Bridges sidebar (ScorePanel) and main view (MainView) across separate React trees.
 */

import * as React from "react";
import { ScoreData } from "./types";
import { ChordAnnotation } from "./core/aiService";
import type { PlaybackHandle } from "./core/player";

export interface StoreState {
  score: ScoreData | null;
  chordAnnotations: ChordAnnotation[];
  fileName: string;
  playbackHandle: PlaybackHandle | null;
  playFromMeasure: number | null;
}

type Listener = (state: StoreState) => void;

let state: StoreState = { score: null, chordAnnotations: [], fileName: "", playbackHandle: null, playFromMeasure: null };
const listeners = new Set<Listener>();

export function getState(): StoreState {
  return state;
}

export function setState(partial: Partial<StoreState>): void {
  state = { ...state, ...partial };
  for (const fn of listeners) fn(state);
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** React hook — subscribes to store changes. */
export function useStore(): StoreState {
  const [snap, setSnap] = React.useState(getState);
  React.useEffect(() => {
    const unsub = subscribe(setSnap);
    // Re-sync in case state changed between initial render and subscription
    setSnap(getState());
    return unsub;
  }, []);
  return snap;
}
