/**
 * Canvas 2D sheet music renderer.
 * Draws staff lines, clef, key signature, time signature, notes,
 * stems, flags, accidentals, ledger lines, and bar lines.
 */

import {
  ScoreData,
  DetectedNote,
  ClefType,
  KeySignature,
  Measure,
  DurationType,
  DURATION_BEATS,
} from "../types";
import { midiToStaffPosition, getAccidental } from "../core/musicTheory";
import type { ChordAnnotation } from "../core/aiService";
import { BeatGroup, groupBeats, measuresToText } from "../core/scoreParser";

/** Convert hex color to rgba string. */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16) || 0;
  const g = parseInt(h.substring(2, 4), 16) || 0;
  const b = parseInt(h.substring(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Layout constants */
const STAFF_LINE_SPACING = 10; // pixels between staff lines
const STAFF_LINES = 5;
const STAFF_HEIGHT = STAFF_LINE_SPACING * (STAFF_LINES - 1); // 40px
const TOP_MARGIN = 50;
const BOTTOM_MARGIN = 30;
const LEFT_MARGIN = 15;
const RIGHT_MARGIN = 10;
const CLEF_WIDTH = 35;
const KEY_SIG_WIDTH = 14; // per accidental
const TIME_SIG_WIDTH = 24;
const NOTE_HEAD_RX = 4; // horizontal radius
const NOTE_HEAD_RY = 3; // vertical radius
const STEM_LENGTH = 28;
const FLAG_LENGTH = 10;
const BARLINE_GAP = 8; // space before/after barline
const DECOR_PAD = 10; // extra space between decorations (clef/key/time) and note area
const SYSTEM_GAP = 140; // vertical gap between systems
const BAR_LINE_EXTRA = 2;

/** Duration-proportional width units (quarter note = 1.0) */
const DURATION_WIDTH: Record<string, number> = {
  whole: 3.0,
  half: 2.0,
  quarter: 1.0,
  eighth: 0.7,
  sixteenth: 0.5,
  thirty_second: 0.35,
};

/** Compute width units for a single beat group. */
function beatUnits(bg: BeatGroup): number {
  const base = DURATION_WIDTH[bg.durationType] ?? 1.0;
  return bg.dotted ? base * 1.3 : base;
}

/** Rest duration types, largest first. */
const REST_TYPES: DurationType[] = ["whole", "half", "quarter", "eighth", "sixteenth", "thirty_second"];

function makeRest(startTime: number, durationSec: number, durationType: DurationType): DetectedNote {
  return { midi: -1, name: "rest", startTime, duration: durationSec, durationType, dotted: false, frequency: 0, amplitude: 0 };
}

/**
 * Ensure every measure has rests filling gaps between notes.
 * Skips measures that already contain rests.
 */
function ensureRests(score: ScoreData): void {
  const beatDur = 60 / score.bpm;
  const measureDur = beatDur * score.beatsPerMeasure;
  const downbeat = score.downbeatOffset ?? 0;

  for (const measure of score.measures) {
    // Skip if already has rests
    if (measure.notes.some((n) => n.midi < 0)) continue;

    const mStart = downbeat + (measure.number - 1) * measureDur;
    const mEnd = mStart + measureDur;
    const sorted = [...measure.notes].sort((a, b) => a.startTime - b.startTime);
    const filled: DetectedNote[] = [];
    let cursor = mStart;
    const tol = beatDur * 0.06;

    let i = 0;
    while (i < sorted.length) {
      const noteStart = sorted[i].startTime;
      // Fill gap before this note
      if (noteStart > cursor + tol) {
        emitRests(filled, cursor, noteStart, beatDur);
      }
      // Collect chord (simultaneous notes)
      let maxEnd = 0;
      while (i < sorted.length && Math.abs(sorted[i].startTime - noteStart) < tol) {
        filled.push(sorted[i]);
        maxEnd = Math.max(maxEnd, sorted[i].startTime + sorted[i].duration);
        i++;
      }
      cursor = Math.max(cursor, maxEnd);
    }
    // Fill gap at end
    if (mEnd > cursor + tol) {
      emitRests(filled, cursor, mEnd, beatDur);
    }
    measure.notes = filled;
  }
}

function emitRests(out: DetectedNote[], from: number, to: number, beatDur: number): void {
  let cursor = from;
  const tol = beatDur * 0.06;
  for (const rt of REST_TYPES) {
    const dur = DURATION_BEATS[rt] * beatDur;
    while (cursor + dur <= to + tol) {
      out.push(makeRest(cursor, dur, rt));
      cursor += dur;
    }
  }
}

export interface RenderOptions {
  width: number;
  backgroundColor?: string;
  staffColor?: string;
  noteColor?: string;
  accentColor?: string;
  chordAnnotations?: ChordAnnotation[];
  highlightMeasure?: number;
}

const DEFAULT_OPTIONS: Required<RenderOptions> = {
  width: 800,
  backgroundColor: "#ffffff",
  staffColor: "#333333",
  noteColor: "#000000",
  accentColor: "#2563eb",
  chordAnnotations: [],
  highlightMeasure: 0,
};

/**
 * Calculate required canvas dimensions for the score.
 */
/** Extra vertical space above each system when chord annotations are present. */
const CHORD_TOP_EXTRA = 15;

/**
 * Compute the minimum top margin so that high notes are not clipped.
 * Scans all notes and ensures enough space above the staff for ledger lines,
 * accidentals, and the score header.
 */
function computeTopMargin(score: ScoreData, baseTopMargin: number): number {
  let minNoteY = 0; // most negative offset relative to staffTop
  for (const measure of score.measures) {
    for (const note of measure.notes) {
      if (note.midi < 0) continue;
      const y = noteToY(note.midi, 0, score.clef);
      if (y < minNoteY) minNoteY = y;
    }
  }
  if (minNoteY >= 0) return baseTopMargin;
  // Space for: note head + ledger lines + score header (15px) + padding
  const needed = -minNoteY + 25;
  return Math.max(baseTopMargin, needed);
}

export function calculateSize(
  score: ScoreData,
  options: RenderOptions
): { width: number; height: number } {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  ensureRests(score);
  const hasChords = opts.chordAnnotations && opts.chordAnnotations.length > 0;
  const topMargin = computeTopMargin(score, hasChords ? TOP_MARGIN + CHORD_TOP_EXTRA : TOP_MARGIN);
  const systemGap = hasChords ? SYSTEM_GAP + CHORD_TOP_EXTRA : SYSTEM_GAP;
  const layout = layoutSystems(score, opts, topMargin, systemGap);
  const height = layout.systems.length * (STAFF_HEIGHT + systemGap) + topMargin + BOTTOM_MARGIN;
  return { width: layout.canvasWidth, height };
}

export interface SystemLayout {
  measures: Measure[];
  y: number; // top of staff
}

/** Fixed number of measures per system. */
const MEASURES_PER_SYSTEM = 3;

function layoutSystems(
  score: ScoreData,
  opts: Required<RenderOptions>,
  topMargin: number = TOP_MARGIN,
  systemGap: number = SYSTEM_GAP,
): { systems: SystemLayout[]; canvasWidth: number } {
  const systems: SystemLayout[] = [];

  for (let i = 0; i < score.measures.length; i += MEASURES_PER_SYSTEM) {
    systems.push({
      measures: score.measures.slice(i, i + MEASURES_PER_SYSTEM),
      y: topMargin + systems.length * (STAFF_HEIGHT + systemGap),
    });
  }

  return { systems, canvasWidth: opts.width };
}

/**
 * Expose layout information for external consumers (e.g. PDF export).
 */
export function getSystemLayouts(
  score: ScoreData,
  opts: RenderOptions,
): {
  systems: SystemLayout[];
  canvasWidth: number;
  staffHeight: number;
  systemGap: number;
  topMargin: number;
  bottomMargin: number;
} {
  const fullOpts = { ...DEFAULT_OPTIONS, ...opts };
  ensureRests(score);
  const hasChords = fullOpts.chordAnnotations && fullOpts.chordAnnotations.length > 0;
  const topM = computeTopMargin(score, hasChords ? TOP_MARGIN + CHORD_TOP_EXTRA : TOP_MARGIN);
  const sysGap = hasChords ? SYSTEM_GAP + CHORD_TOP_EXTRA : SYSTEM_GAP;
  const { systems, canvasWidth } = layoutSystems(score, fullOpts, topM, sysGap);
  return {
    systems,
    canvasWidth,
    staffHeight: STAFF_HEIGHT,
    systemGap: sysGap,
    topMargin: topM,
    bottomMargin: BOTTOM_MARGIN,
  };
}

/**
 * Render the complete score to a canvas context.
 */
export function renderScore(
  ctx: CanvasRenderingContext2D,
  score: ScoreData,
  options: RenderOptions
): void {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const hasChords = opts.chordAnnotations && opts.chordAnnotations.length > 0;
  const topMargin = computeTopMargin(score, hasChords ? TOP_MARGIN + CHORD_TOP_EXTRA : TOP_MARGIN);
  const systemGap = hasChords ? SYSTEM_GAP + CHORD_TOP_EXTRA : SYSTEM_GAP;
  // Ensure rests are present in measure data
  ensureRests(score);

  const { systems, canvasWidth } = layoutSystems(score, opts, topMargin, systemGap);

  // Clear
  ctx.fillStyle = opts.backgroundColor;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Use canvasWidth for staff line right edge
  const renderOpts = { ...opts, width: canvasWidth };

  // Draw score header (tempo + key) above the first system
  if (systems.length > 0) {
    drawScoreHeader(ctx, systems[0].y, renderOpts.width, score, opts.noteColor);
  }

  for (const system of systems) {
    renderSystem(ctx, score, system, renderOpts);
  }
}

function renderSystem(
  ctx: CanvasRenderingContext2D,
  score: ScoreData,
  system: SystemLayout,
  opts: Required<RenderOptions>,
): void {
  const staffTop = system.y;
  const staffLeft = LEFT_MARGIN;
  const staffRight = opts.width - RIGHT_MARGIN;

  // Draw staff lines
  drawStaffLines(ctx, staffLeft, staffTop, staffRight, opts.staffColor);

  // Draw clef
  let decorEndX = staffLeft + 5;
  drawClef(ctx, decorEndX, staffTop, score.clef, opts.noteColor);
  decorEndX += CLEF_WIDTH;

  // Draw key signature
  decorEndX = drawKeySignature(ctx, decorEndX, staffTop, score.key.accidentals, score.clef, opts.noteColor);

  // Draw time signature (only on first system)
  if (system.measures[0]?.number === 1) {
    drawTimeSignature(ctx, decorEndX, staffTop, score.beatsPerMeasure, score.beatUnit, opts.noteColor);
    decorEndX += TIME_SIG_WIDTH;
  }

  decorEndX += DECOR_PAD;

  // Equal-width measure layout
  const numMeasures = system.measures.length;
  const measureWidth = (staffRight - decorEndX) / numMeasures;

  const chordAnns = opts.chordAnnotations ?? [];
  for (let mi = 0; mi < numMeasures; mi++) {
    const measure = system.measures[mi];
    const measureStartX = decorEndX + mi * measureWidth;

    // Highlight current playback measure
    if (opts.highlightMeasure > 0 && measure.number === opts.highlightMeasure) {
      ctx.save();
      ctx.fillStyle = hexToRgba(opts.accentColor, 0.15);
      ctx.fillRect(measureStartX, staffTop - 5, measureWidth, STAFF_HEIGHT + 10);
      ctx.restore();
    }

    const beats = groupBeats(measure.notes);

    // Total beat units in this measure for proportional placement
    let totalUnits = 0;
    for (const bg of beats) totalUnits += beatUnits(bg);
    if (totalUnits <= 0) totalUnits = 1;

    const noteAreaWidth = measureWidth - BARLINE_GAP * 2;
    let cumUnits = 0;

    for (let beatIdx = 0; beatIdx < beats.length; beatIdx++) {
      const bg = beats[beatIdx];
      const noteX = measureStartX + BARLINE_GAP + (cumUnits / totalUnits) * noteAreaWidth;

      // Draw chord annotation if present
      if (chordAnns.length > 0) {
        const ann = chordAnns.find(
          (a) => a.measureNumber === measure.number && a.beatIndex === beatIdx,
        );
        if (ann) {
          drawChordName(ctx, noteX, staffTop, ann.chordName, opts.noteColor);
        }
      }

      // Check if this beat group is a rest (all notes have midi < 0)
      const isRest = bg.notes.every((n) => n.midi < 0);
      if (isRest) {
        drawRest(ctx, noteX, staffTop, bg.durationType, opts.noteColor);
      } else {
        // Draw all note heads + ledger lines + accidentals at the same x
        for (const note of bg.notes) {
          drawNoteHead_full(ctx, noteX, staffTop, note, score.clef, score.key, opts.noteColor);
        }
        // Draw a single shared stem/flags/dot for the beat group
        drawStemForGroup(ctx, noteX, staffTop, bg, score.clef, opts.noteColor);
      }
      cumUnits += beatUnits(bg);
    }

    // Bar line between measures
    if (mi < numMeasures - 1) {
      const barlineX = measureStartX + measureWidth;
      drawBarLine(ctx, barlineX, staffTop, opts.staffColor);
    }
  }

  // Final bar line (double)
  drawFinalBarLine(ctx, staffRight - 5, staffTop, opts.staffColor);
}

function drawStaffLines(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  right: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let i = 0; i < STAFF_LINES; i++) {
    const y = top + i * STAFF_LINE_SPACING;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
}

function drawClef(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  clef: ClefType,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.font = "bold 28px serif";
  ctx.textBaseline = "middle";

  if (clef === "treble") {
    // Draw treble clef using canvas paths (Unicode U+1D11E not available in most fonts)
    drawTrebleClef(ctx, x + 14, staffTop, color);
  } else {
    // Draw bass clef using canvas paths
    drawBassClef(ctx, x + 10, staffTop, color);
  }
}

/** Draw a simplified treble clef (G clef) using canvas paths */
function drawTrebleClef(
  ctx: CanvasRenderingContext2D,
  cx: number,
  staffTop: number,
  color: string
): void {
  const scale = STAFF_HEIGHT / 40;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.8 * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Main S-curve of the treble clef
  const baseY = staffTop + STAFF_HEIGHT / 2;
  ctx.beginPath();
  // Bottom curl
  ctx.moveTo(cx - 2 * scale, baseY + 18 * scale);
  ctx.quadraticCurveTo(cx - 8 * scale, baseY + 14 * scale, cx - 6 * scale, baseY + 8 * scale);
  ctx.quadraticCurveTo(cx - 4 * scale, baseY + 2 * scale, cx + 2 * scale, baseY - 2 * scale);
  // Upper curve
  ctx.quadraticCurveTo(cx + 10 * scale, baseY - 10 * scale, cx + 6 * scale, baseY - 18 * scale);
  ctx.quadraticCurveTo(cx + 2 * scale, baseY - 24 * scale, cx - 4 * scale, baseY - 20 * scale);
  // Back down through center
  ctx.quadraticCurveTo(cx - 8 * scale, baseY - 16 * scale, cx - 4 * scale, baseY - 6 * scale);
  ctx.quadraticCurveTo(cx - 1 * scale, baseY + 2 * scale, cx + 0 * scale, baseY + 10 * scale);
  ctx.stroke();

  // Vertical line through center
  ctx.beginPath();
  ctx.moveTo(cx, baseY - 22 * scale);
  ctx.lineTo(cx, baseY + 20 * scale);
  ctx.stroke();

  // Bottom circle
  ctx.beginPath();
  ctx.arc(cx - 1 * scale, baseY + 20 * scale, 2.5 * scale, 0, 2 * Math.PI);
  ctx.fill();

  ctx.restore();
}

/** Draw a simplified bass clef (F clef) using canvas paths */
function drawBassClef(
  ctx: CanvasRenderingContext2D,
  cx: number,
  staffTop: number,
  color: string
): void {
  const scale = STAFF_HEIGHT / 40;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.8 * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Main curve - starts from the 4th line (F line), curls down
  const baseY = staffTop + STAFF_LINE_SPACING; // 2nd line from top (F3)
  ctx.beginPath();
  ctx.arc(cx - 2 * scale, baseY, 3.5 * scale, 0, 2 * Math.PI);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(cx + 1 * scale, baseY);
  ctx.quadraticCurveTo(cx + 12 * scale, baseY + 2 * scale, cx + 10 * scale, baseY + 12 * scale);
  ctx.quadraticCurveTo(cx + 8 * scale, baseY + 22 * scale, cx - 2 * scale, baseY + 24 * scale);
  ctx.stroke();

  // Two dots (to the right of the curve)
  const dotX = cx + 14 * scale;
  ctx.beginPath();
  ctx.arc(dotX, baseY - 3 * scale, 1.5 * scale, 0, 2 * Math.PI);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(dotX, baseY + 7 * scale, 1.5 * scale, 0, 2 * Math.PI);
  ctx.fill();

  ctx.restore();
}

function drawKeySignature(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  accidentals: number,
  clef: ClefType,
  color: string
): number {
  if (accidentals === 0) return x;

  ctx.fillStyle = color;
  ctx.font = "13px serif";
  ctx.textBaseline = "middle";

  // Sharp positions on treble clef (line/space from top, 0-indexed)
  const sharpPositions = clef === "treble"
    ? [0, 1.5, -0.5, 1, 2.5, 0.5, 2]  // F C G D A E B
    : [2, 3.5, 1.5, 3, 4.5, 2.5, 4];   // Bass clef positions

  // Flat positions on treble clef
  const flatPositions = clef === "treble"
    ? [2, 0.5, 2.5, 1, 3, 1.5, 3.5]    // B E A D G C F
    : [4, 2.5, 4.5, 3, 5, 3.5, 5.5];

  const count = Math.abs(accidentals);
  const isSharp = accidentals > 0;
  const positions = isSharp ? sharpPositions : flatPositions;
  const symbol = isSharp ? "\u266F" : "\u266D"; // ♯ or ♭

  for (let i = 0; i < count && i < positions.length; i++) {
    const y = staffTop + positions[i] * STAFF_LINE_SPACING;
    ctx.fillText(symbol, x, y);
    x += KEY_SIG_WIDTH * 0.8;
  }

  return x + 5;
}

function drawTimeSignature(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  numerator: number,
  denominator: number,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.font = "bold 15px serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  const centerX = x + TIME_SIG_WIDTH / 2;
  ctx.fillText(String(numerator), centerX, staffTop + STAFF_HEIGHT * 0.25);
  ctx.fillText(String(denominator), centerX, staffTop + STAFF_HEIGHT * 0.75);
  ctx.textAlign = "left";
}

/** Convert a note's MIDI to Y coordinate on staff. */
function noteToY(midi: number, staffTop: number, clef: ClefType): number {
  const pos = midiToStaffPosition(midi);
  if (clef === "treble") {
    return staffTop + (10 - pos) * (STAFF_LINE_SPACING / 2);
  }
  // Bass clef: top line is A3 (diatonic position -2)
  return staffTop + (-2 - pos) * (STAFF_LINE_SPACING / 2);
}

/** Draw note head, ledger lines, and accidental (no stem/flags/dot). */
function drawNoteHead_full(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  note: DetectedNote,
  clef: ClefType,
  key: KeySignature,
  color: string
): void {
  if (note.midi < 0) return;

  const y = noteToY(note.midi, staffTop, clef);

  drawLedgerLines(ctx, x, y, staffTop, color);

  const accidental = getAccidental(note.midi, key);
  if (accidental) {
    drawAccidental(ctx, x - 12, y, accidental, color);
  }

  const filled = note.durationType !== "whole" && note.durationType !== "half";
  drawNoteHead(ctx, x, y, filled, color);
}

/** Draw a single shared stem, flags, and dot for a beat group (chord or single note). */
function drawStemForGroup(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  bg: BeatGroup,
  clef: ClefType,
  color: string
): void {
  const validNotes = bg.notes.filter((n) => n.midi >= 0);
  if (validNotes.length === 0) return;

  const ys = validNotes.map((n) => noteToY(n.midi, staffTop, clef));
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const avgY = (minY + maxY) / 2;

  // Stem direction: up if average note is below staff center
  const stemUp = avgY > staffTop + STAFF_HEIGHT / 2;

  if (bg.durationType !== "whole") {
    // Stem from the outermost note head to STEM_LENGTH beyond
    const stemBaseY = stemUp ? maxY : minY;
    const stemTipY = stemUp ? minY - STEM_LENGTH : maxY + STEM_LENGTH;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (stemUp) {
      ctx.moveTo(x + NOTE_HEAD_RX - 1, stemBaseY);
      ctx.lineTo(x + NOTE_HEAD_RX - 1, stemTipY);
    } else {
      ctx.moveTo(x - NOTE_HEAD_RX + 1, stemBaseY);
      ctx.lineTo(x - NOTE_HEAD_RX + 1, stemTipY);
    }
    ctx.stroke();

    // Flags at stem tip
    if (bg.durationType === "eighth" || bg.durationType === "sixteenth" || bg.durationType === "thirty_second") {
      const numFlags = bg.durationType === "thirty_second" ? 3 : bg.durationType === "sixteenth" ? 2 : 1;
      // drawFlags expects the note Y that the stem was drawn from
      const flagNoteY = stemUp ? minY : maxY;
      drawFlags(ctx, x, flagNoteY, stemUp, numFlags, color);
    }
  }

  // Dot: draw beside the outermost note head (top for stem-up, bottom for stem-down)
  if (bg.dotted) {
    const dotY = stemUp ? minY : maxY;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + NOTE_HEAD_RX + 5, dotY, 1.5, 0, 2 * Math.PI);
    ctx.fill();
  }
}

/** Draw a rest symbol at the staff center for the given duration type. */
function drawRest(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  durationType: string,
  color: string,
): void {
  const midY = staffTop + STAFF_HEIGHT / 2; // between lines 2 and 3
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";

  switch (durationType) {
    case "whole": {
      // Filled rectangle hanging from line 2
      const y = staffTop + STAFF_LINE_SPACING; // line 2
      ctx.fillRect(x - 5, y, 10, STAFF_LINE_SPACING / 2);
      break;
    }
    case "half": {
      // Filled rectangle sitting on line 3
      const y = midY - STAFF_LINE_SPACING / 2;
      ctx.fillRect(x - 5, y, 10, STAFF_LINE_SPACING / 2);
      break;
    }
    case "quarter": {
      // Zigzag shape approximation
      const s = STAFF_LINE_SPACING * 0.45;
      ctx.beginPath();
      ctx.moveTo(x + s, midY - s * 2);
      ctx.lineTo(x - s * 0.5, midY - s * 0.5);
      ctx.lineTo(x + s * 0.5, midY + s * 0.5);
      ctx.lineTo(x - s, midY + s * 2);
      ctx.stroke();
      // Small diamonds at the bends
      ctx.beginPath();
      ctx.arc(x - s * 0.5, midY - s * 0.5, 2, 0, 2 * Math.PI);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + s * 0.5, midY + s * 0.5, 2, 0, 2 * Math.PI);
      ctx.fill();
      break;
    }
    case "eighth": {
      // Dot + angled stem + flag
      ctx.beginPath();
      ctx.arc(x, midY - 2, 2, 0, 2 * Math.PI);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, midY - 2);
      ctx.lineTo(x + 1, midY + 8);
      ctx.stroke();
      break;
    }
    case "sixteenth": {
      // Two dots + angled stem
      ctx.beginPath();
      ctx.arc(x, midY - 5, 2, 0, 2 * Math.PI);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, midY + 1, 2, 0, 2 * Math.PI);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, midY - 5);
      ctx.lineTo(x + 1, midY + 8);
      ctx.stroke();
      break;
    }
    case "thirty_second": {
      // Three dots + angled stem
      ctx.beginPath();
      ctx.arc(x, midY - 8, 1.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, midY - 2, 1.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, midY + 4, 1.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, midY - 8);
      ctx.lineTo(x + 1, midY + 10);
      ctx.stroke();
      break;
    }
  }

  ctx.restore();
}

function drawNoteHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  filled: boolean,
  color: string
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.2); // slight tilt

  ctx.beginPath();
  ctx.ellipse(0, 0, NOTE_HEAD_RX, NOTE_HEAD_RY, 0, 0, 2 * Math.PI);

  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  ctx.restore();
}

function drawStem(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  up: boolean,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();

  if (up) {
    ctx.moveTo(x + NOTE_HEAD_RX - 1, y);
    ctx.lineTo(x + NOTE_HEAD_RX - 1, y - STEM_LENGTH);
  } else {
    ctx.moveTo(x - NOTE_HEAD_RX + 1, y);
    ctx.lineTo(x - NOTE_HEAD_RX + 1, y + STEM_LENGTH);
  }

  ctx.stroke();
}

function drawFlags(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  up: boolean,
  count: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;

  for (let i = 0; i < count; i++) {
    const offset = i * 6;
    ctx.beginPath();
    if (up) {
      const stemX = x + NOTE_HEAD_RX - 1;
      const stemTop = y - STEM_LENGTH + offset;
      ctx.moveTo(stemX, stemTop);
      ctx.quadraticCurveTo(
        stemX + 10,
        stemTop + FLAG_LENGTH * 0.4,
        stemX + 2,
        stemTop + FLAG_LENGTH
      );
    } else {
      const stemX = x - NOTE_HEAD_RX + 1;
      const stemBottom = y + STEM_LENGTH - offset;
      ctx.moveTo(stemX, stemBottom);
      ctx.quadraticCurveTo(
        stemX - 10,
        stemBottom - FLAG_LENGTH * 0.4,
        stemX - 2,
        stemBottom - FLAG_LENGTH
      );
    }
    ctx.stroke();
  }
}

