import { describe, it, expect } from "vitest";
import { parseScoreText } from "./scoreParser";

const SAMPLE_SCORE = `BPM: 120
Key: C major
Time: 4/4
Clef: treble
Measures: 2
Duration: 4.0s

M1: C4(quarter) D4(quarter) E4(quarter) F4(quarter)
M2: G4(half) A4.(quarter) B4(eighth)`;

describe("parseScoreText", () => {
  it("parses header fields correctly", () => {
    const score = parseScoreText(SAMPLE_SCORE);
    expect(score).not.toBeNull();
    expect(score!.bpm).toBe(120);
    expect(score!.beatsPerMeasure).toBe(4);
    expect(score!.beatUnit).toBe(4);
    expect(score!.clef).toBe("treble");
    expect(score!.key.root).toBe("C");
    expect(score!.key.mode).toBe("major");
    expect(score!.totalDuration).toBe(4.0);
  });

  it("parses measure count", () => {
    const score = parseScoreText(SAMPLE_SCORE);
    expect(score!.measures).toHaveLength(2);
  });

  it("parses notes in measure 1", () => {
    const score = parseScoreText(SAMPLE_SCORE);
    const m1 = score!.measures[0];
    expect(m1.number).toBe(1);
    expect(m1.notes).toHaveLength(4);
    expect(m1.notes[0].name).toBe("C4");
    expect(m1.notes[0].midi).toBe(60);
    expect(m1.notes[0].durationType).toBe("quarter");
    expect(m1.notes[0].dotted).toBe(false);
    expect(m1.notes[1].name).toBe("D4");
    expect(m1.notes[2].name).toBe("E4");
    expect(m1.notes[3].name).toBe("F4");
  });

  it("parses dotted notes", () => {
    const score = parseScoreText(SAMPLE_SCORE);
    const m2 = score!.measures[1];
    expect(m2.notes[1].name).toBe("A4");
    expect(m2.notes[1].dotted).toBe(true);
    expect(m2.notes[1].durationType).toBe("quarter");
  });

  it("parses bass clef", () => {
    const text = `BPM: 100\nKey: D major\nTime: 4/4\nClef: bass\nMeasures: 1\nDuration: 2.4s\n\nM1: D2(quarter)`;
    const score = parseScoreText(text);
    expect(score!.clef).toBe("bass");
  });

  it("parses D major key", () => {
    const text = `BPM: 100\nKey: D major\nTime: 4/4\nClef: treble\nMeasures: 1\nDuration: 1.0s\n\nM1: D4(quarter)`;
    const score = parseScoreText(text);
    expect(score!.key.root).toBe("D");
    expect(score!.key.mode).toBe("major");
    expect(score!.key.accidentals).toBe(2); // D major = 2 sharps
  });

  it("parses minor key", () => {
    const text = `BPM: 120\nKey: A minor\nTime: 4/4\nClef: treble\nMeasures: 1\nDuration: 1.0s\n\nM1: A4(quarter)`;
    const score = parseScoreText(text);
    expect(score!.key.root).toBe("A");
    expect(score!.key.mode).toBe("minor");
    expect(score!.key.accidentals).toBe(0); // A minor = relative C major = 0
  });

  it("returns null for text without measures", () => {
    expect(parseScoreText("just some random text")).toBeNull();
    expect(parseScoreText("BPM: 120\nKey: C major")).toBeNull();
  });

  it("computes startTime sequentially within a measure", () => {
    const score = parseScoreText(SAMPLE_SCORE);
    const m1 = score!.measures[0];
    // At 120 BPM, quarter = 0.5s
    expect(m1.notes[0].startTime).toBeCloseTo(0, 5);
    expect(m1.notes[1].startTime).toBeCloseTo(0.5, 5);
    expect(m1.notes[2].startTime).toBeCloseTo(1.0, 5);
    expect(m1.notes[3].startTime).toBeCloseTo(1.5, 5);
  });

  it("computes startTime for measure 2 offset by measure duration", () => {
    const score = parseScoreText(SAMPLE_SCORE);
    const m2 = score!.measures[1];
    // Measure 2 starts at 2.0s (4 beats * 0.5s)
    expect(m2.notes[0].startTime).toBeCloseTo(2.0, 5);
  });

  it("parses accidentals in note names", () => {
    const text = `BPM: 120\nKey: C major\nTime: 4/4\nClef: treble\nMeasures: 1\nDuration: 1.0s\n\nM1: C#4(quarter) Db4(quarter)`;
    const score = parseScoreText(text);
    expect(score!.measures[0].notes[0].midi).toBe(61); // C#4
    expect(score!.measures[0].notes[1].midi).toBe(61); // Db4 = same MIDI
  });

  it("parses chord notation [C4,E4,G4](quarter)", () => {
    const text = `BPM: 120\nKey: C major\nTime: 4/4\nClef: treble\nMeasures: 1\nDuration: 2.0s\n\nM1: [C4,E4,G4](quarter) D4(quarter)`;
    const score = parseScoreText(text);
    const m1 = score!.measures[0];
    // Chord produces 3 notes + 1 single = 4 total
    expect(m1.notes).toHaveLength(4);
    // All chord notes share the same startTime
    expect(m1.notes[0].name).toBe("C4");
    expect(m1.notes[1].name).toBe("E4");
    expect(m1.notes[2].name).toBe("G4");
    expect(m1.notes[0].startTime).toBeCloseTo(0, 5);
    expect(m1.notes[1].startTime).toBeCloseTo(0, 5);
    expect(m1.notes[2].startTime).toBeCloseTo(0, 5);
    // D4 follows after the chord duration (0.5s at 120 BPM)
    expect(m1.notes[3].name).toBe("D4");
    expect(m1.notes[3].startTime).toBeCloseTo(0.5, 5);
  });

  it("parses dotted chord notation", () => {
    const text = `BPM: 120\nKey: C major\nTime: 4/4\nClef: treble\nMeasures: 1\nDuration: 1.0s\n\nM1: [C4,E4].(half)`;
    const score = parseScoreText(text);
    const m1 = score!.measures[0];
    expect(m1.notes).toHaveLength(2);
    expect(m1.notes[0].dotted).toBe(true);
    expect(m1.notes[1].dotted).toBe(true);
    expect(m1.notes[0].durationType).toBe("half");
  });
});
