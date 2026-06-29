/**
 * ============================================================
 *  recommendations.js — Smart Coaching Recommendation Engine
 * ============================================================
 *  Consumes a metrics snapshot (from MetricsAnalyzer.getSnapshot())
 *  and produces an array of prioritized, actionable recommendations
 *  sorted by severity / priority.
 * ============================================================
 */

// ── Severity → base priority mapping (lower = higher priority) ──────────────
const SEVERITY_PRIORITY = {
  critical: 1,
  warning:  2,
  info:     3,
  success:  4
};

/**
 * Helper — create a recommendation object with sane defaults.
 */
function rec(severity, icon, title, description, metric, priorityBoost = 0) {
  return {
    severity,
    icon,
    title,
    description,
    metric,
    priority: SEVERITY_PRIORITY[severity] * 10 + priorityBoost
  };
}

/**
 * RecommendationEngine
 * ─────────────────────
 * Stateless engine: call `.generate(snapshot)` each time you want
 * fresh recommendations.
 */
export class RecommendationEngine {

  constructor() {
    // Could store previous-session data here in the future
    // for trend analysis ("You're improving!")
    this._previousSnapshots = [];
  }

  /**
   * Store a snapshot for trend tracking (optional).
   * @param {Object} snapshot  Previous session snapshot.
   */
  addPreviousSession(snapshot) {
    this._previousSnapshots.push(snapshot);
  }

  /**
   * Generate a sorted array of coaching recommendations.
   *
   * @param   {Object} metrics  A snapshot from MetricsAnalyzer.getSnapshot().
   * @returns {{ severity, icon, title, description, metric, priority }[]}
   */
  generate(metrics) {
    const tips = [];

    // ─── Speed recommendations ──────────────────────────────────────────
    this._analyzeSpeed(metrics, tips);

    // ─── Pause recommendations ──────────────────────────────────────────
    this._analyzePauses(metrics, tips);

    // ─── Filler recommendations ─────────────────────────────────────────
    this._analyzeFillers(metrics, tips);

    // ─── Clarity recommendations ────────────────────────────────────────
    this._analyzeClarity(metrics, tips);

    // ─── General / meta recommendations ─────────────────────────────────
    this._analyzeGeneral(metrics, tips);

    // ─── Sort by priority (ascending = most urgent first) ───────────────
    tips.sort((a, b) => a.priority - b.priority);

    // Cap at 8 recommendations
    return tips.slice(0, 8);
  }

  /* ═══════════════════════════════════════════════════════════════════════
   *  Private analysis helpers
   * ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Speed / WPM recommendations.
   * @private
   */
  _analyzeSpeed(m, tips) {
    const wpm = m.avgWpm;

    if (wpm > 170) {
      tips.push(rec(
        'critical', '🏎️', 'You\'re speaking too fast',
        `Your average pace is ${wpm} WPM — well above the recommended range. ` +
        'Try practicing with a metronome set to 130 BPM (one word per beat) to ' +
        'build a natural rhythm. Remember: pausing lets your audience absorb key points.',
        'speed', 0
      ));
    } else if (wpm > 150) {
      tips.push(rec(
        'warning', '⚡', 'Slightly fast pace',
        `At ${wpm} WPM you're a bit above the ideal 120–150 range. ` +
        'Try inserting a brief pause between ideas — it gives your audience ' +
        'time to process and makes you sound more deliberate.',
        'speed', 1
      ));
    } else if (wpm < 100 && wpm > 0) {
      tips.push(rec(
        'warning', '🐢', 'Speaking pace is quite slow',
        `Your average is ${wpm} WPM — below the typical 120–150 range. ` +
        'Try injecting a bit more energy and forward momentum. Reading aloud ' +
        'from a script at a target pace can help build muscle memory.',
        'speed', 1
      ));
    } else if (wpm >= 120 && wpm <= 150) {
      tips.push(rec(
        'success', '🎯', 'Great speaking pace!',
        `${wpm} WPM is right in the sweet spot. Your audience can follow ` +
        'along comfortably — keep it up!',
        'speed', 0
      ));
    }

    // High WPM variance
    if (m.wpmVariance > 30) {
      tips.push(rec(
        'info', '📊', 'Your pace varies a lot',
        `Your WPM standard deviation is ~${m.wpmVariance}. Some variation is natural, ` +
        'but large swings can feel jarring. Practice maintaining a steady rhythm, ' +
        'especially when transitioning between sections.',
        'speed', 5
      ));
    }
  }

  /**
   * Pause recommendations.
   * @private
   */
  _analyzePauses(m, tips) {
    const ps = m.pauseStats;

    if (ps.pauseRatio < 5 && m.sessionDuration > 30) {
      tips.push(rec(
        'warning', '⏸️', 'Not enough pauses',
        'Pausing only makes up ' + ps.pauseRatio + '% of your session. ' +
        'Strategic silence after key points gives your audience time to think ' +
        'and makes you sound more confident. Aim for 10–20%.',
        'pauses', 2
      ));
    } else if (ps.pauseRatio > 30) {
      tips.push(rec(
        'warning', '⏳', 'Too many pauses',
        ps.pauseRatio + '% of your session is silence. Frequent or long pauses ' +
        'can signal uncertainty. Try preparing bullet points so you always know ' +
        'what comes next.',
        'pauses', 2
      ));
    } else if (ps.pauseRatio >= 10 && ps.pauseRatio <= 20) {
      tips.push(rec(
        'success', '✅', 'Nice use of pauses!',
        'Your pause-to-speech ratio is a healthy ' + ps.pauseRatio + '%. ' +
        'Well-placed pauses make your delivery clear and engaging.',
        'pauses', 0
      ));
    }

    if (ps.awkward > 3) {
      tips.push(rec(
        'critical', '😶', 'Several long pauses detected',
        `${ps.awkward} pauses were longer than 3 seconds. If you lose your train ` +
        'of thought, try a bridge phrase like "Let me put it another way…" ' +
        'or take a breath and summarize what you just said.',
        'pauses', 1
      ));
    }
  }

