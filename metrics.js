/**
 * ============================================================
 *  metrics.js — Speech Metrics Analyzer
 * ============================================================
 *  Analyzes speech metrics from transcription and audio data
 *  including WPM, pauses, fillers, dropped sounds, clarity,
 *  and overall composite scoring.
 * ============================================================
 */

// ── Filler words to detect (ordered by specificity — multi‑word first) ──────
const FILLER_WORDS = [
  'you know', 'I mean', 'kind of', 'sort of',
  'um', 'uh', 'uhh', 'umm', 'hmm', 'hm',
  'like', 'basically', 'actually', 'literally',
  'so', 'well', 'right', 'okay',
  'stuff', 'things',
  'obviously', 'honestly', 'frankly'
];

// ── Letter / sound dropping patterns ────────────────────────────────────────
const DROPPING_PATTERNS = [
  // -ing → -in  (g-dropping)
  { pattern: /\b(\w{2,})in\b/gi, replacement: '$1ing', type: 'g-dropping' },

  // Common informal contractions
  { detected: 'gonna',      expected: 'going to',    type: 'contraction' },
  { detected: 'wanna',      expected: 'want to',     type: 'contraction' },
  { detected: 'gotta',      expected: 'got to',      type: 'contraction' },
  { detected: 'kinda',      expected: 'kind of',     type: 'contraction' },
  { detected: 'sorta',      expected: 'sort of',     type: 'contraction' },
  { detected: 'dunno',      expected: "don't know",  type: 'contraction' },
  { detected: 'lemme',      expected: 'let me',      type: 'contraction' },
  { detected: 'gimme',      expected: 'give me',     type: 'contraction' },

  // Syllable drops
  { detected: 'prolly',     expected: 'probably',    type: 'syllable-drop' },
  { detected: 'probly',     expected: 'probably',    type: 'syllable-drop' },
  { detected: 'diff-rent',  expected: 'different',   type: 'syllable-drop' },
  { detected: 'diffrent',   expected: 'different',   type: 'syllable-drop' },
  { detected: 'intresting', expected: 'interesting', type: 'syllable-drop' },
  { detected: 'comftable',  expected: 'comfortable', type: 'syllable-drop' },

  // T-dropping  (mos → most, las → last, etc.)
  { pattern: /\b(mos|las|firs|nex|jus)\b/gi, type: 't-dropping' }
];

// ── Words that are legitimate even though they end in "in" ──────────────────
const IN_WORD_ALLOWLIST = new Set([
  'in', 'an', 'on', 'can', 'man', 'than', 'plan', 'began', 'ran',
  'win', 'bin', 'fin', 'pin', 'sin', 'tin', 'thin', 'skin',
  'begin', 'within', 'herein', 'wherein', 'therein',
  'satin', 'cabin', 'robin', 'ruin', 'basin', 'margin',
  'origin', 'certain', 'captain', 'curtain', 'mountain',
  'fountain', 'maintain', 'contain', 'obtain', 'retain',
  'sustain', 'explain', 'complain', 'remain', 'again',
  'train', 'brain', 'rain', 'main', 'pain', 'gain', 'chain',
  'coin', 'join', 'resin', 'cousin', 'dolphin', 'violin',
  'bulletin', 'insulin', 'muffin', 'coffin', 'penguin',
  'plugin', 'login', 'admin'
]);

// ── Ideal WPM constants ─────────────────────────────────────────────────────
const IDEAL_WPM_LOW  = 120;
const IDEAL_WPM_HIGH = 150;
const IDEAL_WPM_MID  = (IDEAL_WPM_LOW + IDEAL_WPM_HIGH) / 2;

// ── Rolling window & sample interval ────────────────────────────────────────
const ROLLING_WINDOW_SEC   = 30;
const WPM_SAMPLE_INTERVAL  = 5;   // seconds between WPM timeline samples

/**
 * MetricsAnalyzer
 * ────────────────
 * Central class that collects and computes all speech quality metrics.
 */
export class MetricsAnalyzer {

  constructor() {
    this.reset();
  }

  /* ─────────────────────── Reset ─────────────────────── */

  /** Clear all accumulated data — call when starting a new session. */
  reset() {
    // Word buffer: [{ word: string, timestamp: number (seconds) }]
    this._wordBuffer     = [];
    this._totalWords      = 0;
    this._sessionStart    = null;   // timestamp of first word
    this._sessionEnd      = null;   // timestamp of last word

    // WPM timeline: [{ time: seconds, wpm: number }]
    this._wpmTimeline     = [];
    this._lastSampleTime  = 0;

    // Pauses: [{ startTime, endTime, duration }]
    this._pauses          = [];

    // Filler tracking: { word: count }
    this._fillerCounts    = {};
    FILLER_WORDS.forEach(f => { this._fillerCounts[f] = 0; });

    // Dropped sounds: [{ detected, expected, type }]
    this._droppedWords    = [];

    // Low-confidence words (fed from speech recognition)
    this._lowConfCount    = 0;
  }