function drawAccidental(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  type: string,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.font = "11px serif";
  ctx.textBaseline = "middle";

  let symbol = "";
  if (type === "#") symbol = "\u266F"; // ♯
  else if (type === "b") symbol = "\u266D"; // ♭
  else if (type === "n") symbol = "\u266E"; // ♮

  ctx.fillText(symbol, x, y);
}

function drawLedgerLines(
  ctx: CanvasRenderingContext2D,
  x: number,
  noteY: number,
  staffTop: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const staffBottom = staffTop + STAFF_HEIGHT;
  const lineLen = NOTE_HEAD_RX * 2 + 4;

  // Ledger lines above staff
  if (noteY < staffTop) {
    for (let ly = staffTop - STAFF_LINE_SPACING; ly >= noteY - 1; ly -= STAFF_LINE_SPACING) {
      ctx.beginPath();
      ctx.moveTo(x - lineLen / 2, ly);
      ctx.lineTo(x + lineLen / 2, ly);
      ctx.stroke();
    }
  }

  // Ledger lines below staff
  if (noteY > staffBottom) {
    for (let ly = staffBottom + STAFF_LINE_SPACING; ly <= noteY + 1; ly += STAFF_LINE_SPACING) {
      ctx.beginPath();
      ctx.moveTo(x - lineLen / 2, ly);
      ctx.lineTo(x + lineLen / 2, ly);
      ctx.stroke();
    }
  }

}

function drawBarLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, staffTop - BAR_LINE_EXTRA);
  ctx.lineTo(x, staffTop + STAFF_HEIGHT + BAR_LINE_EXTRA);
  ctx.stroke();
}

function drawFinalBarLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  color: string
): void {
  ctx.strokeStyle = color;
  // Thin line
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 5, staffTop - BAR_LINE_EXTRA);
  ctx.lineTo(x - 5, staffTop + STAFF_HEIGHT + BAR_LINE_EXTRA);
  ctx.stroke();
  // Thick line
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, staffTop - BAR_LINE_EXTRA);
  ctx.lineTo(x, staffTop + STAFF_HEIGHT + BAR_LINE_EXTRA);
  ctx.stroke();
}

/** Draw tempo marking and key label above the first system. */
function drawScoreHeader(
  ctx: CanvasRenderingContext2D,
  staffTop: number,
  canvasWidth: number,
  score: ScoreData,
  color: string,
): void {
  const y = staffTop - 15;

  ctx.save();
  ctx.fillStyle = color;
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";

  // Left: tempo marking  ♩= {bpm}
  ctx.font = "16px serif";
  ctx.fillText("♩", LEFT_MARGIN + 5, y);
  const noteWidth = ctx.measureText("♩").width;
  ctx.font = "bold 11px sans-serif";
  ctx.fillText(`= ${score.bpm}`, LEFT_MARGIN + 5 + noteWidth + 1, y);

  // Right: key  {root} {mode}
  ctx.textAlign = "right";
  ctx.fillText(`${score.key.root} ${score.key.mode}`, canvasWidth - RIGHT_MARGIN, y);

  ctx.restore();
}

