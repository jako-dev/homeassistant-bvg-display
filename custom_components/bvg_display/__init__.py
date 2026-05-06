"""BVG Departure Display integration."""

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

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


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up BVG Display from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    departure_count = entry.options.get(CONF_DEPARTURE_COUNT, DEFAULT_DEPARTURE_COUNT)
    filters = entry.options.get(CONF_FILTERS, {})

    coordinator = BvgDepartureCoordinator(
        hass,
        station_id=entry.data[CONF_STATION_ID],
        station_name=entry.data[CONF_STATION_NAME],
        departure_count=departure_count,
        filters=filters,
    )

    await coordinator.async_config_entry_first_refresh()

    hass.data[DOMAIN][entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Register the custom Lovelace card
    hass.http.register_static_path(
        "/bvg-display/bvg-display-card.js",
        str(Path(__file__).parent / "www" / "bvg-display-card.js"),
        cache_headers=False,
    )

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle options update."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id)
    return unload_ok
