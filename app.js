/**
 * ═══════════════════════════════════════════════════════════════
 *  Voice Coach — Main Application Controller
 * ═══════════════════════════════════════════════════════════════
 *  Orchestrates every module in the app and owns all UI state.
 *
 *  Responsibilities
 *  ────────────────
 *  • Recording lifecycle   (start → live updates → stop → analyse)
 *  • Live metric cards     (WPM, clarity, fillers, overall score)
 *  • Post-session dashboard (charts, tabs, recommendations)
 *  • Session history       (modal, save / load / clear)
 *  • Toast notifications   (success / error / info)
 *  • Keyboard shortcuts    (Space, Escape)
 *
 *  Every DOM element ID used here must match the HTML template.
 * ═══════════════════════════════════════════════════════════════
 */

import { AudioAnalyzer }        from './audio-analyzer.js';
import { SpeechEngine }         from './speech-engine.js';
import { MetricsAnalyzer }      from './metrics.js';
import { RecommendationEngine } from './recommendations.js';
import { ChartRenderer }        from './charts.js';
import { StorageManager }       from './storage.js';

/* ───────────────────────── Constants ───────────────────────── */

const LIVE_METRICS_INTERVAL_MS = 2000;   // How often live cards refresh
const TIMER_INTERVAL_MS        = 1000;   // Timer tick
const TOAST_DURATION_MS        = 3000;   // Auto-dismiss toasts
const MIN_SESSION_SECONDS      = 3;      // Ignore ultra-short sessions
const ANIMATION_STAGGER_MS     = 80;     // Stagger delay for dashboard cards

/* ─────────────────────── Main Class ──────────────────────── */

export class VoiceCoachApp {
  constructor () {
    // ── Module instances (AudioAnalyzer is created later with canvas) ──
    this.audioAnalyzer        = null;
    this.speechEngine         = new SpeechEngine();
    this.metricsAnalyzer      = new MetricsAnalyzer();
    this.recommendationEngine = new RecommendationEngine();
    this.chartRenderer        = new ChartRenderer();
    this.storage              = new StorageManager();

    // ── State ─────────────────────────────────────────────────
    this.isRecording       = false;
    this.hasPermission     = false;
    this.timerInterval     = null;
    this.metricsInterval   = null;
    this.elapsedSeconds    = 0;
    this.currentTranscript = '';      // Full running transcript text
    this.activeTab         = 'recommendations-tab';

    // ── DOM element cache (populated in init) ─────────────────
    this.els = {};
  }

  /* ═══════════════════════════════════════════════════════════
   *  Initialisation
   * ═══════════════════════════════════════════════════════════ */

  async init () {
    this._cacheDOM();
    this._checkBrowserSupport();
    this._bindEventListeners();
    this._updateHistoryBadge();

    // Register background sync callback
    this.storage.registerSyncCallback(() => {
      this._updateHistoryBadge();
      this.showNotification('Cloud database synchronized.', 'success');
      if (this.els.historyModal?.classList.contains('open')) {
        this.openHistory(); // refresh history list view if open
      }
    });

    // Create AudioAnalyzer with the waveform canvas
    if (this.els.waveformCanvas) {
      this.audioAnalyzer = new AudioAnalyzer(this.els.waveformCanvas);
    }

    console.log('[VoiceCoach] App initialised ✓');
  }

