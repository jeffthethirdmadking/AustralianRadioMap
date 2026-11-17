#!/usr/bin/env python3
"""
Download the ACMA Register of Radiocommunications Licences (RRL), pull out the
stations the map needs, and write them to ONE file: data/repeaters.json.

Each record has the same layout as split_device_details.py produces: the original
device_details row (empty fields dropped) plus readable labels and everything
linked to it in the other tables:

  STATE, TYPE, FREQUENCY_MHZ, DEVICE_MODE, DUPLEX_MODE, SERVICE_NAME, SUBSERVICE_NAME,
  CLASS_OF_STATION_DESCRIPTION, NATURE_OF_SERVICE_DESCRIPTION, POLARISATION_TEXT
  "site"                 site.csv + licensing area                (via SITE_ID)
  "licence"              licence.csv                              (via LICENCE_NO)
  "client"               client.csv + industry, type, fee status  (via licence CLIENT_NO)
  "antenna"              antenna.csv                              (via ANTENNA_ID)
  "area"                 access_area.csv                          (via AREA_AREA_ID)
  "conditions"           applic_text_block.csv                    (via LICENCE_NO / TCS_ID)
  "same_station_devices" other devices on the same station, e.g. a repeater's receive side

and four fields added for the map:

  RADIO_TYPE   cb | mvhf | mhf | ama | air
  BAND         friendly band label, e.g. "UHF CB", "70 cm"
  POWER_WATTS  transmitter power converted to watts
  CB_CHANNEL   UHF CB channel number (the dataset has none, so it is worked out from the frequency)

Records are sorted so every radio type sits together (cb, mvhf, mhf, ama, air), then by
TYPE (the licence subservice), state and site name.

    python update_data.py                 # download (if the cache is old) and build
    python update_data.py --inspect       # list the CSV files and columns in the zip
    python update_data.py --zip path\\to\\spectra_rrl.zip    # use a zip you already have
    python update_data.py --include-receivers              # also keep receive-side device rows
    python update_data.py --no-text       # skip licence conditions (smaller file, less memory)

Only the Python standard library is needed. The device table is about 390 MB, so
a full run takes a few minutes.

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
from collections import defaultdict
from pathlib import Path

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))  # licence condition text can be long

DOWNLOAD_URL = "https://cdn.acma.gov.au/rrl/spectra_rrl.zip"
HERE = Path(__file__).resolve().parent
CACHE_ZIP = HERE / "cache" / "spectra_rrl.zip"
OUTPUT_JSON = HERE / "data" / "repeaters.json"

STATE_ORDER = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT", "Unknown"]
RADIO_TYPE_ORDER = ["cb", "mvhf", "mhf", "ama", "air"]

DEVICE_MODE = {"T": "Transmit", "R": "Receive"}
DUPLEX_MODE = {"D": "Duplex", "S": "Simplex"}

# Fields copied from the other devices on the same station
PARTNER_FIELDS = [
    "SDD_ID", "DEVICE_TYPE", "FREQUENCY", "BANDWIDTH", "EMISSION", "TRANSMITTER_POWER",
    "TRANSMITTER_POWER_UNIT", "EFL_ID", "SITE_ID", "CALL_SIGN", "CLASS_OF_STATION_CODE", "LICENCE_NO",
]

# ---------------------------------------------------------------------------
# UHF CB repeaters: output frequency -> repeater channel
# Channels 1-8 are 25 kHz apart from 476.425 MHz; channels 41-48 sit 12.5 kHz above.
# You transmit 0.75 MHz ABOVE the repeater's output, on a channel number 30 higher
# (e.g. repeater channel 5 outputs 476.525 MHz and listens on channel 35, 477.275 MHz).
# ---------------------------------------------------------------------------
CB_REPEATER_CHANNELS = {}
for n in range(8):
    CB_REPEATER_CHANNELS[round(476.425 + 0.025 * n, 4)] = n + 1
    CB_REPEATER_CHANNELS[round(476.4375 + 0.025 * n, 4)] = n + 41
CB_INPUT_OFFSET_MHZ = 0.75
CB_INPUT_CHANNEL_OFFSET = 30

# CSV files used from the zip (all are optional except device_details, licence and site)
REQUIRED_FILES = ["device_details.csv", "licence.csv", "site.csv"]


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
# Reading CSV files straight out of the zip
# ---------------------------------------------------------------------------
def find_member(archive, filename):
    """Find a CSV inside the zip, ignoring folder prefixes and letter case."""
    for name in archive.namelist():
        if name.lower().split("/")[-1] == filename:
            return name
    return None


def read_rows(archive, filename):
    """Stream the rows of one CSV as dicts. Yields nothing if the file isn't in the zip."""
    member = find_member(archive, filename)
    if member is None:
        return
    with archive.open(member) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
        reader = csv.DictReader(text)
        reader.fieldnames = [(name or "").strip().upper() for name in reader.fieldnames or []]
        yield from reader


