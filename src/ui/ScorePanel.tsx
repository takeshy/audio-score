/**
 * Main sidebar panel for Audio Score plugin.
 * Handles audio file loading, analysis pipeline, and score display.
 */

import * as React from "react";
import { ScoreData, AnalysisSettings, AnalysisProgress, DEFAULT_SETTINGS, PitchRange } from "../types";
import { detectPitchBasicPitch } from "../core/basicPitchDetector";
import { buildScoreFromNotes } from "../core/noteSegmenter";
import { t } from "../i18n";
import { saveTemporary } from "../storage/idb";
import { playScore, PlaybackHandle } from "../core/player";
import {
  ChordAnnotation,
  analyzeChords,
  improveScore,
  convertToMusicXML,
} from "../core/aiService";
import { setState } from "../store";

interface PluginAPI {
  language?: string;
  drive: {
    createFile(name: string, content: string): Promise<{ id: string; name: string }>;
    readFile?(fileId: string): Promise<string>;
  };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  gemini: {
    chat(
      messages: Array<{ role: string; content: string }>,
      options?: { model?: string; systemPrompt?: string },
    ): Promise<string>;
  };
}

interface ScorePanelProps {
  api: PluginAPI;
  language?: string;
  fileId?: string;
  fileName?: string;
}

type Phase = "idle" | "loading" | "analyzing" | "done" | "error";

