/**
 * ============================================================
 *  SpeechEngine — Web Speech API Wrapper
 * ============================================================
 *  Provides continuous, resilient speech-to-text with word-
 *  level timestamps, confidence scores, and auto-restart.
 *
 *  Usage:
 *    const engine = new SpeechEngine();
 *    if (!engine.isSupported()) { alert('Not supported'); }
 *    engine.onInterimResult((text) => { ... });
 *    engine.onFinalResult(({ text, confidence }) => { ... });
 *    engine.onError((err) => { ... });
 *    engine.start();
 *    // ... later
 *    engine.stop();
 *    console.log(engine.getFullTranscript());
 *    console.log(engine.getWordTimestamps());
 * ============================================================
 */

export class SpeechEngine {

  /* ── Constructor ──────────────────────────────────────── */

  constructor() {
    /**
     * The underlying SpeechRecognition instance (created on start).
     * @type {SpeechRecognition|null}
     */
    this._recognition = null;

    /**
     * Whether we *intend* to be recording.
     * Differentiates intentional stop() from API dropping the session.
     */
    this._shouldBeRunning = false;

    /**
     * Guard against overlapping restart attempts.
     */
    this._isRestarting = false;

    /**
     * Consecutive restart counter — if we keep dying, back off.
     */
    this._restartCount = 0;

    /**
     * Max consecutive restarts before we give up.
     */
    this._maxRestarts = 8;

    /**
     * Timer handle for the restart back-off delay.
     */
    this._restartTimer = null;

    /* ── Transcript storage ─────────────────────────────── */

    /**
     * Array of finalised transcript segments.
     * @type {{ text: string, timestamp: number, confidence: number }[]}
     */
    this._segments = [];

    /**
     * Per-word records with timestamps and confidence.
     * @type {{ word: string, timestamp: number, confidence: number }[]}
     */
    this._wordTimestamps = [];

    /* ── Callbacks ──────────────────────────────────────── */

    /** @type {function(string)|null} */
    this._onInterim = null;

    /** @type {function({ text: string, confidence: number })|null} */
    this._onFinal = null;

    /** @type {function({ error: string, message: string })|null} */
    this._onErrorCb = null;
  }

  /* ── Public API ───────────────────────────────────────── */

  /**
   * Check whether the Web Speech API is available in this browser.
   * @returns {boolean}
   */
  isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /**
   * Start continuous speech recognition.
   * If already running, this is a no-op.
   */
  start() {
    if (this._shouldBeRunning) return;

    if (!this.isSupported()) {
      this._emitError('not-supported', 'Web Speech API is not available in this browser.');
      return;
    }

    this._shouldBeRunning = true;
    this._restartCount = 0;
    this._segments = [];
    this._wordTimestamps = [];
    this._createRecognition();
    this._safeStart();
  }

  /**
   * Intentionally stop recognition.
   */
  stop() {
    this._shouldBeRunning = false;
    clearTimeout(this._restartTimer);

    if (this._recognition) {
      try {
        this._recognition.stop();
      } catch (_) {
        // May throw if already stopped — safe to ignore.
      }
    }
  }

  /**
   * Register a callback for interim (not-yet-final) results.
   * @param {function(string)} callback – receives the interim text.
   */
  onInterimResult(callback) {
    this._onInterim = callback;
  }

  /**
   * Register a callback for finalised results.
   * @param {function({ text: string, confidence: number })} callback
   */
  onFinalResult(callback) {
    this._onFinal = callback;
  }

  /**
   * Register a callback for errors.
   * @param {function({ error: string, message: string })} callback
   */
  onError(callback) {
    this._onErrorCb = callback;
  }

  /**
   * Return the full transcript assembled from all final segments.
   * @returns {string}
   */
  getFullTranscript() {
    return this._segments.map((s) => s.text).join(' ').trim();
  }

  /**
   * Return an array of per-word records.
   * @returns {{ word: string, timestamp: number, confidence: number }[]}
   */
  getWordTimestamps() {
    return [...this._wordTimestamps];
  }

  /**
   * Return raw segments for deeper analysis.
   * @returns {{ text: string, timestamp: number, confidence: number }[]}
   */
  getSegments() {
    return [...this._segments];
  }

  /**
   * Clean up all resources.
   */
  destroy() {
    this.stop();
    this._recognition = null;
    this._onInterim = null;
    this._onFinal = null;
    this._onErrorCb = null;
  }

