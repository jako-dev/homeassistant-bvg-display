"""BVG Departure Display integration."""

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

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
    # Registering the same static route twice raises inside aiohttp and would
    # fail the whole domain, so make this idempotent even if component setup
    # is ever retried.
    if hass.data.get(DOMAIN):
        return True
    hass.data[DOMAIN] = True

    # Serve the card. cache_headers stays at its default (True) so repeat loads
    # avoid a network round trip; the ?v= below keeps upgrades from serving a
    # stale copy (the query string is not part of aiohttp route matching).
    await hass.http.async_register_static_paths([
        StaticPathConfig(CARD_URL, str(CARD_PATH))
    ])

    integration = await async_get_integration(hass, DOMAIN)
    card_url = f"{CARD_URL}?v={integration.version or 'dev'}"

    # Two registration paths on purpose, both pointing at the identical URL so
    # the browser's module map runs the file only once:
    #
    # 1. add_extra_js_url bakes an import() into index.html at the moment that
    #    page is served. It loads earliest -- but if index.html was served (or
    #    cached by the browser/service worker) before this setup ran, the
    #    import line simply isn't in the HTML, the module never loads, and the
    #    dashboard shows "Custom element doesn't exist" until a fresh reload.
    # 2. A Lovelace resource is fetched over the websocket on every dashboard
    #    load, so it does not depend on the cached HTML and also works when
    #    casting, where extra_module_url is dropped entirely.
    add_extra_js_url(hass, card_url)
    await _async_register_card_resource(hass, card_url)

    return True


async def _async_register_card_resource(hass: HomeAssistant, card_url: str) -> None:
    """Ensure the card is registered as a Lovelace resource (storage mode only).

    Best effort: this reaches into the lovelace integration's storage
    collection, so any failure is logged and ignored rather than breaking
    setup -- add_extra_js_url alone still works.
    """
    try:
        lovelace = hass.data.get("lovelace")
        resources = getattr(lovelace, "resources", None)
        if resources is None or getattr(lovelace, "mode", None) != "storage":
            # YAML-mode Lovelace manages resources from configuration.yaml.
            return

        if not getattr(resources, "loaded", True):
            await resources.async_load()

        for item in resources.async_items():
            if str(item.get("url", "")).split("?")[0] != CARD_URL:
                continue
            if item.get("url") != card_url:
                # Same card, older version: update in place so repeated
                # upgrades can't accumulate duplicate resource entries.
                await resources.async_update_item(item["id"], {"url": card_url})
            return

        await resources.async_create_item({"res_type": "module", "url": card_url})
    except Exception:  # noqa: BLE001 - never let this break setup
        _LOGGER.debug(
            "Could not register the Lovelace resource for %s; the card is still "
            "served at %s and registered via extra_module_url",
            DOMAIN,
            CARD_URL,
            exc_info=True,
        )


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