  /**
   * Filler word recommendations.
   * @private
   */
  _analyzeFillers(m, tips) {
    const count  = m.totalFillers;
    const counts = m.fillerCounts;

    if (count > 20) {
      // List the top 3 fillers
      const top3 = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([w, c]) => `"${w}" (×${c})`)
        .join(', ');

      tips.push(rec(
        'critical', '🚨', 'Heavy use of filler words',
        `${count} filler words detected. Your top offenders: ${top3}. ` +
        'Try recording yourself and pausing silently instead of filling gaps. ' +
        'Awareness is the first step!',
        'fillers', 0
      ));
    } else if (count > 10) {
      tips.push(rec(
        'warning', '🔔', 'Moderate filler word usage',
        `${count} filler words crept in. Try replacing them with a brief ` +
        'pause — silence sounds far more professional than "um".',
        'fillers', 2
      ));
    } else if (count > 5) {
      tips.push(rec(
        'info', '💬', 'Some filler words detected',
        `${count} filler words — not bad, but there's room to polish. ` +
        'Being mindful during transitions between ideas helps the most.',
        'fillers', 5
      ));
    } else {
      tips.push(rec(
        'success', '✨', 'Minimal filler words!',
        count === 0
          ? 'Zero filler words — outstanding! Your speech is clean and focused.'
          : `Only ${count} filler word${count > 1 ? 's' : ''} — very clean delivery!`,
        'fillers', 0
      ));
    }

    // Dominant filler check
    if (count > 5) {
      const entries = Object.entries(counts);
      if (entries.length > 0) {
        const [topWord, topCount] = entries.sort((a, b) => b[1] - a[1])[0];
        if (topCount / count > 0.5) {
          tips.push(rec(
            'info', '🎯', `Watch out for "${topWord}"`,
            `"${topWord}" accounts for ${Math.round(topCount / count * 100)}% ` +
            'of your fillers. Try catching yourself before you say it — a silent ' +
            'pause is always a stronger alternative.',
            'fillers', 4
          ));
        }
      }
    }
  }

  /**
   * Clarity & articulation recommendations.
   * @private
   */
  _analyzeClarity(m, tips) {
    const score = m.clarityScore;

    if (score < 50) {
      tips.push(rec(
        'critical', '🔇', 'Clarity needs work',
        'Your clarity score is ' + score + '/100. Try tongue-twister exercises ' +
        '("She sells seashells…") and over-articulate during practice — it builds ' +
        'muscle memory for clear delivery.',
        'clarity', 0
      ));
    } else if (score < 70) {
      tips.push(rec(
        'warning', '🗣️', 'Some clarity issues',
        'Clarity score: ' + score + '/100. Focus on enunciating word endings ' +
        '(especially "-ing" and "-tion") and slowing down slightly in complex sentences.',
        'clarity', 2
      ));
    } else if (score >= 85) {
      tips.push(rec(
        'success', '💎', 'Excellent clarity!',
        'Clarity score: ' + score + '/100 — your articulation is crisp and easy ' +
        'to follow. Keep it up!',
        'clarity', 0
      ));
    }

    // Specific dropping patterns
    if (m.droppedWords && m.droppedWords.length > 0) {
      // Group by type
      const types = {};
      m.droppedWords.forEach(d => {
        types[d.type] = (types[d.type] || 0) + 1;
      });

      const examples = m.droppedWords.slice(0, 3)
        .map(d => `"${d.detected}" → "${d.expected}"`)
        .join(', ');

      tips.push(rec(
        'info', '👂', 'Some sounds are being dropped',
        `Detected ${m.droppedWords.length} informal pronunciations: ${examples}. ` +
        'In casual speech this is fine, but for presentations try pronouncing ' +
        'every syllable clearly.',
        'clarity', 6
      ));
    }
  }

  /**
   * General / meta recommendations.
   * @private
   */
  _analyzeGeneral(m, tips) {
    // Short session warning
    if (m.sessionDuration < 60 && m.sessionDuration > 0) {
      tips.push(rec(
        'info', '⏱️', 'Try a longer practice session',
        'Your session was under a minute. For more accurate and useful metrics, ' +
        'aim for at least 2–3 minutes of continuous speech.',
        'general', 8
      ));
    }

    // Trend analysis (improvement over previous sessions)
    if (this._previousSnapshots.length > 0) {
      const prev = this._previousSnapshots[this._previousSnapshots.length - 1];
      const scoreDelta = m.overallScore - prev.overallScore;

      if (scoreDelta > 5) {
        tips.push(rec(
          'success', '📈', 'You\'re improving!',
          `Your overall score went up by ${scoreDelta} points since your last ` +
          'session. Consistent practice is paying off — keep going!',
          'general', 9
        ));
      } else if (scoreDelta < -10) {
        tips.push(rec(
          'info', '📉', 'Score dipped a bit',
          `Your score dropped ${Math.abs(scoreDelta)} points compared to last time. ` +
          'Don\'t worry — everyone has off days. Review the tips above and try again.',
          'general', 7
        ));
      }
    }
  }
}