  /* ═══════════════════════════════════════════════════════
   *  SPEED ANALYSIS
   * ═══════════════════════════════════════════════════════ */

  /**
   * Add words with a timestamp (seconds from session start).
   * @param {string[]} words  Array of word strings.
   * @param {number}   timestamp  Time in seconds.
   */
  addWords(words, timestamp) {
    if (!words || words.length === 0) return;

    // Track session boundaries
    if (this._sessionStart === null) this._sessionStart = timestamp;
    this._sessionEnd = timestamp;

    // Push each word into the buffer
    words.forEach(w => {
      this._wordBuffer.push({ word: w, timestamp });
      this._totalWords++;
    });

    // Produce a WPM sample every SAMPLE_INTERVAL seconds
    if (timestamp - this._lastSampleTime >= WPM_SAMPLE_INTERVAL) {
      this._wpmTimeline.push({
        time: timestamp,
        wpm:  this.getCurrentWpm()
      });
      this._lastSampleTime = timestamp;
    }
  }

  /**
   * Rolling WPM — words spoken in the last 30 seconds, scaled to a minute.
   * @returns {number}
   */
  getCurrentWpm() {
    if (this._wordBuffer.length === 0) return 0;

    const now      = this._sessionEnd ?? 0;
    const cutoff   = now - ROLLING_WINDOW_SEC;
    const recent   = this._wordBuffer.filter(w => w.timestamp >= cutoff);
    const elapsed  = Math.min(ROLLING_WINDOW_SEC, now - (this._sessionStart ?? 0));

    if (elapsed <= 0) return 0;
    return Math.round((recent.length / elapsed) * 60);
  }

  /**
   * Overall average WPM across the entire session.
   * @returns {number}
   */
  getAverageWpm() {
    if (this._totalWords === 0 || this._sessionStart === null) return 0;

    const minutes = (this._sessionEnd - this._sessionStart) / 60;
    if (minutes <= 0) return 0;
    return Math.round(this._totalWords / minutes);
  }

  /**
   * Timeline data for the WPM chart.
   * @returns {{ time: number, wpm: number }[]}
   */
  getWpmTimeline() {
    return [...this._wpmTimeline];
  }

  /** @returns {number} Total word count this session. */
  getTotalWords() {
    return this._totalWords;
  }

  /* ═══════════════════════════════════════════════════════
   *  PAUSE ANALYSIS
   * ═══════════════════════════════════════════════════════ */

  /**
   * Register a detected pause.
   * @param {{ startTime: number, endTime: number, duration: number }} pause
   */
  addPause(pause) {
    this._pauses.push({ ...pause });
  }

  /** @returns {Array} All recorded pauses. */
  getPauses() {
    return [...this._pauses];
  }

  /**
   * Classify a pause by its duration.
   * @param   {number} duration  Duration in seconds.
   * @returns {'micro'|'good'|'long'|'awkward'}
   */
  classifyPause(duration) {
    if (duration < 0.3)  return 'micro';    //  < 300 ms
    if (duration <= 1.5) return 'good';     //  300 ms – 1.5 s
    if (duration <= 3.0) return 'long';     //  1.5 s  – 3 s
    return 'awkward';                       //  > 3 s
  }

  /**
   * Aggregate pause statistics.
   * @returns {{ total, micro, good, long, awkward, avgDuration, pauseRatio }}
   */
  getPauseStats() {
    const stats = { total: 0, micro: 0, good: 0, long: 0, awkward: 0,
                    avgDuration: 0, pauseRatio: 0 };

    if (this._pauses.length === 0) return stats;

    let totalDur = 0;
    this._pauses.forEach(p => {
      const cls = this.classifyPause(p.duration);
      stats[cls]++;
      stats.total++;
      totalDur += p.duration;
    });

    stats.avgDuration = +(totalDur / stats.total).toFixed(2);

    // Pause ratio = total pause time / total session time
    const sessionDuration = (this._sessionEnd ?? 0) - (this._sessionStart ?? 0);
    stats.pauseRatio = sessionDuration > 0
      ? +((totalDur / sessionDuration) * 100).toFixed(1)
      : 0;

    return stats;
  }

  /* ═══════════════════════════════════════════════════════
   *  FILLER WORD DETECTION
   * ═══════════════════════════════════════════════════════ */

