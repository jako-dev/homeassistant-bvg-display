/**
 * BVG Display Card - LED Matrix Style Lovelace Card
 * Renders BVG departures as a pixel-art LED panel, in one of several styles
 */

// Identifies a BVG departures sensor by what it exposes rather than by its
// entity id, so renamed entities and non-default ids are still found.
const isDeparturesSensor = (stateObj) =>
  !!stateObj &&
  !!stateObj.attributes &&
  Array.isArray(stateObj.attributes.departures) &&
  typeof stateObj.attributes.station_name === 'string';

// How often the card recomputes the countdown locally.
const TICK_INTERVAL_MS = 15000;
// How long the last good departures stay on screen while entities are
// unavailable (HA restart, integration reload, brief API outage).
const STALE_GRACE_MS = 120000;

// Selectable display styles. `led_matrix` is the original colourful panel;
// `bvg_platform` mimics the amber LED train destination displays on BVG
// U-Bahn platforms (printed "Linie / Ziel / Abfahrt" labels, "Gleis" strip).
const STYLES = ['led_matrix', 'bvg_platform'];
const DEFAULT_STYLE = 'led_matrix';
// Colour themes of the bvg_platform style. Each one sets the housing (frame),
// the LED field (background) and the lit LEDs; frame_color, background_color
// and led_color in the card config override single colours of the theme.
const PLATFORM_THEMES = {
  bvg: { name: 'BVG original', frame: '#262626', background: '#17130b', led: '#ffa31a' },
};
const DEFAULT_THEME = 'bvg';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
// Logical x where the "Ziel" column starts in the bvg_platform style.
const PLATFORM_DEST_X = 46;
// Row pitch of bvg_platform: like the real display, the big digits fill
// about 60% of a row, leaving dark space between departures.
const PLATFORM_ROW_HEIGHT = 24;
const PLATFORM_BIG_Y = 5;   // top of the double-size glyphs within a row
const PLATFORM_SMALL_Y = 9; // top of normal glyphs, vertically centered

