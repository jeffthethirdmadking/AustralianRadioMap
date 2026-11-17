#!/usr/bin/env python3
"""
Download the ACMA Register of Radiocommunications Licences (RRL), pull out the
stations the map needs, and write them to data/repeaters.json.

    python3 update_data.py              # download (if the cached copy is old) and build
    python3 update_data.py --inspect    # print the CSV column names inside the zip
    python3 update_data.py --zip path/to/spectra_rrl.zip   # use a zip you already have

Only the Python standard library is needed.

Data: Register of Radiocommunications Licences, (c) Australian Communications and
Media Authority. Use is subject to the ACMA licence terms:
https://www.acma.gov.au/radiocomms-licence-data
"""

import argparse
import csv
import io
import json
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

DOWNLOAD_URL = "https://cdn.acma.gov.au/rrl/spectra_rrl.zip"
HERE = Path(__file__).resolve().parent
CACHE_ZIP = HERE / "cache" / "spectra_rrl.zip"
OUTPUT_JSON = HERE / "data" / "repeaters.json"

# Output field order in the generated JSON.
FIELDS = [
    "state", "siteName", "postcode", "lat", "lon", "callSign", "licenceNumber",
    "channel", "outputMhz", "powerWatts", "antennaHeightM", "polarisation",
    "licenceDate", "antennaType", "radioType", "emission", "bandwidthKhz", "band",
]
STATE_ORDER = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT", "Unknown"]
TYPE_ORDER = ["cb", "mvhf", "mhf", "ama", "air"]

# ---------------------------------------------------------------------------
# UHF CB repeaters: output frequency -> repeater channel
# Channels 1-8 are 25 kHz apart from 476.425 MHz; channels 41-48 sit 12.5 kHz above.
# ---------------------------------------------------------------------------
CB_REPEATER_CHANNELS = {}
for n in range(8):
    CB_REPEATER_CHANNELS[round(476.425 + 0.025 * n, 4)] = n + 1
    CB_REPEATER_CHANNELS[round(476.4375 + 0.025 * n, 4)] = n + 41

# ---------------------------------------------------------------------------
# Column names. The ACMA has renamed columns before, so each value lists the
# names to try, in order. Run with --inspect if something comes up empty.
# ---------------------------------------------------------------------------
COLUMNS = {
    "device": {
        "licence": ["LICENCE_NO"],
        "site": ["SITE_ID"],
        "call_sign": ["DEVICE_REGISTRATION_IDENTIFIER", "CALL_SIGN"],
        "frequency": ["FREQUENCY"],
        "bandwidth": ["BANDWIDTH"],
        "emission": ["EMISSION"],
        "device_type": ["DEVICE_TYPE"],
        "power": ["TRANSMITTER_POWER", "POWER"],
        "power_unit": ["TRANSMITTER_POWER_UNIT", "POWER_UNIT"],
        "polarisation": ["POLARISATION"],
        "height": ["HEIGHT"],
        "antenna": ["ANTENNA_ID"],
    },
    "licence": {
        "licence": ["LICENCE_NO"],
        "service": ["SV_ID"],
        "subservice": ["SS_ID"],
        "status": ["STATUS"],
        "issued": ["DATE_ISSUED", "DATE_OF_EFFECT"],
        "type_name": ["LICENCE_TYPE_NAME"],
        "category": ["LICENCE_CATEGORY_NAME"],
    },
    "site": {
        "site": ["SITE_ID"],
        "lat": ["LATITUDE"],
        "lon": ["LONGITUDE"],
        "name": ["NAME"],
        "state": ["STATE"],
        "postcode": ["POSTCODE"],
    },
    "service": {"id": ["SV_ID"], "name": ["SV_NAME"]},
    "subservice": {"id": ["SS_ID"], "name": ["SS_NAME"]},
    "antenna": {"id": ["ANTENNA_ID"], "type": ["ANTENNA_TYPE"]},
}
CSV_FILES = {
    "device": "device_details.csv",
    "licence": "licence.csv",
    "site": "site.csv",
    "service": "licence_service.csv",
    "subservice": "licence_subservice.csv",
    "antenna": "antenna.csv",
}
REQUIRED = ["device", "licence", "site"]  # the others only improve classification


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------
def progress_bar(current, total, label="Progress", width=32):
    """Print a compact terminal progress bar."""
    if total <= 0:
        return
    fraction = min(current / total, 1.0)
    filled = int(width * fraction)
    bar = "=" * filled + "-" * (width - filled)
    percent = fraction * 100
    print(f"\r{label}: [{bar}] {percent:5.1f}% ({current:,}/{total:,})", end="", flush=True)
    if current >= total:
        print()


