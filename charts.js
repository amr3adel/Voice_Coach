/**
 * ============================================================
 *  charts.js — Premium Chart & Visualization Renderer
 * ============================================================
 *  Renders beautiful, animated charts using Canvas 2D and
 *  dynamic DOM elements.  All canvas work is retina-aware.
 *
 *  Color palette (dark theme):
 *    Purple   #a855f7 / #7c3aed
 *    Cyan     #22d3ee / #06b6d4
 *    Green    #34d399 / #10b981
 *    Yellow   #fbbf24
 *    Red      #f87171
 *    Surface  rgba(255,255,255,0.06)
 *    Text     rgba(255,255,255,0.7)
 * ============================================================
 */

// ── Color constants ─────────────────────────────────────────────────────────
const COLORS = {
  purple:       '#a855f7',
  purpleDark:   '#7c3aed',
  cyan:         '#22d3ee',
  cyanDark:     '#06b6d4',
  green:        '#34d399',
  greenDark:    '#10b981',
  yellow:       '#fbbf24',
  red:          '#f87171',
  redDark:      '#dc2626',
  surface:      'rgba(255,255,255,0.06)',
  gridLine:     'rgba(255,255,255,0.07)',
  textDim:      'rgba(255,255,255,0.45)',
  textMedium:   'rgba(255,255,255,0.7)',
  textBright:   'rgba(255,255,255,0.9)',
  idealZone:    'rgba(52,211,153,0.08)',
  idealBorder:  'rgba(52,211,153,0.25)'
};

const FONT_FAMILY = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

// ── Easing functions ────────────────────────────────────────────────────────
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

/**
 * ChartRenderer
 * ──────────────
 * Stateless renderer — each draw method is self-contained.
 */
export class ChartRenderer {

  constructor() {
    // Track animation frame IDs for cleanup
    this._animations = new Map();
  }

  /* ═══════════════════════════════════════════════════════
   *  1. SPEED TIMELINE  (Canvas — line chart)
   * ═══════════════════════════════════════════════════════ */

