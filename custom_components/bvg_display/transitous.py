"""Client for the Transitous (MOTIS 2) API.

Transitous is a community-run, Germany- and Europe-wide routing service with
realtime data for many networks, including VBB/BVG. It is used both as a
selectable data source and as a fallback when the BVG API is down.

Usage policy (https://transitous.org/api/): every request must carry a
User-Agent with app name, version and a contact URL, and polling has to stay
light, so the coordinator never queries it more than once a minute per stop.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
import logging
import re

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.loader import async_get_integration

from .const import DOMAIN, TRANSITOUS_API_BASE, TRANSPORT_TYPES

_LOGGER = logging.getLogger(__name__)

PROJECT_URL = "https://github.com/jako-dev/homeassistant-bvg-display"

# MOTIS transit modes per card product. Several MOTIS modes collapse into one
# product so the card's colours and the existing filters keep working.
PRODUCT_MODES = {
    "suburban": ["SUBURBAN"],
    "subway": ["SUBWAY"],
    "tram": ["TRAM"],
    "bus": ["BUS", "COACH"],
    "ferry": ["FERRY"],
    "express": ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"],
    "regional": ["REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "RAIL"],
}
MODE_PRODUCT = {
    mode: product for product, modes in PRODUCT_MODES.items() for mode in modes
}

# "1 (U5)" -> "1": VBB suffixes U-Bahn tracks with the line.
_TRACK_SUFFIX = re.compile(r"\s*\([^)]*\)$")
# "S-Bahnsteig Gleis 4" -> "4": S-Bahn stops often only carry it here.
_GLEIS = re.compile(r"\bGleis\s+(\S+)")
# "S+U Pankow (Berlin)" -> "S+U Pankow", matching the BVG API's headsigns.
# Only plain place names, so "Flughafen BER (T1-2)" is left alone.
_HEADSIGN_CITY = re.compile(r"\s+\([A-Za-zÄÖÜäöüß. -]+\)$")


class TransitousError(Exception):
    """Raised when Transitous can't be reached or returns an error."""


async def _user_agent(hass: HomeAssistant) -> str:
    integration = await async_get_integration(hass, DOMAIN)
    return f"homeassistant-bvg-display/{integration.version or 'dev'} (+{PROJECT_URL})"


async def _get(hass: HomeAssistant, path: str, params: dict, timeout: int) -> object:
    session = async_get_clientsession(hass)
    headers = {"User-Agent": await _user_agent(hass)}
    try:
        async with asyncio.timeout(timeout):
            async with session.get(
                f"{TRANSITOUS_API_BASE}{path}", params=params, headers=headers
            ) as resp:
                if resp.status == 429:
                    raise TransitousError("Transitous rate limit exceeded")
                if resp.status != 200:
                    raise TransitousError(f"Transitous returned {resp.status}")
                return await resp.json()
    except asyncio.TimeoutError as err:
        raise TransitousError("Timeout talking to Transitous") from err
    except aiohttp.ClientError as err:
        raise TransitousError(f"Error talking to Transitous: {err}") from err
    except ValueError as err:
        raise TransitousError(f"Invalid JSON from Transitous: {err}") from err


async def async_search_stops(hass: HomeAssistant, query: str) -> list[dict]:
    """Search stops by name. Returns [{"id", "name"}]."""
    data = await _get(
        hass,
        "/v1/geocode",
        {"text": query, "type": "STOP", "language": "de"},
        timeout=10,
    )
    if not isinstance(data, list):
        raise TransitousError("Unexpected response shape from Transitous")

    stops = []
    for item in data:
        if not isinstance(item, dict) or item.get("type") != "STOP":
            continue
        if item.get("id") and item.get("name"):
            stops.append({"id": item["id"], "name": item["name"]})
    return stops[:10]


async def async_resolve_bvg_stop(
    hass: HomeAssistant, bvg_id: str, station_name: str
) -> str | None:
    """Find the Transitous stop id for a BVG/VBB stop id.

    Transitous ids embed the VBB id as one colon-separated component, e.g.
    BVG "900100003" is "de-VBB_de:11000:900100003" (or a "de-DELFI_..." id
    outside Berlin), so search by name and match on that component.
    """
    for stop in await async_search_stops(hass, station_name):
        # Platform-level ids ("...:900078104::3") have extra components after
        # the VBB id; only station-level ids (VBB id last) are wanted here.
        if stop["id"].rstrip(":").split(":")[-1] == bvg_id:
            return stop["id"]
    return None


def _parse(when: str | None) -> datetime | None:
    if not when:
        return None
    try:
        return datetime.fromisoformat(when.replace("Z", "+00:00"))
    except ValueError:
        return None


def _platform(place: dict) -> str:
    track = place.get("track") or place.get("scheduledTrack")
    if track:
        return _TRACK_SUFFIX.sub("", str(track))
    match = _GLEIS.search(place.get("description") or "")
    return match.group(1) if match else ""


async def async_fetch_departures(
    hass: HomeAssistant, stop_id: str, count: int, filters: dict
) -> list[dict]:
    """Fetch departures in the coordinator's normalized format."""
    params = {"stopId": stop_id, "n": str(max(count * 2, 10))}
    if filters and not all(filters.get(t, True) for t in TRANSPORT_TYPES):
        modes = [
            mode
            for product in TRANSPORT_TYPES
            if filters.get(product, True)
            for mode in PRODUCT_MODES[product]
        ]
        if not modes:
            return []
        params["mode"] = ",".join(modes)

    data = await _get(hass, "/v5/stoptimes", params, timeout=15)
    if not isinstance(data, dict):
        raise TransitousError("Unexpected response shape from Transitous")

    departures = []
    for st in data.get("stopTimes") or []:
        if not isinstance(st, dict):
            continue
        place = st.get("place") or {}
        # The last stop of a trip is listed as an arrival only.
        if not place.get("departure") or place.get("pickupType") == "NOT_ALLOWED":
            continue

        planned = place.get("scheduledDeparture")
        actual = place.get("departure") if st.get("realTime") else None
        delay = 0
        if actual and planned:
            p, a = _parse(planned), _parse(actual)
            if p and a:
                delay = int((a - p).total_seconds())

        departures.append({
            "line": st.get("displayName") or st.get("routeShortName") or "?",
            "direction": _HEADSIGN_CITY.sub("", st.get("headsign") or ""),
            "product": MODE_PRODUCT.get(st.get("mode"), ""),
            "departure_planned": planned,
            "departure_actual": actual,
            "delay": delay,
            "platform": _platform(place),
            "cancelled": bool(
                st.get("cancelled") or st.get("tripCancelled") or place.get("cancelled")
            ),
        })

    # Transitous orders by scheduled time; sort by the expected time like the
    # BVG API so a late train doesn't sit above the next on-time one.
    departures.sort(key=lambda d: d["departure_actual"] or d["departure_planned"])
    return departures[:count]
