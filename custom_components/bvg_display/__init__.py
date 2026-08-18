"""BVG Departure Display integration."""

from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.frontend import add_extra_js_url
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

PLATFORMS = ["sensor"]

CARD_URL = "/bvg-display/bvg-display-card.js"
CARD_PATH = Path(__file__).parent / "www" / "bvg-display-card.js"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the BVG Display integration (register frontend card)."""
    # Registering the same static route twice raises inside aiohttp and would
    # fail the whole domain, so make this idempotent even if component setup
    # is ever retried.
    if hass.data.get(DOMAIN):
        return True
    hass.data[DOMAIN] = True

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


def _coordinator_options(entry: ConfigEntry) -> dict:
    """Options the coordinator consumes.

    Defined once so initial setup and the in-place options update can't drift
    apart when a new option is added.
    """
    return {
        "departure_count": entry.options.get(
            CONF_DEPARTURE_COUNT, DEFAULT_DEPARTURE_COUNT
        ),
        "filters": entry.options.get(CONF_FILTERS, {}),
    }


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up BVG Display from a config entry."""
    coordinator = BvgDepartureCoordinator(
        hass,
        entry,
        station_id=entry.data[CONF_STATION_ID],
        station_name=entry.data[CONF_STATION_NAME],
        **_coordinator_options(entry),
    )

    # Deliberately async_refresh() and not async_config_entry_first_refresh():
    # the latter raises ConfigEntryNotReady when the community-run BVG API is
    # slow or down, which fails the whole entry, removes both sensors and puts
    # the entry into a backoff retry (10s, 20s, 40s, 80s...). Bringing the
    # entities up anyway means a failed first poll self-heals on the next
    # 30s cycle instead.
    await coordinator.async_refresh()

    entry.runtime_data = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle options update.

    Applied in place rather than via async_reload: a reload tears down the
    entities and re-runs the blocking first refresh, so a slow or failing BVG
    API at that moment leaves the entry in an error state with the card
    showing "Sensor nicht verfuegbar".
    """
    coordinator: BvgDepartureCoordinator | None = getattr(entry, "runtime_data", None)
    if coordinator is None:
        await hass.config_entries.async_reload(entry.entry_id)
        return

    coordinator.update_options(**_coordinator_options(entry))
    await coordinator.async_request_refresh()


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
