"""Data update coordinator for BVG Departure Display."""

from datetime import timedelta
import logging

import aiohttp
import asyncio
import time

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    BVG_API_BASE,
    DEFAULT_DEPARTURE_COUNT,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    SOURCE_BVG,
    SOURCE_TRANSITOUS,
    TRANSITOUS_MIN_INTERVAL,
    TRANSPORT_TYPES,
)
from . import transitous

_LOGGER = logging.getLogger(__name__)

# The public BVG API is community-run and occasionally drops a request.
# Keep serving the last good departures through short outages instead of
# flipping every entity to "unavailable" on the first hiccup.
MAX_CONSECUTIVE_FAILURES = 3


class BvgDepartureCoordinator(DataUpdateCoordinator):
    """Fetch departure data from BVG or Transitous."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        station_id: str,
        station_name: str,
        departure_count: int = DEFAULT_DEPARTURE_COUNT,
        filters: dict | None = None,
        source: str = SOURCE_BVG,
        transitous_fallback: bool = True,
    ) -> None:
        """Initialize the coordinator."""
        self.station_id = station_id
        self.station_name = station_name
        self.departure_count = departure_count
        self.filters = filters or {}
        self.source = source
        self.transitous_fallback = transitous_fallback
        # Where the current data came from; differs from source while a BVG
        # entry is running on the Transitous fallback.
        self.active_source = source
        self._consecutive_failures = 0
        # Transitous stop id: the entry's own id, or resolved lazily from the
        # BVG id on the first fallback (False once resolving found nothing).
        self._transitous_stop_id: str | bool | None = (
            station_id if source == SOURCE_TRANSITOUS else None
        )
        self._transitous_last_request = 0.0

        scan_interval = (
            TRANSITOUS_MIN_INTERVAL if source == SOURCE_TRANSITOUS else DEFAULT_SCAN_INTERVAL
        )

        # config_entry is passed explicitly: the implicit ContextVar fallback
        # is deprecated (removed in HA 2026.8) and silently skips wiring
        # async_shutdown to the entry, which leaks the polling timer.
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=f"{DOMAIN}_{station_id}",
            update_interval=timedelta(seconds=scan_interval),
        )

    def update_options(
        self, departure_count: int, filters: dict | None, transitous_fallback: bool
    ) -> None:
        """Apply changed options in place.

        Lets the options flow take effect without reloading the config entry,
        which would tear down and recreate every entity (and briefly show the
        card as unavailable).
        """
        self.departure_count = departure_count
        self.filters = filters or {}
        self.transitous_fallback = transitous_fallback
        # Force a fresh fetch so changed filters show up right away.
        self._transitous_last_request = 0.0

    async def _async_update_data(self) -> list[dict]:
        """Fetch departures, tolerating short-lived API outages."""
        try:
            departures = await self._fetch_with_fallback()
        except UpdateFailed as err:
            self._consecutive_failures += 1
            # "is not None", not truthiness: an empty list is a valid cached
            # result (night service, or every product filtered out) and must
            # still count as having data to fall back on.
            if self.data is not None and self._consecutive_failures <= MAX_CONSECUTIVE_FAILURES:
                _LOGGER.warning(
                    "Departure update failed for %s (%s/%s), serving cached departures: %s",
                    self.station_name,
                    self._consecutive_failures,
                    MAX_CONSECUTIVE_FAILURES,
                    err,
                )
                return self.data
            raise

        self._consecutive_failures = 0
        return departures

    async def _fetch_with_fallback(self) -> list[dict]:
        """Fetch from the configured source, falling back to Transitous."""
        if self.source == SOURCE_TRANSITOUS:
            return await self._fetch_transitous()

        try:
            departures = await self._fetch_departures()
        except UpdateFailed as err:
            if not self.transitous_fallback or self._transitous_stop_id is False:
                raise
            if self.active_source == SOURCE_BVG:
                _LOGGER.info(
                    "BVG API failed for %s (%s), falling back to Transitous",
                    self.station_name,
                    err,
                )
            return await self._fetch_transitous()

        if self.active_source != SOURCE_BVG:
            _LOGGER.info("BVG API is back for %s", self.station_name)
        self.active_source = SOURCE_BVG
        return departures

    async def _fetch_transitous(self) -> list[dict]:
        """Fetch departures from Transitous, at most once a minute."""
        # The BVG poll runs every 30s; while on the fallback, reuse the last
        # Transitous result in between so Transitous sees one request a minute.
        # Countdowns stay correct since the sensors work from absolute times.
        if (
            self.active_source == SOURCE_TRANSITOUS
            and self.data is not None
            and time.monotonic() - self._transitous_last_request < TRANSITOUS_MIN_INTERVAL - 5
        ):
            return self.data

        self._transitous_last_request = time.monotonic()
        try:
            if self._transitous_stop_id is None:
                self._transitous_stop_id = (
                    await transitous.async_resolve_bvg_stop(
                        self.hass, self.station_id, self.station_name
                    )
                    or False
                )
                if self._transitous_stop_id is False:
                    _LOGGER.warning(
                        "No Transitous stop found for %s (%s), fallback disabled",
                        self.station_name,
                        self.station_id,
                    )
                    raise UpdateFailed(f"No Transitous stop for {self.station_name}")

            departures = await transitous.async_fetch_departures(
                self.hass, self._transitous_stop_id, self.departure_count, self.filters
            )
        except transitous.TransitousError as err:
            raise UpdateFailed(
                f"Error fetching Transitous data for {self.station_name}: {err}"
            ) from err

        self.active_source = SOURCE_TRANSITOUS
        return departures

    async def _fetch_departures(self) -> list[dict]:
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
        except ValueError as err:
            raise UpdateFailed(f"Invalid JSON from BVG API: {err}") from err

        departures = []
        if isinstance(data, list):
            raw_departures = data
        elif isinstance(data, dict):
            raw_departures = data.get("departures", [])
        else:
            raw_departures = []

        for dep in raw_departures:
            if not isinstance(dep, dict):
                continue
            # "line" is null on some malformed/replacement-service entries.
            line = dep.get("line") or {}
            if not isinstance(line, dict):
                line = {}
            departures.append({
                "line": line.get("name", "?"),
                "direction": dep.get("direction", ""),
                "product": line.get("product", ""),
                "departure_planned": dep.get("plannedWhen"),
                "departure_actual": dep.get("when"),
                "delay": dep.get("delay") or 0,
                "platform": dep.get("platform") or dep.get("plannedPlatform", ""),
                "cancelled": dep.get("cancelled", False),
            })

        return departures