def load_by_key(archive, filename, key, keep=None):
    """{key: row} (last row wins). keep = optional set of keys to retain."""
    table = {}
    for row in read_rows(archive, filename):
        value = row.get(key, "")
        if keep is None or value in keep:
            table[value] = row
    return table


def inspect(archive):
    print("Files in the zip:")
    for info in archive.infolist():
        print(f"  {info.filename}  ({info.file_size / 1e6:.1f} MB)")
    for info in archive.infolist():
        if info.filename.lower().endswith(".csv"):
            with archive.open(info) as raw:
                header = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace").readline()
            print(f"\n{info.filename}\n  {header.strip()}")


# ---------------------------------------------------------------------------
# Converting values
# ---------------------------------------------------------------------------
def clean(record):
    """Drop empty values."""
    return {key: value for key, value in record.items() if value not in ("", None)}


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


def cb_channel(mhz):
    """CB repeater channel for a frequency: its output gives 1-8 / 41-48, its input gives 31-38 / 71-78."""
    mhz = round(mhz, 4)
    if mhz in CB_REPEATER_CHANNELS:
        return CB_REPEATER_CHANNELS[mhz]
    output = round(mhz - CB_INPUT_OFFSET_MHZ, 4)
    if output in CB_REPEATER_CHANNELS:
        return CB_REPEATER_CHANNELS[output] + CB_INPUT_CHANNEL_OFFSET
    return None


def band_name(mhz, radio_type):
    """Friendly band label, matching the labels the web page shows."""
    if radio_type == "cb":
        return "UHF CB"
    if radio_type == "mvhf":
        return "Marine VHF"
    if radio_type == "air" and 108 <= mhz <= 137:
        return "VHF airband"
    for low, high, label in [
        (0, 30, "HF"), (50, 54, "6 m"), (144, 148, "2 m"), (420, 450, "70 cm"), (1240, 1300, "23 cm"),
    ]:
        if low <= mhz <= high:
            return label
    if mhz >= 1300:
        return "Microwave"
    return "VHF" if mhz < 300 else "UHF"


