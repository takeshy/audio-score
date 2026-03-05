/**
 * Main view for Audio Score plugin.
 * Displays score canvas.
 */

import * as React from "react";
import { useStore } from "../store";
import { renderScore, calculateSize, hitTestMeasure, RenderOptions } from "./ScoreRenderer";
import { exportScorePdf } from "./pdfExport";
import { setState } from "../store";
import { t } from "../i18n";

interface MainViewProps {
  language?: string;
}

export function MainView({ language }: MainViewProps) {
  const i = t(language);
  const { score, chordAnnotations, fileName, playbackHandle } = useStore();

  const [saveMsg, setSaveMsg] = React.useState("");
  const [pdfExporting, setPdfExporting] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const canvasAreaRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [canvasWidth, setCanvasWidth] = React.useState(800);
  const [highlightMeasure, setHighlightMeasure] = React.useState(0);

  // Highlight current measure during playback
  React.useEffect(() => {
    if (!playbackHandle || !score) {
      if (highlightMeasure !== 0) setHighlightMeasure(0);
      return;
    }
    const beatDuration = 60 / score.bpm;
    const measureDuration = beatDuration * score.beatsPerMeasure;
    const downbeat = score.downbeatOffset ?? 0;
    let prevMeasure = -1;
    let rafId = 0;

    function tick() {
      if (!playbackHandle) return;
      const absTime = playbackHandle.getElapsed();
      const idx = Math.floor((absTime - downbeat) / measureDuration);
      const m = Math.max(1, Math.min(idx + 1, score!.measures.length));
      if (m !== prevMeasure) {
        prevMeasure = m;
        setHighlightMeasure(m);
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [playbackHandle, score]);

  // Track canvas area width (excluding padding) via ResizeObserver
  React.useEffect(() => {
    const el = canvasAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setCanvasWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Read CSS variables for dark mode colors
  const getColors = React.useCallback(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      bg: style.getPropertyValue("--as-bg-primary").trim() || "#ffffff",
      text: style.getPropertyValue("--as-text").trim() || "#1a1a1a",
      secondary: style.getPropertyValue("--as-text-secondary").trim() || "#666666",
      border: style.getPropertyValue("--as-border").trim() || "#d8d8da",
      accent: style.getPropertyValue("--as-accent").trim() || "#2563eb",
      muted: style.getPropertyValue("--as-text-muted").trim() || "#999999",
    };
  }, []);

  // Render score to canvas
  React.useEffect(() => {
    if (!score || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const colors = getColors();
    const dpr = window.devicePixelRatio || 1;

    // iOS Safari has a max canvas area of ~16.7 million pixels.
    // Reduce effective DPR when the canvas would exceed this limit.
    const MAX_CANVAS_AREA = 16_777_216;

    const opts: RenderOptions = {
      width: canvasWidth,
      backgroundColor: colors.bg,
      staffColor: colors.secondary,
      noteColor: colors.text,
      accentColor: colors.accent,
      chordAnnotations,
      highlightMeasure,
    };
    const size = calculateSize(score, opts);

    let effectiveDpr = dpr;
    if (size.width * dpr * size.height * dpr > MAX_CANVAS_AREA) {
      effectiveDpr = Math.sqrt(MAX_CANVAS_AREA / (size.width * size.height));
    }
    canvas.width = Math.floor(size.width * effectiveDpr);
    canvas.height = Math.floor(size.height * effectiveDpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    ctx.setTransform(effectiveDpr, 0, 0, effectiveDpr, 0, 0);

    renderScore(ctx, score, opts);
  }, [score, chordAnnotations, canvasWidth, getColors, highlightMeasure]);

  // Canvas click → play from clicked measure
  const handleCanvasClick = React.useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!score) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const opts: RenderOptions = {
        width: canvasWidth,
        chordAnnotations,
      };
      const measure = hitTestMeasure(score, opts, x, y);
      if (measure != null) {
        setState({ playFromMeasure: measure });
      }
    },
    [score, canvasWidth, chordAnnotations],
  );

  // PDF export handler
  const handleSavePdf = React.useCallback(async () => {
    if (!score || pdfExporting) return;
    setPdfExporting(true);
    try {
      const title = fileName
        ? fileName.replace(/\.[^.]+$/, "")
        : "Score";
      await exportScorePdf(score, title, chordAnnotations);
      setSaveMsg(i.savePdfSuccess);
      setTimeout(() => setSaveMsg(""), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveMsg(`PDF export failed: ${msg}`);
      setTimeout(() => setSaveMsg(""), 5000);
    } finally {
      setPdfExporting(false);
    }
  }, [score, fileName, chordAnnotations, i, pdfExporting]);

  return (
    <div className="audio-score-main" ref={containerRef}>
      {!score ? (
        <div className="audio-score-main-empty">{i.mainViewEmpty}</div>
      ) : (
        <>
          {/* Toolbar */}
          <div className="audio-score-main-tabs">
            <div className="audio-score-main-tab-spacer" />
            <button
              className="audio-score-btn"
              onClick={handleSavePdf}
              disabled={pdfExporting}
            >
              {i.savePdf}
            </button>
            {saveMsg && <span className="audio-score-export-msg">{saveMsg}</span>}
          </div>

          {/* Canvas area */}
          <div className="audio-score-main-canvas-area" ref={canvasAreaRef}>
            <canvas
              ref={canvasRef}
              className="audio-score-canvas"
              onClick={handleCanvasClick}
              style={{ cursor: "pointer" }}
            />
          </div>
        </>
      )}
    </div>
  );
}
