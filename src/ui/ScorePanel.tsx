/**
 * Main sidebar panel for Audio Score plugin.
 * Handles audio file loading, analysis pipeline, and score display.
 */

import * as React from "react";
import { ScoreData, AnalysisSettings, AnalysisProgress, DEFAULT_SETTINGS } from "../types";
import { detectPitchBasicPitch } from "../core/basicPitchDetector";
import { buildScoreFromNotes } from "../core/noteSegmenter";
import { renderScore, calculateSize, scoreToText } from "./ScoreRenderer";
import { t } from "../i18n";
import { saveTemporary } from "../storage/idb";
import { playScore, PlaybackHandle } from "../core/player";
import { parseScoreText } from "../core/scoreParser";

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
  const [driveFileId, setDriveFileId] = React.useState<string>("");
  const [driveLoading, setDriveLoading] = React.useState(false);
  const [exportMsg, setExportMsg] = React.useState<string>("");
  const [settings, setSettings] = React.useState<AnalysisSettings>(DEFAULT_SETTINGS);
  const [playing, setPlaying] = React.useState(false);
  const [saveMsg, setSaveMsg] = React.useState("");

  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const playbackRef = React.useRef<PlaybackHandle | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Load settings on mount
  React.useEffect(() => {
    api.storage.get("analysisSettings").then((saved) => {
      if (saved && typeof saved === "object") {
        setSettings({ ...DEFAULT_SETTINGS, ...(saved as Partial<AnalysisSettings>) });
      }
    });
  }, [api]);

  // Auto-load if the currently open file is a score.md
  React.useEffect(() => {
    console.log("[audio-score] auto-load effect:", { activeFileId, activeFileName });
    if (!activeFileId || !activeFileName) return;
    if (!activeFileName.endsWith("-score.md")) {
      console.log("[audio-score] not a score.md, skipping");
      return;
    }

    setPhase("loading");
    setError("");

    const loadText = api.drive.readFile
      ? api.drive.readFile(activeFileId)
      : fetch(`/api/drive/files?action=raw&fileId=${encodeURIComponent(activeFileId)}`)
          .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });

    loadText.then(
      (text) => {
        console.log("[audio-score] loaded text, length:", text.length, "first 200:", text.slice(0, 200));
        const parsed = parseScoreText(text);
        console.log("[audio-score] parseScoreText result:", parsed ? `${parsed.measures.length} measures, ${parsed.measures.reduce((s, m) => s + m.notes.length, 0)} notes` : "null");
        if (parsed) {
          setScore(parsed);
          setFileName(activeFileName.replace(/-score\.md$/, ""));
          setPhase("done");
        } else {
          setPhase("idle");
        }
      },
      (err) => {
        console.error("[audio-score] failed to load:", err);
        setPhase("idle");
      },
    );
  }, [activeFileId, activeFileName, api]);

  // Render score to canvas
  const paintCanvas = React.useCallback(() => {
    console.log("[audio-score] paintCanvas called, score:", !!score, "canvas:", !!canvasRef.current);
    if (!score || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    const containerWidth = container ? container.clientWidth - 16 : 760;
    console.log("[audio-score] containerWidth:", containerWidth);

    try {
      const size = calculateSize(score, { width: containerWidth });
      console.log("[audio-score] calculateSize:", size);
      const dpr = window.devicePixelRatio || 1;

      canvas.width = size.width * dpr;
      canvas.height = size.height * dpr;
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) { console.error("[audio-score] failed to get 2d context"); return; }

      ctx.scale(dpr, dpr);

      const isDark =
        document.documentElement.classList.contains("dark") ||
        window.matchMedia("(prefers-color-scheme: dark)").matches;

      console.log("[audio-score] calling renderScore...");
      renderScore(ctx, score, {
        width: containerWidth,
        backgroundColor: isDark ? "#1e1e2e" : "#ffffff",
        staffColor: isDark ? "#a0a0b0" : "#333333",
        noteColor: isDark ? "#e0e0e0" : "#000000",
      });
      console.log("[audio-score] renderScore done");
    } catch (err) {
      console.error("[audio-score] paintCanvas error:", err);
    }
  }, [score]);

  // Re-render when score changes
  React.useEffect(() => {
    paintCanvas();
  }, [paintCanvas]);

  // Re-render when container resizes
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => paintCanvas());
    ro.observe(container);
    return () => ro.disconnect();
  }, [paintCanvas]);

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
        console.log("[audio-score] starting detectPitchBasicPitch...");
        const notes = await detectPitchBasicPitch(
          audioBuffer,
          (pct) => {
            setProgress({ stage: "pitch", percent: 10 + pct * 70 });
          },
          settings.onsetThreshold,
          settings.frameThreshold,
        );
        console.log("[audio-score] detectPitchBasicPitch done, notes:", notes.length);

        // Build score
        setProgress({ stage: "quantizing", percent: 85 });
        await new Promise((r) => setTimeout(r, 0));

        const scoreData = buildScoreFromNotes(notes, settings);
        console.log("[audio-score] buildScoreFromNotes done, measures:", scoreData.measures.length, "totalNotes:", scoreData.measures.reduce((s, m) => s + m.notes.length, 0));

        setProgress({ stage: "done", percent: 100 });
        setScore(scoreData);
        setPhase("done");

        // Save ScoreData JSON to IndexedDB
        const baseName = name.replace(/\.[^.]+$/, "");
        saveTemporary(`${baseName}.json`, JSON.stringify(scoreData)).catch(() => {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`${i.errorAnalysis}: ${msg}`);
        setPhase("error");
      } finally {
        await audioCtx.close();
      }
    },
    [settings, i]
  );

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
   * Load audio from Google Drive via raw endpoint.
   */
  const handleDriveLoad = React.useCallback(async () => {
    if (!driveFileId.trim()) return;

    setDriveLoading(true);
    setPhase("loading");
    setError("");

    try {
      const resp = await fetch(
        `/api/drive/files?action=raw&fileId=${encodeURIComponent(driveFileId.trim())}`
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const buf = await resp.arrayBuffer();
      const name = `drive-${driveFileId.trim().slice(0, 8)}`;
      await analyzeAudio(buf, name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`${i.errorDecode}: ${msg}`);
      setPhase("error");
    } finally {
      setDriveLoading(false);
    }
  }, [driveFileId, analyzeAudio, i]);

  /**
   * Export score as text to Drive.
   */
  const handleExport = React.useCallback(async () => {
    if (!score) return;
    setExportMsg("");

    try {
      const text = scoreToText(score);
      const exportName = fileName
        ? fileName.replace(/\.[^.]+$/, "") + "-score.md"
        : "audio-score.md";
      await api.drive.createFile(exportName, text);
      setExportMsg(i.exportSuccess);
    } catch {
      setExportMsg(i.exportError);
    }

    setTimeout(() => setExportMsg(""), 3000);
  }, [score, fileName, api, i]);

  /**
   * Save canvas as PNG file download.
   */
  const handleSaveImage = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !fileName) return;

    const baseName = fileName.replace(/\.[^.]+$/, "");
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName}.png`;
      a.click();
      URL.revokeObjectURL(url);
      setSaveMsg(i.saveImageSuccess);
      setTimeout(() => setSaveMsg(""), 3000);
    }, "image/png");
  }, [fileName, i]);

  /**
   * Toggle score playback.
   */
  const handlePlayStop = React.useCallback(() => {
    if (playing && playbackRef.current) {
      playbackRef.current.stop();
      playbackRef.current = null;
      setPlaying(false);
      return;
    }

    if (!score) return;

    const handle = playScore(score);
    playbackRef.current = handle;
    setPlaying(true);

    handle.finished.then(() => {
      playbackRef.current = null;
      setPlaying(false);
    });
  }, [playing, score]);

  // Count total notes
  const totalNotes = score
    ? score.measures.reduce((sum, m) => sum + m.notes.length, 0)
    : 0;

  console.log("[audio-score] render, phase:", phase, "score:", !!score, "totalNotes:", totalNotes);

  return (
    <div
      ref={containerRef}
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

          {/* Drive file loading */}
          <div className="audio-score-drive-section">
            <label className="audio-score-label">{i.loadFromDrive}</label>
            <div className="audio-score-drive-row">
              <input
                type="text"
                className="audio-score-input"
                placeholder={i.driveFileId}
                value={driveFileId}
                onChange={(e) => setDriveFileId(e.target.value)}
                disabled={phase === "analyzing" || driveLoading}
              />
              <button
                className="audio-score-btn"
                onClick={handleDriveLoad}
                disabled={!driveFileId.trim() || phase === "analyzing" || driveLoading}
              >
                {driveLoading ? i.driveLoading : i.driveLoad}
              </button>
            </div>
          </div>
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
              </div>
            </div>

            {/* Canvas */}
            {totalNotes > 0 ? (
              <div className="audio-score-canvas-wrapper">
                <canvas ref={canvasRef} className="audio-score-canvas" />
              </div>
            ) : (
              <div className="audio-score-no-notes">{i.noNotes}</div>
            )}

            {/* Actions */}
            {totalNotes > 0 && (
              <div className="audio-score-actions">
                <button className="audio-score-btn" onClick={handleSaveImage}>
                  {i.saveImage}
                </button>
                <button className="audio-score-btn" onClick={handlePlayStop}>
                  {playing ? i.stop : i.play}
                </button>
                <button className="audio-score-btn mod-cta" onClick={handleExport}>
                  {i.export}
                </button>
                {(exportMsg || saveMsg) && (
                  <span className="audio-score-export-msg">{exportMsg || saveMsg}</span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