  /**
   * Scan text for filler words.  Returns array of detected fillers with
   * their positions (for highlighting in UI if needed).
   *
   * @param   {string} text  Raw transcript text.
   * @returns {{ word: string, index: number }[]}
   */
  detectFillers(text) {
    if (!text) return [];

    const lower   = text.toLowerCase();
    const results = [];

    for (const filler of FILLER_WORDS) {
      // Build a regex with word boundaries
      const escaped = filler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex   = new RegExp(`\\b${escaped}\\b`, 'gi');

      let match;
      while ((match = regex.exec(lower)) !== null) {
        // ── Context heuristic for "so" and "well" ──────────
        // Only flag them if they appear at the very start of a
        // sentence (after . ! ? or start of string).
        if (filler === 'so' || filler === 'well') {
          const before = lower.slice(0, match.index).trimEnd();
          if (before.length > 0 && !/[.!?]$/.test(before)) continue;
        }

        results.push({ word: filler, index: match.index });
        this._fillerCounts[filler]++;
      }
    }

    return results;
  }

  /**
   * Map of filler word → count.
   * @returns {Object.<string, number>}
   */
  getFillerCounts() {
    // Return only non-zero entries
    const counts = {};
    for (const [word, count] of Object.entries(this._fillerCounts)) {
      if (count > 0) counts[word] = count;
    }
    return counts;
  }

  /** @returns {number} Sum of all filler occurrences. */
  getTotalFillers() {
    return Object.values(this._fillerCounts).reduce((s, c) => s + c, 0);
  }

  /* ═══════════════════════════════════════════════════════
   *  LETTER / SOUND DROPPING DETECTION
   * ═══════════════════════════════════════════════════════ */

  /**
   * Scan text for pronunciation shortcuts / dropped sounds.
   * @param   {string} text
   * @returns {{ detected: string, expected: string, type: string }[]}
   */
  detectDroppedSounds(text) {
    if (!text) return [];

    const lower   = text.toLowerCase();
    const results = [];

    for (const rule of DROPPING_PATTERNS) {
      if (rule.pattern) {
        // Regex-based rule
        let match;
        // Reset lastIndex (regex is global)
        rule.pattern.lastIndex = 0;

        while ((match = rule.pattern.exec(lower)) !== null) {
          const detected = match[0];

          // For g-dropping: skip allowlisted words
          if (rule.type === 'g-dropping') {
            if (IN_WORD_ALLOWLIST.has(detected.toLowerCase())) continue;
          }

          // Build expected form
          let expected;
          if (rule.replacement) {
            expected = detected.replace(rule.pattern, rule.replacement);
            // Need to reset the regex again after replace
            rule.pattern.lastIndex = match.index + detected.length;
          } else if (rule.type === 't-dropping') {
            expected = detected + 't';
          } else {
            expected = detected;
          }

          results.push({ detected, expected, type: rule.type });
        }
      } else {
        // Exact-match rule
        const regex = new RegExp(`\\b${rule.detected}\\b`, 'gi');
        let match;
        while ((match = regex.exec(lower)) !== null) {
          results.push({
            detected: match[0],
            expected: rule.expected,
            type:     rule.type
          });
        }
      }
    }

    this._droppedWords.push(...results);
    return results;
  }

  /**
   * All detected dropped-sound instances this session.
   * @returns {{ detected: string, expected: string, type: string }[]}
   */
  getDroppedWords() {
    return [...this._droppedWords];
  }

  /**
   * Register low-confidence words from the speech recognizer.
   * @param {number} count  Number of low-confidence words in this batch.
   */
  addLowConfidenceWords(count) {
    this._lowConfCount += count;
  }

  /* ═══════════════════════════════════════════════════════
   *  CLARITY SCORE  (0 – 100)
   * ═══════════════════════════════════════════════════════ */

  /**
   * Composite clarity score.
   * Starts at 100, deductions for fillers, drops, low-confidence words,
   * and excessively fast segments.
   *
   * @returns {number} 0 – 100
   */
  getClarityScore() {
    let score = 100;

    // ── Filler penalty: -1 each, cap -30 ──
    const fillers = this.getTotalFillers();
    score -= Math.min(fillers, 30);

    // ── Dropped sounds: -2 each, cap -20 ──
    score -= Math.min(this._droppedWords.length * 2, 20);

    // ── Low-confidence words: -1 each, cap -20 ──
    score -= Math.min(this._lowConfCount, 20);

    // ── Fast segments: -5 per segment > 170 WPM, cap -15 ──
    const fastSegments = this._wpmTimeline.filter(s => s.wpm > 170).length;
    score -= Math.min(fastSegments * 5, 15);

    return Math.max(15, Math.round(score));
  }

  /* ═══════════════════════════════════════════════════════
   *  OVERALL SCORE  (0 – 100)  +  GRADE
   * ═══════════════════════════════════════════════════════ */

  /**
   * Weighted composite score (25 % each sub-score).
   * @returns {number} 0 – 100
   */
  getOverallScore() {
    const speed   = this._calcSpeedScore();
    const pause   = this._calcPauseScore();
    const clarity = this.getClarityScore();
    const fluency = this._calcFluencyScore();

    return Math.round(speed * 0.25 + pause * 0.25 + clarity * 0.25 + fluency * 0.25);
  }

