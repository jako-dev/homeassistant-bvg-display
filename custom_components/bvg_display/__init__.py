"""BVG Departure Display integration."""

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady

from .const import (
    CONF_DEPARTURE_COUNT,
    CONF_FILTERS,
    CONF_STATION_ID,
    CONF_STATION_NAME,
    DEFAULT_DEPARTURE_COUNT,
    DOMAIN,
)
from .coordinator import BvgDepartureCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor"]

CARD_URL = "/bvg-display/bvg-display-card.js"
CARD_PATH = Path(__file__).parent / "www" / "bvg-display-card.js"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the BVG Display integration (register frontend card)."""
    hass.data.setdefault(DOMAIN, {})

    # Register the Lovelace card static path immediately so the frontend
    # can always find it, regardless of config entry load state.
    await hass.http.async_register_static_paths([
        StaticPathConfig(
            CARD_URL,
            str(CARD_PATH),
            cache_headers=False,
        )
    ])
    add_extra_js_url(hass, CARD_URL)

    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up BVG Display from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    # Guard against duplicate setup (race condition during reload)
    if entry.entry_id in hass.data[DOMAIN]:
        _LOGGER.debug("Entry %s already set up, skipping", entry.entry_id)
        return True

    departure_count = entry.options.get(CONF_DEPARTURE_COUNT, DEFAULT_DEPARTURE_COUNT)
    filters = entry.options.get(CONF_FILTERS, {})

    coordinator = BvgDepartureCoordinator(
        hass,
        station_id=entry.data[CONF_STATION_ID],
        station_name=entry.data[CONF_STATION_NAME],
        departure_count=departure_count,
        filters=filters,
    )

    try:
        await coordinator.async_config_entry_first_refresh()
    except Exception as err:
        raise ConfigEntryNotReady(
            f"Failed to fetch initial data for {entry.data[CONF_STATION_NAME]}: {err}"
        ) from err

    hass.data[DOMAIN][entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle options update."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok
