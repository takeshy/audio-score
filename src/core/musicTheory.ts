import {
  DetectedNote,
  DurationType,
  DURATION_BEATS,
  Measure,
  KeySignature,
  ClefType,
} from "../types";

// Note names with sharps
const NOTE_NAMES_SHARP = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];
// Note names with flats
const NOTE_NAMES_FLAT = [
  "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
];

/** Convert frequency (Hz) to MIDI note number */
export function frequencyToMidi(freq: number): number {
  if (freq <= 0) return -1;
  return Math.round(12 * Math.log2(freq / 440) + 69);
}

/** Convert MIDI note number to frequency (Hz) */
export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Convert MIDI note number to note name (e.g. "C4", "F#5") */
export function midiToNoteName(midi: number, useFlats: boolean = false): string {
  if (midi < 0) return "rest";
  const octave = Math.floor(midi / 12) - 1;
  const noteIndex = midi % 12;
  const names = useFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  return names[noteIndex] + octave;
}

/** Get pitch class (0-11) from MIDI note number */
export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

/**
 * Detect BPM from onset intervals using histogram mode estimation.
 * Returns the most common inter-onset interval mapped to BPM.
 */
export function detectBPM(
  onsetTimes: number[],
  minBPM: number = 40,
  maxBPM: number = 220
): number {
  if (onsetTimes.length < 2) return 120; // default

  // Compute inter-onset intervals
  const intervals: number[] = [];
  for (let i = 1; i < onsetTimes.length; i++) {
    const dt = onsetTimes[i] - onsetTimes[i - 1];
    if (dt > 0) intervals.push(dt);
  }
  if (intervals.length === 0) return 120;

  // Build histogram with 5ms resolution
  const resolution = 0.005;
  const minInterval = 60 / maxBPM;
  const maxInterval = 60 / minBPM;
  const bins = new Map<number, number>();

  for (const iv of intervals) {
    if (iv < minInterval || iv > maxInterval) continue;
    const binKey = Math.round(iv / resolution);
    bins.set(binKey, (bins.get(binKey) ?? 0) + 1);
  }

  if (bins.size === 0) return 120;

  // Find mode (most frequent bin)
  let bestBin = 0;
  let bestCount = 0;
  for (const [bin, count] of bins) {
    if (count > bestCount) {
      bestCount = count;
      bestBin = bin;
    }
  }

  const modeInterval = bestBin * resolution;
  const bpm = Math.round(60 / modeInterval);
  return Math.max(minBPM, Math.min(maxBPM, bpm));
}

/**
 * Quantize a duration in seconds to the nearest musical duration type.
 * Returns the duration type and whether it's dotted.
 */
export function quantizeDuration(
  durationSec: number,
  bpm: number
): { type: DurationType; dotted: boolean } {
  const beatDuration = 60 / bpm; // duration of one quarter note in seconds
  const beats = durationSec / beatDuration;

  // Candidate durations in beats: plain and dotted
  const candidates: Array<{ type: DurationType; dotted: boolean; beats: number }> = [];
  const types: DurationType[] = ["whole", "half", "quarter", "eighth", "sixteenth"];
  for (const t of types) {
    const b = DURATION_BEATS[t];
    candidates.push({ type: t, dotted: false, beats: b });
    candidates.push({ type: t, dotted: true, beats: b * 1.5 });
  }

  // Find closest match using log-scale distance
  let best = candidates[0];
  let bestDist = Infinity;
  for (const c of candidates) {
    const dist = Math.abs(Math.log2(beats / c.beats));
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }

  return { type: best.type, dotted: best.dotted };
}

/**
 * Detect key signature from a set of MIDI notes.
 * Uses the Krumhansl-Schmuckler key-finding algorithm (simplified).
 */
