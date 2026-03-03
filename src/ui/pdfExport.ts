/**
 * PDF export for sheet music scores.
 * Renders score to an offscreen high-resolution canvas and slices it
 * into A4 pages using jsPDF.
 */

import { jsPDF } from "jspdf";
import { ScoreData } from "../types";
import { renderScore, getSystemLayouts, RenderOptions, SystemLayout } from "./ScoreRenderer";
import type { ChordAnnotation } from "../core/aiService";

/** A4 dimensions in mm */
const A4_W = 210;
const A4_H = 297;

/** Margins in mm */
const MARGIN_TOP = 15;
const MARGIN_BOTTOM = 15;
const MARGIN_LEFT = 10;
const MARGIN_RIGHT = 10;

/** Title area height in mm (first page only) */
const TITLE_HEIGHT = 12;

/** Max canvas area (iOS Safari limit) */
const MAX_CANVAS_AREA = 16_777_216;

/** Target DPI for rendering */
const TARGET_DPI = 150;

/**
 * Export the score as an A4 PDF and trigger download.
 */
export async function exportScorePdf(
  score: ScoreData,
  title: string,
  chordAnnotations?: ChordAnnotation[],
): Promise<void> {
  // Printable area in mm
  const printW = A4_W - MARGIN_LEFT - MARGIN_RIGHT; // 190mm
  const printH = A4_H - MARGIN_TOP - MARGIN_BOTTOM; // 267mm

  // Convert mm to pixels at target DPI: px = mm / 25.4 * dpi
  const mmToPx = (mm: number) => (mm / 25.4) * TARGET_DPI;
  const canvasWidthPx = mmToPx(printW);

  // Get layout information at this width
  const renderOpts: RenderOptions = {
    width: canvasWidthPx,
    backgroundColor: "#ffffff",
    staffColor: "#333333",
    noteColor: "#000000",
    chordAnnotations: chordAnnotations ?? [],
  };

  const layout = getSystemLayouts(score, renderOpts);
  const { systems, staffHeight, systemGap, topMargin, bottomMargin } = layout;

  if (systems.length === 0) return;

  // Total canvas height
  const totalHeight =
    systems.length * (staffHeight + systemGap) + topMargin + bottomMargin;
  const canvasW = Math.ceil(layout.canvasWidth);
  const canvasH = Math.ceil(totalHeight);

  // Determine effective DPI – reduce if canvas would exceed pixel limit
  let dpi = TARGET_DPI;
  if (canvasW * canvasH > MAX_CANVAS_AREA) {
    const scale = Math.sqrt(MAX_CANVAS_AREA / (canvasW * canvasH));
    dpi = Math.floor(TARGET_DPI * scale);
  }

  // Re-compute if DPI changed
  const effectiveMmToPx = (mm: number) => (mm / 25.4) * dpi;
  let finalCanvasW = canvasW;
  let finalCanvasH = canvasH;
  let finalRenderOpts = renderOpts;
  let finalLayout = layout;

  if (dpi !== TARGET_DPI) {
    const newCanvasWidthPx = effectiveMmToPx(printW);
    finalRenderOpts = { ...renderOpts, width: newCanvasWidthPx };
    finalLayout = getSystemLayouts(score, finalRenderOpts);
    const newTotalHeight =
      finalLayout.systems.length * (finalLayout.staffHeight + finalLayout.systemGap) +
      finalLayout.topMargin + finalLayout.bottomMargin;
    finalCanvasW = Math.ceil(finalLayout.canvasWidth);
    finalCanvasH = Math.ceil(newTotalHeight);
  }

  // Create offscreen canvas and render
  const canvas = document.createElement("canvas");
  canvas.width = finalCanvasW;
  canvas.height = finalCanvasH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot create canvas context");

  renderScore(ctx, score, finalRenderOpts);

  // Split systems into pages
  const pxToMm = (px: number) => (px * 25.4) / dpi;
  const pages = splitIntoPages(
    finalLayout.systems,
    finalLayout.staffHeight,
    finalLayout.systemGap,
    finalLayout.topMargin,
    pxToMm,
    printH,
    TITLE_HEIGHT,
  );

  // Create PDF
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    if (pageIdx > 0) pdf.addPage();

    const page = pages[pageIdx];
    const isFirstPage = pageIdx === 0;

    // Title on first page — rendered via Canvas to support CJK characters
    if (isFirstPage && title) {
      const titleImg = renderTitleImage(title, finalCanvasW, dpi);
      const titleWMm = pxToMm(titleImg.width);
      const titleHMm = pxToMm(titleImg.height);
      const titleScale = printW / titleWMm;
      pdf.addImage(
        titleImg.toDataURL("image/png"), "PNG",
        MARGIN_LEFT, MARGIN_TOP,
        printW, titleHMm * titleScale,
      );
    }

    // Slice the region of the full canvas for this page
    const srcY = page.srcY;
    const srcH = page.srcH;

    if (srcH <= 0) continue;

    // Create a temporary canvas for the slice
    const sliceCanvas = document.createElement("canvas");
    sliceCanvas.width = finalCanvasW;
    sliceCanvas.height = Math.ceil(srcH);
    const sliceCtx = sliceCanvas.getContext("2d");
    if (!sliceCtx) continue;

    // Fill white background
    sliceCtx.fillStyle = "#ffffff";
    sliceCtx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);

    // Draw the slice
    sliceCtx.drawImage(
      canvas,
      0, srcY, finalCanvasW, srcH,
      0, 0, finalCanvasW, srcH,
    );

    // Convert to data URL and add to PDF
    const imgData = sliceCanvas.toDataURL("image/png");
    const imgWMm = pxToMm(finalCanvasW);
    const imgHMm = pxToMm(srcH);

    // Scale to fit printable width
    const scale = printW / imgWMm;
    const destW = printW;
    const destH = imgHMm * scale;

    const destY = isFirstPage
      ? MARGIN_TOP + TITLE_HEIGHT + 2
      : MARGIN_TOP;

    pdf.addImage(imgData, "PNG", MARGIN_LEFT, destY, destW, destH);
  }

  // Download
  const safeName = title.replace(/[^a-zA-Z0-9_\-\u3000-\u9FFF\u3040-\u309F\u30A0-\u30FF]/g, "_") || "score";
  pdf.save(`${safeName}.pdf`);
}