/** Draw a chord name above the staff. */
function drawChordName(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  chordName: string,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = "bold 10px sans-serif";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillText(chordName, x - 4, staffTop - 4);
  ctx.restore();
}

/**
 * Hit-test a CSS coordinate against the score layout.
 * Returns the 1-based measure number at (x, y), or null if no measure was hit.
 */
export function hitTestMeasure(
  score: ScoreData,
  options: RenderOptions,
  x: number,
  y: number,
): number | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const hasChords = opts.chordAnnotations && opts.chordAnnotations.length > 0;
  const topMargin = computeTopMargin(score, hasChords ? TOP_MARGIN + CHORD_TOP_EXTRA : TOP_MARGIN);
  const systemGap = hasChords ? SYSTEM_GAP + CHORD_TOP_EXTRA : SYSTEM_GAP;
  const { systems } = layoutSystems(score, opts, topMargin, systemGap);

  for (const system of systems) {
    const staffTop = system.y;
    // Generous vertical hit area: from above chord annotations to below staff
    if (y < staffTop - 20 || y > staffTop + STAFF_HEIGHT + 20) continue;

    const staffLeft = LEFT_MARGIN;
    const staffRight = opts.width - RIGHT_MARGIN;

    // Compute decorEndX (same logic as renderSystem)
    let decorEndX = staffLeft + 5 + CLEF_WIDTH;
    const keyAccCount = Math.abs(score.key.accidentals);
    if (keyAccCount > 0) {
      decorEndX += keyAccCount * KEY_SIG_WIDTH * 0.8 + 5;
    }
    if (system.measures[0]?.number === 1) {
      decorEndX += TIME_SIG_WIDTH;
    }
    decorEndX += DECOR_PAD;

    const numMeasures = system.measures.length;
    const measureWidth = (staffRight - decorEndX) / numMeasures;

    for (let mi = 0; mi < numMeasures; mi++) {
      const measureStartX = decorEndX + mi * measureWidth;
      const measureEndX = measureStartX + measureWidth;
      if (x >= measureStartX && x < measureEndX) {
        return system.measures[mi].number;
      }
    }
  }
  return null;
}

/**
 * Generate a text summary of the score for export.
 */
export function scoreToText(score: ScoreData): string {
  const header = [
    `BPM: ${score.bpm}`,
    `Key: ${score.key.root} ${score.key.mode}`,
    `Time: ${score.beatsPerMeasure}/${score.beatUnit}`,
    `Clef: ${score.clef}`,
    `Measures: ${score.measures.length}`,
    `Duration: ${score.totalDuration.toFixed(1)}s`,
    "",
  ].join("\n");

  return header + "\n" + measuresToText(score.measures);
}