  /**
   * Cache frequently-accessed DOM nodes once on startup so we
   * never pay the cost of repeated querySelector calls.
   */
  _cacheDOM () {
    const id = (s) => document.getElementById(s);

    this.els = {
      // Views
      recordingView  : id('recording-view'),
      dashboardView  : id('dashboard-view'),

      // Recording controls
      recordBtn      : id('record-btn'),
      timer          : id('timer'),
      statusBadge    : id('status-badge'),
      transcriptArea : id('transcript-area'),

      // Waveform
      waveformCanvas : id('waveform-canvas'),

      // Live metric cards (the .metric-value inside each card)
      liveWpm        : id('live-wpm')?.querySelector('.metric-value'),
      liveClarity    : id('live-clarity')?.querySelector('.metric-value'),
      liveFillers    : id('live-fillers')?.querySelector('.metric-value'),
      liveScore      : id('live-score')?.querySelector('.metric-value'),

      // Dashboard elements
      overallScore   : id('overall-score'),
      summaryDuration: id('summary-duration'),
      summaryWords   : id('summary-words'),
      speedChart     : id('speed-chart'),

      // Tab content containers
      pauseList      : id('pause-list'),
      issuesList     : id('issues-list'),
      fillerCloud    : id('filler-cloud'),
      droppedList    : id('dropped-letters-list'),
      recsList       : id('recommendations-list'),

      // Buttons
      newSessionBtn  : id('new-session-btn'),
      saveSessionBtn : id('save-session-btn'),
      historyBtn     : id('history-btn'),
      settingsBtn    : id('settings-btn'),
      clearHistoryBtn: id('clear-history-btn'),

      // History modal
      historyModal   : id('history-modal'),
      historyList    : id('history-list'),

      // Permission modal
      permissionModal: id('permission-modal'),
      allowMicBtn    : id('allow-mic-btn'),

      // Settings modal
      settingsModal  : id('settings-modal'),
      settingsForm   : id('settings-form'),
      sbUrlInput     : id('sb-url'),
      sbKeyInput     : id('sb-key'),
      disconnectBtn  : id('disconnect-btn'),

      // Tabs
      tabBtns        : document.querySelectorAll('.tab-btn'),
      tabContents    : document.querySelectorAll('.tab-content'),

      // Modal close buttons
      modalCloses    : document.querySelectorAll('.modal-close'),
      modalOverlays  : document.querySelectorAll('.modal-overlay'),

      // Notification container (we'll create it if missing)
      toastContainer : id('toast-container'),
    };

    // Guarantee a toast container exists
    if (!this.els.toastContainer) {
      const tc = document.createElement('div');
      tc.id = 'toast-container';
      tc.setAttribute('aria-live', 'polite');
      document.body.appendChild(tc);
      this.els.toastContainer = tc;
    }
  }

  /**
   * Feature-detect SpeechRecognition.  If missing, we disable
   * the record button and show a persistent warning.
   */
  _checkBrowserSupport () {
    if (!this.speechEngine.isSupported()) {
      this.showNotification(
        'Speech recognition is not supported in this browser. ' +
        'Please use Chrome, Edge, or Safari.',
        'error'
      );

      if (this.els.recordBtn) {
        this.els.recordBtn.disabled = true;
        this.els.recordBtn.title    = 'Not supported in this browser';
      }
    }
  }