def classify(mhz, service_text):
    """
    Work out which of the map's radio types a device belongs to, from its frequency
    and the licence's service wording. Returns None for anything else.
    """
    text = service_text.lower()
    if "amateur" in text:
        return "ama"
    if "cbrs repeater" in text or round(mhz, 4) in CB_REPEATER_CHANNELS:
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
# Build the records
# ---------------------------------------------------------------------------
def select_devices(archive, args, licences, sites, service_names, subservice_names):
    """Pass 1: stream device_details.csv and keep the rows the map needs."""
    print("Pass 1: finding the devices the map needs ...")
    kept = []
    skipped = defaultdict(int)
    for number, row in enumerate(read_rows(archive, "device_details.csv"), start=1):
        if number % 250_000 == 0:
            print(f"  read {number:,} rows, kept {len(kept):,}", end="\r", flush=True)

        licence = licences.get(row.get("LICENCE_NO", ""))
        if licence is None:
            continue
        if licence.get("STATUS", "1") not in ("1", ""):  # 1 = Granted
            skipped["licence not granted"] += 1
            continue
        if row.get("DEVICE_TYPE") == "R" and not args.include_receivers:
            skipped["receive-only"] += 1
            continue

        hz = to_float(row.get("FREQUENCY"))
        if not hz:
            continue
        mhz = hz / 1e6  # the ACMA stores frequency in Hz

        service_text = " ".join([
            service_names.get(row.get("SV_ID", ""), ""),
            subservice_names.get(row.get("SS_ID", ""), ""),
            licence.get("LICENCE_TYPE_NAME", ""),
            licence.get("LICENCE_CATEGORY_NAME", ""),
        ])
        radio_type = classify(mhz, service_text)
        if radio_type is None:
            skipped["other services"] += 1
            continue

        site = sites.get(row.get("SITE_ID", ""))
        has_coordinates = site and to_float(site.get("LATITUDE")) is not None and to_float(site.get("LONGITUDE")) is not None
        if not has_coordinates and not args.keep_no_coords:
            skipped["no coordinates"] += 1
            continue
        kept.append((row, radio_type, mhz))

    print(f"\n  kept {len(kept):,} devices. Skipped: " + ", ".join(f"{n:,} {why}" for why, n in skipped.items()))
    return kept


def collect_partners(archive, needed_equipment):
    """Pass 2: other devices on the same stations (EQP_ID), e.g. a repeater's receive side."""
    print("Pass 2: collecting other devices on the same stations ...")
    partners = defaultdict(list)
    for row in read_rows(archive, "device_details.csv"):
        equipment = row.get("EQP_ID", "")
        if equipment and equipment in needed_equipment:
            partners[equipment].append({field: row.get(field, "") for field in PARTNER_FIELDS + ["EQP_ID"]})
    return partners


def load_conditions(archive, needed_tcs, needed_licences):
    """Licence-level notes (prefix LI) and station-level conditions (prefix TCS)."""
    print("Loading licence conditions ...")
    by_tcs, by_licence = defaultdict(list), defaultdict(list)
    for row in read_rows(archive, "applic_text_block.csv"):
        prefix = row.get("APTB_TABLE_PREFIX")
        if prefix == "TCS" and row.get("APTB_TABLE_ID") in needed_tcs:
            by_tcs[row["APTB_TABLE_ID"]].append(row)
        elif prefix == "LI" and row.get("LICENCE_NO") in needed_licences:
            by_licence[row["LICENCE_NO"]].append(row)
    return by_tcs, by_licence