class BvgDisplayCard extends HTMLElement {
  static get properties() {
    return {
      hass: {},
      config: {},
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._config = null;
    this._entityConfigs = [];
    this._scrollIndex = 0;
    this._scrollTimer = null;
    this._rendered = false;
    this._observer = null;
    this._visible = true;
    this._tickTimer = null;
    this._lastGood = null;
    // Defaults mirror setConfig: HA may call getCardSize()/getGridOptions()
    // or connectedCallback before setConfig, and undefined here would make
    // those return NaN and corrupt the dashboard layout.
    this._rows = 3;
    this._scrollSpeed = 3000;
    this._scrollEnabled = true;
    this._showPlatform = true;
    this._showHeader = false;
    this._frameStyle = 'panel';
    this._style = DEFAULT_STYLE;
    this._theme = DEFAULT_THEME;
    this._colors = { ...PLATFORM_THEMES[DEFAULT_THEME] };
  }

  // Accepts a list, a single entry, or nothing. A bare string must not be
  // spread into one entity per character, and a mapping must not throw.
  static _asEntityList(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    return [value];
  }

  // Theme colours with the per-colour overrides from the config applied.
  static _resolveColors(config) {
    const theme = PLATFORM_THEMES[config.theme] || PLATFORM_THEMES[DEFAULT_THEME];
    const pick = (key, fallback) => (HEX_COLOR.test(config[key] || '') ? config[key] : fallback);
    return {
      frame: pick('frame_color', theme.frame),
      background: pick('background_color', theme.background),
      led: pick('led_color', theme.led),
    };
  }

  // Blends two #rrggbb colours; t = 0 gives a, t = 1 gives b.
  static _mix(a, b, t) {
    const pa = [1, 3, 5].map(i => parseInt(a.substr(i, 2), 16));
    const pb = [1, 3, 5].map(i => parseInt(b.substr(i, 2), 16));
    return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t)
      .toString(16).padStart(2, '0')).join('');
  }

  // Line filter: list or comma-separated string -> normalized names ("M10").
  static _parseLines(value) {
    const list = Array.isArray(value) ? value : String(value ?? '').split(',');
    return list.map(BvgDisplayCard._normLine).filter(Boolean);
  }

  static _normLine(line) {
    return String(line ?? '').toUpperCase().replace(/\s/g, '');
  }

  set hass(hass) {
    this._hass = hass;
    if (this._rendered) {
      this._updateCard();
    }
  }

  setConfig(config) {
    if (!config) {
      throw new Error("No configuration provided.");
    }

    this._config = { ...config };

    // Normalize entities: support string[] or {entity, walk_time}[]
    const rawEntities = BvgDisplayCard._asEntityList(config.entities ?? config.entity);
    this._entityConfigs = [];
    for (const e of rawEntities) {
      if (typeof e === 'string') {
        if (e) this._entityConfigs.push({ entity: e, walk_time: 0, lines: [] });
      } else if (e && typeof e === 'object' && e.entity) {
        this._entityConfigs.push({
          entity: e.entity,
          walk_time: Math.min(30, Math.max(0, parseInt(e.walk_time, 10) || 0)),
          lines: BvgDisplayCard._parseLines(e.lines),
        });
      }
      // Skip invalid/empty entries silently (editor intermediate states)
    }

    this._rows = Math.min(6, Math.max(1, parseInt(config.rows, 10) || 3));
    this._scrollSpeed = Math.max(250, parseInt(config.scroll_speed, 10) || 3000);
    this._scrollEnabled = config.scroll_enabled !== false;
    this._showPlatform = config.show_platform !== false;
    this._showHeader = config.show_header || false;
    this._frameStyle = config.frame_style || 'panel';
    this._style = STYLES.includes(config.style) ? config.style : DEFAULT_STYLE;
    this._theme = PLATFORM_THEMES[config.theme] ? config.theme : DEFAULT_THEME;
    this._colors = BvgDisplayCard._resolveColors(config);
    this._scrollIndex = 0;
    // Drop the cached snapshot: it belongs to the previous entity set and
    // must not be resurrected under a newly configured station.
    this._lastGood = null;

    // Re-render if already connected (config change via editor)
    if (this._rendered) {
      this._render();
      this._updateCard();
      this._restartScroll();
    }
  }

  connectedCallback() {
    // Reset visibility: it may still be false from a previous disconnect, and
    // both timers refuse to start while it is, which would leave the card
    // frozen when IntersectionObserver is unavailable.
    this._visible = true;
    this._render();
    this._rendered = true;
    this._updateCard();
    this._restartScroll();
    this._startTick();
    this._observeVisibility();
  }

  disconnectedCallback() {
    this._stopScroll();
    this._stopTick();
    this._unobserveVisibility();
  }

  // Countdown ticker: keeps "in N min" advancing between coordinator updates,
  // and also when scrolling is disabled (no other timer runs in that mode).
  _startTick() {
    this._stopTick();
    if (!this._visible) return;
    this._tickTimer = setInterval(() => this._updateCard(), TICK_INTERVAL_MS);
  }

  _stopTick() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  _observeVisibility() {
    if (typeof IntersectionObserver === 'undefined') return;
    this._unobserveVisibility();
    this._observer = new IntersectionObserver((entries) => {
      const wasVisible = this._visible;
      // Callbacks can be coalesced; the last entry is the current state.
      this._visible = entries[entries.length - 1].isIntersecting;
      if (this._visible && !wasVisible) {
        this._restartScroll();
        this._startTick();
        this._updateCard();
      } else if (!this._visible && wasVisible) {
        this._stopScroll();
        this._stopTick();
      }
    }, { threshold: 0.1 });
    this._observer.observe(this);
  }

  _unobserveVisibility() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
  }

  // Logical canvas geometry per style. bvg_platform is wider and uses taller
  // rows so line and minutes can be drawn in the double-size LED font.
  _layout() {
    return this._style === 'bvg_platform'
      ? { width: 176, rowHeight: PLATFORM_ROW_HEIGHT }
      : { width: 128, rowHeight: 10 };
  }

  _render() {
    const SCALE = 3;
    const isPlatform = this._style === 'bvg_platform';
    const { width, rowHeight } = this._layout();
    const htmlHeader = this._showHeader && !isPlatform;
    const logicalH = this._rows * rowHeight + 2 + (htmlHeader ? 10 : 0);
    const canvasW = width * SCALE;
    const canvasH = logicalH * SCALE;
    const frameClass = this._frameStyle === 'flat' ? 'bvg-panel-flat' : 'bvg-panel-frame';
    // Printed labels line up with the LED columns, so they are positioned in
    // percent of the canvas width.
    const zielLeft = (PLATFORM_DEST_X / width) * 100;
    const panelHtml = isPlatform ? `
        <div class="bvg-platform" style="${this._platformCssVars()}">
          <div class="bvg-platform-labels">
            <span>Linie</span>
            <span style="position:absolute;left:${zielLeft}%;">Ziel</span>
            <span style="margin-left:auto;">Abfahrt</span>
          </div>
          <div class="bvg-platform-led">
            <canvas class="bvg-canvas" width="${canvasW}" height="${canvasH}"></canvas>
          </div>
          <div class="bvg-platform-footer"></div>
        </div>` : `
        <div class="${frameClass}">
          <canvas class="bvg-canvas" width="${canvasW}" height="${canvasH}"></canvas>
        </div>`;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        ha-card {
          background: #1a1a1a;
          padding: 12px;
          border-radius: 12px;
          overflow: hidden;
        }
        .bvg-header {
          color: #ffcc00;
          font-family: monospace;
          font-size: 0.85rem;
          font-weight: bold;
          padding: 0 4px 8px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .bvg-panel-frame {
          background: #000;
          border: 3px solid #333;
          border-radius: 6px;
          padding: 4px;
          box-shadow: inset 0 0 10px rgba(0,0,0,0.8);
        }
        .bvg-panel-flat {
          background: #000;
          border-radius: 4px;
          padding: 2px;
        }
        /* The display housing is the card itself: no HA card background around it. */
        ha-card.bvg-card-platform {
          background: none;
          border: none;
          box-shadow: none;
          padding: 0;
          border-radius: 4px;
        }
        .bvg-platform {
          background: linear-gradient(var(--bvg-frame-top), var(--bvg-frame));
          border: 1px solid var(--bvg-frame-border);
          border-radius: 4px;
          overflow: hidden;
          padding: 4% 5% 0;
          container-type: inline-size;
          box-shadow: 0 2px 6px rgba(0,0,0,0.6);
        }
        .bvg-platform-labels {
          position: relative;
          display: flex;
          color: #efe4c4;
          font-family: "Helvetica Neue", Arial, sans-serif;
          font-weight: 600;
          font-size: clamp(0.75rem, 4.6cqw, 1.7rem);
          line-height: 1.2;
          padding-bottom: 0.15em;
        }
        .bvg-platform-led {
          background: var(--bvg-led-bg);
          border-radius: 2px;
          padding: 1.5%;
          box-shadow: inset 0 0 8px rgba(0,0,0,0.9);
        }
        .bvg-platform.no-footer {
          padding-bottom: 5%;
        }
        .bvg-platform-footer[hidden] {
          display: none;
        }
        .bvg-platform-footer {
          color: #cfc6a6;
          font-family: "Helvetica Neue", Arial, sans-serif;
          font-weight: 600;
          font-size: clamp(0.7rem, 3.8cqw, 1.4rem);
          line-height: 1.6;
          min-height: 1.6em;
          margin: 3% -5.3% 0;
          padding: 0 5%;
          background: var(--bvg-strip);
          border-top: 1px solid var(--bvg-frame-border);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .bvg-canvas {
          width: 100%;
          height: auto;
          display: block;
          image-rendering: pixelated;
          image-rendering: crisp-edges;
        }
        .bvg-error {
          color: #ff5050;
          font-size: 0.85rem;
          padding: 8px;
          font-family: monospace;
        }
      </style>
      <ha-card class="${isPlatform ? 'bvg-card-platform' : ''}">
        ${htmlHeader ? '<div class="bvg-header"></div>' : ''}
        ${panelHtml}
      </ha-card>
    `;
    this._canvas = this.shadowRoot.querySelector('.bvg-canvas');
    this._ctx = this._canvas.getContext('2d');
    this._headerEl = this.shadowRoot.querySelector('.bvg-header');
    this._footerEl = this.shadowRoot.querySelector('.bvg-platform-footer');
    this._offPattern = null;
  }

  // Housing shades derived from the frame colour, so one picker drives the
  // gradient, the edge and the printed strip.
  _platformCssVars() {
    const { frame, background } = this._colors;
    const mix = BvgDisplayCard._mix;
    return [
      `--bvg-frame:${frame}`,
      `--bvg-frame-top:${mix(frame, '#ffffff', 0.04)}`,
      `--bvg-frame-border:${mix(frame, '#ffffff', 0.12)}`,
      `--bvg-strip:${mix(frame, '#000000', 0.45)}`,
      `--bvg-led-bg:${background}`,
    ].join(';');
  }

  _restartScroll() {
    this._stopScroll();
    if (this._scrollEnabled && this._visible) {
      this._scrollTimer = setInterval(() => {
        this._scrollIndex++;
        this._updateCard();
      }, this._scrollSpeed);
    }
  }

  _startScroll() {
    this._restartScroll();
  }

  _stopScroll() {
    if (this._scrollTimer) {
      clearInterval(this._scrollTimer);
      this._scrollTimer = null;
    }
  }

  _updateCard() {
    if (!this._hass || !this._config || !this._canvas) return;

    // No entities configured yet (stub config or editor in progress)
    if (this._entityConfigs.length === 0) {
      this._renderLed([], []);
      return;
    }

    // Collect departures from all configured entities, filtering per-station walk time
    let allDepartures = [];
    let stationNames = [];
    let unavailable = [];

    for (const ec of this._entityConfigs) {
      const entity = this._hass.states[ec.entity];
      if (!entity) {
        unavailable.push(ec.entity);
        continue;
      }
      if (entity.state === 'unavailable' || entity.state === 'unknown') {
        unavailable.push(ec.entity);
        continue;
      }
      const attrs = entity.attributes || {};
      const deps = Array.isArray(attrs.departures) ? attrs.departures : [];
      const name = attrs.station_name || '';
      if (name && !stationNames.includes(name)) stationNames.push(name);
      // Recompute minutes locally so the countdown stays live between updates.
      // _walk is carried along so the filter can be re-applied to cached rows.
      const walkTime = ec.walk_time || 0;
      const lineFilter = ec.lines || [];
      const withMinutes = deps
        .filter(d => lineFilter.length === 0 ||
          lineFilter.includes(BvgDisplayCard._normLine(d.line)))
        .map(
        d => ({ ...d, minutes: this._minutesFor(d), _walk: walkTime })
      );
      allDepartures = allDepartures.concat(withMinutes.filter(d => this._isReachable(d)));
    }

    // Sort by minutes (soonest first)
    allDepartures.sort((a, b) => {
      const aMin = typeof a.minutes === 'number' ? a.minutes : 999;
      const bMin = typeof b.minutes === 'number' ? b.minutes : 999;
      return aMin - bMin;
    });

    // Remember the last usable render so a restart/reload (entities briefly
    // missing) doesn't immediately flash "Sensor nicht verfuegbar".
    // Only bridge when *every* configured station is down. If one station is
    // live and simply has nothing to show, its own state is the truth and
    // cached rows must not contradict it.
    const allDown = unavailable.length === this._entityConfigs.length;

    if (!allDown) {
      this._lastGood = { departures: allDepartures, stationNames, at: Date.now() };
    } else if (this._lastGood && Date.now() - this._lastGood.at < STALE_GRACE_MS) {
      allDepartures = this._lastGood.departures
        .filter(d => !this._hasDeparted(d))
        .map(d => ({ ...d, minutes: this._minutesFor(d) }))
        .filter(d => this._isReachable(d));
      stationNames = this._lastGood.stationNames;
      unavailable = [];
    }

    if (this._headerEl) {
      this._headerEl.textContent = stationNames.join(' / ');
    }

    this._stationNames = stationNames;
    this._renderLed(allDepartures, unavailable);
  }

  // Prefer the absolute departure time so the countdown ticks down locally;
  // fall back to the server-computed snapshot for older backends.
  _minutesFor(dep) {
    if (dep && dep.departure_time) {
      const ts = Date.parse(dep.departure_time);
      if (!isNaN(ts)) {
        return Math.max(0, Math.round((ts - Date.now()) / 60000));
      }
    }
    return dep && typeof dep.minutes === 'number' ? dep.minutes : null;
  }

  // Per-station walk time: hide departures that can no longer be reached.
  _isReachable(dep) {
    const walk = (dep && dep._walk) || 0;
    if (walk <= 0) return true;
    return typeof dep.minutes === 'number' && dep.minutes >= walk;
  }

  // True once a cached departure's absolute time has passed, so stale data
  // drops rows instead of pinning them at "jetzt" forever.
  _hasDeparted(dep) {
    if (!dep || !dep.departure_time) return false;
    const ts = Date.parse(dep.departure_time);
    return !isNaN(ts) && ts < Date.now();
  }

  _renderLed(departures, unavailable) {
    const ctx = this._ctx;
    const SCALE = 3;
    const W = this._canvas.width;
    const H = this._canvas.height;
    const isPlatform = this._style === 'bvg_platform';

    ctx.fillStyle = isPlatform ? this._colors.background : '#000';
    ctx.fillRect(0, 0, W, H);
    if (isPlatform) {
      // Unlit LEDs stay faintly visible, like on the real display.
      ctx.fillStyle = this._getOffPattern(ctx, SCALE);
      ctx.fillRect(0, 0, W, H);
      this._updatePlatformFooter(departures);
    }
    const top = 0;
    const fg = isPlatform ? this._colors.led : null;
    const bold = isPlatform;

    if (unavailable && unavailable.length > 0 && (!departures || departures.length === 0)) {
      this._drawString(ctx, 'Sensor nicht', 4, top + 2, fg || '#ff5050', SCALE, { bold });
      this._drawString(ctx, 'verfuegbar', 4, top + 12, fg || '#ff5050', SCALE, { bold });
      return;
    }

    if (!departures || departures.length === 0) {
      if (this._entityConfigs.length === 0) {
        this._drawString(ctx, 'Station hinzu-', 4, top + 2, fg || '#888888', SCALE, { bold });
        this._drawString(ctx, 'fuegen...', 4, top + 12, fg || '#888888', SCALE, { bold });
      } else {
        this._drawString(ctx, 'Keine Abfahrten', 4, top + 12, fg || '#ffcc00', SCALE, { bold });
      }
      return;
    }

    const rows = this._rows;
    const { rowHeight } = this._layout();
    const drawRow = isPlatform
      ? (dep, y) => this._renderPlatformRow(ctx, dep, y, SCALE)
      : (dep, y) => this._renderDepartureRow(ctx, dep, y, SCALE);

    if (!this._scrollEnabled) {
      // Static mode: show only the first N rows
      for (let i = 0; i < rows && i < departures.length; i++) {
        const y = top + i * rowHeight + 1;
        drawRow(departures[i], y);
      }
    } else {
      const maxStart = Math.max(1, departures.length - rows + 1);
      const startIdx = this._scrollIndex % maxStart;
      for (let i = 0; i < rows; i++) {
        const depIdx = startIdx + i;
        if (depIdx >= departures.length) break;
        const dep = departures[depIdx];
        const y = top + i * rowHeight + 1;
        drawRow(dep, y);
      }
    }
  }

  _renderDepartureRow(ctx, dep, y, scale) {
    if (!dep) return;
    const W = 128;
    // Line badge
    const lineColor = this._getLineColor(dep.product, dep.line);
    const lineText = (dep.line || '?').toUpperCase();
    const badgeWidth = lineText.length * 6 + 3;

    // Draw badge background
    for (let px = 0; px < badgeWidth; px++) {
      for (let py = 0; py < 9; py++) {
        ctx.fillStyle = lineColor;
        ctx.fillRect((px) * scale, (y + py) * scale, scale, scale);
      }
    }

    // Line text in badge (black or white depending on brightness)
    const rgb = this._hexToRgb(lineColor);
    const brightness = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
    const badgeTextColor = brightness > 128 ? '#000000' : '#ffffff';
    this._drawString(ctx, lineText, 2, y + 1, badgeTextColor, scale);

    // Time string (right-aligned)
    const timeStr = this._formatTime(dep);
    const timeColor = dep.cancelled ? '#ff0000' : (dep.delay > 0 ? '#ff5050' : '#ffcc00');
    const timeWidth = timeStr.length * 6;
    let timeX = W - timeWidth;

    // Platform (between time and direction, if enabled and available)
    let platformWidth = 0;
    if (this._showPlatform && dep.platform) {
      const platStr = dep.platform;
      platformWidth = platStr.length * 6 + 6; // extra gap
      const platX = W - timeWidth - platformWidth;
      this._drawString(ctx, platStr, platX, y + 1, '#888888', scale);
    }

    this._drawString(ctx, timeStr, timeX, y + 1, timeColor, scale);

    // Direction (white, between badge and time/platform)
    const dirX = badgeWidth + 2;
    const rightEdge = W - timeWidth - platformWidth - 2;
    const availableChars = Math.floor((rightEdge - dirX) / 6);
    let direction = dep.direction || '';
    if (direction.length > availableChars) {
      direction = direction.substring(0, Math.max(0, availableChars - 1)) + '.';
    }
    const dirColor = dep.cancelled ? '#666666' : '#ffffff';
    this._drawString(ctx, direction, dirX, y + 1, dirColor, scale);
  }

  // bvg_platform: big line | destination | big minutes, all in one LED colour.
  _renderPlatformRow(ctx, dep, y, scale) {
    if (!dep) return;
    const W = this._layout().width;
    const color = this._colors.led;
    const big = { size: 2, bold: true };
    const small = { bold: true };

    // Line: double size if it fits the column ("U7", "M10"), else normal.
    const line = (dep.line || '?').toUpperCase();
    const lineBig = this._textWidth(line, big) <= PLATFORM_DEST_X - 4;
    this._drawString(ctx, line, 1, y + (lineBig ? PLATFORM_BIG_Y : PLATFORM_SMALL_Y), color, scale,
      lineBig ? big : small);

    // Minutes: "2'" in the big font; text states in the normal font.
    let timeStr;
    let timeOpts = big;
    if (dep.cancelled) {
      timeStr = 'faellt aus';
      timeOpts = small;
    } else if (dep.minutes == null) {
      timeStr = '--';
    } else if (dep.minutes <= 0) {
      timeStr = 'sofort';
      timeOpts = small;
    } else {
      timeStr = String(dep.minutes);
    }
    // Minute mark: a small tick after the big digits, as on the real display.
    const tick = timeOpts === big && timeStr !== '--';
    const tickW = tick ? 4 : 0;
    const timeX = W - 1 - tickW - this._textWidth(timeStr, timeOpts);
    this._drawString(ctx, timeStr, timeX,
      y + (timeOpts === big ? PLATFORM_BIG_Y : PLATFORM_SMALL_Y),
      color, scale, timeOpts);
    if (tick) {
      this._drawString(ctx, "'", W - 1 - tickW, y + PLATFORM_BIG_Y - 1, color, scale, small);
    }

    const advance = this._textWidth('a', small) + 1;
    const chars = Math.floor((timeX - 6 - PLATFORM_DEST_X) / advance);
    this._drawString(ctx, this._fit(dep.direction || '', chars), PLATFORM_DEST_X,
      y + PLATFORM_SMALL_Y,
      color, scale, small);
  }

  // The printed strip under the display: "Gleis 2", optionally with the station.
  _updatePlatformFooter(departures) {
    if (!this._footerEl) return;
    const parts = [];
    if (this._showHeader && this._stationNames && this._stationNames.length) {
      parts.push(this._stationNames.join(' / '));
    }
    if (this._showPlatform) {
      const platforms = [...new Set((departures || []).map(d => d.platform).filter(Boolean))];
      if (platforms.length > 0 && platforms.length <= 3) {
        parts.push('Gleis ' + platforms.join(' / '));
      }
    }
    this._footerEl.textContent = parts.join(' \u00b7 ');
    // Nothing to print: drop the strip and close the housing below the LEDs.
    this._footerEl.hidden = parts.length === 0;
    this._footerEl.parentElement.classList.toggle('no-footer', parts.length === 0);
  }

  _fit(text, chars) {
    if (text.length <= chars) return text;
    return text.substring(0, Math.max(0, chars - 1)) + '.';
  }

  // One dim LED dot per logical pixel, used as the bvg_platform background.
  _getOffPattern(ctx, scale) {
    if (this._offPattern) return this._offPattern;
    const tile = document.createElement('canvas');
    tile.width = scale;
    tile.height = scale;
    const tctx = tile.getContext('2d');
    // Unlit LEDs: the background with a faint tint of the LED colour.
    tctx.fillStyle = BvgDisplayCard._mix(this._colors.background, this._colors.led, 0.1);
    tctx.beginPath();
    tctx.arc(scale / 2, scale / 2, scale * 0.42, 0, Math.PI * 2);
    tctx.fill();
    this._offPattern = ctx.createPattern(tile, 'repeat');
    return this._offPattern;
  }

  // Lights one logical pixel: a square on the LED matrix, a round dot on bvg_platform.
  _plot(ctx, x, y, color, scale) {
    ctx.fillStyle = color;
    if (this._style === 'bvg_platform') {
      ctx.beginPath();
      ctx.arc((x + 0.5) * scale, (y + 0.5) * scale, scale * 0.48, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }

  _formatTime(dep) {
    if (dep.cancelled) return 'X';
    const min = dep.minutes;
    if (min == null) return '--';
    if (min <= 0) return 'jetzt';
    if (min < 60) return min + ' min';
    return min + "'";
  }

  _hexToRgb(hex) {
    if (!hex || typeof hex !== 'string') return [255, 204, 0];
    const h = hex.replace('#', '');
    if (h.length !== 6) return [255, 204, 0];
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return [255, 204, 0];
    return [r, g, b];
  }

  _getLineColor(product, lineName) {
    // Specific line colors (Berlin)
    const name = (lineName || '').toLowerCase().replace(/\s/g, '');
    const specific = {
      'u1': '#7dad4c', 'u2': '#da421e', 'u3': '#007a5b',
      'u4': '#f0d722', 'u5': '#7e5330', 'u6': '#8c6dab',
      'u7': '#528dba', 'u8': '#224f86', 'u9': '#f3791d',
      's1': '#de4da4', 's2': '#005f27', 's3': '#0060aa',
      's41': '#a23b1e', 's42': '#c26a37', 's5': '#ff5900',
      's7': '#7760b0', 's8': '#55a822', 's9': '#8b1c62',
      's25': '#005f27', 's26': '#005f27', 's46': '#c26a37',
      'm1': '#be1414', 'm2': '#be1414', 'm4': '#be1414',
      'm5': '#be1414', 'm6': '#be1414', 'm8': '#be1414',
      'm10': '#be1414', 'm13': '#be1414', 'm17': '#be1414',
    };
    if (specific[name]) return specific[name];

    const colors = {
      suburban: '#008d4f',
      subway: '#0060aa',
      tram: '#be1414',
      bus: '#9b2790',
      ferry: '#0089b4',
      express: '#646464',
      regional: '#e30613',
    };
    return colors[product] || '#ffcc00';
  }

  // 5x7 bitmap font - column encoded (5 cols, 7 bits per col, LSB=top).
  // opts.size scales each font pixel to size x size LEDs; opts.bold doubles
  // every stroke one LED to the right.
  _drawString(ctx, text, x, y, color, scale, opts = {}) {
    const size = opts.size || 1;
    const advance = (5 * size) + (opts.bold ? 1 : 0) + size;
    let curX = x;
    for (let i = 0; i < text.length; i++) {
      this._drawChar(ctx, text[i], curX, y, color, scale, size);
      if (opts.bold) this._drawChar(ctx, text[i], curX + 1, y, color, scale, size);
      curX += advance;
    }
  }

  _textWidth(text, opts = {}) {
    const size = opts.size || 1;
    const advance = (5 * size) + (opts.bold ? 1 : 0) + size;
    return text.length ? text.length * advance - size : 0;
  }

  _drawChar(ctx, ch, x, y, color, scale, size = 1) {
    const glyph = FONT_5x7[ch] || FONT_5x7[ch.toUpperCase()] || FONT_5x7['?'];
    if (!glyph) return;
    for (let col = 0; col < 5; col++) {
      const colData = glyph[col];
      for (let row = 0; row < 7; row++) {
        if (colData & (1 << row)) {
          for (let dx = 0; dx < size; dx++) {
            for (let dy = 0; dy < size; dy++) {
              this._plot(ctx, x + col * size + dx, y + row * size + dy, color, scale);
            }
          }
        }
      }
    }
  }

  getCardSize() {
    if (this._style === 'bvg_platform') {
      // Taller rows plus the printed labels and footer strip.
      return Math.max(3, Math.ceil(this._rows * 1.6) + 2);
    }
    return Math.max(2, Math.ceil(this._rows * 1.2));
  }

  getGridOptions() {
    if (this._style === 'bvg_platform') {
      // Let the card take the height its fixed aspect ratio needs instead
      // of being squeezed into a fixed number of grid rows.
      return { rows: 'auto', columns: 12, min_columns: 6 };
    }
    return {
      rows: Math.max(2, this._rows + (this._style === 'bvg_platform' ? 2 : 0)),
      columns: 12,
      min_rows: 2,
      min_columns: 6,
    };
  }

  static getConfigElement() {
    return document.createElement('bvg-display-card-editor');
  }

  static getStubConfig(hass) {
    // Find a BVG departure sensor by its attributes, not its name: entity ids
    // are user-renameable and the bvg_ prefix is not guaranteed.
    const states = (hass && hass.states) || {};
    const entities = Object.keys(states).filter(e => isDeparturesSensor(states[e]));
    return {
      entities: entities.length > 0 ? [{ entity: entities[0], walk_time: 0 }] : [],
      rows: 3,
      scroll_speed: 3000,
      scroll_enabled: true,
      show_platform: true,
      show_header: false,
      frame_style: 'panel',
      style: DEFAULT_STYLE,
    };
  }
}

// 5x7 column-encoded font (5 columns per char, 7 bits per column, LSB = top row)
const FONT_5x7 = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00],
  '!': [0x00, 0x00, 0x5F, 0x00, 0x00],
  "'": [0x00, 0x05, 0x03, 0x00, 0x00],
  '(': [0x00, 0x1C, 0x22, 0x41, 0x00],
  ')': [0x00, 0x41, 0x22, 0x1C, 0x00],
  '+': [0x08, 0x08, 0x3E, 0x08, 0x08],
  '-': [0x08, 0x08, 0x08, 0x08, 0x08],
  '.': [0x00, 0x60, 0x60, 0x00, 0x00],
  '/': [0x20, 0x10, 0x08, 0x04, 0x02],
  '0': [0x3E, 0x51, 0x49, 0x45, 0x3E],
  '1': [0x00, 0x42, 0x7F, 0x40, 0x00],
  '2': [0x42, 0x61, 0x51, 0x49, 0x46],
  '3': [0x21, 0x41, 0x45, 0x4B, 0x31],
  '4': [0x18, 0x14, 0x12, 0x7F, 0x10],
  '5': [0x27, 0x45, 0x45, 0x45, 0x39],
  '6': [0x3C, 0x4A, 0x49, 0x49, 0x30],
  '7': [0x01, 0x71, 0x09, 0x05, 0x03],
  '8': [0x36, 0x49, 0x49, 0x49, 0x36],
  '9': [0x06, 0x49, 0x49, 0x29, 0x1E],
  ':': [0x00, 0x36, 0x36, 0x00, 0x00],
  '?': [0x02, 0x01, 0x51, 0x09, 0x06],
  'A': [0x7E, 0x11, 0x11, 0x11, 0x7E],
  'B': [0x7F, 0x49, 0x49, 0x49, 0x36],
  'C': [0x3E, 0x41, 0x41, 0x41, 0x22],
  'D': [0x7F, 0x41, 0x41, 0x22, 0x1C],
  'E': [0x7F, 0x49, 0x49, 0x49, 0x41],
  'F': [0x7F, 0x09, 0x09, 0x09, 0x01],
  'G': [0x3E, 0x41, 0x49, 0x49, 0x7A],
  'H': [0x7F, 0x08, 0x08, 0x08, 0x7F],
  'I': [0x00, 0x41, 0x7F, 0x41, 0x00],
  'J': [0x20, 0x40, 0x41, 0x3F, 0x01],
  'K': [0x7F, 0x08, 0x14, 0x22, 0x41],
  'L': [0x7F, 0x40, 0x40, 0x40, 0x40],
  'M': [0x7F, 0x02, 0x0C, 0x02, 0x7F],
  'N': [0x7F, 0x04, 0x08, 0x10, 0x7F],
  'O': [0x3E, 0x41, 0x41, 0x41, 0x3E],
  'P': [0x7F, 0x09, 0x09, 0x09, 0x06],
  'Q': [0x3E, 0x41, 0x51, 0x21, 0x5E],
  'R': [0x7F, 0x09, 0x19, 0x29, 0x46],
  'S': [0x46, 0x49, 0x49, 0x49, 0x31],
  'T': [0x01, 0x01, 0x7F, 0x01, 0x01],
  'U': [0x3F, 0x40, 0x40, 0x40, 0x3F],
  'V': [0x1F, 0x20, 0x40, 0x20, 0x1F],
  'W': [0x3F, 0x40, 0x38, 0x40, 0x3F],
  'X': [0x63, 0x14, 0x08, 0x14, 0x63],
  'Y': [0x07, 0x08, 0x70, 0x08, 0x07],
  'Z': [0x61, 0x51, 0x49, 0x45, 0x43],
  'a': [0x20, 0x54, 0x54, 0x54, 0x78],
  'b': [0x7F, 0x48, 0x44, 0x44, 0x38],
  'c': [0x38, 0x44, 0x44, 0x44, 0x20],
  'd': [0x38, 0x44, 0x44, 0x48, 0x7F],
  'e': [0x38, 0x54, 0x54, 0x54, 0x18],
  'f': [0x08, 0x7E, 0x09, 0x01, 0x02],
  'g': [0x0C, 0x52, 0x52, 0x52, 0x3E],
  'h': [0x7F, 0x08, 0x04, 0x04, 0x78],
  'i': [0x00, 0x44, 0x7D, 0x40, 0x00],
  'j': [0x20, 0x40, 0x44, 0x3D, 0x00],
  'k': [0x7F, 0x10, 0x28, 0x44, 0x00],
  'l': [0x00, 0x41, 0x7F, 0x40, 0x00],
  'm': [0x7C, 0x04, 0x18, 0x04, 0x78],
  'n': [0x7C, 0x08, 0x04, 0x04, 0x78],
  'o': [0x38, 0x44, 0x44, 0x44, 0x38],
  'p': [0x7C, 0x14, 0x14, 0x14, 0x08],
  'q': [0x08, 0x14, 0x14, 0x18, 0x7C],
  'r': [0x7C, 0x08, 0x04, 0x04, 0x08],
  's': [0x48, 0x54, 0x54, 0x54, 0x20],
  't': [0x04, 0x3F, 0x44, 0x40, 0x20],
  'u': [0x3C, 0x40, 0x40, 0x20, 0x7C],
  'v': [0x1C, 0x20, 0x40, 0x20, 0x1C],
  'w': [0x3C, 0x40, 0x30, 0x40, 0x3C],
  'x': [0x44, 0x28, 0x10, 0x28, 0x44],
  'y': [0x0C, 0x50, 0x50, 0x50, 0x3C],
  'z': [0x44, 0x64, 0x54, 0x4C, 0x44],
  // German umlauts
  '\u00C4': [0x7E, 0x11, 0x11, 0x11, 0x7E], // Ä
  '\u00D6': [0x3E, 0x41, 0x41, 0x41, 0x3E], // Ö
  '\u00DC': [0x3F, 0x40, 0x40, 0x40, 0x3F], // Ü
  '\u00E4': [0x20, 0x54, 0x54, 0x54, 0x78], // ä
  '\u00F6': [0x38, 0x44, 0x44, 0x44, 0x38], // ö
  '\u00FC': [0x3C, 0x40, 0x40, 0x20, 0x7C], // ü
  '\u00DF': [0x7E, 0x01, 0x49, 0x49, 0x36], // ß
};

// Guarded: an unguarded re-define throws NotSupportedError, which would abort
// the rest of this module and leave the editor unregistered and the card
// missing from the "Add card" picker.
if (!customElements.get('bvg-display-card')) {
  customElements.define('bvg-display-card', BvgDisplayCard);
}

/**
 * BVG Display Card Editor
 * Visual configuration UI for the Lovelace card
 */
class BvgDisplayCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
  }

  set hass(hass) {
    this._hass = hass;
    this._updateEntityPicker();
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
    // ha-entity-picker ships with the frontend but is only registered once a
    // built-in editor has pulled it in. Render immediately with the plain text
    // fallback, then swap in the autocomplete picker as soon as it exists.
    if (!customElements.get('ha-entity-picker')) {
      BvgDisplayCardEditor._loadEntityPicker().then((ok) => {
        if (ok) this._render();
      });
    }
  }

  static _loadEntityPicker() {
    if (BvgDisplayCardEditor._pickerPromise) {
      return BvgDisplayCardEditor._pickerPromise;
    }
    BvgDisplayCardEditor._pickerPromise = (async () => {
      if (customElements.get('ha-entity-picker')) return true;
      try {
        // Loading the built-in entities card editor registers ha-entity-picker.
        const helpers = await window.loadCardHelpers();
        const card = await helpers.createCardElement({ type: 'entities', entities: [] });
        if (card && card.constructor && card.constructor.getConfigElement) {
          await card.constructor.getConfigElement();
        }
      } catch (err) {
        return false;
      }
      return !!customElements.get('ha-entity-picker');
    })();
    return BvgDisplayCardEditor._pickerPromise;
  }

  _render() {
    if (this.shadowRoot) {
      this.shadowRoot.innerHTML = '';
    } else {
      this.attachShadow({ mode: 'open' });
    }

    // Same coercion as the card, plus a null guard: an empty YAML list item
    // ("- ") reaches here as null and used to crash the editor only.
    const rawEntities = BvgDisplayCard._asEntityList(
      this._config.entities ?? this._config.entity
    );
    const entities = rawEntities
      .filter(e => e !== null && e !== undefined && e !== '')
      .map(e => typeof e === 'string'
        ? { entity: e, walk_time: 0, lines: [] }
        : { entity: e.entity || '', walk_time: e.walk_time || 0,
            lines: BvgDisplayCard._parseLines(e.lines) });
    const rowsValue = this._config.rows || 3;
    const scrollValue = this._config.scroll_speed || 3000;
    const scrollEnabled = this._config.scroll_enabled !== false;
    const showPlatform = this._config.show_platform !== false;
    const showHeader = this._config.show_header || false;
    const frameStyle = this._config.frame_style || 'panel';
    const style = STYLES.includes(this._config.style) ? this._config.style : DEFAULT_STYLE;
    const isPlatform = style === 'bvg_platform';
    const theme = PLATFORM_THEMES[this._config.theme] ? this._config.theme : DEFAULT_THEME;
    const colors = BvgDisplayCard._resolveColors(this._config);
    const themeOptions = Object.entries(PLATFORM_THEMES).map(([id, t]) =>
      `<option value="${id}" ${id === theme ? 'selected' : ''}>${t.name}</option>`).join('');

    const usePicker = !!customElements.get('ha-entity-picker');
    const entityListHtml = entities.map((e, idx) => `
      <div class="entity-row">
        ${usePicker
          ? `<ha-entity-picker class="entity-input" data-idx="${idx}" allow-custom-entity></ha-entity-picker>`
          : `<input type="text" class="entity-input" data-idx="${idx}" placeholder="sensor.bvg_..._departures">`}
        <input type="number" class="walk-input" data-idx="${idx}" value="${e.walk_time}" min="0" max="30" placeholder="0" title="Walk time (min)">
        <button class="remove-btn" data-idx="${idx}" title="Remove">✕</button>
      </div>
      <input type="text" class="lines-input" data-idx="${idx}" placeholder="All lines (e.g. U7, M10)" title="Only show these lines (comma-separated, empty = all)">
    `).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        .form {
          display: flex;
          flex-direction: column;
          gap: 16px;
          padding: 16px 0;
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        label {
          font-weight: 500;
          font-size: 0.875rem;
          color: var(--primary-text-color);
        }
        .description {
          font-size: 0.75rem;
          color: var(--secondary-text-color);
        }
        select, input[type="text"], input[type="number"] {
          padding: 8px 12px;
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 8px;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          font-size: 0.95rem;
          outline: none;
          width: 100%;
          box-sizing: border-box;
        }
        select:focus, input:focus {
          border-color: var(--primary-color);
        }
        .toggle-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 4px 0;
        }
        .toggle-label {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        input[type="checkbox"] {
          width: 18px;
          height: 18px;
          accent-color: var(--primary-color);
        }
        .entity-row {
          display: flex;
          gap: 8px;
          align-items: center;
          margin-bottom: 8px;
        }
        .color-row {
          display: flex;
          gap: 16px;
          flex-wrap: wrap;
        }
        .color-pick {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: normal;
        }
        .color-pick input {
          width: 40px;
          height: 32px;
          padding: 0;
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 6px;
          background: none;
        }
        .lines-input {
          margin: -2px 0 12px;
        }
        .entity-row .entity-input {
          flex: 1;
        }
        .entity-row .walk-input {
          width: 60px;
          flex: none;
          text-align: center;
        }
        .remove-btn {
          background: none;
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 6px;
          color: var(--error-color, #db4437);
          cursor: pointer;
          padding: 6px 10px;
          font-size: 0.9rem;
        }
        .add-btn {
          background: none;
          border: 1px dashed var(--divider-color, #e0e0e0);
          border-radius: 8px;
          color: var(--primary-color);
          cursor: pointer;
          padding: 8px;
          font-size: 0.85rem;
          width: 100%;
        }
        .add-btn:hover {
          background: var(--secondary-background-color, #f5f5f5);
        }
      </style>
      <div class="form">
        <div class="field">
          <label>Stations</label>
          <span class="description">Add one or more BVG departure sensors. Set walk time (min) per station to hide unreachable departures, and optionally limit each station to certain lines.</span>
          <div style="display:flex;gap:8px;margin-bottom:4px;font-size:0.75rem;color:var(--secondary-text-color);">
            <span style="flex:1;">Entity</span>
            <span style="width:60px;text-align:center;">🚶 min</span>
            <span style="width:34px;"></span>
          </div>
          <div id="entity-list">${entityListHtml}</div>
          <button class="add-btn" id="add-entity">+ Add station</button>
        </div>
        <div class="field">
          <label>Display Style</label>
          <span class="description">Overall look of the departure board</span>
          <select id="style">
            <option value="led_matrix" ${style === 'led_matrix' ? 'selected' : ''}>LED matrix (colored lines)</option>
            <option value="bvg_platform" ${isPlatform ? 'selected' : ''}>BVG U-Bahn platform display</option>
          </select>
        </div>
        ${isPlatform ? `
        <div class="field">
          <label>Theme</label>
          <span class="description">Color preset. Choosing a theme resets the colors below.</span>
          <select id="theme">${themeOptions}</select>
        </div>
        <div class="field">
          <label>Colors</label>
          <div class="color-row">
            <label class="color-pick"><input type="color" id="frame_color" value="${colors.frame}"><span>Frame</span></label>
            <label class="color-pick"><input type="color" id="background_color" value="${colors.background}"><span>Background</span></label>
            <label class="color-pick"><input type="color" id="led_color" value="${colors.led}"><span>LEDs</span></label>
          </div>
        </div>` : ''}
        <div class="field">
          <label>Rows</label>
          <span class="description">Number of departure rows visible at once</span>
          <select id="rows">
            <option value="1" ${rowsValue === 1 ? 'selected' : ''}>1</option>
            <option value="2" ${rowsValue === 2 ? 'selected' : ''}>2</option>
            <option value="3" ${rowsValue === 3 ? 'selected' : ''}>3 (Default)</option>
            <option value="4" ${rowsValue === 4 ? 'selected' : ''}>4</option>
            <option value="5" ${rowsValue === 5 ? 'selected' : ''}>5</option>
            <option value="6" ${rowsValue === 6 ? 'selected' : ''}>6</option>
          </select>
        </div>
        <div class="field">
          <div class="toggle-row">
            <div class="toggle-label">
              <label>Scroll Enabled</label>
              <span class="description">Cycle through all departures. If off, only shows first rows.</span>
            </div>
            <input type="checkbox" id="scroll_enabled" ${scrollEnabled ? 'checked' : ''}>
          </div>
        </div>
        <div class="field">
          <label>Scroll Speed</label>
          <span class="description">How fast departures cycle (only when scroll is enabled)</span>
          <select id="scroll_speed">
            <option value="1500" ${scrollValue === 1500 ? 'selected' : ''}>1.5s (Fast)</option>
            <option value="2000" ${scrollValue === 2000 ? 'selected' : ''}>2s</option>
            <option value="3000" ${scrollValue === 3000 ? 'selected' : ''}>3s (Default)</option>
            <option value="4000" ${scrollValue === 4000 ? 'selected' : ''}>4s</option>
            <option value="5000" ${scrollValue === 5000 ? 'selected' : ''}>5s</option>
            <option value="8000" ${scrollValue === 8000 ? 'selected' : ''}>8s (Slow)</option>
          </select>
        </div>
        ${isPlatform ? '' : `<div class="field">
          <label>Frame Style</label>
          <span class="description">Appearance of the panel border</span>
          <select id="frame_style">
            <option value="panel" ${frameStyle === 'panel' ? 'selected' : ''}>Panel (3D frame)</option>
            <option value="flat" ${frameStyle === 'flat' ? 'selected' : ''}>Flat (minimal)</option>
          </select>
        </div>`}
        <div class="field">
          <div class="toggle-row">
            <div class="toggle-label">
              <label>Show Platform</label>
              <span class="description">Display platform/track number if available</span>
            </div>
            <input type="checkbox" id="show_platform" ${showPlatform ? 'checked' : ''}>
          </div>
        </div>
        <div class="field">
          <div class="toggle-row">
            <div class="toggle-label">
              <label>Show Station Header</label>
              <span class="description">${isPlatform ? 'Display station name(s) in the strip below the display' : 'Display station name(s) above the panel'}</span>
            </div>
            <input type="checkbox" id="show_header" ${showHeader ? 'checked' : ''}>
          </div>
        </div>
      </div>
    `;

    // Entity list events
    const setEntityAt = (i, value) => {
      const newEntities = [...entities];
      newEntities[i] = { ...newEntities[i], entity: value || '' };
      this._updateEntities(newEntities);
    };

    this.shadowRoot.querySelectorAll('.entity-input').forEach((input, idx) => {
      if (usePicker) {
        // Properties, not attributes: ha-entity-picker reads these off the
        // element, and this also keeps entity ids out of the HTML string.
        input.hass = this._hass;
        input.value = entities[idx].entity;
        input.includeDomains = ['sensor'];
        // Offer only actual BVG departure sensors rather than every sensor.
        input.entityFilter = isDeparturesSensor;
        input.allowCustomEntity = true;
        input.addEventListener('value-changed', (e) => {
          e.stopPropagation();
          setEntityAt(parseInt(input.dataset.idx, 10), e.detail && e.detail.value);
        });
      } else {
        input.value = entities[idx].entity;
        input.addEventListener('change', (e) => {
          setEntityAt(parseInt(e.target.dataset.idx, 10), e.target.value);
        });
      }
    });
    this.shadowRoot.querySelectorAll('.walk-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.idx);
        const newEntities = [...entities];
        newEntities[idx] = { ...newEntities[idx], walk_time: Math.max(0, Math.min(30, parseInt(e.target.value) || 0)) };
        this._updateEntities(newEntities);
      });
    });
    this.shadowRoot.querySelectorAll('.lines-input').forEach(input => {
      // Property, not attribute: keeps user text out of the HTML string.
      input.value = entities[parseInt(input.dataset.idx, 10)].lines.join(', ');
      input.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        const newEntities = [...entities];
        newEntities[idx] = { ...newEntities[idx], lines: BvgDisplayCard._parseLines(e.target.value) };
        this._updateEntities(newEntities);
      });
    });
    this.shadowRoot.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.idx);
        const newEntities = entities.filter((_, i) => i !== idx);
        this._updateEntities(newEntities);
      });
    });
    this.shadowRoot.getElementById('add-entity').addEventListener('click', () => {
      const newEntities = [...entities, { entity: '', walk_time: 0 }];
      this._updateEntities(newEntities);
    });

    this.shadowRoot.getElementById('style').addEventListener('change', (e) => {
      this._updateConfig('style', e.target.value);
      // Style-specific fields appear/disappear with the selection.
      this._render();
    });
    if (isPlatform) {
      this.shadowRoot.getElementById('theme').addEventListener('change', (e) => {
        const { frame_color, background_color, led_color, ...rest } = this._config;
        this._config = { ...rest, theme: e.target.value };
        this._fireConfigChanged();
        this._render();
      });
      ['frame_color', 'background_color', 'led_color'].forEach((key) => {
        this.shadowRoot.getElementById(key).addEventListener('change', (e) => {
          this._updateConfig(key, e.target.value);
        });
      });
    }
    this.shadowRoot.getElementById('rows').addEventListener('change', (e) => {
      this._updateConfig('rows', parseInt(e.target.value));
    });
    this.shadowRoot.getElementById('scroll_enabled').addEventListener('change', (e) => {
      this._updateConfig('scroll_enabled', e.target.checked);
    });
    this.shadowRoot.getElementById('scroll_speed').addEventListener('change', (e) => {
      this._updateConfig('scroll_speed', parseInt(e.target.value));
    });
    const frameSelect = this.shadowRoot.getElementById('frame_style');
    if (frameSelect) {
      frameSelect.addEventListener('change', (e) => {
        this._updateConfig('frame_style', e.target.value);
      });
    }
    this.shadowRoot.getElementById('show_platform').addEventListener('change', (e) => {
      this._updateConfig('show_platform', e.target.checked);
    });
    this.shadowRoot.getElementById('show_header').addEventListener('change', (e) => {
      this._updateConfig('show_header', e.target.checked);
    });
  }

  _updateEntities(entities) {
    // Leave `lines` out of the YAML when no filter is set.
    const cleaned = entities.map(({ lines, ...rest }) =>
      (lines && lines.length ? { ...rest, lines } : rest));
    this._config = { ...this._config, entities: cleaned };
    // Remove legacy single entity key
    delete this._config.entity;
    this._fireConfigChanged();
    this._render();
  }

  _updateConfig(key, value) {
    this._config = { ...this._config, [key]: value };
    this._fireConfigChanged();
  }

  _fireConfigChanged() {
    const event = new CustomEvent('config-changed', {
      detail: { config: this._config },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  _updateEntityPicker() {
    // hass usually arrives after the first render, and the pickers need it to
    // resolve entity names and populate their dropdown.
    if (!this.shadowRoot) return;
    this.shadowRoot.querySelectorAll('ha-entity-picker').forEach((picker) => {
      picker.hass = this._hass;
    });
  }
}

if (!customElements.get('bvg-display-card-editor')) {
  customElements.define('bvg-display-card-editor', BvgDisplayCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some(c => c.type === 'bvg-display-card')) {
  window.customCards.push({
    type: 'bvg-display-card',
    name: 'BVG Departure Display',
    description: 'LED matrix style BVG departure board',
    preview: true,
    documentationURL: 'https://github.com/jako-dev/homeassistant-bvg-display',
  });
}
