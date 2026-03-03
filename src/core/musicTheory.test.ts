import { describe, it, expect } from "vitest";
import {
  frequencyToMidi,
  midiToFrequency,
  midiToNoteName,
  pitchClass,
  detectBPM,
  quantizeDuration,
  detectKey,
  chooseClef,
  detectDownbeatOffset,
  quantizeStartTimes,
} from "./musicTheory";
import { DetectedNote } from "../types";

describe("frequencyToMidi / midiToFrequency", () => {
  it("A4 = 440Hz = MIDI 69", () => {
    expect(frequencyToMidi(440)).toBe(69);
    expect(midiToFrequency(69)).toBeCloseTo(440, 1);
  });

  it("C4 = ~261.6Hz = MIDI 60", () => {
    expect(frequencyToMidi(261.63)).toBe(60);
    expect(midiToFrequency(60)).toBeCloseTo(261.63, 0);
  });

  it("returns -1 for non-positive frequencies", () => {
    expect(frequencyToMidi(0)).toBe(-1);
    expect(frequencyToMidi(-100)).toBe(-1);
  });
});

describe("midiToNoteName", () => {
  it("converts C4", () => {
    expect(midiToNoteName(60)).toBe("C4");
  });

  it("converts A4", () => {
    expect(midiToNoteName(69)).toBe("A4");
  });

  it("uses sharps by default", () => {
    expect(midiToNoteName(61)).toBe("C#4");
  });

  it("uses flats when specified", () => {
    expect(midiToNoteName(61, true)).toBe("Db4");
  });

  it("returns 'rest' for negative MIDI", () => {
    expect(midiToNoteName(-1)).toBe("rest");
  });
});

describe("pitchClass", () => {
  it("C = 0", () => expect(pitchClass(60)).toBe(0));
  it("D = 2", () => expect(pitchClass(62)).toBe(2));
  it("B = 11", () => expect(pitchClass(71)).toBe(11));
});

describe("detectBPM", () => {
  it("returns 120 for fewer than 2 onsets", () => {
    expect(detectBPM([])).toBe(120);
    expect(detectBPM([0.5])).toBe(120);
  });

  it("detects 120 BPM from evenly spaced onsets (0.5s intervals)", () => {
    const onsets = Array.from({ length: 20 }, (_, i) => i * 0.5);
    expect(detectBPM(onsets)).toBe(120);
  });

  it("detects 60 BPM from 1s intervals", () => {
    const onsets = Array.from({ length: 20 }, (_, i) => i * 1.0);
    expect(detectBPM(onsets)).toBe(60);
  });

  it("detects ~150 BPM from 0.4s intervals", () => {
    const onsets = Array.from({ length: 20 }, (_, i) => i * 0.4);
    expect(detectBPM(onsets)).toBe(150);
  });
});

describe("quantizeDuration", () => {
  it("quantizes a half-second at 120 BPM to quarter note", () => {
    const result = quantizeDuration(0.5, 120);
    expect(result.type).toBe("quarter");
    expect(result.dotted).toBe(false);
  });

  it("quantizes 1 second at 120 BPM to half note", () => {
    const result = quantizeDuration(1.0, 120);
    expect(result.type).toBe("half");
    expect(result.dotted).toBe(false);
  });

  it("quantizes 0.25s at 120 BPM to eighth note", () => {
    const result = quantizeDuration(0.25, 120);
    expect(result.type).toBe("eighth");
    expect(result.dotted).toBe(false);
  });

  it("quantizes 0.75s at 120 BPM to dotted quarter", () => {
    const result = quantizeDuration(0.75, 120);
    expect(result.type).toBe("quarter");
    expect(result.dotted).toBe(true);
  });

  it("quantizes 0.0625s at 120 BPM to thirty_second note", () => {
    // 120 BPM → beat = 0.5s, 32nd = 0.5/8 = 0.0625s
    const result = quantizeDuration(0.0625, 120);
    expect(result.type).toBe("thirty_second");
    expect(result.dotted).toBe(false);
  });
});