export function detectKey(midiNotes: number[]): KeySignature {
  if (midiNotes.length === 0) {
    return { root: "C", mode: "major", accidentals: 0 };
  }

  // Build pitch class histogram
  const histogram = new Array(12).fill(0);
  for (const midi of midiNotes) {
    if (midi >= 0) histogram[pitchClass(midi)]++;
  }

  // Major and minor profiles (Krumhansl-Kessler)
  const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  let bestKey = 0;
  let bestMode: "major" | "minor" = "major";
  let bestCorr = -Infinity;

  for (let root = 0; root < 12; root++) {
    for (const [mode, profile] of [["major", majorProfile], ["minor", minorProfile]] as const) {
      // Rotate histogram to align with root
      let sumXY = 0, sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0;
      for (let i = 0; i < 12; i++) {
        const x = histogram[(i + root) % 12];
        const y = profile[i];
        sumXY += x * y;
        sumX += x;
        sumY += y;
        sumX2 += x * x;
        sumY2 += y * y;
      }
      const n = 12;
      const num = n * sumXY - sumX * sumY;
      const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
      const corr = den === 0 ? 0 : num / den;

      if (corr > bestCorr) {
        bestCorr = corr;
        bestKey = root;
        bestMode = mode;
      }
    }
  }

  // Map root to key signature accidentals
  // Circle of fifths: C=0, G=1, D=2, A=3, E=4, B=5, F#=6, F=-1, Bb=-2, Eb=-3, Ab=-4, Db=-5, Gb=-6
  const accidentalMap: Record<number, number> = {
    0: 0,   // C
    7: 1,   // G
    2: 2,   // D
    9: 3,   // A
    4: 4,   // E
    11: 5,  // B
    6: 6,   // F#/Gb
    5: -1,  // F
    10: -2, // Bb
    3: -3,  // Eb
    8: -4,  // Ab
    1: -5,  // Db
  };

  const accidentals = accidentalMap[bestKey] ?? 0;
  // For minor keys, the relative major is 3 semitones up
  const effectiveAccidentals = bestMode === "minor"
    ? (accidentalMap[(bestKey + 3) % 12] ?? 0)
    : accidentals;

  const useFlats = effectiveAccidentals < 0;
  const rootName = (useFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP)[bestKey];

  return {
    root: rootName,
    mode: bestMode,
    accidentals: effectiveAccidentals,
  };
}

/**
 * Choose clef based on the average MIDI note value.
 * Middle C (MIDI 60) is the dividing line.
 */
export function chooseClef(midiNotes: number[]): ClefType {
  const validNotes = midiNotes.filter((m) => m >= 0);
  if (validNotes.length === 0) return "treble";
  const avg = validNotes.reduce((a, b) => a + b, 0) / validNotes.length;
  return avg >= 55 ? "treble" : "bass";
}

/**
 * Detect the downbeat offset — the time of the first beat in the audio.
 * Each onset implies a candidate grid phase (onset mod subdivision).
 * We test every onset's phase and pick the one that minimises the
 * sum-of-squared residuals across all onsets, then snap the first onset
 * to that grid to produce the downbeat position.
 */
export function detectDownbeatOffset(
  onsetTimes: number[],
  bpm: number,
): number {
  if (onsetTimes.length === 0) return 0;

  const beatDuration = 60 / bpm;
  const subdivision = beatDuration / 4; // 16th-note grid

  // Each onset implies a phase = onset mod subdivision
  let bestPhase = 0;
  let bestError = Infinity;

  for (const candidate of onsetTimes) {
    const phase = ((candidate % subdivision) + subdivision) % subdivision;
    let error = 0;
    for (const t of onsetTimes) {
      const gridUnits = (t - phase) / subdivision;
      const residual = gridUnits - Math.round(gridUnits);
      error += residual * residual;
    }
    if (error < bestError) {
      bestError = error;
      bestPhase = phase;
    }
  }

  // Snap the first onset to the winning grid
  const gridUnits = (onsetTimes[0] - bestPhase) / subdivision;
  return Math.round(gridUnits) * subdivision + bestPhase;
}

/**
 * Snap every note's startTime to the nearest 16th-note grid position.
 */