  /**
   * Bind all interactive event listeners.
   */
  _bindEventListeners () {
    // ── Record button ─────────────────────────────────────────
    this.els.recordBtn?.addEventListener('click', () => this._toggleRecording());

    // ── History button ────────────────────────────────────────
    this.els.historyBtn?.addEventListener('click', () => this.openHistory());

    // ── Settings button ───────────────────────────────────────
    this.els.settingsBtn?.addEventListener('click', () => this.openSettings());
    this.els.settingsForm?.addEventListener('submit', (e) => this._saveSettings(e));
    this.els.disconnectBtn?.addEventListener('click', () => this._disconnectSettings());

    // ── Dashboard action buttons ─────────────────────────────
    this.els.newSessionBtn?.addEventListener('click', () => {
      this.showRecordingView();
      this._resetSession();
    });
    this.els.saveSessionBtn?.addEventListener('click', () => this._saveCurrentSession());

    // ── Tab buttons ──────────────────────────────────────────
    this.els.tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tabName = btn.dataset.tab;
        if (tabName) this.switchTab(tabName);
      });
    });

    // ── Permission modal ─────────────────────────────────────
    this.els.allowMicBtn?.addEventListener('click', () => this._requestMicPermission());

    // ── History modal ────────────────────────────────────────
    this.els.clearHistoryBtn?.addEventListener('click', () => this.clearHistory());

    // ── Modal close buttons ──────────────────────────────────
    this.els.modalCloses.forEach((btn) => {
      btn.addEventListener('click', () => this._closeAllModals());
    });

    // ── Modal overlay click to close ─────────────────────────
    this.els.modalOverlays.forEach((overlay) => {
      overlay.addEventListener('click', () => this._closeAllModals());
    });

    // ── Keyboard shortcuts ───────────────────────────────────
    document.addEventListener('keydown', (e) => {
      // Escape → close modals
      if (e.key === 'Escape') {
        this._closeAllModals();
        return;
      }

      // Space → toggle recording (but not if typing in an input or modal is open)
      if (e.code === 'Space' && !this._isAnyModalOpen()) {
        const tag = e.target.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'BUTTON') {
          e.preventDefault();
          this._toggleRecording();
        }
      }
    });

    // ── Canvas resize on window resize ───────────────────────
    window.addEventListener('resize', () => {
      // AudioAnalyzer handles its own resize internally
    });
  }

  /* ═══════════════════════════════════════════════════════════
   *  Recording Lifecycle
   * ═══════════════════════════════════════════════════════════ */

  /** Toggle between start and stop. */
  async _toggleRecording () {
    if (this.isRecording) {
      await this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  /**
   * Start a new recording session.
   *
   * 1. Request mic access (show modal the first time)
   * 2. Start audio analyser (waveform visualisation)
   * 3. Start speech engine (live transcription)
   * 4. Start timer + live metrics intervals
   */
  async startRecording () {
    try {
      // ── Mic permission gate ────────────────────────────────
      if (!this.hasPermission) {
        this.showPermissionModal();
        return; // The "allow" button will call us again
      }

      // ── Reset state for a fresh session ────────────────────
      this._resetSession();

      // ── Init audio analyser if needed ──────────────────────
      if (this.audioAnalyzer && !this.audioAnalyzer._audioContext) {
        await this.audioAnalyzer.init();
      }

      // ── Wire up pause detection callbacks ──────────────────
      if (this.audioAnalyzer) {
        this.audioAnalyzer.onPauseDetected((pauseInfo) => {
          // pauseInfo = { startTime }
          // We'll track the start for when it ends
        });

        this.audioAnalyzer.onPauseEnded((pauseInfo) => {
          // pauseInfo = { startTime, endTime, duration }
          // Duration is in ms, convert to seconds for metrics
          this.metricsAnalyzer.addPause({
            startTime: pauseInfo.startTime,
            endTime:   pauseInfo.endTime,
            duration:  pauseInfo.duration / 1000
          });
        });

        // Start audio recording + waveform
        this.audioAnalyzer.start();
      }

      // ── Wire up speech recognition callbacks ───────────────
      this.speechEngine.onInterimResult((text) => {
        this.updateTranscript(text, false);
      });

      this.speechEngine.onFinalResult(({ text, confidence }) => {
        this.updateTranscript(text, true);

        // Feed recognised words into metrics with timestamp
        const words = text.trim().split(/\s+/).filter(Boolean);
        if (words.length > 0) {
          this.metricsAnalyzer.addWords(words, this.elapsedSeconds);
        }
      });

      this.speechEngine.onError((err) => {
        console.warn('[SpeechEngine] Error:', err);
        // Non-fatal — allow recording to continue (audio still records)
      });

      this.speechEngine.start();

      // ── Intervals ──────────────────────────────────────────
      this.timerInterval = setInterval(() => this.updateTimer(), TIMER_INTERVAL_MS);
      this.metricsInterval = setInterval(
        () => this.updateLiveMetrics(),
        LIVE_METRICS_INTERVAL_MS
      );

      // ── UI state ───────────────────────────────────────────
      this.isRecording = true;
      document.body.classList.add('recording-active');
      this._setRecordButton(true);
      this._setStatus('recording', 'Recording');
      this.showRecordingView();

    } catch (err) {
      console.error('[VoiceCoach] Failed to start recording:', err);
      this.showNotification('Could not start recording. Check microphone access.', 'error');
    }
  }

  /**
   * Stop the current recording session and generate analytics.
   */
  async stopRecording () {
    if (!this.isRecording) return;

    try {
      // ── Stop modules ───────────────────────────────────────
      if (this.audioAnalyzer) {
        await this.audioAnalyzer.stop();
      }
      this.speechEngine.stop();

      // ── Stop intervals ─────────────────────────────────────
      clearInterval(this.timerInterval);
      clearInterval(this.metricsInterval);
      this.timerInterval   = null;
      this.metricsInterval = null;

      // ── UI state ───────────────────────────────────────────
      this.isRecording = false;
      document.body.classList.remove('recording-active');
      this._setRecordButton(false);
      this._setStatus('done', 'Done');

      // ── Guard: ultra-short sessions produce no useful data ─
      if (this.elapsedSeconds < MIN_SESSION_SECONDS) {
        this.showNotification(
          'Session too short — speak for at least a few seconds.',
          'info'
        );
        return;
      }

      // ── Final text analysis ────────────────────────────────
      const fullText = this.currentTranscript.trim();
      if (fullText) {
        this.metricsAnalyzer.detectFillers(fullText);
        this.metricsAnalyzer.detectDroppedSounds(fullText);
      }

      // ── Build metrics & recommendations ────────────────────
      const metrics         = this.metricsAnalyzer.getSnapshot();
      const recommendations = this.recommendationEngine.generate(metrics);

      // ── Build session payload ──────────────────────────────
      const sessionData = {
        id          : crypto.randomUUID?.() || Date.now().toString(36),
        date        : new Date().toISOString(),
        duration    : this.elapsedSeconds,
        transcript  : fullText,
        metrics,
        recommendations,
      };

      // Stash for save-button use
      this._lastSession = sessionData;

      // ── Render dashboard ───────────────────────────────────
      this.showDashboard(sessionData);

    } catch (err) {
      console.error('[VoiceCoach] Error stopping recording:', err);
      this.showNotification('Something went wrong finalising your session.', 'error');
    }
  }

  /* ═══════════════════════════════════════════════════════════
   *  Live UI Updates (during recording)
   * ═══════════════════════════════════════════════════════════ */

  /** Tick the on-screen timer every second. */
  updateTimer () {
    this.elapsedSeconds += 1;
    if (this.els.timer) {
      this.els.timer.textContent = this.formatTime(this.elapsedSeconds);
    }
  }

  /** Refresh the four live metric cards with current data. */
  updateLiveMetrics () {
    if (!this.isRecording) return;

    const snap = this.metricsAnalyzer.getSnapshot();

    this._animateValue(this.els.liveWpm,     Math.round(snap.avgWpm || snap.currentWpm || 0));
    this._animateValue(this.els.liveClarity,  `${Math.round(snap.clarityScore)}%`);
    this._animateValue(this.els.liveFillers,  snap.totalFillers ?? 0);
    this._animateValue(this.els.liveScore,    Math.round(snap.overallScore));
  }

  /**
   * Update the transcript pane.
   * @param {string}  text    – The new text fragment
   * @param {boolean} isFinal – true → append permanently; false → show as interim
   */
  updateTranscript (text, isFinal) {
    const el = this.els.transcriptArea;
    if (!el) return;

    if (isFinal) {
      // Append to running transcript
      this.currentTranscript += (this.currentTranscript ? ' ' : '') + text;
      el.innerHTML =
        `<span class="final-text">${this._escapeHTML(this.currentTranscript)}</span>`;
    } else {
      // Show confirmed text + interim in lighter colour
      el.innerHTML =
        `<span class="final-text">${this._escapeHTML(this.currentTranscript)}</span>` +
        `<span class="interim-text"> ${this._escapeHTML(text)}</span>`;
    }

    // Auto-scroll to bottom
    el.scrollTop = el.scrollHeight;
  }

  /* ═══════════════════════════════════════════════════════════
   *  View Switching
   * ═══════════════════════════════════════════════════════════ */

  /** Show the recording interface, hide the dashboard. */
  showRecordingView () {
    this.els.dashboardView?.classList.remove('active');
    this.els.recordingView?.classList.add('active');
  }

  /** Show the post-session dashboard populated with data. */
  showDashboard (sessionData) {
    const { metrics, recommendations } = sessionData;

    this.renderDashboard(metrics, recommendations, sessionData.duration);

    // Swap views
    this.els.recordingView?.classList.remove('active');
    this.els.dashboardView?.classList.add('active');

    // Default tab
    this.switchTab('recommendations-tab');
  }

  /* ═══════════════════════════════════════════════════════════
   *  Dashboard Rendering
   * ═══════════════════════════════════════════════════════════ */

  /**
   * Populate every widget on the dashboard.
   * All animated elements receive staggered entrance delays.
   */
  renderDashboard (metrics, recommendations, duration) {
    const sessionDuration = duration || metrics.sessionDuration || this.elapsedSeconds;

    // ── Score ring ──────────────────────────────────────────
    this._renderScoreRing(metrics.overallScore, metrics.grade);

    // ── Summary stats ────────────────────────────────────────
    this._setText(this.els.summaryDuration, this.formatTime(sessionDuration));
    this._setText(this.els.summaryWords, metrics.totalWords ?? 0);

    // ── Speed timeline chart ─────────────────────────────────
    if (this.els.speedChart && metrics.wpmTimeline && metrics.wpmTimeline.length > 0) {
      this.chartRenderer.drawSpeedTimeline(
        this.els.speedChart,
        metrics.wpmTimeline
      );
    }

    // ── Tab content ──────────────────────────────────────────
    this.renderPauseAnalysis(metrics.pauses, sessionDuration);
    this.renderClarityDetails(metrics);
    this.renderRecommendations(recommendations);

    // ── Staggered animation ──────────────────────────────────
    this._staggerAnimateIn('.summary-card, .chart-container, .recommendation-item');
  }

  /**
   * Render the score ring with grade letter and animated fill.
   */
  _renderScoreRing (score, grade) {
    const s = Math.round(Math.max(0, Math.min(100, score || 0)));
    const g = grade || this._scoreToGrade(s);

    if (this.els.overallScore) {
      // Set the score as a CSS custom property for conic-gradient animation
      this.els.overallScore.style.setProperty('--score', 0);
      requestAnimationFrame(() => {
        this.els.overallScore.style.setProperty('--score', s);
      });

      const scoreLetter = this.els.overallScore.querySelector('.score-letter');
      if (scoreLetter) {
        scoreLetter.textContent = g;
      }
    }
  }

  /**
   * Render the Pause Analysis tab.
   * Shows a visual pause list + summary statistics.
   */
  renderPauseAnalysis (pauses = [], duration = 0) {
    const container = this.els.pauseList;
    if (!container) return;

    if (!pauses.length) {
      container.innerHTML = `
        <div class="empty-state">
          <p>No significant pauses detected.</p>
        </div>`;
      return;
    }

    // Compute stats
    const totalPauseTime = pauses.reduce((sum, p) => sum + (p.duration || 0), 0);
    const avgPause       = totalPauseTime / pauses.length;
    const longestPause   = Math.max(...pauses.map((p) => p.duration || 0));
    const pauseRatio     = duration > 0 ? ((totalPauseTime / duration) * 100) : 0;

    container.innerHTML = `
      <div class="pause-stats">
        <div class="stat-card glass-card">
          <span class="stat-value">${pauses.length}</span>
          <span class="stat-label">Total Pauses</span>
        </div>
        <div class="stat-card glass-card">
          <span class="stat-value">${avgPause.toFixed(1)}s</span>
          <span class="stat-label">Average Length</span>
        </div>
        <div class="stat-card glass-card">
          <span class="stat-value">${longestPause.toFixed(1)}s</span>
          <span class="stat-label">Longest Pause</span>
        </div>
        <div class="stat-card glass-card">
          <span class="stat-value">${pauseRatio.toFixed(0)}%</span>
          <span class="stat-label">Silence Ratio</span>
        </div>
      </div>

      <div class="pause-items">
        ${pauses.map((p, i) => {
          const classification = this.metricsAnalyzer.classifyPause(p.duration);
          const barWidth = Math.min((p.duration / (longestPause || 1)) * 100, 100);
          const badgeClass = {
            micro: 'badge-micro',
            good: 'badge-natural',
            long: 'badge-long',
            awkward: 'badge-awkward'
          }[classification] || 'badge-natural';

          return `
            <div class="pause-item glass-card" style="animation-delay: ${i * 50}ms">
              <span class="pause-timestamp">${this.formatTime(Math.floor(p.startTime || 0))}</span>
              <div class="pause-duration-bar">
                <div class="pause-duration-fill" style="width: ${barWidth}%"></div>
              </div>
              <span class="pause-duration-text">${p.duration.toFixed(1)}s</span>
              <span class="pause-classification ${badgeClass}">${classification}</span>
            </div>`;
        }).join('')}
      </div>`;
  }

  /**
   * Render the Clarity Details tab.
   * Shows filler-word breakdown + dropped-sound list.
   */
  renderClarityDetails (metrics) {
    // ── Filler words ───────────────────────────────────────
    const fillerContainer = this.els.fillerCloud;
    if (fillerContainer) {
      const fillers = metrics.fillerCounts || {};
      const fillerEntries = Object.entries(fillers)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);

      if (fillerEntries.length > 0) {
        fillerContainer.innerHTML = fillerEntries.map(([word, count]) =>
          `<span class="filler-word">${this._escapeHTML(word)} <span class="filler-count">×${count}</span></span>`
        ).join('');
      } else {
        fillerContainer.innerHTML = '<p class="empty-state">🎉 No filler words detected — great job!</p>';
      }
    }

    // ── Dropped sounds ──────────────────────────────────────
    const droppedContainer = this.els.droppedList;
    if (droppedContainer) {
      const dropped = metrics.droppedWords || [];

      if (dropped.length > 0) {
        droppedContainer.innerHTML = dropped.map((item) =>
          `<div class="dropped-item glass-card">
            <span class="dropped-detected">"${this._escapeHTML(item.detected)}"</span>
            <span class="dropped-arrow">→</span>
            <span class="dropped-expected">"${this._escapeHTML(item.expected)}"</span>
            <span class="dropped-type badge-${item.type || 'other'}">${item.type || ''}</span>
          </div>`
        ).join('');
      } else {
        droppedContainer.innerHTML = '<p class="empty-state">🎯 No dropped sounds detected — excellent clarity!</p>';
      }
    }

    // ── Issues summary ──────────────────────────────────────
    const issuesContainer = this.els.issuesList;
    if (issuesContainer) {
      const totalIssues = (metrics.totalFillers || 0) + (metrics.droppedWords?.length || 0);
      const clarityScore = metrics.clarityScore || 100;

      if (totalIssues > 0) {
        issuesContainer.innerHTML = `
          <div class="clarity-summary glass-card">
            <div class="clarity-score-display">
              <span class="clarity-number">${Math.round(clarityScore)}</span>
              <span class="clarity-label">/ 100 Clarity Score</span>
            </div>
            <div class="clarity-breakdown">
              <span>${metrics.totalFillers || 0} filler words</span>
              <span>${metrics.droppedWords?.length || 0} dropped sounds</span>
            </div>
          </div>`;
      } else {
        issuesContainer.innerHTML = '<p class="empty-state">✨ No clarity issues detected!</p>';
      }
    }
  }

  /**
   * Render the Recommendations tab.
   * Cards are sorted by priority (highest first) and stagger in.
   */
  renderRecommendations (recommendations = []) {
    const container = this.els.recsList;
    if (!container) return;

    if (!recommendations.length) {
      container.innerHTML = `
        <div class="empty-state">
          <p>Complete a longer session to receive personalised tips.</p>
        </div>`;
      return;
    }

    container.innerHTML = recommendations.map((rec, i) => {
      const severityClass = `severity-${rec.severity || 'info'}`;
      return `
        <div class="recommendation-item glass-card ${severityClass}" style="animation-delay: ${i * ANIMATION_STAGGER_MS}ms">
          <div class="rec-icon">${rec.icon || '💡'}</div>
          <div class="rec-body">
            <h5 class="rec-title">${this._escapeHTML(rec.title)}</h5>
            <p class="rec-description">${this._escapeHTML(rec.description)}</p>
          </div>
        </div>`;
    }).join('');
  }

  /* ═══════════════════════════════════════════════════════════
   *  Tab Switching
   * ═══════════════════════════════════════════════════════════ */

  /**
   * Switch between dashboard detail tabs.
   * @param {string} tabName - The data-tab value (e.g. 'pause-tab', 'clarity-tab', 'recommendations-tab')
   */
  switchTab (tabName) {
    this.activeTab = tabName;

    // ── Update button states ─────────────────────────────────
    this.els.tabBtns.forEach((btn) => {
      const isActive = btn.dataset.tab === tabName;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    // ── Show / hide content panels ───────────────────────────
    this.els.tabContents.forEach((panel) => {
      const isTarget = panel.id === tabName;

      if (isTarget) {
        panel.classList.add('active');
        panel.style.display = '';
      } else {
        panel.classList.remove('active');
        panel.style.display = 'none';
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
   *  History Modal
   * ═══════════════════════════════════════════════════════════ */

  /** Open the history modal and populate the session list. */
  openHistory () {
    const sessions = this.storage.getAllSessions();

    if (!this.els.historyList) return;

    if (!sessions.length) {
      this.els.historyList.innerHTML = `
        <div class="empty-state">
          <p>No sessions saved yet. Record your first session!</p>
        </div>`;
    } else {
      this.els.historyList.innerHTML = sessions.map((s) => `
        <div class="history-item" data-session-id="${s.id}">
          <div class="history-date">
            ${this._formatDate(s.date)}
          </div>
          <div class="history-meta">
            <span class="score-badge grade-${(s.metrics?.grade || this._scoreToGrade(s.metrics?.overallScore)).toLowerCase()}">
              ${s.metrics?.grade || this._scoreToGrade(s.metrics?.overallScore)}
            </span>
            <span class="history-duration">${this.formatTime(s.duration)}</span>
            <span class="history-wpm">${Math.round(s.metrics?.avgWpm ?? 0)} WPM</span>
          </div>
        </div>
      `).join('');

      // Attach click handlers
      this.els.historyList.querySelectorAll('.history-item').forEach((item) => {
        item.addEventListener('click', () => {
          const sessionId = item.dataset.sessionId;
          this.viewSession(sessionId);
        });
      });
    }

    this.els.historyModal?.classList.add('open');
  }

  /** Close the history modal. */
  closeHistory () {
    this.els.historyModal?.classList.remove('open');
  }

  /**
   * Load a past session by ID and render it in the dashboard.
   */
  viewSession (sessionId) {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      this.showNotification('Session not found.', 'error');
      return;
    }

    this._lastSession    = session;
    this.elapsedSeconds  = session.duration ?? 0;
    this.currentTranscript = session.transcript ?? '';

    this.closeHistory();
    this.showDashboard(session);
  }

  /** Clear all saved sessions. */
  clearHistory () {
    this.storage.clearAll();
    this._updateHistoryBadge();
    this.closeHistory();
    this.showNotification('History cleared.', 'info');
  }

  /* ═══════════════════════════════════════════════════════════
   *  Permission Modal
   * ═══════════════════════════════════════════════════════════ */

  showPermissionModal () {
    this.els.permissionModal?.classList.add('open');
  }

  hidePermissionModal () {
    this.els.permissionModal?.classList.remove('open');
  }

  /**
   * Request mic access.  On success, sets hasPermission and starts
   * recording automatically.
   */
  async _requestMicPermission () {
    try {
      // Just requesting the stream validates permission
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop the preview stream; AudioAnalyzer will request its own
      stream.getTracks().forEach((t) => t.stop());

      this.hasPermission = true;
      this.hidePermissionModal();
      this.showNotification('Microphone access granted.', 'success');

      // Automatically begin recording now that we have permission
      await this.startRecording();
    } catch (err) {
      console.error('[VoiceCoach] Mic permission denied:', err);
      this.showNotification(
        'Microphone access was denied. Please allow it in browser settings.',
        'error'
      );
    }
  }

  /* ═══════════════════════════════════════════════════════════
   *  Toast Notifications
   * ═══════════════════════════════════════════════════════════ */

  /**
   * Show a small floating notification.
   * @param {string} message
   * @param {'success'|'error'|'info'} type
   */
  showNotification (message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');

    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span class="toast-message">${this._escapeHTML(message)}</span>
    `;

    this.els.toastContainer.appendChild(toast);

    // Trigger entrance animation on next frame
    requestAnimationFrame(() => toast.classList.add('visible'));

    // Auto-dismiss
    setTimeout(() => {
      toast.classList.remove('visible');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
      // Fallback removal in case transitionend never fires
      setTimeout(() => toast.remove(), 500);
    }, TOAST_DURATION_MS);
  }

  /* ═══════════════════════════════════════════════════════════
   *  Utilities (private)
   * ═══════════════════════════════════════════════════════════ */

  /**
   * Format seconds into MM:SS.
   * @param {number} seconds
   * @returns {string}
   */
  formatTime (seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /** Reset all per-session state ready for a new recording. */
  _resetSession () {
    this.elapsedSeconds    = 0;
    this.currentTranscript = '';
    this._lastSession      = null;

    this.metricsAnalyzer.reset();

    if (this.els.timer)        this.els.timer.textContent = '00:00';
    if (this.els.transcriptArea) this.els.transcriptArea.innerHTML =
      '<p class="transcript-placeholder">Your speech will appear here in real-time…</p>';
    if (this.els.liveWpm)      this.els.liveWpm.textContent     = '0';
    if (this.els.liveClarity)  this.els.liveClarity.textContent = '—';
    if (this.els.liveFillers)  this.els.liveFillers.textContent = '0';
    if (this.els.liveScore)    this.els.liveScore.textContent   = '—';

    this._setStatus('ready', 'Ready');
  }

  /** Save the most recent session to storage. */
  _saveCurrentSession () {
    if (!this._lastSession) {
      this.showNotification('No session to save.', 'info');
      return;
    }

    this.storage.saveSession(this._lastSession);
    this._updateHistoryBadge();
    this.showNotification('Session saved!', 'success');
  }

  /** Refresh the history badge count. */
  _updateHistoryBadge () {
    const count = this.storage.getSessionCount?.() ?? this.storage.getAllSessions().length;
    // Badge is displayed inline in the history button if count > 0
    // We'll update the button text or add a badge span
    const btn = this.els.historyBtn;
    if (!btn) return;

    let badge = btn.querySelector('.history-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'history-badge';
        btn.appendChild(badge);
      }
      badge.textContent = count;
      badge.style.display = '';
    } else if (badge) {
      badge.style.display = 'none';
    }
  }

  /** Toggle the record button between start / stop visual state. */
  _setRecordButton (isRecording) {
    if (!this.els.recordBtn) return;

    this.els.recordBtn.classList.toggle('recording', isRecording);

    // Toggle SVG icon visibility
    const micIcon  = this.els.recordBtn.querySelector('.icon-mic');
    const stopIcon = this.els.recordBtn.querySelector('.icon-stop');

    if (micIcon)  micIcon.style.display  = isRecording ? 'none' : '';
    if (stopIcon) stopIcon.style.display = isRecording ? '' : 'none';

    // Update the label below the button
    const label = this.els.recordBtn.parentElement?.querySelector('.record-btn-label');
    if (label) {
      label.textContent = isRecording ? 'Tap to stop' : 'Tap to record';
    }

    this.els.recordBtn.setAttribute(
      'aria-label',
      isRecording ? 'Stop recording' : 'Start recording'
    );
  }

  /** Update the status badge. */
  _setStatus (state, text) {
    const badge = this.els.statusBadge;
    if (!badge) return;

    // Remove all status classes
    badge.className = 'status-badge';
    badge.classList.add(`status-${state}`);

    const textEl = badge.querySelector('.status-text');
    if (textEl) textEl.textContent = text;
  }

  /** Check whether any modal is currently visible. */
  _isAnyModalOpen () {
    return !!(
      this.els.historyModal?.classList.contains('open') ||
      this.els.permissionModal?.classList.contains('open') ||
      this.els.settingsModal?.classList.contains('open')
    );
  }

  /** Close every modal. */
  _closeAllModals () {
    this.els.historyModal?.classList.remove('open');
    this.els.permissionModal?.classList.remove('open');
    this.els.settingsModal?.classList.remove('open');
  }

  /** Open settings modal and prefill data if connected. */
  openSettings () {
    if (this.storage.isConnected()) {
      if (this.els.sbUrlInput) this.els.sbUrlInput.value = localStorage.getItem('voice-coach-sb-url') || '';
      if (this.els.sbKeyInput) this.els.sbKeyInput.value = localStorage.getItem('voice-coach-sb-key') || '';
    } else {
      if (this.els.sbUrlInput) this.els.sbUrlInput.value = '';
      if (this.els.sbKeyInput) this.els.sbKeyInput.value = '';
    }
    this.els.settingsModal?.classList.add('open');
  }

  /** Close settings modal. */
  closeSettings () {
    this.els.settingsModal?.classList.remove('open');
  }

  /** Save Supabase connection details and trigger sync. */
  async _saveSettings (e) {
    e.preventDefault();
    const url = this.els.sbUrlInput?.value.trim();
    const key = this.els.sbKeyInput?.value.trim();

    if (!url || !key) {
      this.showNotification('URL and Key are required.', 'error');
      return;
    }

    try {
      this.showNotification('Connecting to Supabase...', 'info');
      await this.storage.connectSupabase(url, key);
      this.showNotification('Supabase connected and synced!', 'success');
      this.closeSettings();
    } catch (err) {
      this.showNotification('Connection failed. Verify URL and Key.', 'error');
    }
  }

  /** Disconnect database and clear fields. */
  _disconnectSettings () {
    this.storage.disconnectSupabase();
    if (this.els.sbUrlInput) this.els.sbUrlInput.value = '';
    if (this.els.sbKeyInput) this.els.sbKeyInput.value = '';
    this.showNotification('Supabase database disconnected.', 'info');
    this.closeSettings();
    this._updateHistoryBadge();
  }

  /** Smoothly update a metric card value. */
  _animateValue (el, value) {
    if (!el) return;
    el.textContent = value;
    el.classList.add('metric-updated');
    setTimeout(() => el.classList.remove('metric-updated'), 600);
  }

  /** Add staggered `animate-in` class to matching elements. */
  _staggerAnimateIn (selector) {
    const nodes = document.querySelectorAll(selector);
    nodes.forEach((node, i) => {
      node.style.animationDelay = `${i * ANIMATION_STAGGER_MS}ms`;
      node.classList.add('animate-in');
    });
  }

  /** Convert score 0-100 → letter grade. */
  _scoreToGrade (score) {
    const s = Math.round(score ?? 0);
    if (s >= 90) return 'A';
    if (s >= 80) return 'B';
    if (s >= 70) return 'C';
    if (s >= 60) return 'D';
    return 'F';
  }

  /** Format an ISO date string for display. */
  _formatDate (isoString) {
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString(undefined, {
        month : 'short',
        day   : 'numeric',
        year  : 'numeric',
        hour  : '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  }

  /** Set textContent safely. */
  _setText (el, value) {
    if (el) el.textContent = value;
  }

  /** Basic HTML escape to prevent XSS in user-generated transcript. */
  _escapeHTML (str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  Bootstrap on DOM ready
 * ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', async () => {
  const app = new VoiceCoachApp();
  await app.init();

  // Expose to console for debugging in dev
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '') {
    window.__voiceCoach = app;
  }
});