def download_zip(max_age_hours, force):
    """Download spectra_rrl.zip unless a recent copy is already cached."""
    if CACHE_ZIP.exists() and not force:
        age_hours = (time.time() - CACHE_ZIP.stat().st_mtime) / 3600
        if age_hours < max_age_hours:
            print(f"Using cached download ({age_hours:.1f} h old): {CACHE_ZIP}")
            return CACHE_ZIP

    CACHE_ZIP.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {DOWNLOAD_URL}")
    request = urllib.request.Request(DOWNLOAD_URL, headers={"User-Agent": "AustralianRadioMap-data-updater"})
    temp_path = CACHE_ZIP.with_suffix(".part")
    with urllib.request.urlopen(request, timeout=120) as response, open(temp_path, "wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        while chunk := response.read(1024 * 256):
            out.write(chunk)
            done += len(chunk)
            if total:
                progress_bar(done, total, "Downloading")
            else:
                print(f"\rDownloaded {done / 1e6:.1f} MB", end="", flush=True)
    if not total:
        print()
    temp_path.replace(CACHE_ZIP)  # only replace the cache once the download completed
    return CACHE_ZIP


# ---------------------------------------------------------------------------
# Reading the CSV tables
# ---------------------------------------------------------------------------
def find_member(archive, filename):
    """Find a CSV inside the zip, ignoring folder prefixes and letter case."""
    for name in archive.namelist():
        if name.lower().split("/")[-1] == filename:
            return name
    return None


def read_table(archive, key):
    """Return the rows of one table as dicts with upper-case column names."""
    member = find_member(archive, CSV_FILES[key])
    if member is None:
        return None
    with archive.open(member) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
        reader = csv.DictReader(text)
        reader.fieldnames = [(name or "").strip().upper() for name in reader.fieldnames or []]
        return list(reader)


def column(table_key, field, rows):
    """Pick the first candidate column name that exists in this table."""
    if not rows:
        return None
    for candidate in COLUMNS[table_key][field]:
        if candidate in rows[0]:
            return candidate
    return None


def get(row, table_key, field, rows, default=""):
    name = column(table_key, field, rows)
    return (row.get(name) or "").strip() if name else default


def inspect(archive):
    print("Files in the zip:")
    for info in archive.infolist():
        print(f"  {info.filename}  ({info.file_size / 1e6:.1f} MB)")
    for key, filename in CSV_FILES.items():
        member = find_member(archive, filename)
        print(f"\n{filename}: " + ("NOT FOUND" if member is None else ""))
        if member:
            with archive.open(member) as raw:
                header = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace").readline()
            print("  columns:", header.strip())


# ---------------------------------------------------------------------------
# Converting values
# ---------------------------------------------------------------------------
def to_float(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def to_watts(value, unit):
    """Convert a transmitter power and its unit to watts."""
    power = to_float(value)
    if power is None:
        return 0.0
    unit = (unit or "W").strip().lower()
    if unit == "kw":
        return power * 1000
    if unit == "mw":
        return power / 1000
    if unit == "dbw":
        return round(10 ** (power / 10), 2)
    if unit == "dbm":
        return round(10 ** (power / 10) / 1000, 3)
    return power


def normalise_state(text):
    state = (text or "").strip().upper()
    return state if state in STATE_ORDER else "Unknown"


def band_name(mhz, radio_type):
    """Friendly band label, matching the labels the web page already shows."""
    if radio_type == "cb":
        return "UHF CB"
    if radio_type == "mvhf":
        return "Marine VHF"
    if radio_type == "air" and 108 <= mhz <= 137:
        return "VHF airband"
    for low, high, label in [
        (0, 30, "HF"), (50, 54, "6 m"), (144, 148, "2 m"), (420, 450, "70 cm"),
        (1240, 1300, "23 cm"),
    ]:
        if low <= mhz <= high:
            return label
    if mhz >= 1300:
        return "Microwave"
    return "VHF" if mhz < 300 else "UHF"


def classify(mhz, service_text):
    """
    Work out which of the map's radio types a transmitter belongs to, from its
    frequency and the licence's service wording. Returns None for anything else.
    """
    text = service_text.lower()
    if "amateur" in text:
        return "ama"
    if round(mhz, 4) in CB_REPEATER_CHANNELS:
        return "cb"
    if "aeronaut" in text or "aviation" in text:
        return "air"
    if any(word in text for word in ("maritime", "marine", "ship", "coast")):
        if 156 <= mhz <= 163:
            return "mvhf"
        if mhz < 30:
            return "mhf"
    return None


# ---------------------------------------------------------------------------
# Build the station list
# ---------------------------------------------------------------------------
def build_stations(archive, keep_no_coords):
    tables = {key: read_table(archive, key) for key in CSV_FILES}
    missing = [key for key in REQUIRED if not tables[key]]
    if missing:
        sys.exit(
            "Couldn't find or read: " + ", ".join(CSV_FILES[k] for k in missing)
            + "\nRun with --inspect to see what is in the zip."
        )

    devices, licences, sites = tables["device"], tables["licence"], tables["site"]
    for key in REQUIRED:
        for field, names in COLUMNS[key].items():
            if column(key, field, tables[key]) is None and field in (
                "licence", "site", "frequency", "lat", "lon"
            ):
                sys.exit(f"{CSV_FILES[key]} has none of the columns {names} (needed for '{field}'). Try --inspect.")

    # Lookup tables keyed by id
    site_by_id = {get(r, "site", "site", sites): r for r in sites}
    licence_by_no = {get(r, "licence", "licence", licences): r for r in licences}
    service_names = {get(r, "service", "id", tables["service"]): get(r, "service", "name", tables["service"])
                     for r in tables["service"] or []}
    subservice_names = {get(r, "subservice", "id", tables["subservice"]): get(r, "subservice", "name", tables["subservice"])
                        for r in tables["subservice"] or []}
    antenna_types = {get(r, "antenna", "id", tables["antenna"]): get(r, "antenna", "type", tables["antenna"])
                     for r in tables["antenna"] or []}

    stations, skipped = [], {"not granted": 0, "receiver": 0, "other service": 0, "no coordinates": 0}
    total_devices = len(devices)
    for device_index, device in enumerate(devices, start=1):
        # Update often enough to feel responsive without flooding the terminal.
        if device_index == 1 or device_index % max(1, total_devices // 100) == 0 or device_index == total_devices:
            progress_bar(device_index, total_devices, "Processing")

        licence_no = get(device, "device", "licence", devices)
        licence = licence_by_no.get(licence_no)
        if licence is None:
            continue

        status = get(licence, "licence", "status", licences)
        if status and status not in ("1", "Granted", "granted"):
            skipped["not granted"] += 1
            continue

        device_type = get(device, "device", "device_type", devices)
        if device_type and device_type.upper().startswith("R"):  # receive-only
            skipped["receiver"] += 1
            continue

        hz = to_float(get(device, "device", "frequency", devices))
        if not hz:
            continue
        mhz = hz / 1e6  # the ACMA stores frequency in Hz

        service_text = " ".join([
            service_names.get(get(licence, "licence", "service", licences), ""),
            subservice_names.get(get(licence, "licence", "subservice", licences), ""),
            get(licence, "licence", "type_name", licences),
            get(licence, "licence", "category", licences),
        ])
        radio_type = classify(mhz, service_text)
        if radio_type is None:
            skipped["other service"] += 1
            continue

        site = site_by_id.get(get(device, "device", "site", devices), {})
        lat = to_float(get(site, "site", "lat", sites)) if site else None
        lon = to_float(get(site, "site", "lon", sites)) if site else None
        if (lat is None or lon is None) and not keep_no_coords:
            skipped["no coordinates"] += 1
            continue

        bandwidth_hz = to_float(get(device, "device", "bandwidth", devices))
        stations.append({
            "state": normalise_state(get(site, "site", "state", sites) if site else ""),
            "siteName": get(site, "site", "name", sites) if site else "",
            "postcode": get(site, "site", "postcode", sites) if site else "",
            "lat": lat,
            "lon": lon,
            "callSign": get(device, "device", "call_sign", devices),
            "licenceNumber": licence_no,
            "channel": CB_REPEATER_CHANNELS.get(round(mhz, 4)) if radio_type == "cb" else None,
            "outputMhz": round(mhz, 6),
            "powerWatts": to_watts(get(device, "device", "power", devices), get(device, "device", "power_unit", devices)),
            "antennaHeightM": to_float(get(device, "device", "height", devices)),
            "polarisation": get(device, "device", "polarisation", devices)[:1].upper(),
            "licenceDate": get(licence, "licence", "issued", licences)[:10],
            "antennaType": antenna_types.get(get(device, "device", "antenna", devices), ""),
            "radioType": radio_type,
            "emission": get(device, "device", "emission", devices),
            "bandwidthKhz": round(bandwidth_hz / 1000, 3) if bandwidth_hz else None,
            "band": band_name(mhz, radio_type),
        })

    print("Skipped:", ", ".join(f"{count} {reason}" for reason, count in skipped.items()))
    return stations


def sort_key(station):
    state = STATE_ORDER.index(station["state"])
    return (TYPE_ORDER.index(station["radioType"]), state, station["siteName"], station["outputMhz"])


# ---------------------------------------------------------------------------
# Writing the output
# ---------------------------------------------------------------------------
def write_outputs(stations):
    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    # Write a plain JSON array: one station object per line, with stable field order.
    with open(OUTPUT_JSON, "w", encoding="utf-8") as out:
        out.write("[\n")
        out.write(",\n".join(
            "    " + json.dumps(
                {field: station.get(field) for field in FIELDS},
                ensure_ascii=False,
                separators=(",", ": "),
            )
            for station in stations
        ))
        out.write("\n]\n")
    print(f"Wrote {len(stations)} stations to {OUTPUT_JSON}")

    counts = {}
    for station in stations:
        counts[station["radioType"]] = counts.get(station["radioType"], 0) + 1
    print("By type:", ", ".join(f"{radio_type} {counts.get(radio_type, 0)}" for radio_type in TYPE_ORDER))


def main():
    parser = argparse.ArgumentParser(description="Build data/repeaters.json from the ACMA RRL download.")
    parser.add_argument("--zip", help="use this spectra_rrl.zip instead of downloading")
    parser.add_argument("--force", action="store_true", help="download even if the cached copy is recent")
    parser.add_argument("--max-age-hours", type=float, default=24, help="re-download if the cache is older than this")
    parser.add_argument("--inspect", action="store_true", help="list the CSV files and columns, then stop")
    parser.add_argument("--keep-no-coords", action="store_true", help="keep stations that have no latitude/longitude")
    args = parser.parse_args()

    zip_path = Path(args.zip) if args.zip else download_zip(args.max_age_hours, args.force)
    with zipfile.ZipFile(zip_path) as archive:
        if args.inspect:
            return inspect(archive)
        stations = build_stations(archive, args.keep_no_coords)

    stations.sort(key=sort_key)
    write_outputs(stations)


if __name__ == "__main__":
    main()
