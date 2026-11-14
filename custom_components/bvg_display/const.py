"""Constants for the BVG Departure Display integration."""

DOMAIN = "bvg_display"

CONF_STATION_ID = "station_id"
CONF_STATION_NAME = "station_name"
CONF_DEPARTURE_COUNT = "departure_count"
CONF_FILTERS = "filters"
CONF_SOURCE = "source"
CONF_TRANSITOUS_FALLBACK = "transitous_fallback"

SOURCE_BVG = "bvg"
SOURCE_TRANSITOUS = "transitous"

DEFAULT_DEPARTURE_COUNT = 6
DEFAULT_SCAN_INTERVAL = 30  # seconds
# Transitous asks clients to stay light on its volunteer-run servers.
TRANSITOUS_MIN_INTERVAL = 60  # seconds

BVG_API_BASE = "https://v6.bvg.transport.rest"
TRANSITOUS_API_BASE = "https://api.transitous.org/api"
TRANSITOUS_ATTRIBUTION = "Data: Transitous (https://transitous.org/sources/)"

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
