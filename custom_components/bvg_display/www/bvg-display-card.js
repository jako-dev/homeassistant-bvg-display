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
    // Line badge
    const lineColor = this._getLineColor(dep.product);
    const lineText = dep.line || '?';
    const lineWidth = Math.max(lineText.length * 5 + 2, 14);

    // Draw badge background
    for (let px = 0; px < lineWidth; px++) {
      for (let py = 0; py < 8; py++) {
        ctx.fillStyle = lineColor;
        ctx.fillRect((1 + px) * scale, (y + py) * scale, scale, scale);
      }
    }

    // Line text on badge
    this._drawString(ctx, lineText, 2, y + 1, '#000', scale);

    // Direction
    const dirX = lineWidth + 4;
    const direction = this._truncate(dep.direction, 16);
    this._drawString(ctx, direction, dirX, y + 1, '#ffcc00', scale);

    // Minutes
    const minStr = dep.cancelled ? 'X' : (dep.minutes != null ? String(dep.minutes) : '--');
    const minColor = dep.cancelled ? '#ff3333' : (dep.delay > 0 ? '#ff6600' : '#00ff00');
    const minX = 128 - (minStr.length * 5 + 8);
    this._drawString(ctx, minStr, minX, y + 1, minColor, scale);

    // "min" label
    this._drawString(ctx, 'min', 128 - 15, y + 1, '#888888', scale);
  }

  _getLineColor(product) {
    const colors = {
      suburban: '#009933',
      subway: '#0066cc',
      tram: '#cc0000',
      bus: '#993399',
      ferry: '#009999',
      express: '#666666',
      regional: '#ff6600',
    };
    return colors[product] || '#ffcc00';
  }

  _truncate(str, maxLen) {
    if (!str) return '';
    return str.length > maxLen ? str.substring(0, maxLen - 1) + '.' : str;
  }

  // 5x7 bitmap font (subset for LED look)
  _drawString(ctx, text, x, y, color, scale) {
    const chars = text.toUpperCase();
    let curX = x;
    for (let i = 0; i < chars.length; i++) {
      this._drawChar(ctx, chars[i], curX, y, color, scale);
      curX += 5;
    }
  }

  _drawChar(ctx, ch, x, y, color, scale) {
    const bitmap = FONT_DATA[ch] || FONT_DATA['?'];
    if (!bitmap) return;
    for (let row = 0; row < 7; row++) {
      const rowData = bitmap[row] || 0;
      for (let col = 0; col < 4; col++) {
        if (rowData & (1 << (3 - col))) {
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

// 4x7 pixel font data
const FONT_DATA = {
  ' ': [0b0000, 0b0000, 0b0000, 0b0000, 0b0000, 0b0000, 0b0000],
  '0': [0b0110, 0b1001, 0b1011, 0b1101, 0b1001, 0b1001, 0b0110],
  '1': [0b0010, 0b0110, 0b0010, 0b0010, 0b0010, 0b0010, 0b0111],
  '2': [0b0110, 0b1001, 0b0001, 0b0010, 0b0100, 0b1000, 0b1111],
  '3': [0b0110, 0b1001, 0b0001, 0b0110, 0b0001, 0b1001, 0b0110],
  '4': [0b1001, 0b1001, 0b1001, 0b1111, 0b0001, 0b0001, 0b0001],
  '5': [0b1111, 0b1000, 0b1110, 0b0001, 0b0001, 0b1001, 0b0110],
  '6': [0b0110, 0b1000, 0b1000, 0b1110, 0b1001, 0b1001, 0b0110],
  '7': [0b1111, 0b0001, 0b0010, 0b0010, 0b0100, 0b0100, 0b0100],
  '8': [0b0110, 0b1001, 0b1001, 0b0110, 0b1001, 0b1001, 0b0110],
  '9': [0b0110, 0b1001, 0b1001, 0b0111, 0b0001, 0b0001, 0b0110],
  'A': [0b0110, 0b1001, 0b1001, 0b1111, 0b1001, 0b1001, 0b1001],
  'B': [0b1110, 0b1001, 0b1001, 0b1110, 0b1001, 0b1001, 0b1110],
  'C': [0b0110, 0b1001, 0b1000, 0b1000, 0b1000, 0b1001, 0b0110],
  'D': [0b1110, 0b1001, 0b1001, 0b1001, 0b1001, 0b1001, 0b1110],
  'E': [0b1111, 0b1000, 0b1000, 0b1110, 0b1000, 0b1000, 0b1111],
  'F': [0b1111, 0b1000, 0b1000, 0b1110, 0b1000, 0b1000, 0b1000],
  'G': [0b0110, 0b1001, 0b1000, 0b1011, 0b1001, 0b1001, 0b0110],
  'H': [0b1001, 0b1001, 0b1001, 0b1111, 0b1001, 0b1001, 0b1001],
  'I': [0b0111, 0b0010, 0b0010, 0b0010, 0b0010, 0b0010, 0b0111],
  'J': [0b0001, 0b0001, 0b0001, 0b0001, 0b0001, 0b1001, 0b0110],
  'K': [0b1001, 0b1010, 0b1100, 0b1000, 0b1100, 0b1010, 0b1001],
  'L': [0b1000, 0b1000, 0b1000, 0b1000, 0b1000, 0b1000, 0b1111],
  'M': [0b1001, 0b1111, 0b1111, 0b1001, 0b1001, 0b1001, 0b1001],
  'N': [0b1001, 0b1101, 0b1101, 0b1011, 0b1011, 0b1001, 0b1001],
  'O': [0b0110, 0b1001, 0b1001, 0b1001, 0b1001, 0b1001, 0b0110],
  'P': [0b1110, 0b1001, 0b1001, 0b1110, 0b1000, 0b1000, 0b1000],
  'Q': [0b0110, 0b1001, 0b1001, 0b1001, 0b1011, 0b1010, 0b0111],
  'R': [0b1110, 0b1001, 0b1001, 0b1110, 0b1010, 0b1001, 0b1001],
  'S': [0b0110, 0b1001, 0b1000, 0b0110, 0b0001, 0b1001, 0b0110],
  'T': [0b1111, 0b0010, 0b0010, 0b0010, 0b0010, 0b0010, 0b0010],
  'U': [0b1001, 0b1001, 0b1001, 0b1001, 0b1001, 0b1001, 0b0110],
  'V': [0b1001, 0b1001, 0b1001, 0b1001, 0b1001, 0b0110, 0b0010],
  'W': [0b1001, 0b1001, 0b1001, 0b1001, 0b1111, 0b1111, 0b1001],
  'X': [0b1001, 0b1001, 0b0110, 0b0110, 0b0110, 0b1001, 0b1001],
  'Y': [0b1001, 0b1001, 0b0110, 0b0010, 0b0010, 0b0010, 0b0010],
  'Z': [0b1111, 0b0001, 0b0010, 0b0100, 0b1000, 0b1000, 0b1111],
  '-': [0b0000, 0b0000, 0b0000, 0b1111, 0b0000, 0b0000, 0b0000],
  '.': [0b0000, 0b0000, 0b0000, 0b0000, 0b0000, 0b0000, 0b0010],
  '/': [0b0001, 0b0001, 0b0010, 0b0010, 0b0100, 0b0100, 0b1000],
  ':': [0b0000, 0b0010, 0b0010, 0b0000, 0b0010, 0b0010, 0b0000],
  '?': [0b0110, 0b1001, 0b0001, 0b0010, 0b0010, 0b0000, 0b0010],
  '!': [0b0010, 0b0010, 0b0010, 0b0010, 0b0010, 0b0000, 0b0010],
  '+': [0b0000, 0b0010, 0b0010, 0b0111, 0b0010, 0b0010, 0b0000],
  '(': [0b0010, 0b0100, 0b0100, 0b0100, 0b0100, 0b0100, 0b0010],
  ')': [0b0100, 0b0010, 0b0010, 0b0010, 0b0010, 0b0010, 0b0100],
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
