/**
 * ============================================================
 *  AudioAnalyzer — Web Audio API Recording & Visualization
 * ============================================================
 *  Handles microphone capture, real-time waveform rendering,
 *  pause detection, and audio blob export.
 *
 *  Usage:
 *    const analyzer = new AudioAnalyzer(canvasEl);
 *    await analyzer.init();
 *    analyzer.onPauseDetected(({ startTime }) => { ... });
 *    analyzer.onPauseEnded(({ startTime, endTime, duration }) => { ... });
 *    analyzer.start();
 *    // ... later
 *    analyzer.stop();
 *    const blob = analyzer.getAudioBlob();
 * ============================================================
 */

export class AudioAnalyzer {

  /* ── Configuration ────────────────────────────────────── */

  static DEFAULTS = {
    fftSize: 2048,
    smoothingTimeConstant: 0.82,
    pauseThreshold: 0.01,        // RMS volume below this = silence
    pauseMinDuration: 300,       // ms before we call it a real pause
    barWidthRatio: 0.6,          // fraction of bar slot filled (gap = 1 - ratio)
    minBarHeight: 2,             // px – even silence has a tiny line
    glowBlur: 12,                // px – neon glow radius
    idleAmplitude: 0.04,         // subtle sine wave when idle
    idleSpeed: 0.0012,           // idle animation speed
    mimeType: 'audio/webm',     // MediaRecorder output format
  };

  /* ── Constructor ──────────────────────────────────────── */

  /**
   * @param {HTMLCanvasElement} canvasElement – the <canvas> for waveform drawing
   */
  constructor(canvasElement) {
    this._canvas = canvasElement;
    this._ctx = canvasElement.getContext('2d');

    // Audio graph nodes
    this._audioContext = null;
    this._analyser = null;
    this._sourceNode = null;
    this._stream = null;

    // Recording
    this._mediaRecorder = null;
    this._audioChunks = [];
    this._audioBlob = null;

    // Visualization state
    this._animFrameId = null;
    this._isRecording = false;
    this._idlePhase = 0;           // phase accumulator for idle animation

    // Pause detection state
    this._currentRms = 0;
    this._belowThresholdSince = null;   // timestamp when volume first dropped
    this._inPause = false;
    this._pauses = [];                  // { startTime, endTime, duration }

    // Callbacks
    this._onPauseDetected = null;
    this._onPauseEnded = null;

    // Frequency data buffer (allocated once after analyser is created)
    this._frequencyData = null;
    this._timeDomainData = null;

    // Bind the resize handler so we can remove it later
    this._handleResize = this._handleResize.bind(this);
    window.addEventListener('resize', this._handleResize);
    this._syncCanvasSize();
  }

  /* ── Public API ───────────────────────────────────────── */

  /**
   * Request microphone permission and wire up the audio graph.
   * Must be called (and awaited) before start().
   */
  async init() {
    // 1. Get mic stream
    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // 2. Create AudioContext + AnalyserNode
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this._audioContext = new AudioCtx();
    this._analyser = this._audioContext.createAnalyser();
    this._analyser.fftSize = AudioAnalyzer.DEFAULTS.fftSize;
    this._analyser.smoothingTimeConstant = AudioAnalyzer.DEFAULTS.smoothingTimeConstant;

    // 3. Connect mic → analyser (we don't connect to destination to avoid feedback)
    this._sourceNode = this._audioContext.createMediaStreamSource(this._stream);
    this._sourceNode.connect(this._analyser);

    // 4. Allocate typed arrays for getByteFrequencyData / getByteTimeDomainData
    this._frequencyData = new Uint8Array(this._analyser.frequencyBinCount);
    this._timeDomainData = new Uint8Array(this._analyser.fftSize);

    // 5. Set up MediaRecorder for blob export
    this._initMediaRecorder();

    // 6. Start the idle visualisation loop (runs even before recording)
    this._drawLoop();
  }

  /**
   * Begin recording audio and activate pause detection.
   */
  start() {
    if (!this._analyser) {
      throw new Error('AudioAnalyzer.init() must be called before start().');
    }

    // Resume AudioContext if suspended (Chrome autoplay policy)
    if (this._audioContext.state === 'suspended') {
      this._audioContext.resume();
    }

    this._isRecording = true;
    this._audioChunks = [];
    this._audioBlob = null;
    this._pauses = [];
    this._belowThresholdSince = null;
    this._inPause = false;

    // Start MediaRecorder
    if (this._mediaRecorder && this._mediaRecorder.state === 'inactive') {
      this._mediaRecorder.start(250); // emit data every 250 ms
    }
  }

  /**
   * Stop recording and return the captured audio Blob.
   * @returns {Promise<Blob>} – the recorded audio
   */
  stop() {
    this._isRecording = false;

    // Close any open pause
    if (this._inPause) {
      this._closePause();
    }

    return new Promise((resolve) => {
      if (!this._mediaRecorder || this._mediaRecorder.state === 'inactive') {
        resolve(this._audioBlob);
        return;
      }

      // Wait for the final dataavailable before resolving
      this._mediaRecorder.addEventListener('stop', () => {
        this._audioBlob = new Blob(this._audioChunks, {
          type: AudioAnalyzer.DEFAULTS.mimeType,
        });
        resolve(this._audioBlob);
      }, { once: true });

      this._mediaRecorder.stop();
    });
  }

