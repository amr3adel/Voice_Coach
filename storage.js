/**
 * ============================================================
 *  StorageManager — localStorage Session Persistence
 * ============================================================
 *  Saves, loads, and queries Voice Coach sessions using the
 *  browser's localStorage API.  All operations are wrapped in
 *  try/catch so that storage quota errors or privacy-mode
 *  restrictions never crash the app.
 *
 *  Usage:
 *    const store = new StorageManager();
 *    const id = store.saveSession(sessionData);
 *    const session = store.getSession(id);
 *    const all = store.getAllSessions();
 *    store.deleteSession(id);
 * ============================================================
 */

export class StorageManager {

  /**
   * @param {string} storageKey – the localStorage key under which all
   *                               sessions are stored as a JSON array.
   */
  constructor(storageKey = 'voice-coach-sessions') {
    this._key = storageKey;
  }

  /* ── Public API ───────────────────────────────────────── */

  /**
   * Persist a new session.  A unique `id` and `date` are stamped
   * automatically if not already present on the incoming data.
   *
   * @param {object} sessionData – must follow the session schema
   * @returns {string|null} the session ID, or null on failure
   *
   * Session schema:
   * {
   *   id?:              string,          // auto-generated if missing
   *   date?:            string,          // ISO 8601, auto-set if missing
   *   duration:         number,          // seconds
   *   transcript:       string,          // full text
   *   metrics: {
   *     avgWpm:         number,
   *     wpmTimeline:    { time: number, wpm: number }[],
   *     totalWords:     number,
   *     pauses:         { startTime: number, endTime: number, duration: number, type: string }[],
   *     pauseRatio:     number,          // 0‒1
   *     fillerWords:    { [word]: count },
   *     fillerCount:    number,
   *     droppedWords:   { original: string, detected: string, timestamp: number }[],
   *     clarityScore:   number,          // 0‒100
   *     overallScore:   number,          // 0‒100
   *     grade:          'A' | 'B' | 'C' | 'D' | 'F'
   *   },
   *   recommendations:  { severity: string, title: string, description: string }[]
   * }
   */
  saveSession(sessionData) {
    try {
      const sessions = this._load();

      // Stamp ID and date if not present
      const session = {
        ...sessionData,
        id: sessionData.id || this._generateId(),
        date: sessionData.date || new Date().toISOString(),
      };

      sessions.push(session);
      this._save(sessions);
      return session.id;
    } catch (err) {
      console.error('[StorageManager] saveSession failed:', err);
      return null;
    }
  }

  /**
   * Retrieve a single session by its ID.
   * @param {string} sessionId
   * @returns {object|null}
   */
  getSession(sessionId) {
    try {
      const sessions = this._load();
      return sessions.find((s) => s.id === sessionId) || null;
    } catch (err) {
      console.error('[StorageManager] getSession failed:', err);
      return null;
    }
  }

  /**
   * Return every stored session, newest first.
   * @returns {object[]}
   */
  getAllSessions() {
    try {
      const sessions = this._load();
      // Sort descending by date (newest first)
      return sessions.sort((a, b) => new Date(b.date) - new Date(a.date));
    } catch (err) {
      console.error('[StorageManager] getAllSessions failed:', err);
      return [];
    }
  }

  /**
   * Delete a specific session.
   * @param {string} sessionId
   * @returns {boolean} true if deleted, false if not found or error
   */
  deleteSession(sessionId) {
    try {
      const sessions = this._load();
      const idx = sessions.findIndex((s) => s.id === sessionId);
      if (idx === -1) return false;

      sessions.splice(idx, 1);
      this._save(sessions);
      return true;
    } catch (err) {
      console.error('[StorageManager] deleteSession failed:', err);
      return false;
    }
  }

  /**
   * Remove ALL stored sessions.
   * @returns {boolean}
   */
  clearAll() {
    try {
      localStorage.removeItem(this._key);
      return true;
    } catch (err) {
      console.error('[StorageManager] clearAll failed:', err);
      return false;
    }
  }

  /**
   * How many sessions are stored?
   * @returns {number}
   */
  getSessionCount() {
    try {
      return this._load().length;
    } catch (err) {
      console.error('[StorageManager] getSessionCount failed:', err);
      return 0;
    }
  }

  /**
   * Build an array suitable for charting progress over time.
   * Returns sessions sorted oldest-first with key scores extracted.
   *
   * @returns {{
   *   id: string,
   *   date: string,
   *   overallScore: number,
   *   clarityScore: number,
   *   avgWpm: number,
   *   fillerCount: number,
   *   pauseRatio: number,
   *   grade: string,
   *   duration: number
   * }[]}
   */
  getProgressData() {
    try {
      const sessions = this._load();

      // Sort ascending (oldest first) for chronological charting
      sessions.sort((a, b) => new Date(a.date) - new Date(b.date));

      return sessions.map((s) => ({
        id: s.id,
        date: s.date,
        overallScore: s.metrics?.overallScore ?? 0,
        clarityScore: s.metrics?.clarityScore ?? 0,
        avgWpm:       s.metrics?.avgWpm ?? 0,
        fillerCount:  s.metrics?.fillerCount ?? 0,
        pauseRatio:   s.metrics?.pauseRatio ?? 0,
        grade:        s.metrics?.grade ?? '—',
        duration:     s.duration ?? 0,
      }));
    } catch (err) {
      console.error('[StorageManager] getProgressData failed:', err);
      return [];
    }
  }

  /* ── Private Helpers ──────────────────────────────────── */

  /**
   * Load the sessions array from localStorage.
   * @returns {object[]}
   */
  _load() {
    const raw = localStorage.getItem(this._key);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    // Defensive: if stored value isn't an array, reset
    if (!Array.isArray(parsed)) return [];
    return parsed;
  }

  /**
   * Write the sessions array to localStorage.
   * @param {object[]} sessions
   */
  _save(sessions) {
    localStorage.setItem(this._key, JSON.stringify(sessions));
  }

  /**
   * Generate a unique-enough session ID.
   * Format: `session_<timestamp>_<random4hex>`
   * @returns {string}
   */
  _generateId() {
    const ts = Date.now();
    const rand = Math.floor(Math.random() * 0xFFFF).toString(16).padStart(4, '0');
    return `session_${ts}_${rand}`;
  }
}