describe("detectKey", () => {
  it("detects C major from C major scale notes", () => {
    // C D E F G A B
    const notes = [60, 62, 64, 65, 67, 69, 71];
    const key = detectKey(notes);
    expect(key.root).toBe("C");
    expect(key.mode).toBe("major");
  });

  it("returns C major for empty input", () => {
    const key = detectKey([]);
    expect(key.root).toBe("C");
    expect(key.mode).toBe("major");
  });
});

describe("chooseClef", () => {
  it("chooses treble for high notes", () => {
    expect(chooseClef([60, 65, 70, 75])).toBe("treble");
  });

  it("chooses bass for low notes", () => {
    expect(chooseClef([36, 40, 45, 50])).toBe("bass");
  });

  it("defaults to treble for empty input", () => {
    expect(chooseClef([])).toBe("treble");
  });
});

/** Helper to build a minimal DetectedNote for testing */
function makeNote(startTime: number, midi: number = 60): DetectedNote {
  return {
    midi,
    name: "C4",
    startTime,
    duration: 0.5,
    durationType: "quarter",
    dotted: false,
    frequency: 261.63,
    amplitude: 0.8,
  };
}

describe("detectDownbeatOffset", () => {
  it("returns 0 for empty onsets", () => {
    expect(detectDownbeatOffset([], 120)).toBe(0);
  });

  it("returns the first onset when all onsets are perfectly on-grid", () => {
    // 120 BPM → beat = 0.5s, 32nd = 0.0625s
    // Onsets at 0.3, 0.8, 1.3 → offset should be 0.3
    const onsets = [0.3, 0.8, 1.3, 1.8];
    const offset = detectDownbeatOffset(onsets, 120);
    expect(offset).toBeCloseTo(0.3, 5);
  });

  it("picks the phase that best aligns onsets to the 32nd grid", () => {
    // 120 BPM → 32nd = 0.0625s
    // True grid: 0.2, 0.2625, 0.325, 0.3875, 0.45, ...
    // Add noise so onsets aren't perfectly on-grid:
    const onsets = [0.21, 0.33, 0.58, 0.70, 0.83];
    const offset = detectDownbeatOffset(onsets, 120);
    // The best offset should be near 0.2 (within one step = 0.03125)
    expect(Math.abs(offset - 0.2)).toBeLessThan(0.04);
  });

  it("returns first onset for a single onset", () => {
    const offset = detectDownbeatOffset([0.42], 100);
    expect(offset).toBeCloseTo(0.42, 5);
  });
});

describe("quantizeStartTimes", () => {
  it("snaps start times to the nearest 32nd-note grid", () => {
    // 120 BPM → 32nd = 0.0625s, offset = 0.1
    // Grid positions: 0.1, 0.1625, 0.225, 0.2875, 0.35, ..., 0.6, ...
    const notes = [makeNote(0.11), makeNote(0.34), makeNote(0.62)];
    const result = quantizeStartTimes(notes, 120, 0.1);
    expect(result[0].startTime).toBeCloseTo(0.1, 5);
    expect(result[1].startTime).toBeCloseTo(0.35, 5);
    expect(result[2].startTime).toBeCloseTo(0.6, 5);
  });

  it("preserves other note properties", () => {
    const notes = [makeNote(0.13, 72)];
    const result = quantizeStartTimes(notes, 120, 0.1);
    expect(result[0].midi).toBe(72);
    expect(result[0].duration).toBe(0.5);
  });

  it("works with offset = 0", () => {
    // 120 BPM → 32nd = 0.0625s
    const notes = [makeNote(0.06), makeNote(0.49)];
    const result = quantizeStartTimes(notes, 120, 0);
    expect(result[0].startTime).toBeCloseTo(0.0625, 5);  // rounds to 1st 32nd
    expect(result[1].startTime).toBeCloseTo(0.5, 5);     // rounds to 0.5
  });
});
