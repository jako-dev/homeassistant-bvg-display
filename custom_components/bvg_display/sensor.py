"""Sensor platform for BVG Departure Display."""

from datetime import datetime
import logging

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
import homeassistant.util.dt as dt_util

from .const import (
    ATTR_CANCELLED,
    ATTR_DELAY,
    ATTR_DEPARTURES,
    ATTR_DIRECTION,
    ATTR_LINE,
    ATTR_PLATFORM,
    ATTR_PRODUCT,
    CONF_STATION_ID,
    CONF_STATION_NAME,
    DOMAIN,
)
from .coordinator import BvgDepartureCoordinator

_LOGGER = logging.getLogger(__name__)


def _parse_departure_time(when: str | None) -> datetime | None:
    """Parse a BVG API ISO timestamp into a tz-aware datetime."""
    if not when:
        return None
    return dt_util.parse_datetime(when)


def _minutes_until(dep_time: datetime | None) -> int | None:
    """Return minutes remaining until dep_time, floored at 0."""
    if dep_time is None:
        return None
    delta = (dep_time - dt_util.utcnow()).total_seconds() / 60
    return max(0, round(delta))


def _device_info(entry: ConfigEntry) -> DeviceInfo:
    """Build the shared device info for a station's sensors.

    The device name keeps the "BVG " prefix so that has_entity_name composes
    back to the historic entity ids (sensor.bvg_<station>_departures) that the
    docs, the card's getStubConfig autodetect and existing dashboards rely on.
    """
    return DeviceInfo(
        identifiers={(DOMAIN, entry.data[CONF_STATION_ID])},
        name=f"BVG {entry.data[CONF_STATION_NAME]}",
        manufacturer="BVG/VBB (transport.rest)",
        model="Departure Board",
    )


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up BVG sensors from config entry."""
    coordinator: BvgDepartureCoordinator = entry.runtime_data

    entities = [
        BvgNextDepartureSensor(coordinator, entry),
        BvgDeparturesSensor(coordinator, entry),
    ]
    async_add_entities(entities)


class BvgNextDepartureSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing the next departure time."""

    # "Next" (not "Next departure") so has_entity_name composes back to the
    # documented sensor.bvg_<station>_next entity id.
    _attr_has_entity_name = True
    _attr_name = "Next"
    _attr_icon = "mdi:bus-clock"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(self, coordinator: BvgDepartureCoordinator, entry: ConfigEntry) -> None:
        """Initialize the sensor."""
        super().__init__(coordinator)
        self._entry = entry
        self._attr_unique_id = f"{entry.data[CONF_STATION_ID]}_next"
        self._attr_device_info = _device_info(entry)

    @property
    def native_value(self) -> datetime | None:
        """Return the next departure time."""
        if not self.coordinator.data:
            return None
        dep = self.coordinator.data[0]
        when = dep.get("departure_actual") or dep.get("departure_planned")
        return _parse_departure_time(when)

    @property
    def extra_state_attributes(self) -> dict:
        """Return attributes of the next departure."""
        if not self.coordinator.data:
            return {}
        dep = self.coordinator.data[0]
        when = dep.get("departure_actual") or dep.get("departure_planned")
        return {
            ATTR_LINE: dep["line"],
            ATTR_DIRECTION: dep["direction"],
            ATTR_PRODUCT: dep["product"],
            ATTR_DELAY: dep["delay"],
            ATTR_PLATFORM: dep["platform"],
            ATTR_CANCELLED: dep["cancelled"],
            "minutes": _minutes_until(_parse_departure_time(when)),
        }


class BvgDeparturesSensor(CoordinatorEntity, SensorEntity):
    """Sensor holding all departures as attributes (for the Lovelace card)."""

    _attr_has_entity_name = True
    _attr_name = "Departures"
    _attr_icon = "mdi:train"

    def __init__(self, coordinator: BvgDepartureCoordinator, entry: ConfigEntry) -> None:
        """Initialize the sensor."""
        super().__init__(coordinator)
        self._entry = entry
        self._attr_unique_id = f"{entry.data[CONF_STATION_ID]}_departures"
        self._attr_device_info = _device_info(entry)

    @property
    def native_value(self) -> int:
        """Return number of departures."""
        if not self.coordinator.data:
            return 0
        return len(self.coordinator.data)

    @property
    def extra_state_attributes(self) -> dict:
        """Return all departures as a list attribute."""
        if not self.coordinator.data:
            return {ATTR_DEPARTURES: []}

        departures = []
        for dep in self.coordinator.data:
            when = dep.get("departure_actual") or dep.get("departure_planned")
            departures.append({
                "line": dep["line"],
                "direction": dep["direction"],
                "product": dep["product"],
                "delay": dep["delay"] or 0,
                "platform": dep["platform"],
                "cancelled": dep["cancelled"],
                # Absolute time lets the card tick the countdown down between
                # polls; "minutes" is a snapshot kept for templates/automations.
                "departure_time": when,
                "minutes": _minutes_until(_parse_departure_time(when)),
            })

        return {
            ATTR_DEPARTURES: departures,
            "station_name": self._entry.data[CONF_STATION_NAME],
        }
