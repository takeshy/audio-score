/**
 * Canvas 2D piano roll renderer.
 * Draws MIDI notes as rectangles on a time × pitch grid.
 */

import { ScoreData, DURATION_BEATS } from "../types";

/** Layout constants */
const KEY_LABEL_WIDTH = 40;
const HEADER_HEIGHT = 24;
const PITCH_HEIGHT = 6;       // pixels per semitone
const PIXELS_PER_BEAT = 40;
const PADDING_SEMITONES = 2;  // extra range above/below

export interface PianoRollOptions {
  width: number;
  backgroundColor?: string;
  gridColor?: string;
  noteColor?: string;
  barLineColor?: string;
  labelColor?: string;
}

const DEFAULTS: Required<PianoRollOptions> = {
  width: 800,
  backgroundColor: "#ffffff",
  gridColor: "#e0e0e0",
  noteColor: "#2563eb",
  barLineColor: "#999999",
  labelColor: "#333333",
};

/** Note names for labelling (C only) */
function midiNoteName(midi: number): string | null {
  if (midi % 12 !== 0) return null;
  const octave = Math.floor(midi / 12) - 1;
  return `C${octave}`;
}

/** Whether a MIDI pitch is a black key */
function isBlackKey(midi: number): boolean {
  const pc = midi % 12;
  return [1, 3, 6, 8, 10].includes(pc);
}

/** Compute MIDI range from score notes */
function midiRange(score: ScoreData): { min: number; max: number } {
  let min = 127;
  let max = 0;
  for (const m of score.measures) {
    for (const n of m.notes) {
      if (n.midi < 0) continue; // rest
      if (n.midi < min) min = n.midi;
      if (n.midi > max) max = n.midi;
    }
  }
  if (min > max) return { min: 60, max: 72 }; // fallback
  return {
    min: Math.max(0, min - PADDING_SEMITONES),
    max: Math.min(127, max + PADDING_SEMITONES),
  };
}

/** Total beats in the score */
function totalBeats(score: ScoreData): number {
  return score.measures.length * score.beatsPerMeasure;
}

/**
 * Calculate required canvas dimensions for the piano roll.
 */
export function calculatePianoRollSize(
  score: ScoreData,
  options: PianoRollOptions,
): { width: number; height: number } {
  const range = midiRange(score);
  const pitchSpan = range.max - range.min + 1;
  const beats = totalBeats(score);

  const contentWidth = KEY_LABEL_WIDTH + beats * PIXELS_PER_BEAT;
  const width = Math.max(options.width, contentWidth);
  const height = HEADER_HEIGHT + pitchSpan * PITCH_HEIGHT;

  return { width, height };
}

/**
 * Render piano roll to a canvas context.
 */
export function renderPianoRoll(
  ctx: CanvasRenderingContext2D,
  score: ScoreData,
  options: PianoRollOptions,
): void {
  const opts = { ...DEFAULTS, ...options };
  const range = midiRange(score);
  const pitchSpan = range.max - range.min + 1;
  const beats = totalBeats(score);

  const contentWidth = KEY_LABEL_WIDTH + beats * PIXELS_PER_BEAT;
  const canvasWidth = Math.max(opts.width, contentWidth);
  const canvasHeight = HEADER_HEIGHT + pitchSpan * PITCH_HEIGHT;

  // --- Background ---
  ctx.fillStyle = opts.backgroundColor;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // --- Key label area background (drawn first so grid doesn't bleed into it) ---
  ctx.fillStyle = opts.backgroundColor;
  ctx.fillRect(0, 0, KEY_LABEL_WIDTH, canvasHeight);

  // --- Pitch stripes (white/black key alternation) ---
  for (let midi = range.min; midi <= range.max; midi++) {
    const y = HEADER_HEIGHT + (range.max - midi) * PITCH_HEIGHT;
    if (isBlackKey(midi)) {
      ctx.fillStyle = opts.gridColor;
      ctx.fillRect(KEY_LABEL_WIDTH, y, canvasWidth - KEY_LABEL_WIDTH, PITCH_HEIGHT);
    }
  }

  // --- Beat grid lines ---
  ctx.strokeStyle = opts.gridColor;
  for (let b = 0; b <= beats; b++) {
    const x = KEY_LABEL_WIDTH + b * PIXELS_PER_BEAT;
    const isBar = b % score.beatsPerMeasure === 0;
    ctx.lineWidth = isBar ? 1.5 : 0.5;
    if (isBar) ctx.strokeStyle = opts.barLineColor;
    else ctx.strokeStyle = opts.gridColor;
    ctx.beginPath();
    ctx.moveTo(x, HEADER_HEIGHT);
    ctx.lineTo(x, canvasHeight);
    ctx.stroke();
  }

  // --- Note rectangles ---
  const beatDuration = 60 / score.bpm;
  let beatOffset = 0;
  for (const measure of score.measures) {
    for (const note of measure.notes) {
      if (note.midi < 0) continue; // skip rests

      // Compute beat position within measure from startTime
      const measureStartTime = beatOffset * beatDuration;
      const relativeTime = note.startTime - measureStartTime;
      const beatInMeasure = relativeTime / beatDuration;

      const x = KEY_LABEL_WIDTH + (beatOffset + Math.max(0, beatInMeasure)) * PIXELS_PER_BEAT;
      const y = HEADER_HEIGHT + (range.max - note.midi) * PITCH_HEIGHT;

      const durationBeats = DURATION_BEATS[note.durationType] * (note.dotted ? 1.5 : 1);
      const w = Math.max(2, durationBeats * PIXELS_PER_BEAT - 1);
      const h = PITCH_HEIGHT - 1;

      ctx.fillStyle = opts.noteColor;
      ctx.fillRect(x, y, w, h);
    }
    beatOffset += score.beatsPerMeasure;
  }

  // --- Separator line between key labels and grid ---
  ctx.strokeStyle = opts.barLineColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(KEY_LABEL_WIDTH, 0);
  ctx.lineTo(KEY_LABEL_WIDTH, canvasHeight);
  ctx.stroke();

  // --- Header bottom line ---
  ctx.beginPath();
  ctx.moveTo(0, HEADER_HEIGHT);
  ctx.lineTo(canvasWidth, HEADER_HEIGHT);
  ctx.stroke();

  // --- Measure numbers (on top of header) ---
  ctx.fillStyle = opts.labelColor;
  ctx.font = "11px sans-serif";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  for (let m = 0; m < score.measures.length; m++) {
    const x = KEY_LABEL_WIDTH + m * score.beatsPerMeasure * PIXELS_PER_BEAT +
      (score.beatsPerMeasure * PIXELS_PER_BEAT) / 2;
    ctx.fillText(String(m + 1), x, 4);
  }

  // --- Key labels (octave C only, on top of label area) ---
  ctx.fillStyle = opts.labelColor;
  ctx.font = "10px sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (let midi = range.min; midi <= range.max; midi++) {
    const label = midiNoteName(midi);
    if (!label) continue;
    const y = HEADER_HEIGHT + (range.max - midi) * PITCH_HEIGHT + PITCH_HEIGHT / 2;
    ctx.fillText(label, KEY_LABEL_WIDTH - 4, y);
  }

}