  /**
   * Current RMS volume normalised to 0‒1.
   * @returns {number}
   */
  getVolume() {
    return this._currentRms;
  }

  /**
   * Whether the speaker is currently in a detected pause.
   * @returns {boolean}
   */
  isInPause() {
    return this._inPause;
  }

  /**
   * Register a callback for pause-detected events.
   * @param {function({ startTime: number })} callback
   */
  onPauseDetected(callback) {
    this._onPauseDetected = callback;
  }

  /**
   * Register a callback for pause-ended events.
   * @param {function({ startTime: number, endTime: number, duration: number })} callback
   */
  onPauseEnded(callback) {
    this._onPauseEnded = callback;
  }

  /**
   * Return the recorded audio Blob (available after stop()).
   * @returns {Blob|null}
   */
  getAudioBlob() {
    return this._audioBlob;
  }

  /**
   * Return the array of detected pauses.
   * @returns {{ startTime: number, endTime: number, duration: number }[]}
   */
  getPauses() {
    return [...this._pauses];
  }

  /**
   * Tear down everything — stops streams, kills animation, removes listeners.
   */
  destroy() {
    this._isRecording = false;

    // Cancel animation
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }

    // Stop MediaRecorder
    if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
      try { this._mediaRecorder.stop(); } catch (_) { /* ignore */ }
    }

    // Disconnect audio graph
    if (this._sourceNode) {
      try { this._sourceNode.disconnect(); } catch (_) { /* ignore */ }
    }

    // Close AudioContext
    if (this._audioContext && this._audioContext.state !== 'closed') {
      this._audioContext.close();
    }

    // Stop mic stream tracks
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
    }

    // Remove resize listener
    window.removeEventListener('resize', this._handleResize);

    // Null out references
    this._audioContext = null;
    this._analyser = null;
    this._sourceNode = null;
    this._stream = null;
    this._mediaRecorder = null;
  }

  /* ── Private — Media Recorder ─────────────────────────── */

  _initMediaRecorder() {
    // Choose a supported mime type
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    let mimeType = '';
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) { mimeType = t; break; }
    }

    this._mediaRecorder = new MediaRecorder(this._stream, mimeType ? { mimeType } : {});

    this._mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) {
        this._audioChunks.push(e.data);
      }
    });
  }

  /* ── Private — Pause Detection ────────────────────────── */

  /**
   * Called every animation frame while recording to evaluate silence.
   */
  _evaluatePause() {
    const { pauseThreshold, pauseMinDuration } = AudioAnalyzer.DEFAULTS;
    const now = performance.now();

    if (this._currentRms < pauseThreshold) {
      // Volume is below threshold
      if (this._belowThresholdSince === null) {
        this._belowThresholdSince = now;
      }

      const elapsed = now - this._belowThresholdSince;
      if (!this._inPause && elapsed >= pauseMinDuration) {
        // Pause officially starts
        this._inPause = true;
        const pauseRecord = { startTime: this._belowThresholdSince, endTime: null, duration: null };
        this._pauses.push(pauseRecord);
        if (this._onPauseDetected) {
          this._onPauseDetected({ startTime: pauseRecord.startTime });
        }
      }
    } else {
      // Volume is above threshold — speech resumed
      if (this._inPause) {
        this._closePause();
      }
      this._belowThresholdSince = null;
    }
  }

  /**
   * Finalise the most recent pause record and fire the callback.
   */
  _closePause() {
    const now = performance.now();
    const pauseRecord = this._pauses[this._pauses.length - 1];
    if (pauseRecord && pauseRecord.endTime === null) {
      pauseRecord.endTime = now;
      pauseRecord.duration = now - pauseRecord.startTime;
    }
    this._inPause = false;
    this._belowThresholdSince = null;

    if (this._onPauseEnded && pauseRecord) {
      this._onPauseEnded({
        startTime: pauseRecord.startTime,
        endTime: pauseRecord.endTime,
        duration: pauseRecord.duration,
      });
    }
  }

  /* ── Private — RMS Calculation ────────────────────────── */

  /**
   * Compute the Root-Mean-Square volume from the time-domain data.
   * @returns {number} 0‒1
   */
  _computeRms() {
    if (!this._analyser) return 0;
    this._analyser.getByteTimeDomainData(this._timeDomainData);

    let sumSquares = 0;
    for (let i = 0; i < this._timeDomainData.length; i++) {
      const normalised = (this._timeDomainData[i] - 128) / 128; // centre around 0
      sumSquares += normalised * normalised;
    }
    return Math.sqrt(sumSquares / this._timeDomainData.length);
  }

  /* ── Private — Canvas / Resize ────────────────────────── */

  _syncCanvasSize() {
    const rect = this._canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width = rect.width * dpr;
    this._canvas.height = rect.height * dpr;
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _handleResize() {
    this._syncCanvasSize();
  }

  /* ── Private — Visualisation ──────────────────────────── */

  /**
   * Main render loop — delegates to active or idle drawing.
   */
  _drawLoop() {
    // Compute RMS every frame so getVolume() is always fresh
    this._currentRms = this._computeRms();

    if (this._isRecording) {
      this._evaluatePause();
      this._drawActiveWaveform();
    } else {
      this._drawIdleWaveform();
    }

    this._animFrameId = requestAnimationFrame(() => this._drawLoop());
  }

  /* ── Active Waveform (frequency bars with gradient + glow) ── */

  _drawActiveWaveform() {
    const ctx = this._ctx;
    const W = this._canvas.getBoundingClientRect().width;
    const H = this._canvas.getBoundingClientRect().height;
    const { barWidthRatio, minBarHeight, glowBlur } = AudioAnalyzer.DEFAULTS;

    // Grab frequency data
    this._analyser.getByteFrequencyData(this._frequencyData);

    // Clear
    ctx.clearRect(0, 0, W, H);

    // We only draw the lower half of the frequency bins (upper bins are mostly empty)
    const usableBins = Math.floor(this._frequencyData.length * 0.65);

    // Determine how many bars we can fit (aim for ~80-120 bars)
    const targetBars = Math.min(usableBins, Math.max(40, Math.floor(W / 6)));
    const step = Math.floor(usableBins / targetBars);
    const barSlotWidth = W / targetBars;
    const barWidth = barSlotWidth * barWidthRatio;

    // Build a vertical gradient: purple → cyan → green
    const gradient = ctx.createLinearGradient(0, H, 0, 0);
    gradient.addColorStop(0.0, '#7c3aed');  // violet
    gradient.addColorStop(0.35, '#a855f7'); // purple
    gradient.addColorStop(0.55, '#06b6d4'); // cyan
    gradient.addColorStop(0.8, '#22d3ee');  // light cyan
    gradient.addColorStop(1.0, '#4ade80');  // green

    // Enable glow
    ctx.shadowColor = '#06b6d4';
    ctx.shadowBlur = glowBlur;

    const centerY = H / 2;

    for (let i = 0; i < targetBars; i++) {
      // Average a few bins for this bar to smooth things out
      let sum = 0;
      for (let j = 0; j < step; j++) {
        sum += this._frequencyData[i * step + j];
      }
      const avg = sum / step;                     // 0‒255
      const normAmp = avg / 255;                   // 0‒1
      const barHeight = Math.max(normAmp * (H * 0.9), minBarHeight);

      const x = i * barSlotWidth + (barSlotWidth - barWidth) / 2;

      // Draw mirrored bar (extends up and down from centre)
      ctx.fillStyle = gradient;
      ctx.beginPath();
      // Rounded-rect helper (top-left x, top-left y, w, h, radius)
      const half = barHeight / 2;
      const radius = Math.min(barWidth / 2, 3);
      this._roundRect(ctx, x, centerY - half, barWidth, barHeight, radius);
      ctx.fill();
    }

    // Reset shadow so it doesn't bleed into next frame
    ctx.shadowBlur = 0;
  }

  /* ── Idle Waveform (subtle breathing sine wave) ───────── */

  _drawIdleWaveform() {
    const ctx = this._ctx;
    const W = this._canvas.getBoundingClientRect().width;
    const H = this._canvas.getBoundingClientRect().height;
    const { idleAmplitude, idleSpeed, minBarHeight } = AudioAnalyzer.DEFAULTS;

    ctx.clearRect(0, 0, W, H);

    this._idlePhase += idleSpeed * 16; // ~16 ms per frame at 60 fps

    const targetBars = Math.max(40, Math.floor(W / 6));
    const barSlotWidth = W / targetBars;
    const barWidth = barSlotWidth * 0.6;
    const centerY = H / 2;

    // Soft purple gradient for idle state
    const gradient = ctx.createLinearGradient(0, H, 0, 0);
    gradient.addColorStop(0.0, 'rgba(124, 58, 237, 0.25)');
    gradient.addColorStop(0.5, 'rgba(168, 85, 247, 0.35)');
    gradient.addColorStop(1.0, 'rgba(6, 182, 212, 0.25)');

    ctx.fillStyle = gradient;
    ctx.shadowColor = 'rgba(168, 85, 247, 0.4)';
    ctx.shadowBlur = 6;

    for (let i = 0; i < targetBars; i++) {
      // Sine wave amplitude per bar
      const wave = Math.sin(this._idlePhase + i * 0.15) * 0.5 + 0.5; // 0‒1
      const barHeight = Math.max(wave * idleAmplitude * H + minBarHeight, minBarHeight);
      const x = i * barSlotWidth + (barSlotWidth - barWidth) / 2;
      const half = barHeight / 2;
      const radius = Math.min(barWidth / 2, 3);
      this._roundRect(ctx, x, centerY - half, barWidth, barHeight, radius);
      ctx.fill();
    }

    ctx.shadowBlur = 0;
  }

  /* ── Utility — Rounded Rectangle Path ─────────────────── */

  /**
   * Adds a rounded-rect sub-path (does NOT stroke/fill — caller does that).
   */
  _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
}