  /**
   * Draw a smooth WPM-over-time line chart.
   *
   * @param {HTMLCanvasElement} canvas   Target canvas element.
   * @param {{ time: number, wpm: number }[]} wpmData  Timeline data.
   * @param {Object} [options]
   * @param {number} [options.idealLow=120]   Low bound of ideal zone.
   * @param {number} [options.idealHigh=150]  High bound of ideal zone.
   * @param {boolean} [options.animate=true]  Animate on first render.
   */
  drawSpeedTimeline(canvas, wpmData, options = {}) {
    const {
      idealLow  = 120,
      idealHigh = 150,
      animate   = true
    } = options;

    if (!wpmData || wpmData.length === 0) {
      this._drawEmptyState(canvas, 'No speed data yet');
      return;
    }

    const ctx = this._setupCanvas(canvas);
    const { w, h } = this._canvasDimensions(canvas);

    // ── Layout padding ──
    const pad = { top: 24, right: 24, bottom: 44, left: 52 };
    const chartW = w - pad.left - pad.right;
    const chartH = h - pad.top - pad.bottom;

    // ── Data bounds ──
    const maxWpm  = Math.max(200, ...wpmData.map(d => d.wpm)) + 10;
    const minWpm  = 0;
    const maxTime = Math.max(...wpmData.map(d => d.time));
    const minTime = Math.min(...wpmData.map(d => d.time));

    // ── Mapping helpers ──
    const xOf = (t) => pad.left + ((t - minTime) / (maxTime - minTime || 1)) * chartW;
    const yOf = (wpm) => pad.top + (1 - (wpm - minWpm) / (maxWpm - minWpm)) * chartH;

    // ── Build the draw function (used for animation frames) ──
    const drawFrame = (progress) => {
      ctx.clearRect(0, 0, w, h);

      // ▸ Grid lines (horizontal)
      this._drawHGridLines(ctx, pad, chartW, chartH, minWpm, maxWpm, 5, 'WPM');

      // ▸ X-axis labels
      this._drawTimeAxis(ctx, pad, chartW, h, wpmData, minTime, maxTime);

      // ▸ Ideal zone band
      const idealTop    = yOf(idealHigh);
      const idealBottom = yOf(idealLow);
      ctx.fillStyle = COLORS.idealZone;
      ctx.fillRect(pad.left, idealTop, chartW, idealBottom - idealTop);
      ctx.strokeStyle = COLORS.idealBorder;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, idealTop);
      ctx.lineTo(pad.left + chartW, idealTop);
      ctx.moveTo(pad.left, idealBottom);
      ctx.lineTo(pad.left + chartW, idealBottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // Ideal zone label
      ctx.fillStyle = COLORS.idealBorder;
      ctx.font = `500 10px ${FONT_FAMILY}`;
      ctx.textAlign = 'right';
      ctx.fillText('Ideal zone', pad.left + chartW - 4, idealTop + 12);

      // ▸ Determine how many points to draw based on animation progress
      const pointCount = Math.max(1, Math.ceil(wpmData.length * progress));
      const visibleData = wpmData.slice(0, pointCount);

      // ▸ Build cubic bezier path
      const points = visibleData.map(d => ({ x: xOf(d.time), y: yOf(d.wpm) }));

      if (points.length >= 2) {
        // Gradient stroke
        const grad = ctx.createLinearGradient(pad.left, pad.top, pad.left, pad.top + chartH);
        grad.addColorStop(0, COLORS.red);
        grad.addColorStop(0.35, COLORS.yellow);
        grad.addColorStop(0.65, COLORS.green);
        grad.addColorStop(1, COLORS.cyan);

        // ▸ Draw smooth line
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);

        for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1];
          const curr = points[i];
          // Cubic bezier with horizontal control points for smooth curves
          const cpx = (prev.x + curr.x) / 2;
          ctx.bezierCurveTo(cpx, prev.y, cpx, curr.y, curr.x, curr.y);
        }

        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();

        // ▸ Area fill under the line (subtle gradient)
        const areaGrad = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
        areaGrad.addColorStop(0, 'rgba(168,85,247,0.15)');
        areaGrad.addColorStop(1, 'rgba(168,85,247,0.0)');

