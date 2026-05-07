# BVG Departure Display for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)

A custom Home Assistant integration that shows real-time Berlin public transport (BVG/VBB) departures — complete with a pixel-art LED matrix Lovelace card.

![LED Matrix Card Preview](docs/card-preview.png)

## Features

- **Real-time departures** from any BVG/VBB station
- **Multi-station support** — combine multiple stations in one card
- **Per-station walk time** — hide departures you can't reach in time
- **Custom Lovelace card** with authentic LED matrix panel look
- **UI config flow** — add stations via Settings > Integrations
- **Visual card editor** — configure everything from the dashboard UI
- **Transport filters** — show/hide S-Bahn, U-Bahn, Tram, Bus, Ferry, IC/ICE, Regional
- **Configurable departure count** (1, 3, 6, 9, 12, 15)
- **Auto-scrolling** through departures (pauses when card is not visible)
- **Color-coded lines** by transport type
- **Delay indicators** — green (on time), orange (delayed), red (cancelled)
- **Unavailable sensor detection** — shows error state on the LED display
- **Options flow** — reconfigure filters and count without removing the integration

## Installation

### HACS (Recommended)

1. Open HACS in Home Assistant
2. Click the three dots menu → **Custom repositories**
3. Add this repository URL: `https://github.com/jako-dev/homeassistant-bvg-display`
4. Category: **Integration**
5. Click **Add** → find "BVG Departure Display" → **Download**
6. Restart Home Assistant

### Manual

1. Copy the `custom_components/bvg_display` folder into your `config/custom_components/` directory
2. Restart Home Assistant

## Setup

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for **"BVG Departure Display"**
3. Enter a station name (e.g. "Alexanderplatz")
4. Select your station from the results
5. Configure departure count and transport filters
6. Done! Two sensor entities are created per station.

## Entities

Each station creates two sensors:

| Entity | Description |
|--------|-------------|
| `sensor.bvg_<station>_next` | Next departure as human-readable text |
| `sensor.bvg_<station>_departures` | All departures with full details in attributes |

### Attributes of `*_departures` sensor

```yaml
station_name: "S+U Alexanderplatz"
departures:
  - line: "U2"
    direction: "Pankow"
    product: "subway"
    delay: 0
    platform: "1"
    cancelled: false
    minutes: 2
  - line: "S7"
    direction: "Ahrensfelde"
    product: "suburban"
    delay: 60
    platform: "3"
    cancelled: false
    minutes: 5
```

## Lovelace Card

### Register the card resource

The card resource is registered automatically when the integration is loaded. If you need to add it manually:

**Settings → Dashboards → Resources → Add Resource:**

```
URL: /bvg-display/bvg-display-card.js
Type: JavaScript Module
```

### Basic card configuration

```yaml
type: custom:bvg-display-card
entities:
  - sensor.bvg_alexanderplatz_departures
rows: 3
scroll_speed: 3000
scroll_enabled: true
```

### Multi-station with walk time

```yaml
type: custom:bvg-display-card
entities:
  - entity: sensor.bvg_bersarinplatz_berlin_departures
    walk_time: 5
  - entity: sensor.bvg_u_weberwiese_berlin_departures
    walk_time: 9
  - entity: sensor.bvg_am_friedrichshain_berlin_departures
    walk_time: 18
rows: 6
scroll_speed: 3000
scroll_enabled: false
show_platform: false
show_header: false
frame_style: flat
```

Departures from all stations are merged and sorted by time. Each station's `walk_time` (in minutes) filters out departures you can no longer reach on foot.

### Card Options

| Option | Default | Description |
|--------|---------|-------------|
| `entities` | (required) | List of `*_departures` sensor entities (string or `{entity, walk_time}` object) |
| `entity` | — | Single entity (legacy, use `entities` instead) |
| `rows` | `3` | Number of departure rows to display (1–6) |
| `scroll_enabled` | `true` | Enable/disable auto-scrolling through departures |
| `scroll_speed` | `3000` | Auto-scroll interval in milliseconds |
| `show_platform` | `true` | Show platform/track number |
| `show_header` | `false` | Display station name(s) above the panel |
| `frame_style` | `panel` | Panel border style: `panel` (3D frame) or `flat` (minimal) |

### Entity format

Entities can be specified as plain strings (no walk time filtering) or objects:

```yaml
entities:
  # Simple (no walk time filtering)
  - sensor.bvg_alexanderplatz_departures

  # With walk time
  - entity: sensor.bvg_alexanderplatz_departures
    walk_time: 5
```

## Options / Reconfiguration

To change filters or departure count after setup:

1. Go to **Settings → Devices & Services**
2. Find **BVG Departure Display**
3. Click **Configure** on the station entry
4. Adjust settings and save

## API

Uses the public [v6.bvg.transport.rest](https://v6.bvg.transport.rest/) API:
- No API key required
- Rate limit: 100 requests/minute
- Polling interval: 30 seconds (respects HA update coordinator)
- Uses Home Assistant's shared HTTP session (no connection leaks)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Config entry already been setup" | Fixed in v1.5 — update to latest version. Entry reload races are now guarded. |
| No departures shown | BVG API may be temporarily down. Entry will auto-retry (ConfigEntryNotReady). |
| Card not rendering | Make sure the resource is registered (usually automatic). Check browser console. |
| Entity unavailable | Check HA logs for API errors; verify internet connectivity |
| Card shows "Sensor nicht verfuegbar" | The configured entity doesn't exist or is in `unavailable` state |
| Stale data | The coordinator polls every 30s. Check `last_updated` on the entity |

## License

MIT