  /* ── Private — Recognition Setup ──────────────────────── */

  /**
   * Instantiate and configure a new SpeechRecognition object.
   */
  _createRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    /* ── onresult ────────────────────────────────────────── */
    recognition.onresult = (event) => {
      // Reset restart counter on every successful result
      this._restartCount = 0;

      let interimTranscript = '';
      const now = Date.now();

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        const confidence = result[0].confidence;

        if (result.isFinal) {
          // ── Final result ──────────────────────────────────
          const trimmed = transcript.trim();
          if (trimmed.length === 0) continue;

          this._segments.push({
            text: trimmed,
            timestamp: now,
            confidence: confidence || 0,
          });

          // Extract individual words and assign timestamps
          this._extractWords(trimmed, now, confidence || 0);

          if (this._onFinal) {
            this._onFinal({ text: trimmed, confidence: confidence || 0 });
          }
        } else {
          // ── Interim result ────────────────────────────────
          interimTranscript += transcript;
        }
      }

      if (interimTranscript && this._onInterim) {
        this._onInterim(interimTranscript.trim());
      }
    };

    /* ── onerror ─────────────────────────────────────────── */
    recognition.onerror = (event) => {
      const errorMap = {
        'no-speech':      'No speech was detected. Please speak louder or check your microphone.',
        'audio-capture':  'Microphone not found or inaccessible. Check browser permissions.',
        'not-allowed':    'Microphone permission denied. Please allow access and try again.',
        'network':        'A network error occurred during speech recognition.',
        'aborted':        'Speech recognition was aborted.',
        'service-not-available': 'Speech recognition service is not available right now.',
      };

      const message = errorMap[event.error] || `Speech recognition error: ${event.error}`;
      this._emitError(event.error, message);

      // Fatal errors — don't try to restart
      const fatalErrors = ['not-allowed', 'audio-capture', 'service-not-available'];
      if (fatalErrors.includes(event.error)) {
        this._shouldBeRunning = false;
      }
    };

    /* ── onend ───────────────────────────────────────────── */
    recognition.onend = () => {
      // If we still want to be running, restart (the API sometimes stops on its own)
      if (this._shouldBeRunning) {
        this._scheduleRestart();
      }
    };

    this._recognition = recognition;
  }

  /* ── Private — Start / Restart Logic ──────────────────── */

  /**
   * Safely call recognition.start(), catching the "already started" error.
   */
  _safeStart() {
    if (!this._recognition || !this._shouldBeRunning) return;

    try {
      this._recognition.start();
      this._isRestarting = false;
    } catch (err) {
      // "Failed to execute 'start'" — already running, which is fine
      this._isRestarting = false;
    }
  }

  /**
   * Schedule an auto-restart with exponential back-off.
   */
  _scheduleRestart() {
    if (this._isRestarting || !this._shouldBeRunning) return;
    this._isRestarting = true;
    this._restartCount++;

    if (this._restartCount > this._maxRestarts) {
      this._emitError('max-restarts', 'Speech recognition stopped after too many consecutive restarts.');
      this._shouldBeRunning = false;
      this._isRestarting = false;
      return;
    }

    // Back-off: 100ms, 200ms, 400ms, … up to ~3 s
    const delay = Math.min(100 * Math.pow(2, this._restartCount - 1), 3000);

    this._restartTimer = setTimeout(() => {
      // Re-create the recognition object to avoid stale state
      this._createRecognition();
      this._safeStart();
    }, delay);
  }

  /* ── Private — Helpers ────────────────────────────────── */

  /**
   * Split a final transcript string into words and record each one.
   */
  _extractWords(text, baseTimestamp, confidence) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) return;

    // We don't have true per-word timing from the API,
    // so we spread them evenly across a small window.
    const spread = Math.min(words.length * 80, 2000); // ms
    const step = words.length > 1 ? spread / (words.length - 1) : 0;

    words.forEach((word, idx) => {
      this._wordTimestamps.push({
        word,
        timestamp: baseTimestamp - spread + step * idx,
        confidence,
      });
    });
  }

  /**
   * Fire the error callback (if registered).
   */
  _emitError(error, message) {
    if (this._onErrorCb) {
      this._onErrorCb({ error, message });
    }
  }
}
