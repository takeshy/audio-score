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
} from "./musicTheory";

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
