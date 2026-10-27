"""Config flow for BVG Departure Display."""

import asyncio

import aiohttp
import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, OptionsFlow
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    BVG_API_BASE,
    CONF_DEPARTURE_COUNT,
    CONF_FILTERS,
    CONF_SOURCE,
    CONF_STATION_ID,
    CONF_STATION_NAME,
    CONF_TRANSITOUS_FALLBACK,
    DEFAULT_DEPARTURE_COUNT,
    DOMAIN,
    SOURCE_BVG,
    SOURCE_TRANSITOUS,
    TRANSPORT_TYPES,
)
from . import transitous

DEPARTURE_COUNT_OPTIONS = ["1", "3", "6", "9", "12", "15"]

SOURCE_OPTIONS = {
    SOURCE_BVG: "BVG/VBB (Berlin & Brandenburg)",
    SOURCE_TRANSITOUS: "Transitous (Germany & Europe)",
}


def _options_schema(source: str, count: int, filters: dict, fallback: bool) -> dict:
    """Departure count, filters and (BVG only) the Transitous fallback."""
    schema = {
        vol.Required(CONF_DEPARTURE_COUNT, default=str(count)): vol.In(
            DEPARTURE_COUNT_OPTIONS
        ),
    }
    for transport_type in TRANSPORT_TYPES:
        schema[
            vol.Optional(transport_type, default=filters.get(transport_type, True))
        ] = bool
    if source == SOURCE_BVG:
        schema[vol.Optional(CONF_TRANSITOUS_FALLBACK, default=fallback)] = bool
    return schema


def _options_from_input(source: str, user_input: dict) -> dict:
    options = {
        CONF_DEPARTURE_COUNT: int(
            user_input.get(CONF_DEPARTURE_COUNT, str(DEFAULT_DEPARTURE_COUNT))
        ),
        CONF_FILTERS: {
            transport_type: user_input.get(transport_type, True)
            for transport_type in TRANSPORT_TYPES
        },
    }
    if source == SOURCE_BVG:
        options[CONF_TRANSITOUS_FALLBACK] = user_input.get(CONF_TRANSITOUS_FALLBACK, True)
    return options


class _StationSearchError(Exception):
    """Raised when the station search API can't be reached or errors."""


class BvgDisplayConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for BVG Display."""

    VERSION = 1

    def __init__(self) -> None:
        """Initialize config flow."""
        self._stations: list[dict] = []
        self._source = SOURCE_BVG
        self._selected_station_id: str | None = None
        self._selected_station_name: str | None = None

    async def async_step_user(self, user_input=None) -> FlowResult:
        """Handle the initial step - station search."""
        errors = {}

        if user_input is not None:
            self._source = user_input.get(CONF_SOURCE, SOURCE_BVG)
            query = user_input.get("query", "").strip()
            if query:
                try:
                    if self._source == SOURCE_TRANSITOUS:
                        self._stations = await self._search_transitous(query)
                    else:
                        self._stations = await self._search_stations(query)
                except _StationSearchError:
                    errors["base"] = "cannot_connect"
                else:
                    if self._stations:
                        return await self.async_step_select_station()
                    errors["base"] = "no_results"

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({
                vol.Required(CONF_SOURCE, default=self._source): vol.In(SOURCE_OPTIONS),
                vol.Required("query"): str,
            }),
            errors=errors,
            description_placeholders={"example": "Alexanderplatz"},
        )

    async def async_step_select_station(self, user_input=None) -> FlowResult:
        """Handle station selection."""
        if user_input is not None:
            station_id = user_input["station"]
            for station in self._stations:
                if station["id"] == station_id:
                    self._selected_station_id = station["id"]
                    self._selected_station_name = station["name"]
                    break
            return await self.async_step_options()

        station_options = {
            station["id"]: station["name"]
            for station in self._stations
        }

        return self.async_show_form(
            step_id="select_station",
            data_schema=vol.Schema({
                vol.Required("station"): vol.In(station_options),
            }),
        )

    async def async_step_options(self, user_input=None) -> FlowResult:
        """Handle departure options (count, filters)."""
        if user_input is not None:
            await self.async_set_unique_id(self._selected_station_id)
            self._abort_if_unique_id_configured()

            return self.async_create_entry(
                title=self._selected_station_name,
                data={
                    CONF_STATION_ID: self._selected_station_id,
                    CONF_STATION_NAME: self._selected_station_name,
                    CONF_SOURCE: self._source,
                },
                options=_options_from_input(self._source, user_input),
            )

        return self.async_show_form(
            step_id="options",
            data_schema=vol.Schema(
                _options_schema(self._source, DEFAULT_DEPARTURE_COUNT, {}, True)
            ),
        )

    async def _search_transitous(self, query: str) -> list[dict]:
        """Search Transitous for stops (Germany- and Europe-wide)."""
        try:
            return await transitous.async_search_stops(self.hass, query)
        except transitous.TransitousError as err:
            raise _StationSearchError(str(err)) from err

    async def _search_stations(self, query: str) -> list[dict]:
        """Search BVG API for stations."""
        url = f"{BVG_API_BASE}/locations"
        params = {
            "query": query,
            "results": "10",
            "stops": "true",
            "addresses": "false",
            "poi": "false",
            "pretty": "false",
        }

        try:
            session = async_get_clientsession(self.hass)
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    raise _StationSearchError(f"BVG API returned {resp.status}")
                data = await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise _StationSearchError(str(err)) from err

        if not isinstance(data, list):
            raise _StationSearchError("Unexpected response shape from BVG API")

        stations = []
        for item in data:
            if not isinstance(item, dict):
                continue
            if item.get("type") not in ("stop", "station"):
                continue
            station_id = item.get("id")
            station_name = item.get("name")
            if not station_id or not station_name:
                continue
            stations.append({"id": station_id, "name": station_name})
        return stations

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        """Get the options flow for this handler."""
        return BvgDisplayOptionsFlow()


class BvgDisplayOptionsFlow(OptionsFlow):
    """Handle options flow for BVG Display."""

    async def async_step_init(self, user_input=None) -> FlowResult:
        """Manage the options."""
        source = self.config_entry.data.get(CONF_SOURCE, SOURCE_BVG)
        if user_input is not None:
            return self.async_create_entry(
                title="", data=_options_from_input(source, user_input)
            )

        options = self.config_entry.options
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                _options_schema(
                    source,
                    options.get(CONF_DEPARTURE_COUNT, DEFAULT_DEPARTURE_COUNT),
                    options.get(CONF_FILTERS, {}),
                    options.get(CONF_TRANSITOUS_FALLBACK, True),
                )
            ),
        )
