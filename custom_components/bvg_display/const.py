"""Constants for the BVG Departure Display integration."""

DOMAIN = "bvg_display"

CONF_STATION_ID = "station_id"
CONF_STATION_NAME = "station_name"
CONF_DEPARTURE_COUNT = "departure_count"
CONF_FILTERS = "filters"

DEFAULT_DEPARTURE_COUNT = 6
DEFAULT_SCAN_INTERVAL = 30  # seconds

BVG_API_BASE = "https://v6.bvg.transport.rest"

TRANSPORT_TYPES = [
    "suburban",
    "subway",
    "tram",
    "bus",
    "ferry",
    "express",
    "regional",
]

TRANSPORT_TYPE_NAMES = {
    "suburban": "S-Bahn",
    "subway": "U-Bahn",
    "tram": "Tram",
    "bus": "Bus",
    "ferry": "Fähre",
    "express": "IC/ICE",
    "regional": "Regional",
}

ATTR_LINE = "line"
ATTR_DIRECTION = "direction"
ATTR_DEPARTURE_TIME = "departure_time"
ATTR_DELAY = "delay"
ATTR_PLATFORM = "platform"
ATTR_PRODUCT = "product"
ATTR_CANCELLED = "cancelled"
ATTR_DEPARTURES = "departures"