interface PageSlice {
  srcY: number; // source Y in canvas pixels
  srcH: number; // source height in canvas pixels
}

/**
 * Split systems into pages that fit within the printable height.
 */
function splitIntoPages(
  systems: SystemLayout[],
  staffHeight: number,
  systemGap: number,
  topMargin: number,
  pxToMm: (px: number) => number,
  printHeightMm: number,
  titleHeightMm: number,
): PageSlice[] {
  const pages: PageSlice[] = [];

  let currentPageSystems: SystemLayout[] = [];
  let isFirstPage = true;

  for (let i = 0; i < systems.length; i++) {
    currentPageSystems.push(systems[i]);

    // Calculate the height of current page systems in mm
    const firstSysY = currentPageSystems[0].y;
    const lastSysY = currentPageSystems[currentPageSystems.length - 1].y;
    const heightPx = lastSysY - firstSysY + staffHeight + systemGap / 2;
    const heightMm = pxToMm(heightPx);

    const availableH = isFirstPage
      ? printHeightMm - titleHeightMm - 2
      : printHeightMm;

    if (heightMm > availableH && currentPageSystems.length > 1) {
      // Remove last system and finalize this page
      currentPageSystems.pop();

      const pageSrcY = currentPageSystems[0].y - topMargin / 2;
      const pageLastY = currentPageSystems[currentPageSystems.length - 1].y;
      const pageSrcH = pageLastY - pageSrcY + staffHeight + systemGap / 2;

      pages.push({ srcY: Math.max(0, pageSrcY), srcH: pageSrcH });

      // Start new page with the removed system
      currentPageSystems = [systems[i]];
      isFirstPage = false;
    }
  }

  // Remaining systems
  if (currentPageSystems.length > 0) {
    const pageSrcY = currentPageSystems[0].y - topMargin / 2;
    const pageLastY = currentPageSystems[currentPageSystems.length - 1].y;
    const pageSrcH = pageLastY - pageSrcY + staffHeight + systemGap / 2;

    pages.push({ srcY: Math.max(0, pageSrcY), srcH: pageSrcH });
  }

  return pages;
}

/**
 * Render title text onto a small canvas so any Unicode (including CJK) is supported.
 */
function renderTitleImage(
  title: string,
  widthPx: number,
  dpi: number,
): HTMLCanvasElement {
  const fontSize = Math.round((14 / 72) * dpi); // 14pt at given DPI
  const padding = Math.round(fontSize * 0.5);
  const height = fontSize + padding * 2;

  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#000000";
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(title, widthPx / 2, height / 2);

  return canvas;
}
