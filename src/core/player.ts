/**
 * Score playback using Web Audio API.
 */

import { ScoreData, DURATION_BEATS } from "../types";
import { midiToFrequency } from "./musicTheory";

export interface PlaybackHandle {
  stop(): void;
  finished: Promise<void>;
}

/**
 * Play a ScoreData through Web Audio API using triangle-wave oscillators.
 * Uses each note's startTime for accurate scheduling.
 * Limits total oscillators to MAX_OSCILLATORS to avoid browser overload.
 */
export function playScore(score: ScoreData): PlaybackHandle {
  const ctx = new AudioContext();
  const nodes: OscillatorNode[] = [];
  let stopped = false;

  const beatDuration = 60 / score.bpm;
  const baseTime = ctx.currentTime + 0.05; // small lookahead
  const MAX_OSCILLATORS = 500;

  let lastEnd = 0;

  for (const measure of score.measures) {
    for (const note of measure.notes) {
      if (note.midi < 0) continue; // skip rests
      if (nodes.length >= MAX_OSCILLATORS) break;

      const dur =
        DURATION_BEATS[note.durationType] * (note.dotted ? 1.5 : 1) * beatDuration;
      if (dur <= 0) continue;
      const noteStart = baseTime + note.startTime;

      const freq = midiToFrequency(note.midi);

      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = freq;

      const gain = ctx.createGain();
      const attack = Math.min(0.02, dur * 0.1);
      const release = Math.min(0.02, dur * 0.1);
      const sustainEnd = Math.max(noteStart + attack, noteStart + dur - release);
      gain.gain.setValueAtTime(0, noteStart);
      gain.gain.linearRampToValueAtTime(0.3, noteStart + attack);
      gain.gain.setValueAtTime(0.3, sustainEnd);
      gain.gain.linearRampToValueAtTime(0, noteStart + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(noteStart);
      osc.stop(noteStart + dur);
      nodes.push(osc);

      const noteEnd = note.startTime + dur;
      if (noteEnd > lastEnd) lastEnd = noteEnd;
    }
    if (nodes.length >= MAX_OSCILLATORS) break;
  }

  const totalDuration = lastEnd + 0.05;

  let resolveFinished: (() => void) | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
    timeoutId = setTimeout(() => {
      if (!stopped) {
        ctx.close().catch(() => {});
      }
      resolve();
    }, totalDuration * 1000 + 100);
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timeoutId !== null) clearTimeout(timeoutId);
    for (const osc of nodes) {
      try {
        osc.stop();
      } catch {
        // already stopped
      }
    }
    ctx.close().catch(() => {});
    resolveFinished?.();
  }

  return { stop, finished };
}