def build_records(archive, args):
    missing = [name for name in REQUIRED_FILES if find_member(archive, name) is None]
    if missing:
        sys.exit("Couldn't find " + ", ".join(missing) + " in the zip. Run with --inspect to see what is there.")

    print("Loading lookup tables ...")
    licences = load_by_key(archive, "licence.csv", "LICENCE_NO")
    sites = load_by_key(archive, "site.csv", "SITE_ID")
    service_names = {k: r.get("SV_NAME", "") for k, r in load_by_key(archive, "licence_service.csv", "SV_ID").items()}
    subservice_names = {k: r.get("SS_NAME", "") for k, r in load_by_key(archive, "licence_subservice.csv", "SS_ID").items()}

    kept = select_devices(archive, args, licences, sites, service_names, subservice_names)
    if not kept:
        sys.exit("No devices matched. Run with --inspect and check the column names.")

    # Keys the kept rows need from the other tables
    needed = {name: {row.get(column, "") for row, _, _ in kept} - {""}
              for name, column in [("antenna", "ANTENNA_ID"), ("licence", "LICENCE_NO"), ("tcs", "TCS_ID"),
                                   ("equipment", "EQP_ID"), ("area", "AREA_AREA_ID")]}

    partners = {} if args.no_pairs else collect_partners(archive, needed["equipment"])
    conditions_by_tcs, conditions_by_licence = ({}, {}) if args.no_text else load_conditions(
        archive, needed["tcs"], needed["licence"])

    print("Loading the remaining lookup tables ...")
    antennas = load_by_key(archive, "antenna.csv", "ANTENNA_ID", needed["antenna"])
    client_numbers = {licences[no].get("CLIENT_NO", "") for no in needed["licence"]} - {""}
    clients = load_by_key(archive, "client.csv", "CLIENT_NO", client_numbers)
    industries = load_by_key(archive, "industry_cat.csv", "CAT_ID")
    client_types = load_by_key(archive, "client_type.csv", "TYPE_ID")
    fee_statuses = load_by_key(archive, "fee_status.csv", "FEE_STATUS_ID")
    licensing_areas = load_by_key(archive, "licensing_area.csv", "LICENSING_AREA_ID")
    access_areas = load_by_key(archive, "access_area.csv", "AREA_ID", needed["area"])
    polarisations = load_by_key(archive, "antenna_polarity.csv", "POLARISATION_CODE")
    classes_of_station = load_by_key(archive, "class_of_station.csv", "CODE")
    natures_of_service = load_by_key(archive, "nature_of_service.csv", "CODE")

    def condition(row, level):
        return clean({"level": level, "category": row.get("APTB_CATEGORY", ""), "item": row.get("APTB_ITEM", ""),
                      "description": row.get("APTB_DESCRIPTION", ""), "text": row.get("APTB_TEXT", "")})

    def build(row, radio_type, mhz):
        record = clean(row)
        record["FREQUENCY_MHZ"] = round(mhz, 6)
        record["DEVICE_MODE"] = DEVICE_MODE.get(row.get("DEVICE_TYPE", ""), "")
        if row.get("LEQD_MODE"):
            record["DUPLEX_MODE"] = DUPLEX_MODE.get(row["LEQD_MODE"], row["LEQD_MODE"])
        record["SERVICE_NAME"] = service_names.get(row.get("SV_ID", ""), "")
        record["SUBSERVICE_NAME"] = subservice_names.get(row.get("SS_ID", ""), "")
        record["CLASS_OF_STATION_DESCRIPTION"] = classes_of_station.get(row.get("CLASS_OF_STATION_CODE", ""), {}).get("DESCRIPTION", "")
        record["NATURE_OF_SERVICE_DESCRIPTION"] = natures_of_service.get(row.get("NATURE_OF_SERVICE_ID", ""), {}).get("DESCRIPTION", "")
        record["POLARISATION_TEXT"] = polarisations.get(row.get("POLARISATION", ""), {}).get("POLARISATION_TEXT", "")

        site = sites.get(row.get("SITE_ID", ""))
        site_record = {}
        if site:
            site_record = dict(site)
            site_record["LICENSING_AREA"] = licensing_areas.get(site.get("LICENSING_AREA_ID", ""), {}).get("DESCRIPTION", "")
            record["site"] = clean(site_record)
        record["STATE"] = normalise_state(site_record.get("STATE", ""))
        record["TYPE"] = record["SUBSERVICE_NAME"] or record["SERVICE_NAME"] or "UNKNOWN"

        # Fields added for the map
        record["RADIO_TYPE"] = radio_type
        record["BAND"] = band_name(mhz, radio_type)
        record["POWER_WATTS"] = to_watts(row.get("TRANSMITTER_POWER"), row.get("TRANSMITTER_POWER_UNIT"))
        if radio_type == "cb":
            record["CB_CHANNEL"] = cb_channel(mhz)

        licence = licences.get(row.get("LICENCE_NO", ""))
        if licence:
            record["licence"] = clean(licence)
            client = clients.get(licence.get("CLIENT_NO", ""))
            if client:
                client_record = dict(client)
                client_record["INDUSTRY_CATEGORY"] = industries.get(client.get("CAT_ID", ""), {}).get("NAME", "")
                client_record["INDUSTRY_DESCRIPTION"] = industries.get(client.get("CAT_ID", ""), {}).get("DESCRIPTION", "")
                client_record["CLIENT_TYPE"] = client_types.get(client.get("CLIENT_TYPE_ID", ""), {}).get("NAME", "")
                client_record["FEE_STATUS"] = fee_statuses.get(client.get("FEE_STATUS_ID", ""), {}).get("FEE_STATUS_TEXT", "")
                record["client"] = clean(client_record)

        if row.get("ANTENNA_ID") in antennas:
            record["antenna"] = clean(antennas[row["ANTENNA_ID"]])
        if row.get("AREA_AREA_ID") in access_areas:
            record["area"] = clean(access_areas[row["AREA_AREA_ID"]])

        conditions = [condition(r, "licence") for r in conditions_by_licence.get(row.get("LICENCE_NO", ""), [])]
        conditions += [condition(r, "station") for r in conditions_by_tcs.get(row.get("TCS_ID", ""), [])]
        if conditions:
            record["conditions"] = conditions

        others = []
        for partner in partners.get(row.get("EQP_ID", ""), []):
            if partner["LICENCE_NO"] != row.get("LICENCE_NO") or partner["SDD_ID"] == row.get("SDD_ID"):
                continue
            other = clean({field: partner[field] for field in PARTNER_FIELDS if field != "LICENCE_NO"})
            other_mhz = to_float(other.get("FREQUENCY"))
            if other_mhz:
                other["FREQUENCY_MHZ"] = round(other_mhz / 1e6, 6)
            other["DEVICE_MODE"] = DEVICE_MODE.get(other.get("DEVICE_TYPE", ""), "")
            others.append(other)
        if others:
            record["same_station_devices"] = others

        return {key: value for key, value in record.items() if value not in ("", None)}

    return [build(row, radio_type, mhz) for row, radio_type, mhz in kept]


