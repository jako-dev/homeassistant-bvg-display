/**
 * BVG Display Card - LED Matrix Style Lovelace Card
 * Renders BVG departures as a pixel-art LED panel
 */

class BvgDisplayCard extends HTMLElement {
  static get properties() {
    return {
      hass: {},
      config: {},
    };
  }

  set hass(hass) {
    this._hass = hass;
    this._updateCard();
  }

  setConfig(config) {
    if (!config.entity) {
      throw new Error("Please define an entity (sensor.bvg_*_departures)");
    }
    this._config = config;
    this._rows = config.rows || 4;
    this._scrollSpeed = config.scroll_speed || 3000;
    this._scrollIndex = 0;
    this._rendered = false;
  }

  connectedCallback() {
    if (!this._rendered) {
      this._render();
      this._rendered = true;
    }
    this._startScroll();
  }

  disconnectedCallback() {
    this._stopScroll();
  }

  _render() {
    this.innerHTML = `
      <ha-card>
        <div class="bvg-panel-frame">
          <canvas class="bvg-canvas" width="384" height="96"></canvas>
        </div>
      </ha-card>
      <style>
        ha-card {
          background: #1a1a1a;
          padding: 12px;
          border-radius: 12px;
        }
        .bvg-panel-frame {
          background: #000;
          border: 3px solid #333;
          border-radius: 6px;
          padding: 4px;
          box-shadow: inset 0 0 10px rgba(0,0,0,0.8);
        }
        .bvg-canvas {
          width: 100%;
          height: auto;
          display: block;
          image-rendering: pixelated;
          image-rendering: crisp-edges;
        }
      </style>
    `;
    this._canvas = this.querySelector('.bvg-canvas');
    this._ctx = this._canvas.getContext('2d');
  }

  _startScroll() {
    this._stopScroll();
    this._scrollTimer = setInterval(() => {
      this._scrollIndex++;
      this._updateCard();
    }, this._scrollSpeed);
  }

  _stopScroll() {
    if (this._scrollTimer) {
      clearInterval(this._scrollTimer);
      this._scrollTimer = null;
    }
  }

  _updateCard() {
    if (!this._hass || !this._config || !this._canvas) return;

    const entity = this._hass.states[this._config.entity];
    if (!entity) return;

    const departures = entity.attributes.departures || [];
    const stationName = entity.attributes.station_name || '';

    this._renderLed(departures, stationName);
  }

  _renderLed(departures, stationName) {
    const ctx = this._ctx;
    const W = 384;  // 128 * 3 (scaled)
    const H = 96;   // 32 * 3 (scaled)
    const SCALE = 3;
    const LOGICAL_W = 128;
    const LOGICAL_H = 32;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (!departures || departures.length === 0) {
      this._drawString(ctx, 'Keine Abfahrten', 4, 12, '#ffcc00', SCALE);
      return;
    }

    const rows = Math.min(this._rows, 3);
    const rowHeight = 10;
    const startIdx = this._scrollIndex % Math.max(1, departures.length - rows + 1);

    for (let i = 0; i < rows; i++) {
      const depIdx = startIdx + i;
      if (depIdx >= departures.length) break;
      const dep = departures[depIdx];
      const y = i * rowHeight + 2;

      this._renderDepartureRow(ctx, dep, y, SCALE);
    }
  }