export function ScorePanel({ api, language, fileId: activeFileId, fileName: activeFileName }: ScorePanelProps) {
  const i = t(language ?? api.language);

  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progress, setProgress] = React.useState<AnalysisProgress | null>(null);
  const [score, setScore] = React.useState<ScoreData | null>(null);
  const [error, setError] = React.useState<string>("");
  const [fileName, setFileName] = React.useState<string>("");
  const [settings, setSettings] = React.useState<AnalysisSettings>(DEFAULT_SETTINGS);
  const [playing, setPlaying] = React.useState(false);
  const [bpmInput, setBpmInput] = React.useState("");
  const [pitchRange, setPitchRange] = React.useState<PitchRange>("all");

  // AI state
  const [aiLoading, setAiLoading] = React.useState("");
  const [aiMessage, setAiMessage] = React.useState("");
  const [aiError, setAiError] = React.useState("");
  const [chordAnnotations, setChordAnnotations] = React.useState<ChordAnnotation[]>([]);
  const [aiProgress, setAiProgress] = React.useState<{ completed: number; total: number; stage?: string } | null>(null);

  const playbackRef = React.useRef<PlaybackHandle | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Load settings on mount
  React.useEffect(() => {
    api.storage.get("analysisSettings").then((saved) => {
      if (saved && typeof saved === "object") {
        setSettings({ ...DEFAULT_SETTINGS, ...(saved as Partial<AnalysisSettings>) });
      }
    });
  }, [api]);

  const AUDIO_EXTS = /\.(mp3|wav|ogg|flac|aac|m4a|webm|wma)$/i;

  // Whether the currently open file is an audio file
  const isCurrentFileAudio = !!(activeFileId && activeFileName && AUDIO_EXTS.test(activeFileName));

  // Auto-load if the currently open file is a .audioscore (ScoreData JSON)
  React.useEffect(() => {
    if (!activeFileId || !activeFileName) return;
    if (!activeFileName.endsWith(".audioscore")) return;

    setPhase("loading");
    setError("");

    const loadText = api.drive.readFile
      ? api.drive.readFile(activeFileId)
      : fetch(`/api/drive/files?action=raw&fileId=${encodeURIComponent(activeFileId)}`)
          .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });

    loadText.then(
      (text) => {
        try {
          const parsed = JSON.parse(text) as ScoreData;
          if (parsed && parsed.measures) {
            setScore(parsed);
            setChordAnnotations(parsed.chordAnnotations ?? []);
            setFileName(activeFileName.replace(/\.audioscore$/, ""));
            setPhase("done");
          } else {
            setPhase("idle");
          }
        } catch {
          setPhase("idle");
        }
      },
      () => {
        setPhase("idle");
      },
    );
  }, [activeFileId, activeFileName, api]);

  // Stop playback when score changes or on unmount
  React.useEffect(() => {
    return () => {
      if (playbackRef.current) {
        playbackRef.current.stop();
        playbackRef.current = null;
        setPlaying(false);
      }
    };
  }, [score]);

  // Sync score, chordAnnotations, and fileName to shared store for main view
  React.useEffect(() => { setState({ score }); }, [score]);
  React.useEffect(() => { setState({ chordAnnotations }); }, [chordAnnotations]);
  React.useEffect(() => { setState({ fileName }); }, [fileName]);

  const progressLabel = (p: AnalysisProgress): string => {
    const labels: Record<AnalysisProgress["stage"], string> = {
      decoding: i.stageDecoding,
      loading_model: i.stageLoadingModel,
      pitch: i.stagePitch,
      quantizing: i.stageQuantizing,
      done: i.stageDone,
    };
    return labels[p.stage] ?? "";
  };

  /**
   * Decode audio buffer and run analysis pipeline.
   */
  const analyzeAudio = React.useCallback(
    async (arrayBuffer: ArrayBuffer, name: string) => {
      setPhase("analyzing");
      setError("");
      setFileName(name);
      setScore(null);

      const audioCtx = new AudioContext();
      try {
        // Decode
        setProgress({ stage: "decoding", percent: 5 });
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

        // Load model & detect pitch
        setProgress({ stage: "loading_model", percent: 10 });
        const notes = await detectPitchBasicPitch(
          audioBuffer,
          (pct) => {
            setProgress({ stage: "pitch", percent: 10 + pct * 70 });
          },
          settings.onsetThreshold,
          settings.frameThreshold,
        );

        // Build score
        setProgress({ stage: "quantizing", percent: 85 });
        await new Promise((r) => setTimeout(r, 0));

        const bpmOverride = bpmInput ? parseInt(bpmInput, 10) || 0 : 0;
        const scoreData = buildScoreFromNotes(notes, { ...settings, bpmOverride, pitchRange });

        setProgress({ stage: "done", percent: 100 });
        setScore(scoreData);
        setPhase("done");

        // Save ScoreData JSON to IndexedDB
        const baseName = name.replace(/\.[^.]+$/, "");
        saveTemporary(`${baseName}.json`, JSON.stringify(scoreData)).catch(() => {});

        // Auto-save as .audioscore to Drive
        const json = JSON.stringify(scoreData);
        api.drive.createFile(`${baseName}.audioscore`, json).catch(() => {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`${i.errorAnalysis}: ${msg}`);
        setPhase("error");
      } finally {
        await audioCtx.close();
      }
    },
    [settings, bpmInput, pitchRange, i, api]
  );

  /**
   * Load the currently open audio file and analyze it.
   */
  const handleCurrentFileAnalyze = React.useCallback(async () => {
    if (!activeFileId || !activeFileName) return;

    setPhase("loading");
    setError("");

    try {
      const resp = await fetch(
        `/api/drive/files?action=raw&fileId=${encodeURIComponent(activeFileId)}`,
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const buf = await resp.arrayBuffer();
      await analyzeAudio(buf, activeFileName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`${i.errorDecode}: ${msg}`);
      setPhase("error");
    }
  }, [activeFileId, activeFileName, analyzeAudio, i]);

  /**
   * Handle file input change.
   */
  const loadFile = React.useCallback(
    (file: File) => {
      setPhase("loading");
      file.arrayBuffer().then(
        (buf) => analyzeAudio(buf, file.name),
        (err) => {
          setError(`${i.errorDecode}: ${err instanceof Error ? err.message : String(err)}`);
          setPhase("error");
        }
      );
    },
    [analyzeAudio, i]
  );

  const handleFileChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) loadFile(file);
    },
    [loadFile]
  );

  const handleDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (file) loadFile(file);
    },
    [loadFile]
  );

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  /**
   * Toggle score playback.
   */
  const handlePlayStop = React.useCallback(() => {
    if (playing && playbackRef.current) {
      playbackRef.current.stop();
      playbackRef.current = null;
      setState({ playbackHandle: null });
      setPlaying(false);
      return;
    }

    if (!score) return;

    const handle = playScore(score);
    playbackRef.current = handle;
    setState({ playbackHandle: handle });
    setPlaying(true);

    handle.finished.then(() => {
      playbackRef.current = null;
      setState({ playbackHandle: null });
      setPlaying(false);
    });
  }, [playing, score]);

  // AI helper: show success message for 3 seconds
  const showAiSuccess = React.useCallback((msg: string) => {
    setAiMessage(msg);
    setTimeout(() => setAiMessage(""), 3000);
  }, []);

  // AI helper: show error message
  const showAiError = React.useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    setAiError(`${i.aiError}: ${msg}`);
    setTimeout(() => setAiError(""), 5000);
  }, [i]);

  /**
   * AI: Analyze chords
   */
  const handleAiChords = React.useCallback(async () => {
    if (!score || aiLoading) return;
    setAiLoading("chords");
    setAiError("");
    try {
      const annotations = await analyzeChords(api.gemini, score);
      setChordAnnotations(annotations);

      // Save chord annotations into score and persist to .audioscore file
      const updatedScore = { ...score, chordAnnotations: annotations };
      setScore(updatedScore);
      const baseName = fileName ? fileName.replace(/\.[^.]+$/, "") : "score";
      const json = JSON.stringify(updatedScore);
      saveTemporary(`${baseName}.json`, json).catch(() => {});
      api.drive.createFile(`${baseName}.audioscore`, json).catch(() => {});

      showAiSuccess(i.aiChordsSuccess);
    } catch (err) {
      showAiError(err);
    } finally {
      setAiLoading("");
    }
  }, [score, aiLoading, api.gemini, i, fileName, showAiSuccess, showAiError, api.drive]);

  /**
   * AI: Improve score (remove ML artifacts)
   */
  const handleAiImprove = React.useCallback(async () => {
    if (!score || aiLoading) return;
    setAiLoading("improve");
    setAiError("");
    setAiProgress(null);
    try {
      const improved = await improveScore(api.gemini, score, (completed, total, stage) => {
        setAiProgress({ completed, total, stage });
      });
      if (improved) {
        setScore(improved);
        setChordAnnotations(improved.chordAnnotations ?? []);

        const baseName = fileName ? fileName.replace(/\.[^.]+$/, "") : "score";
        const improvedName = `${baseName}_improved`;
        const json = JSON.stringify(improved);
        saveTemporary(`${improvedName}.json`, json).catch(() => {});
        api.drive.createFile(`${improvedName}.audioscore`, json).catch(() => {});

        showAiSuccess(i.aiImproveSuccess);
      }
    } catch (err) {
      showAiError(err);
    } finally {
      setAiLoading("");
      setAiProgress(null);
    }
  }, [score, aiLoading, api.gemini, i, fileName, showAiSuccess, showAiError, api.drive]);

  /**
   * Convert to MusicXML and download (no AI needed).
   */
  const handleMusicXML = React.useCallback(() => {
    if (!score) return;
    try {
      const xml = convertToMusicXML(score);
      const blob = new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const baseName = fileName ? fileName.replace(/\.[^.]+$/, "") : "score";
      a.download = `${baseName}.musicxml`;
      a.click();
      URL.revokeObjectURL(url);
      showAiSuccess(i.aiMusicXMLSuccess);
    } catch (err) {
      showAiError(err);
    }
  }, [score, fileName, i, showAiSuccess, showAiError]);

  // Count total notes
  const totalNotes = score
    ? score.measures.reduce((sum, m) => sum + m.notes.length, 0)
    : 0;

  return (
    <div
      className="audio-score-container"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div className="audio-score-panel">
        {/* Header */}
        <div className="audio-score-header">
          <h2>{i.pluginName}</h2>
        </div>

        {/* File loading section */}
        <div className="audio-score-input-section">
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />
          <button
            className="audio-score-btn mod-cta"
            onClick={() => fileInputRef.current?.click()}
            disabled={phase === "analyzing"}
          >
            {i.loadFile}
          </button>
          <p className="audio-score-hint">{i.orDragDrop}</p>

          {/* BPM override & Pitch range */}
          <div className="audio-score-bpm-section">
            <div className="audio-score-options-row">
              <div className="audio-score-option-group">
                <label className="audio-score-label">{i.bpmOverride}</label>
                <input
                  type="number"
                  className="audio-score-input"
                  placeholder={i.bpmOverrideHint}
                  value={bpmInput}
                  min={0}
                  max={300}
                  onChange={(e) => setBpmInput(e.target.value)}
                  disabled={phase === "analyzing"}
                  style={{ width: "100px" }}
                />
              </div>
              <div className="audio-score-option-group">
                <label className="audio-score-label">{i.pitchRange}</label>
                <select
                  className="audio-score-input"
                  value={pitchRange}
                  onChange={(e) => setPitchRange(e.target.value as PitchRange)}
                  disabled={phase === "analyzing"}
                >
                  <option value="all">{i.pitchRangeAll}</option>
                  <option value="cut_bass">{i.pitchRangeCutBass}</option>
                  <option value="melody">{i.pitchRangeMelody}</option>
                </select>
              </div>
            </div>
          </div>

          {/* Current audio file */}
          {isCurrentFileAudio && (
            <div className="audio-score-drive-section">
              <label className="audio-score-label">{i.currentFile}</label>
              <div className="audio-score-drive-row">
                <span className="audio-score-current-file-name">{activeFileName}</span>
                <button
                  className="audio-score-btn mod-cta"
                  onClick={handleCurrentFileAnalyze}
                  disabled={phase === "analyzing"}
                >
                  {phase === "analyzing" ? i.analyzing : i.analyzeCurrentFile}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Progress */}
        {(phase === "loading" || phase === "analyzing") && progress && (
          <div className="audio-score-progress">
            <div className="audio-score-progress-bar">
              <div
                className="audio-score-progress-fill"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <span className="audio-score-progress-label">
              {progressLabel(progress)}
            </span>
          </div>
        )}

        {/* Error */}
        {phase === "error" && error && (
          <div className="audio-score-error">{error}</div>
        )}

        {/* Score info */}
        {score && phase === "done" && (
          <>
            <div className="audio-score-info">
              <div className="audio-score-info-grid">
                <span className="audio-score-info-label">{i.bpm}:</span>
                <span>{score.bpm}</span>
                <span className="audio-score-info-label">{i.key}:</span>
                <span>
                  {score.key.root} {score.key.mode}
                </span>
                <span className="audio-score-info-label">{i.clef}:</span>
                <span>{score.clef === "treble" ? i.treble : i.bass}</span>
                <span className="audio-score-info-label">{i.totalNotes}:</span>
                <span>{totalNotes}</span>
                <span className="audio-score-info-label">{i.measures}:</span>
                <span>{score.measures.length}</span>
                <span className="audio-score-info-label">{i.duration}:</span>
                <span>{score.totalDuration.toFixed(1)}s</span>
                <span className="audio-score-info-label">{i.pitchRange}:</span>
                <span>
                  {score.pitchRange === "melody"
                    ? i.pitchRangeMelody
                    : score.pitchRange === "cut_bass"
                      ? i.pitchRangeCutBass
                      : i.pitchRangeAll}
                </span>
              </div>
            </div>

            {/* AI Section */}
            {totalNotes > 0 && api.gemini && (
              <div className="audio-score-ai-section">
                <div className="audio-score-ai-section-title">{i.aiSection}</div>
                <div className="audio-score-ai-buttons">
                  <button
                    className={`audio-score-btn${aiLoading === "chords" ? " is-loading" : ""}`}
                    onClick={handleAiChords}
                    disabled={!!aiLoading}
                  >
                    {aiLoading === "chords" ? i.aiChordsLoading : i.aiChords}
                  </button>
                  <button
                    className={`audio-score-btn${aiLoading === "improve" ? " is-loading" : ""}`}
                    onClick={handleAiImprove}
                    disabled={!!aiLoading}
                  >
                    {aiLoading === "improve" ? i.aiImproveLoading : i.aiImprove}
                  </button>
                  <button
                    className="audio-score-btn"
                    onClick={handleMusicXML}
                  >
                    {i.aiMusicXML}
                  </button>
                </div>
                {aiLoading === "improve" && aiProgress && (
                  <div className="audio-score-progress">
                    <div className="audio-score-progress-bar">
                      <div
                        className="audio-score-progress-fill"
                        style={{ width: aiProgress.stage === "filter" ? "5%" : `${(aiProgress.completed / aiProgress.total) * 100}%` }}
                      />
                    </div>
                    <span className="audio-score-progress-label">
                      {aiProgress.stage === "filter"
                        ? i.aiImproveFiltering
                        : `${aiProgress.completed}/${aiProgress.total}`}
                    </span>
                  </div>
                )}
                {aiMessage && <div className="audio-score-ai-msg">{aiMessage}</div>}
                {aiError && <div className="audio-score-ai-error">{aiError}</div>}
              </div>
            )}

            {totalNotes === 0 && (
              <div className="audio-score-no-notes">{i.noNotes}</div>
            )}

            {/* Actions */}
            {totalNotes > 0 && (
              <div className="audio-score-actions">
                <button className="audio-score-btn" onClick={handlePlayStop}>
                  {playing ? i.stop : i.play}
                </button>
              </div>
            )}

          </>
        )}
      </div>
    </div>
  );
}
