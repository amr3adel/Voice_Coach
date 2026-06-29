/**
 * ============================================================
 *  StorageManager — localStorage & Supabase Sync Persistence
 * ============================================================
 *  Saves, loads, and queries Voice Coach sessions using a hybrid
 *  offline-first sync architecture.
 *  
 *  - Standard operations read/write to localStorage instantly for
 *    offline support and zero-latency UI loads.
 *  - If Supabase credentials are configured, saves and deletes are
 *    automatically replicated to the cloud in the background.
 *  - On startup, a background sync merges remote and local sessions.
 * ============================================================
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export class StorageManager {

  /**
   * @param {string} storageKey – the localStorage key under which all
   *                               sessions are cached as a JSON array.
   */
  constructor(storageKey = 'voice-coach-sessions') {
    this._key = storageKey;
    this.supabase = null;
    this.onSyncCompleted = null;

    // Load credentials and initialize Supabase if configured
    this._initSupabaseFromStorage();

    // Trigger background sync if connected
    if (this.supabase) {
      this.syncBackground();
    }
  }

  /**
   * Initialize Supabase client using stored credentials.
   * @private
   */
  _initSupabaseFromStorage() {
    try {
      const url = localStorage.getItem('voice-coach-sb-url');
      const key = localStorage.getItem('voice-coach-sb-key');

      if (url && key) {
        this.supabase = createClient(url, key);
        console.log('[StorageManager] Supabase client initialized.');
      }
    } catch (err) {
      console.error('[StorageManager] Failed to init Supabase:', err);
    }
  }

  /**
   * Register sync completed callback.
   * @param {function} cb 
   */
  registerSyncCallback(cb) {
    this.onSyncCompleted = cb;
  }

  /**
   * Connect to a new Supabase database.
   * Performs an immediate sync and merges data.
   */
  async connectSupabase(url, key) {
    try {
      localStorage.setItem('voice-coach-sb-url', url);
      localStorage.setItem('voice-coach-sb-key', key);
      
      this.supabase = createClient(url, key);
      console.log('[StorageManager] Supabase connected successfully.');
      
      // Perform initial full sync
      await this.syncBackground();
      return true;
    } catch (err) {
      console.error('[StorageManager] Connection failed:', err);
      this.disconnectSupabase();
      throw err;
    }
  }

  /**
   * Disconnect from Supabase, reverting to local-only storage.
   */
  disconnectSupabase() {
    localStorage.removeItem('voice-coach-sb-url');
    localStorage.removeItem('voice-coach-sb-key');
    this.supabase = null;
    console.log('[StorageManager] Supabase disconnected.');
  }

  /**
   * Returns true if Supabase is connected.
   */
  isConnected() {
    return !!this.supabase;
  }

  /**
   * Background sync loop: Merges remote and local sessions.
   */
  async syncBackground() {
    if (!this.supabase) return;

    try {
      console.log('[StorageManager] Starting background sync...');
      
      // 1. Fetch remote sessions
      const { data: remoteSessions, error } = await this.supabase
        .from('voice_coach_sessions')
        .select('*');

      if (error) throw error;

      // 2. Fetch local sessions
      const localSessions = this._load();
      const mergedSessions = [...localSessions];
      let hasChanges = false;

      // 3. Upload local-only sessions to remote
      for (const local of localSessions) {
        const existsRemote = remoteSessions.some((r) => r.id === local.id);
        if (!existsRemote) {
          console.log(`[StorageManager] Syncing local session to cloud: ${local.id}`);
          await this.supabase.from('voice_coach_sessions').upsert({
            id: local.id,
            date: local.date,
            duration: local.duration,
            transcript: local.transcript,
            metrics: local.metrics,
            recommendations: local.recommendations
          });
        }
      }

      // 4. Download remote-only sessions to local
      for (const remote of remoteSessions) {
        const existsLocal = localSessions.some((l) => l.id === remote.id);
        if (!existsLocal) {
          console.log(`[StorageManager] Pulling remote session to local: ${remote.id}`);
          mergedSessions.push(remote);
          hasChanges = true;
        }
      }

      // 5. If changes occurred locally, save and notify UI
      if (hasChanges) {
        this._save(mergedSessions);
        if (this.onSyncCompleted) {
          this.onSyncCompleted();
        }
      }
      
      console.log('[StorageManager] Sync complete.');
    } catch (err) {
      console.error('[StorageManager] Sync failed:', err);
    }
  }

  /* ── Public API ───────────────────────────────────────── */

  /**
   * Persist a new session. Saves locally first, then pushes to Supabase.
   *
   * @param {object} sessionData – must follow the session schema
   * @returns {string|null} the session ID, or null on failure
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

      // Async push to Supabase in background
      if (this.supabase) {
        this.supabase.from('voice_coach_sessions').upsert({
          id: session.id,
          date: session.date,
          duration: session.duration,
          transcript: session.transcript,
          metrics: session.metrics,
          recommendations: session.recommendations
        }).then(({ error }) => {
          if (error) console.error('[StorageManager] Supabase upload failed:', error);
          else console.log('[StorageManager] Session synced to Supabase.');
        });
      }

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

      // Async delete from Supabase in background
      if (this.supabase) {
        this.supabase.from('voice_coach_sessions')
          .delete()
          .eq('id', sessionId)
          .then(({ error }) => {
            if (error) console.error('[StorageManager] Supabase delete failed:', error);
            else console.log('[StorageManager] Session deleted from Supabase.');
          });
      }

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

      // Async clear from Supabase in background (deletes all user records)
      if (this.supabase) {
        this.supabase.from('voice_coach_sessions')
          .delete()
          .neq('id', 'placeholder') // hack to delete all rows
          .then(({ error }) => {
            if (error) console.error('[StorageManager] Supabase clear failed:', error);
            else console.log('[StorageManager] Supabase storage cleared.');
          });
      }

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
   * Build progress timeline data sorted oldest-first.
   */
  getProgressData() {
    try {
      const sessions = this._load();
      // Sort ascending (oldest first)
      sessions.sort((a, b) => new Date(a.date) - new Date(b.date));

      return sessions.map((s) => ({
        id: s.id,
        date: s.date,
        overallScore: s.metrics?.overallScore ?? 0,
        clarityScore: s.metrics?.clarityScore ?? 0,
        avgWpm:       s.metrics?.avgWpm ?? 0,
        fillerCount:  s.metrics?.totalFillers ?? 0,
        pauseRatio:   s.metrics?.pauseStats?.pauseRatio ?? 0,
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
   * Generate a unique session ID.
   * Format: `session_<timestamp>_<random4hex>`
   * @returns {string}
   */
  _generateId() {
    const ts = Date.now();
    const rand = Math.floor(Math.random() * 0xFFFF).toString(16).padStart(4, '0');
    return `session_${ts}_${rand}`;
  }
}