  _renderDepartureRow(ctx, dep, y, scale) {
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
    const timeX = W - timeWidth;
    this._drawString(ctx, timeStr, timeX, y + 1, timeColor, scale);

    // Direction (white, between badge and time)
    const dirX = badgeWidth + 2;
    const availableChars = Math.floor((timeX - dirX - 2) / 6);
    let direction = dep.direction || '';
    if (direction.length > availableChars) {
      direction = direction.substring(0, Math.max(0, availableChars - 1)) + '.';
    }
    const dirColor = dep.cancelled ? '#666666' : '#ffffff';
    this._drawString(ctx, direction, dirX, y + 1, dirColor, scale);
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
    const h = hex.replace('#', '');
    return [parseInt(h.substring(0,2), 16), parseInt(h.substring(2,4), 16), parseInt(h.substring(4,6), 16)];
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

  // 5x7 bitmap font - column encoded (5 cols, 7 bits per col, LSB=top)
  _drawString(ctx, text, x, y, color, scale) {
    let curX = x;
    for (let i = 0; i < text.length; i++) {
      this._drawChar(ctx, text[i], curX, y, color, scale);
      curX += 6; // 5px char + 1px gap
    }
  }

  _drawChar(ctx, ch, x, y, color, scale) {
    const glyph = FONT_5x7[ch] || FONT_5x7[ch.toUpperCase()] || FONT_5x7['?'];
    if (!glyph) return;
    for (let col = 0; col < 5; col++) {
      const colData = glyph[col];
      for (let row = 0; row < 7; row++) {
        if (colData & (1 << row)) {
          ctx.fillStyle = color;
          ctx.fillRect((x + col) * scale, (y + row) * scale, scale, scale);
        }
      }
    }
  }

  getCardSize() {
    return 3;
  }

  static getConfigElement() {
    return document.createElement('bvg-display-card-editor');
  }

  static getStubConfig() {
    return { entity: '', rows: 3, scroll_speed: 3000 };
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

customElements.define('bvg-display-card', BvgDisplayCard);

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
  }

  _render() {
    if (this.shadowRoot) {
      this.shadowRoot.innerHTML = '';
    } else {
      this.attachShadow({ mode: 'open' });
    }

    const entityValue = this._config.entity || '';
    const rowsValue = this._config.rows || 3;
    const scrollValue = this._config.scroll_speed || 3000;

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
        select, input {
          padding: 8px 12px;
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 8px;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          font-size: 0.95rem;
          outline: none;
        }
        select:focus, input:focus {
          border-color: var(--primary-color);
        }
        .entity-picker {
          position: relative;
        }
        input[type="text"] {
          width: 100%;
          box-sizing: border-box;
        }
        .preview-hint {
          background: var(--secondary-background-color, #f5f5f5);
          border-radius: 8px;
          padding: 12px;
          font-size: 0.8rem;
          color: var(--secondary-text-color);
        }
      </style>
      <div class="form">
        <div class="field">
          <label for="entity">Entity</label>
          <span class="description">Select a BVG departures sensor (sensor.bvg_*_departures)</span>
          <input type="text" id="entity" value="${entityValue}" placeholder="sensor.bvg_..._departures">
        </div>
        <div class="field">
          <label for="rows">Rows</label>
          <span class="description">Number of departure rows shown on the panel (1–4)</span>
          <select id="rows">
            <option value="1" ${rowsValue === 1 ? 'selected' : ''}>1</option>
            <option value="2" ${rowsValue === 2 ? 'selected' : ''}>2</option>
            <option value="3" ${rowsValue === 3 ? 'selected' : ''}>3</option>
            <option value="4" ${rowsValue === 4 ? 'selected' : ''}>4</option>
          </select>
        </div>
        <div class="field">
          <label for="scroll_speed">Scroll Speed (ms)</label>
          <span class="description">How fast departures cycle (in milliseconds)</span>
          <select id="scroll_speed">
            <option value="1500" ${scrollValue === 1500 ? 'selected' : ''}>1500 (Fast)</option>
            <option value="2000" ${scrollValue === 2000 ? 'selected' : ''}>2000</option>
            <option value="3000" ${scrollValue === 3000 ? 'selected' : ''}>3000 (Default)</option>
            <option value="4000" ${scrollValue === 4000 ? 'selected' : ''}>4000</option>
            <option value="5000" ${scrollValue === 5000 ? 'selected' : ''}>5000 (Slow)</option>
          </select>
        </div>
        <div class="preview-hint">
          💡 The card renders departures as a pixel-art LED matrix panel with auto-scrolling and color-coded transit lines.
        </div>
      </div>
    `;

    this.shadowRoot.getElementById('entity').addEventListener('change', (e) => {
      this._updateConfig('entity', e.target.value);
    });
    this.shadowRoot.getElementById('entity').addEventListener('input', (e) => {
      this._updateConfig('entity', e.target.value);
    });
    this.shadowRoot.getElementById('rows').addEventListener('change', (e) => {
      this._updateConfig('rows', parseInt(e.target.value));
    });
    this.shadowRoot.getElementById('scroll_speed').addEventListener('change', (e) => {
      this._updateConfig('scroll_speed', parseInt(e.target.value));
    });
  }

  _updateConfig(key, value) {
    this._config = { ...this._config, [key]: value };
    const event = new CustomEvent('config-changed', {
      detail: { config: this._config },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  _updateEntityPicker() {
    // If hass is available, we could enhance with autocomplete
    // For now the text input works with any entity ID
  }
}

customElements.define('bvg-display-card-editor', BvgDisplayCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'bvg-display-card',
  name: 'BVG Departure Display',
  description: 'LED matrix style BVG departure board',
  preview: true,
  documentationURL: 'https://github.com/jako-dev/homeassistant-bvg-display',
});