  /**
   * Letter grade based on overall score.
   * @returns {'A'|'B'|'C'|'D'|'F'}
   */
  getGrade() {
    const score = this.getOverallScore();
    if (score >= 85) return 'A';
    if (score >= 70) return 'B';
    if (score >= 55) return 'C';
    if (score >= 40) return 'D';
    return 'F';
  }

  /* ─────────── Sub-score helpers (private) ─────────── */

  /**
   * Speed score: 100 when WPM is in the ideal zone, drops off outside.
   * @private
   * @returns {number} 0 – 100
   */
  _calcSpeedScore() {
    const wpm = this.getAverageWpm();
    if (wpm === 0) return 50; // no data — neutral

    if (wpm >= IDEAL_WPM_LOW && wpm <= IDEAL_WPM_HIGH) return 100;

    // Linear drop: lose 2 pts per WPM away from the ideal range
    const dist = wpm < IDEAL_WPM_LOW
      ? IDEAL_WPM_LOW - wpm
      : wpm - IDEAL_WPM_HIGH;

    return Math.max(0, Math.round(100 - dist * 2));
  }

  /**
   * Pause score: rewards 10 – 20 % pause ratio and good-type pauses.
   * @private
   * @returns {number} 0 – 100
   */
  _calcPauseScore() {
    const ps = this.getPauseStats();
    if (ps.total === 0) return 60; // no pauses recorded — neutral-ish

    let score = 100;

    // ── Ratio penalty ──
    const ratio = ps.pauseRatio;
    if (ratio < 5)        score -= 25;
    else if (ratio < 10)  score -= 10;
    else if (ratio > 30)  score -= 30;
    else if (ratio > 20)  score -= 10;
    // 10-20% is ideal → no deduction

    // ── Awkward pauses penalty ──
    score -= Math.min(ps.awkward * 10, 30);

    // ── Reward "good" pauses (strategic, well-timed) ──
    const goodRatio = ps.total > 0 ? ps.good / ps.total : 0;
    score += Math.round(goodRatio * 15); // up to +15

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Fluency score: low fillers + consistent pacing.
   * @private
   * @returns {number} 0 – 100
   */
  _calcFluencyScore() {
    let score = 100;

    // ── Filler penalty ──
    const fillers = this.getTotalFillers();
    score -= Math.min(fillers * 2, 40);

    // ── Pacing consistency: penalize high WPM variance ──
    if (this._wpmTimeline.length >= 3) {
      const wpms = this._wpmTimeline.map(s => s.wpm);
      const mean = wpms.reduce((a, b) => a + b, 0) / wpms.length;
      const variance = wpms.reduce((s, w) => s + (w - mean) ** 2, 0) / wpms.length;
      const stdDev = Math.sqrt(variance);

      // Penalize standard deviation above 15 WPM
      if (stdDev > 15) {
        score -= Math.min(Math.round((stdDev - 15) * 1.5), 30);
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  /* ═══════════════════════════════════════════════════════
   *  SNAPSHOT  — full metrics export
   * ═══════════════════════════════════════════════════════ */

  /**
   * Return a complete, JSON-serializable snapshot of all metrics.
   * Useful for saving sessions, passing to RecommendationEngine, etc.
   *
   * @returns {Object}
   */
  getSnapshot() {
    const pauseStats = this.getPauseStats();
    const avgWpm     = this.getAverageWpm();

    // Compute WPM variance for the snapshot
    let wpmVariance = 0;
    if (this._wpmTimeline.length >= 2) {
      const wpms = this._wpmTimeline.map(s => s.wpm);
      const mean = wpms.reduce((a, b) => a + b, 0) / wpms.length;
      wpmVariance = Math.round(
        Math.sqrt(wpms.reduce((s, w) => s + (w - mean) ** 2, 0) / wpms.length)
      );
    }

    // Session duration in seconds
    const sessionDuration = (this._sessionEnd ?? 0) - (this._sessionStart ?? 0);

    return {
      // Session meta
      sessionDuration,
      totalWords:     this._totalWords,

      // Speed
      avgWpm,
      currentWpm:     this.getCurrentWpm(),
      wpmTimeline:    this.getWpmTimeline(),
      wpmVariance,

      // Pauses
      pauses:         this.getPauses(),
      pauseStats,

      // Fillers
      fillerCounts:   this.getFillerCounts(),
      totalFillers:   this.getTotalFillers(),

      // Dropped sounds
      droppedWords:   this.getDroppedWords(),

      // Scores
      clarityScore:   this.getClarityScore(),
      overallScore:   this.getOverallScore(),
      grade:          this.getGrade()
    };
  }
}