export function quantizeStartTimes(
  notes: DetectedNote[],
  bpm: number,
  offset: number,
): DetectedNote[] {
  const beatDuration = 60 / bpm;
  const subdivision = beatDuration / 4; // 16th-note

  return notes.map((note) => {
    const gridUnits = (note.startTime - offset) / subdivision;
    const snapped = Math.round(gridUnits) * subdivision + offset;
    return { ...note, startTime: snapped };
  });
}

/**
 * Split notes into measures based on BPM and time signature.
 */
export function splitIntoMeasures(
  notes: DetectedNote[],
  bpm: number,
  beatsPerMeasure: number,
  downbeatOffset: number = 0,
): Measure[] {
  if (notes.length === 0) return [];

  const beatDuration = 60 / bpm;
  const measureDuration = beatDuration * beatsPerMeasure;
  const measures: Measure[] = [];

  let currentMeasure: DetectedNote[] = [];
  let measureStart = downbeatOffset;
  let measureNum = 1;

  for (const note of notes) {
    // If note starts in a new measure
    while (note.startTime >= measureStart + measureDuration) {
      measures.push({
        number: measureNum,
        notes: currentMeasure,
        totalBeats: beatsPerMeasure,
      });
      measureNum++;
      measureStart += measureDuration;
      currentMeasure = [];
    }
    currentMeasure.push(note);
  }

  // Push remaining notes
  if (currentMeasure.length > 0) {
    measures.push({
      number: measureNum,
      notes: currentMeasure,
      totalBeats: beatsPerMeasure,
    });
  }

  return measures;
}

/**
 * Convert MIDI note to staff position (semitones from middle C).
 * Returns the number of staff lines/spaces from middle C.
 * Positive = above, negative = below.
 */
export function midiToStaffPosition(midi: number): number {
  // Returns diatonic position relative to C4 (middle C = 0).
  // Each step is one diatonic note (line or space).
  // Treble clef: top line F5 = 10, bottom line E4 = 2
  // Bass clef: top line A3 = -2, bottom line G2 = -10
  const octave = Math.floor(midi / 12) - 1;
  const noteIndex = midi % 12;

  const chromaticToDiatonic = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
  const diatonicStep = chromaticToDiatonic[noteIndex];

  return (octave - 4) * 7 + diatonicStep;
}

/**
 * Check if a MIDI note requires an accidental given the key signature.
 * Returns "#", "b", "n" (natural), or "" (no accidental needed).
 */
export function getAccidental(midi: number, key: KeySignature): string {
  const pc = pitchClass(midi);
  const isBlackKey = [false, true, false, true, false, false, true, false, true, false, true, false];

  // Sharps in order: F# C# G# D# A# E# B#
  // These are the RAISED pitch classes (natural + 1 semitone)
  const sharpOrder = [6, 1, 8, 3, 10, 5, 0];
  // Flats in order: Bb Eb Ab Db Gb Cb Fb
  // These are the LOWERED pitch classes (natural - 1 semitone)
  const flatOrder = [10, 3, 8, 1, 6, 11, 4];

  const keyNotes = new Set<number>();

  if (key.accidentals > 0) {
    for (let i = 0; i < Math.min(key.accidentals, sharpOrder.length); i++) {
      keyNotes.add(sharpOrder[i]);
    }
  } else if (key.accidentals < 0) {
    for (let i = 0; i < Math.min(-key.accidentals, flatOrder.length); i++) {
      keyNotes.add(flatOrder[i]);
    }
  }

  if (isBlackKey[pc]) {
    // Chromatic note — no accidental needed if it's in the key signature
    if (keyNotes.has(pc)) return "";
    return key.accidentals >= 0 ? "#" : "b";
  } else {
    // Diatonic (white key) — natural sign needed if key signature
    // would alter this note (e.g. F natural in G major needs ♮)
    // Check if the raised/lowered version is in the key
    if (key.accidentals > 0 && keyNotes.has((pc + 1) % 12)) return "n";
    if (key.accidentals < 0 && keyNotes.has((pc + 11) % 12)) return "n";
    return "";
  }
}
