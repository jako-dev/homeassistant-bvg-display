"""Data update coordinator for BVG Departure Display."""

from datetime import timedelta
import logging

import aiohttp
import asyncio

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    BVG_API_BASE,
    DEFAULT_DEPARTURE_COUNT,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    TRANSPORT_TYPES,
)

_LOGGER = logging.getLogger(__name__)


class BvgDepartureCoordinator(DataUpdateCoordinator):
    """Fetch BVG departure data."""

    def __init__(
        self,
        hass: HomeAssistant,
        station_id: str,
        station_name: str,
        departure_count: int = DEFAULT_DEPARTURE_COUNT,
        filters: dict | None = None,
        scan_interval: int = DEFAULT_SCAN_INTERVAL,
    ) -> None:
        """Initialize the coordinator."""
        self.station_id = station_id
        self.station_name = station_name
        self.departure_count = departure_count
        self.filters = filters or {}

        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_{station_id}",
            update_interval=timedelta(seconds=scan_interval),
        )

    async def _async_update_data(self) -> list[dict]:
        """Fetch departures from BVG API."""
        params = {
            "duration": "30",
            "results": str(self.departure_count),
            "remarks": "true",
            "pretty": "false",
            "language": "de",
        }

        for transport_type in TRANSPORT_TYPES:
            if transport_type in self.filters:
                params[transport_type] = str(self.filters[transport_type]).lower()

        url = f"{BVG_API_BASE}/stops/{self.station_id}/departures"

        try:
            session = async_get_clientsession(self.hass)
            async with asyncio.timeout(15):
                async with session.get(url, params=params) as resp:
                    if resp.status == 429:
                        raise UpdateFailed("BVG API rate limit exceeded, retrying next cycle")
                    if resp.status != 200:
                        raise UpdateFailed(f"BVG API returned {resp.status}")
                    data = await resp.json()
        except asyncio.TimeoutError as err:
            raise UpdateFailed(f"Timeout fetching BVG data for {self.station_name}") from err
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Error fetching BVG data: {err}") from err

        departures = []
        raw_departures = data.get("departures", data if isinstance(data, list) else [])

        for dep in raw_departures:
            line = dep.get("line", {})
            departures.append({
                "line": line.get("name", "?"),
                "direction": dep.get("direction", ""),
                "product": line.get("product", ""),
                "departure_planned": dep.get("plannedWhen"),
                "departure_actual": dep.get("when"),
                "delay": dep.get("delay", 0),
                "platform": dep.get("platform") or dep.get("plannedPlatform", ""),
                "cancelled": dep.get("cancelled", False),
            })

        return departures
