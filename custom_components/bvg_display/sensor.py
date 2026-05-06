"""Sensor platform for BVG Departure Display."""

from datetime import datetime
import logging

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

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


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up BVG sensors from config entry."""
    coordinator: BvgDepartureCoordinator = hass.data[DOMAIN][entry.entry_id]

    entities = [
        BvgNextDepartureSensor(coordinator, entry),
        BvgDeparturesSensor(coordinator, entry),
    ]
    async_add_entities(entities)


class BvgNextDepartureSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing the next departure."""

    _attr_icon = "mdi:bus-clock"

    def __init__(self, coordinator: BvgDepartureCoordinator, entry: ConfigEntry) -> None:
        """Initialize the sensor."""
        super().__init__(coordinator)
        self._entry = entry
        station_name = entry.data[CONF_STATION_NAME]
        self._attr_name = f"BVG {station_name} Next"
        self._attr_unique_id = f"{entry.data[CONF_STATION_ID]}_next"

    @property
    def native_value(self) -> str | None:
        """Return the next departure as a string."""
        if not self.coordinator.data:
            return None
        dep = self.coordinator.data[0]
        minutes = self._calc_minutes(dep)
        if minutes is not None:
            return f"{dep['line']} {dep['direction']} in {minutes} min"
        return f"{dep['line']} {dep['direction']}"

    @property
    def extra_state_attributes(self) -> dict:
        """Return attributes of the next departure."""
        if not self.coordinator.data:
            return {}
        dep = self.coordinator.data[0]
        return {
            ATTR_LINE: dep["line"],
            ATTR_DIRECTION: dep["direction"],
            ATTR_PRODUCT: dep["product"],
            ATTR_DELAY: dep["delay"],
            ATTR_PLATFORM: dep["platform"],
            ATTR_CANCELLED: dep["cancelled"],
            "minutes": self._calc_minutes(dep),
        }

    def _calc_minutes(self, dep: dict) -> int | None:
        """Calculate minutes until departure."""
        when = dep.get("departure_actual") or dep.get("departure_planned")
        if not when:
            return None
        try:
            dep_time = datetime.fromisoformat(when)
            now = datetime.now(dep_time.tzinfo)
            delta = (dep_time - now).total_seconds() / 60
            return max(0, round(delta))
        except (ValueError, TypeError):
            return None


class BvgDeparturesSensor(CoordinatorEntity, SensorEntity):
    """Sensor holding all departures as attributes (for the Lovelace card)."""

    _attr_icon = "mdi:train"

    def __init__(self, coordinator: BvgDepartureCoordinator, entry: ConfigEntry) -> None:
        """Initialize the sensor."""
        super().__init__(coordinator)
        self._entry = entry
        station_name = entry.data[CONF_STATION_NAME]
        self._attr_name = f"BVG {station_name} Departures"
        self._attr_unique_id = f"{entry.data[CONF_STATION_ID]}_departures"

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
        now = datetime.now()
        for dep in self.coordinator.data:
            when = dep.get("departure_actual") or dep.get("departure_planned")
            minutes = None
            if when:
                try:
                    dep_time = datetime.fromisoformat(when)
                    now_tz = datetime.now(dep_time.tzinfo)
                    minutes = max(0, round((dep_time - now_tz).total_seconds() / 60))
                except (ValueError, TypeError):
                    pass

            departures.append({
                "line": dep["line"],
                "direction": dep["direction"],
                "product": dep["product"],
                "delay": dep["delay"] or 0,
                "platform": dep["platform"],
                "cancelled": dep["cancelled"],
                "minutes": minutes,
            })

        return {
            ATTR_DEPARTURES: departures,
            "station_name": self._entry.data[CONF_STATION_NAME],
        }