        ctx.lineTo(points[points.length - 1].x, pad.top + chartH);
        ctx.lineTo(points[0].x, pad.top + chartH);
        ctx.closePath();
        ctx.fillStyle = areaGrad;
        ctx.fill();
      }

      // ▸ Data point dots
      if (progress >= 1) {
        points.forEach((p, i) => {
          const wpm = visibleData[i].wpm;
          const color = wpm > 170 ? COLORS.red
                      : wpm > 150 ? COLORS.yellow
                      : wpm >= 120 ? COLORS.green
                      : COLORS.cyan;

          // Outer glow
          ctx.beginPath();
          ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
          ctx.fillStyle = color.replace(')', ',0.2)').replace('rgb', 'rgba');
          ctx.fill();

          // Inner dot
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        });
      }
    };

    // ── Animate or draw immediately ──
    if (animate) {
      this._animate(canvas, 1200, drawFrame);
    } else {
      drawFrame(1);
    }
  }

  /* ═══════════════════════════════════════════════════════
   *  2. PAUSE MAP  (DOM — horizontal timeline bar)
   * ═══════════════════════════════════════════════════════ */

  /**
   * Create a horizontal timeline showing pause positions and types.
   *
   * @param {HTMLElement} container   Target container div.
   * @param {{ startTime, endTime, duration }[]} pauses  Pause list.
   * @param {number} totalDuration  Total session duration in seconds.
   */
  drawPauseMap(container, pauses, totalDuration) {
    container.innerHTML = '';

    if (!pauses || pauses.length === 0 || totalDuration <= 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:20px;color:${COLORS.textDim};
                    font:400 13px ${FONT_FAMILY};">No pause data available</div>`;
      return;
    }

    // ── Wrapper styles ──
    Object.assign(container.style, {
      position: 'relative',
      padding: '12px 0'
    });

    // ── Pause type colors ──
    const pauseColor = (dur) => {
      if (dur < 0.3)  return { bg: 'rgba(255,255,255,0.15)', label: 'Micro pause', cls: 'micro' };
      if (dur <= 1.5) return { bg: COLORS.green,  label: 'Good pause',    cls: 'good' };
      if (dur <= 3.0) return { bg: COLORS.yellow, label: 'Long pause',    cls: 'long' };
      return                  { bg: COLORS.red,    label: 'Awkward pause', cls: 'awkward' };
    };

    // ── The timeline bar ──
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'relative',
      width: '100%',
      height: '32px',
      background: 'rgba(255,255,255,0.04)',
      borderRadius: '8px',
      overflow: 'hidden',
      border: '1px solid rgba(255,255,255,0.08)'
    });

    // ── Render each pause as a colored segment ──
    pauses.forEach((p, i) => {
      const left  = (p.startTime / totalDuration) * 100;
      const width = Math.max(0.3, (p.duration / totalDuration) * 100); // min 0.3% visibility
      const info  = pauseColor(p.duration);

      const seg = document.createElement('div');
      Object.assign(seg.style, {
        position: 'absolute',
        left: `${left}%`,
        width: `${width}%`,
        top: '0',
        height: '100%',
        background: info.bg,
        opacity: '0.7',
        borderRadius: '2px',
        cursor: 'pointer',
        transition: 'opacity 0.2s, transform 0.2s',
        zIndex: '1'
      });

      // Hover tooltip
      const tooltip = document.createElement('div');
      tooltip.textContent = `${info.label} · ${p.duration.toFixed(1)}s`;
      Object.assign(tooltip.style, {
        position: 'absolute',
        bottom: '110%',
        left: '50%',
        transform: 'translateX(-50%) scale(0.9)',
        background: 'rgba(15,15,25,0.95)',
        color: COLORS.textBright,
        padding: '4px 10px',
        borderRadius: '6px',
        fontSize: '11px',
        fontFamily: FONT_FAMILY,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity 0.2s, transform 0.2s',
        border: `1px solid ${info.bg}`,
        zIndex: '10'
      });

      seg.appendChild(tooltip);
      seg.addEventListener('mouseenter', () => {
        seg.style.opacity = '1';
        seg.style.transform = 'scaleY(1.15)';
        tooltip.style.opacity = '1';
        tooltip.style.transform = 'translateX(-50%) scale(1)';
      });
      seg.addEventListener('mouseleave', () => {
        seg.style.opacity = '0.7';
        seg.style.transform = 'scaleY(1)';
        tooltip.style.opacity = '0';
        tooltip.style.transform = 'translateX(-50%) scale(0.9)';
      });

      // Stagger animation
      seg.style.animation = `pauseFadeIn 0.4s ease ${i * 0.05}s both`;

      bar.appendChild(seg);
    });

    container.appendChild(bar);

    // ── Time labels ──
    const labels = document.createElement('div');
    Object.assign(labels.style, {
      display: 'flex',
      justifyContent: 'space-between',
      marginTop: '6px',
      font: `400 11px ${FONT_FAMILY}`,
      color: COLORS.textDim
    });
    labels.innerHTML = `<span>0:00</span><span>${ChartRenderer.formatTime(totalDuration)}</span>`;
    container.appendChild(labels);

    // ── Legend ──
    const legend = document.createElement('div');
    Object.assign(legend.style, {
      display: 'flex',
      gap: '14px',
      marginTop: '10px',
      flexWrap: 'wrap'
    });

    [
      { color: 'rgba(255,255,255,0.15)', label: 'Micro (<0.3s)' },
      { color: COLORS.green,  label: 'Good (0.3–1.5s)' },
      { color: COLORS.yellow, label: 'Long (1.5–3s)' },
      { color: COLORS.red,    label: 'Awkward (>3s)' }
    ].forEach(({ color, label }) => {
      const item = document.createElement('div');
      Object.assign(item.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        font: `400 11px ${FONT_FAMILY}`,
        color: COLORS.textMedium
      });
      item.innerHTML = `<span style="display:inline-block;width:10px;height:10px;
        border-radius:3px;background:${color};opacity:0.8"></span>${label}`;
      legend.appendChild(item);
    });

    container.appendChild(legend);

    // ── Inject animation keyframes (once) ──
    this._injectPauseAnimation();
  }

  /* ═══════════════════════════════════════════════════════
   *  3. SCORE GAUGE  (Canvas — circular donut)
   * ═══════════════════════════════════════════════════════ */

  /**
   * Draw an animated circular gauge with the score and grade.
   *
   * @param {HTMLCanvasElement} canvas  Target canvas.
   * @param {number} score             0 – 100.
   * @param {string} grade             Letter grade (A/B/C/D/F).
   * @param {Object} [options]
   * @param {boolean} [options.animate=true]
   */
  drawScoreGauge(canvas, score, grade, options = {}) {
    const { animate = true } = options;

    const ctx = this._setupCanvas(canvas);
    const { w, h } = this._canvasDimensions(canvas);
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2 - 20;
    const lineWidth = 14;

    const drawFrame = (progress) => {
      ctx.clearRect(0, 0, w, h);

      const currentScore = score * progress;
      const angle = (currentScore / 100) * Math.PI * 1.5; // 270° max arc
      const startAngle = Math.PI * 0.75;  // start at bottom-left (135°)

      // ▸ Background track
      ctx.beginPath();
      ctx.arc(cx, cy, radius, startAngle, startAngle + Math.PI * 1.5);
      ctx.strokeStyle = COLORS.surface;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.stroke();

      // ▸ Score arc with gradient
      if (currentScore > 0) {
        const grad = ctx.createConicGradient(startAngle, cx, cy);
        grad.addColorStop(0, COLORS.red);
        grad.addColorStop(0.25, COLORS.yellow);
        grad.addColorStop(0.5, COLORS.green);
        grad.addColorStop(0.75, COLORS.cyan);
        grad.addColorStop(1, COLORS.purple);

        ctx.beginPath();
        ctx.arc(cx, cy, radius, startAngle, startAngle + angle);
        ctx.strokeStyle = grad;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.stroke();

        // ▸ Glow effect at the tip
        const tipAngle = startAngle + angle;
        const tipX = cx + Math.cos(tipAngle) * radius;
        const tipY = cy + Math.sin(tipAngle) * radius;

        const glowGrad = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, 16);
        const tipColor = currentScore > 70 ? COLORS.green : currentScore > 40 ? COLORS.yellow : COLORS.red;
        glowGrad.addColorStop(0, tipColor.replace(')', ',0.4)').replace('rgb', 'rgba').replace('#', ''));
        glowGrad.addColorStop(1, 'transparent');

        // Simplified glow — just a brighter dot
        ctx.beginPath();
        ctx.arc(tipX, tipY, 8, 0, Math.PI * 2);
        ctx.fillStyle = `${tipColor}44`;
        ctx.fill();
      }

      // ▸ Grade letter (center)
      if (progress >= 0.5) {
        const textOpacity = Math.min(1, (progress - 0.5) * 4);
        ctx.globalAlpha = textOpacity;

        ctx.fillStyle = COLORS.textBright;
        ctx.font = `800 ${radius * 0.6}px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(grade, cx, cy - 4);

        // Score number below grade
        ctx.fillStyle = COLORS.textMedium;
        ctx.font = `600 ${radius * 0.2}px ${FONT_FAMILY}`;
        ctx.fillText(`${Math.round(currentScore)} / 100`, cx, cy + radius * 0.35);

        ctx.globalAlpha = 1;
      }
    };

    if (animate) {
      this._animate(canvas, 1600, drawFrame, easeOutCubic);
    } else {
      drawFrame(1);
    }
  }

  /* ═══════════════════════════════════════════════════════
   *  4. FILLER CHART  (DOM — horizontal bar chart)
   * ═══════════════════════════════════════════════════════ */

  /**
   * Render a horizontal bar chart of filler word counts.
   *
   * @param {HTMLElement} container       Target container div.
   * @param {Object.<string,number>} fillerCounts  { word: count } map.
   */
  drawFillerChart(container, fillerCounts) {
    container.innerHTML = '';

    const entries = Object.entries(fillerCounts || {})
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1]);

    if (entries.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:24px;color:${COLORS.textDim};
                    font:400 13px ${FONT_FAMILY};">
          🎉 No filler words detected!
        </div>`;
      return;
    }

    const maxCount = entries[0][1];

    // ── Chart wrapper ──
    const wrapper = document.createElement('div');
    Object.assign(wrapper.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '4px 0'
    });

    entries.forEach(([word, count], i) => {
      const pct = (count / maxCount) * 100;

      // Intensity: higher count → more saturated
      const intensity = Math.min(1, count / Math.max(maxCount, 1));
      const barColor = this._lerpColor(COLORS.purple, COLORS.red, intensity);

      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'grid',
        gridTemplateColumns: '80px 1fr 36px',
        alignItems: 'center',
        gap: '10px'
      });

      // Label
      const label = document.createElement('span');
      label.textContent = `"${word}"`;
      Object.assign(label.style, {
        font: `500 13px ${FONT_FAMILY}`,
        color: COLORS.textMedium,
        textAlign: 'right',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      });

      // Bar container
      const barContainer = document.createElement('div');
      Object.assign(barContainer.style, {
        height: '22px',
        background: COLORS.surface,
        borderRadius: '6px',
        overflow: 'hidden',
        position: 'relative'
      });

      // Bar fill
      const barFill = document.createElement('div');
      Object.assign(barFill.style, {
        width: '0%',
        height: '100%',
        background: `linear-gradient(90deg, ${barColor}88, ${barColor})`,
        borderRadius: '6px',
        transition: `width 0.6s cubic-bezier(0.34,1.56,0.64,1) ${i * 0.08}s`
      });

      // Trigger animation after append
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          barFill.style.width = `${pct}%`;
        });
      });

      barContainer.appendChild(barFill);

      // Count badge
      const badge = document.createElement('span');
      badge.textContent = `×${count}`;
      Object.assign(badge.style, {
        font: `700 12px ${FONT_FAMILY}`,
        color: barColor,
        textAlign: 'left'
      });

      row.appendChild(label);
      row.appendChild(barContainer);
      row.appendChild(badge);
      wrapper.appendChild(row);
    });

    container.appendChild(wrapper);
  }

  /* ═══════════════════════════════════════════════════════
   *  STATIC UTILITIES
   * ═══════════════════════════════════════════════════════ */

  /**
   * Format seconds to mm:ss.
   * @param   {number} seconds
   * @returns {string}
   */
  static formatTime(seconds) {
    if (seconds == null || isNaN(seconds) || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /* ═══════════════════════════════════════════════════════
   *  PRIVATE HELPERS
   * ═══════════════════════════════════════════════════════ */

  /**
   * Set up a canvas for crisp retina rendering.
   * @param   {HTMLCanvasElement} canvas
   * @returns {CanvasRenderingContext2D}
   * @private
   */
  _setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    canvas.width  = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    return ctx;
  }

  /**
   * Get CSS pixel dimensions of a canvas.
   * @param   {HTMLCanvasElement} canvas
   * @returns {{ w: number, h: number }}
   * @private
   */
  _canvasDimensions(canvas) {
    const rect = canvas.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
  }

  /**
   * Run an animation loop on a canvas.
   * @param {HTMLCanvasElement} canvas
   * @param {number}   durationMs     Total animation duration.
   * @param {Function} drawFn         Called with progress (0 → 1).
   * @param {Function} [easeFn]       Easing function, default easeOutCubic.
   * @private
   */
  _animate(canvas, durationMs, drawFn, easeFn = easeOutCubic) {
    // Cancel any existing animation on this canvas
    const existing = this._animations.get(canvas);
    if (existing) cancelAnimationFrame(existing);

    const start = performance.now();

    const tick = (now) => {
      const elapsed  = now - start;
      const rawProgress = Math.min(1, elapsed / durationMs);
      const progress = easeFn(rawProgress);

      drawFn(progress);

      if (rawProgress < 1) {
        this._animations.set(canvas, requestAnimationFrame(tick));
      } else {
        this._animations.delete(canvas);
      }
    };

    this._animations.set(canvas, requestAnimationFrame(tick));
  }

  /**
   * Draw horizontal grid lines with labels.
   * @private
   */
  _drawHGridLines(ctx, pad, chartW, chartH, minVal, maxVal, count, unit) {
    ctx.strokeStyle = COLORS.gridLine;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.textDim;
    ctx.font = `400 10px ${FONT_FAMILY}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= count; i++) {
      const val = minVal + (maxVal - minVal) * (i / count);
      const y   = pad.top + chartH - (chartH * (i / count));

      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + chartW, y);
      ctx.stroke();

      ctx.fillText(Math.round(val).toString(), pad.left - 8, y);
    }
  }

  /**
   * Draw time axis labels.
   * @private
   */
  _drawTimeAxis(ctx, pad, chartW, canvasH, data, minTime, maxTime) {
    ctx.fillStyle = COLORS.textDim;
    ctx.font = `400 10px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Pick up to 6 evenly-spaced labels
    const labelCount = Math.min(6, data.length);
    const step = Math.max(1, Math.floor(data.length / labelCount));

    for (let i = 0; i < data.length; i += step) {
      const d = data[i];
      const x = pad.left + ((d.time - minTime) / (maxTime - minTime || 1)) * chartW;
      ctx.fillText(ChartRenderer.formatTime(d.time), x, canvasH - pad.bottom + 10);
    }

    // Always draw last label
    const last = data[data.length - 1];
    const lastX = pad.left + chartW;
    ctx.fillText(ChartRenderer.formatTime(last.time), lastX, canvasH - pad.bottom + 10);
  }

  /**
   * Draw an empty-state message on a canvas.
   * @private
   */
  _drawEmptyState(canvas, message) {
    const ctx = this._setupCanvas(canvas);
    const { w, h } = this._canvasDimensions(canvas);

    ctx.fillStyle = COLORS.textDim;
    ctx.font = `400 14px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message, w / 2, h / 2);
  }

  /**
   * Linear interpolation between two hex colors.
   * @param   {string} color1  Hex color.
   * @param   {string} color2  Hex color.
   * @param   {number} t       0 – 1.
   * @returns {string} Hex color.
   * @private
   */
  _lerpColor(color1, color2, t) {
    const c1 = this._hexToRgb(color1);
    const c2 = this._hexToRgb(color2);
    const r = Math.round(c1.r + (c2.r - c1.r) * t);
    const g = Math.round(c1.g + (c2.g - c1.g) * t);
    const b = Math.round(c1.b + (c2.b - c1.b) * t);
    return `rgb(${r},${g},${b})`;
  }

  /**
   * Parse hex color to { r, g, b }.
   * @private
   */
  _hexToRgb(hex) {
    const m = hex.replace('#', '').match(/.{2}/g);
    return {
      r: parseInt(m[0], 16),
      g: parseInt(m[1], 16),
      b: parseInt(m[2], 16)
    };
  }

  /**
   * Inject CSS keyframes for pause-map animation (idempotent).
   * @private
   */
  _injectPauseAnimation() {
    if (document.getElementById('__vc_pause_anim')) return;
    const style = document.createElement('style');
    style.id = '__vc_pause_anim';
    style.textContent = `
      @keyframes pauseFadeIn {
        from { opacity: 0; transform: scaleY(0.3); }
        to   { opacity: 0.7; transform: scaleY(1); }
      }
    `;
    document.head.appendChild(style);
  }
}