def sort_key(record):
    """Bundle by radio type, then licence subservice (TYPE), state, site name and frequency."""
    return (
        RADIO_TYPE_ORDER.index(record["RADIO_TYPE"]),
        record["TYPE"],
        STATE_ORDER.index(record["STATE"]),
        record.get("site", {}).get("NAME", ""),
        record["FREQUENCY_MHZ"],
    )


# ---------------------------------------------------------------------------
# Writing the output
# ---------------------------------------------------------------------------
def write_output(records, output_path):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as out:
        out.write("[\n")
        out.write(",\n".join(json.dumps(record, ensure_ascii=False) for record in records))
        out.write("\n]\n")
    print(f"Wrote {len(records):,} records to {output_path} ({output_path.stat().st_size / 1e6:.1f} MB)")

    counts = defaultdict(int)
    for record in records:
        counts[record["RADIO_TYPE"]] += 1
    print("By radio type:", ", ".join(f"{t} {counts[t]:,}" for t in RADIO_TYPE_ORDER))


def main():
    parser = argparse.ArgumentParser(
        description="Build data/repeaters.json from the ACMA RRL download.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--zip", help="use this spectra_rrl.zip instead of downloading")
    parser.add_argument("-o", "--output", type=Path, default=OUTPUT_JSON, help="output file (default data/repeaters.json)")
    parser.add_argument("--force", action="store_true", help="download even if the cached copy is recent")
    parser.add_argument("--max-age-hours", type=float, default=24, help="re-download if the cache is older than this")
    parser.add_argument("--inspect", action="store_true", help="list the CSV files and columns, then stop")
    parser.add_argument("--keep-no-coords", action="store_true", help="keep devices whose site has no latitude/longitude")
    parser.add_argument("--include-receivers", action="store_true",
                        help="also write receive-only device rows (they are already listed under same_station_devices)")
    parser.add_argument("--no-text", action="store_true", help="skip licence conditions (smaller file, less memory)")
    parser.add_argument("--no-pairs", action="store_true", help="skip same_station_devices (saves a pass)")
    args = parser.parse_args()

    zip_path = Path(args.zip) if args.zip else download_zip(args.max_age_hours, args.force)
    with zipfile.ZipFile(zip_path) as archive:
        if args.inspect:
            return inspect(archive)
        records = build_records(archive, args)

    records.sort(key=sort_key)
    write_output(records, args.output)


if __name__ == "__main__":
    main()
