#!/usr/bin/env python3
"""
Extract every device_details record from the ACMA spectra_rrl dataset and
populate it with ALL the information linked to it in the other tables.

Each output record is the original device_details row (empty fields dropped)
plus:

  STATE, TYPE, FREQUENCY_MHZ, readable labels (device mode, duplex, service,
  subservice, class of station, nature of service, polarisation)

  "site"        site.csv + licensing area                      (via SITE_ID)
  "licence"     licence.csv                                    (via LICENCE_NO)
  "client"      client.csv + industry, client type, fee status (via licence CLIENT_NO)
  "antenna"     antenna.csv (+ "pattern" rows with --patterns) (via ANTENNA_ID)
  "area"        access_area.csv                                (via AREA_AREA_ID)
  "satellite"   satellite.csv                                  (via SA_ID)
  "broadcast"   bsl.csv + bsl_area.csv                         (via licence BSL_NO)
  "spectrum_authorisation"  auth_spectrum_freq/area.csv        (via LICENCE_NO)
  "conditions"  applic_text_block.csv: licence-level notes (prefix LI, via
                LICENCE_NO) and station-level special conditions / advisory
                notes (prefix TCS, via TCS_ID)
  "same_station_devices"  other device rows sharing the same EQP_ID and
                LICENCE_NO, e.g. the receive side of a repeater

Output layout (--layout):
  type         <out>/<type>.json             all states together, each record has STATE (default)
  state-type   <out>/<STATE>/<type>.json
  single       <out>/all_devices.json

"type" (--type-by): subservice (default) | service | device | class

Usage:
  python extract_device_details.py /path/to/unzipped_spectra_rrl -o out
  python extract_device_details.py /path/to/unzipped_spectra_rrl -o uhf --min-mhz 476 --max-mhz 478

Notes:
  * It makes three streaming passes over device_details.csv (it is ~390 MB).
  * Lookup tables are loaded into memory. With --min-mhz/--max-mhz only the rows
    needed are kept; for a full unfiltered run allow several GB of RAM, and
    expect very large JSON output.
  * The dataset has no UHF CB channel numbers, so none are added.

Needs: pandas  (pip install pandas)
"""
import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import pandas as pd

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

DEVICE_MODE = {"T": "Transmit", "R": "Receive"}
DUPLEX = {"D": "Duplex", "S": "Simplex"}

PARTNER_FIELDS = ["SDD_ID", "DEVICE_TYPE", "FREQUENCY", "BANDWIDTH", "EMISSION",
                  "TRANSMITTER_POWER", "TRANSMITTER_POWER_UNIT", "EFL_ID",
                  "SITE_ID", "CALL_SIGN", "CLASS_OF_STATION_CODE", "LICENCE_NO"]


# ------------------------------------------------------------------ helpers
def safe_name(value) -> str:
    value = re.sub(r"[^\w.\- ]+", "_", str(value)).strip(" ._")
    return value or "UNKNOWN"


def clean(d: dict) -> dict:
    """Drop empty values."""
    return {k: v for k, v in d.items() if v not in ("", None)}


def read_rows(path: Path):
    with open(path, encoding="utf-8", errors="replace", newline="") as fh:
        yield from csv.DictReader(fh)


def load_by_key(path: Path, key: str, keep=None) -> dict:
    """{key: row} (last row wins). keep = optional set of keys to retain."""
    out = {}
    if not path.exists():
        return out
    for r in read_rows(path):
        k = r[key]
        if keep is None or k in keep:
            out[k] = r
    return out


def load_multi(path: Path, key: str, keep=None) -> dict:
    """{key: [rows]}."""
    out = defaultdict(list)
    if not path.exists():
        return out
    for r in read_rows(path):
        k = r[key]
        if keep is None or k in keep:
            out[k].append(r)
    return out


class JsonArrayWriter:
    def __init__(self):
        self.started = set()

    def write(self, path: Path, records: list):
        if not records:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        body = ",\n".join(json.dumps(r, ensure_ascii=False) for r in records)
        with open(path, "a", encoding="utf-8") as fh:
            if path in self.started:
                fh.write(",\n")
            else:
                fh.write("[\n")
                self.started.add(path)
            fh.write(body)

    def close_all(self):
        for p in self.started:
            with open(p, "a", encoding="utf-8") as fh:
                fh.write("\n]\n")


def freq_filter(chunk: pd.DataFrame, lo, hi) -> pd.DataFrame:
    if lo is None and hi is None:
        return chunk
    f = pd.to_numeric(chunk["FREQUENCY"], errors="coerce") / 1e6
    keep = pd.Series(True, index=chunk.index)
    if lo is not None:
        keep &= f >= lo
    if hi is not None:
        keep &= f <= hi
    return chunk[keep]


def read_device_chunks(path: Path, chunk: int, usecols=None):
    return pd.read_csv(path, dtype=str, keep_default_na=False, chunksize=chunk,
                       usecols=usecols, encoding="utf-8", encoding_errors="replace")


# --------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("data_dir", type=Path, help="folder with the unzipped ACMA CSVs")
    ap.add_argument("-o", "--out", type=Path, default=Path("device_full"))
    ap.add_argument("--layout", choices=["type", "state-type", "single"], default="type")
    ap.add_argument("--type-by", choices=["subservice", "service", "device", "class"],
                    default="subservice")
    ap.add_argument("--min-mhz", type=float)
    ap.add_argument("--max-mhz", type=float)
    ap.add_argument("--chunk", type=int, default=250_000)
    ap.add_argument("--patterns", action="store_true",
                    help="also include antenna pattern rows (can be large)")
    ap.add_argument("--no-text", action="store_true",
                    help="skip applic_text_block conditions (saves memory/time)")
    ap.add_argument("--no-pairs", action="store_true",
                    help="skip same_station_devices (saves a pass)")
    args = ap.parse_args()

    D = args.data_dir
    dd_path = D / "device_details.csv"
    if not dd_path.exists():
        sys.exit(f"Missing {dd_path}")
    if args.out.exists() and any(args.out.rglob("*.json")):
        sys.exit(f"{args.out}/ already contains .json files. Use an empty or new folder.")
    args.out.mkdir(parents=True, exist_ok=True)

    # ---------- pass A: which keys are needed by the rows we will keep -------
    print("Pass 1: finding rows and the keys they need ...")
    need = {k: set() for k in ("site", "antenna", "licence", "tcs", "eqp", "area", "sat")}
    kept = 0
    cols = ["FREQUENCY", "SITE_ID", "ANTENNA_ID", "LICENCE_NO", "TCS_ID",
            "EQP_ID", "AREA_AREA_ID", "SA_ID"]
    for ch in read_device_chunks(dd_path, args.chunk, usecols=cols):
        ch = freq_filter(ch, args.min_mhz, args.max_mhz)
        kept += len(ch)
        for col, key in (("SITE_ID", "site"), ("ANTENNA_ID", "antenna"),
                         ("LICENCE_NO", "licence"), ("TCS_ID", "tcs"),
                         ("EQP_ID", "eqp"), ("AREA_AREA_ID", "area"), ("SA_ID", "sat")):
            need[key].update(v for v in ch[col].unique() if v)
    print(f"  {kept:,} device rows to extract")
    if kept == 0:
        sys.exit("No rows match the frequency filter.")

    # ---------- pass B: other devices on the same station (EQP_ID) -----------
    pairs = defaultdict(list)
    if not args.no_pairs and need["eqp"]:
        print("Pass 2: collecting other devices on the same stations ...")
        for ch in read_device_chunks(dd_path, args.chunk,
                                     usecols=PARTNER_FIELDS + ["EQP_ID"]):
            ch = ch[ch["EQP_ID"].isin(need["eqp"])]
            for r in ch.to_dict("records"):
                pairs[r["EQP_ID"]].append(r)

    # ---------- lookups -------------------------------------------------------
    print("Loading lookup tables ...")
    site = load_by_key(D / "site.csv", "SITE_ID", need["site"])
    antenna = load_by_key(D / "antenna.csv", "ANTENNA_ID", need["antenna"])
    licence = load_by_key(D / "licence.csv", "LICENCE_NO", need["licence"])
    client_nos = {l["CLIENT_NO"] for l in licence.values() if l.get("CLIENT_NO")}
    client = load_by_key(D / "client.csv", "CLIENT_NO", client_nos)
    industry = load_by_key(D / "industry_cat.csv", "CAT_ID")
    client_type = load_by_key(D / "client_type.csv", "TYPE_ID")
    fee_status = load_by_key(D / "fee_status.csv", "FEE_STATUS_ID")
    lic_area = load_by_key(D / "licensing_area.csv", "LICENSING_AREA_ID")
    access_area = load_by_key(D / "access_area.csv", "AREA_ID", need["area"])
    satellite = load_by_key(D / "satellite.csv", "SA_ID", need["sat"])
    pol = load_by_key(D / "antenna_polarity.csv", "POLARISATION_CODE")
    cos = load_by_key(D / "class_of_station.csv", "CODE")
    nos = load_by_key(D / "nature_of_service.csv", "CODE")
    sv = load_by_key(D / "licence_service.csv", "SV_ID")
    ss = load_by_key(D / "licence_subservice.csv", "SS_ID")
    bsl_nos = {l["BSL_NO"] for l in licence.values() if l.get("BSL_NO")}
    bsl = load_by_key(D / "bsl.csv", "BSL_NO", bsl_nos)
    bsl_area = load_by_key(D / "bsl_area.csv", "AREA_CODE")
    spec_freq = load_multi(D / "auth_spectrum_freq.csv", "LICENCE_NO", need["licence"])
    spec_area = load_multi(D / "auth_spectrum_area.csv", "LICENCE_NO", need["licence"])
    patterns = (load_multi(D / "antenna_pattern.csv", "ANTENNA_ID", need["antenna"])
                if args.patterns else {})

    tcs_text, lic_text = defaultdict(list), defaultdict(list)
    if not args.no_text:
        print("Loading conditions / advisory notes (applic_text_block) ...")
        for r in read_rows(D / "applic_text_block.csv"):
            if r["APTB_TABLE_PREFIX"] == "TCS" and r["APTB_TABLE_ID"] in need["tcs"]:
                tcs_text[r["APTB_TABLE_ID"]].append(r)
            elif r["APTB_TABLE_PREFIX"] == "LI" and r["LICENCE_NO"] in need["licence"]:
                lic_text[r["LICENCE_NO"]].append(r)

    def cond(r, level):
        return clean({"level": level, "category": r["APTB_CATEGORY"],
                      "item": r["APTB_ITEM"], "description": r["APTB_DESCRIPTION"],
                      "text": r["APTB_TEXT"]})

    def type_of(row) -> str:
        if args.type_by == "device":
            return row["DEVICE_TYPE"] or "UNKNOWN"
        if args.type_by == "class":
            return row["CLASS_OF_STATION_CODE"] or "UNKNOWN"
        if args.type_by == "service":
            return sv.get(row["SV_ID"], {}).get("SV_NAME") or f"SV_{row['SV_ID'] or 'UNKNOWN'}"
        return ss.get(row["SS_ID"], {}).get("SS_NAME") or f"SS_{row['SS_ID'] or 'UNKNOWN'}"

    # ---------- build one enriched record ------------------------------------
    def build(row: dict) -> dict:
        rec = clean(row)
        try:
            rec["FREQUENCY_MHZ"] = round(float(row["FREQUENCY"]) / 1e6, 6)
        except ValueError:
            pass
        rec["DEVICE_MODE"] = DEVICE_MODE.get(row["DEVICE_TYPE"], "")
        if row["LEQD_MODE"]:
            rec["DUPLEX_MODE"] = DUPLEX.get(row["LEQD_MODE"], row["LEQD_MODE"])
        rec["SERVICE_NAME"] = sv.get(row["SV_ID"], {}).get("SV_NAME", "")
        rec["SUBSERVICE_NAME"] = ss.get(row["SS_ID"], {}).get("SS_NAME", "")
        rec["CLASS_OF_STATION_DESCRIPTION"] = cos.get(row["CLASS_OF_STATION_CODE"], {}).get("DESCRIPTION", "")
        rec["NATURE_OF_SERVICE_DESCRIPTION"] = nos.get(row["NATURE_OF_SERVICE_ID"], {}).get("DESCRIPTION", "")
        rec["POLARISATION_TEXT"] = pol.get(row["POLARISATION"], {}).get("POLARISATION_TEXT", "")

        s = site.get(row["SITE_ID"])
        state = ""
        if s:
            state = s.get("STATE", "")
            sd = dict(s)
            sd["LICENSING_AREA"] = lic_area.get(s.get("LICENSING_AREA_ID", ""), {}).get("DESCRIPTION", "")
            rec["site"] = clean(sd)
        rec["STATE"] = state or "NO_SITE"
        rec["TYPE"] = type_of(row)

        lic = licence.get(row["LICENCE_NO"])
        if lic:
            rec["licence"] = clean(lic)
            c = client.get(lic.get("CLIENT_NO", ""))
            if c:
                cd = dict(c)
                cd["INDUSTRY_CATEGORY"] = industry.get(c.get("CAT_ID", ""), {}).get("NAME", "")
                cd["INDUSTRY_DESCRIPTION"] = industry.get(c.get("CAT_ID", ""), {}).get("DESCRIPTION", "")
                cd["CLIENT_TYPE"] = client_type.get(c.get("CLIENT_TYPE_ID", ""), {}).get("NAME", "")
                cd["FEE_STATUS"] = fee_status.get(c.get("FEE_STATUS_ID", ""), {}).get("FEE_STATUS_TEXT", "")
                rec["client"] = clean(cd)
            b = bsl.get(lic.get("BSL_NO", ""))
            if b:
                bd = dict(b)
                bd["AREA_NAME"] = bsl_area.get(b.get("AREA_CODE", ""), {}).get("AREA_NAME", "")
                rec["broadcast"] = clean(bd)

        a = antenna.get(row["ANTENNA_ID"])
        if a:
            ad = clean(a)
            if args.patterns and row["ANTENNA_ID"] in patterns:
                ad["pattern"] = [clean(p) for p in patterns[row["ANTENNA_ID"]]]
            rec["antenna"] = ad
        if row["AREA_AREA_ID"] in access_area:
            rec["area"] = clean(access_area[row["AREA_AREA_ID"]])
        if row["SA_ID"] in satellite:
            rec["satellite"] = clean(satellite[row["SA_ID"]])

        lno = row["LICENCE_NO"]
        if lno in spec_freq or lno in spec_area:
            rec["spectrum_authorisation"] = {
                "frequencies": [clean(x) for x in spec_freq.get(lno, [])],
                "areas": [clean(x) for x in spec_area.get(lno, [])]}

        conds = [cond(r, "licence") for r in lic_text.get(lno, [])]
        conds += [cond(r, "station") for r in tcs_text.get(row["TCS_ID"], [])]
        if conds:
            rec["conditions"] = conds

        if row["EQP_ID"] and row["EQP_ID"] in pairs:
            others = [clean({k: p[k] for k in PARTNER_FIELDS if k != "LICENCE_NO"})
                      for p in pairs[row["EQP_ID"]]
                      if p["LICENCE_NO"] == lno and p["SDD_ID"] != row["SDD_ID"]]
            for o in others:
                if "FREQUENCY" in o:
                    try:
                        o["FREQUENCY_MHZ"] = round(float(o["FREQUENCY"]) / 1e6, 6)
                    except ValueError:
                        pass
                o["DEVICE_MODE"] = DEVICE_MODE.get(o.get("DEVICE_TYPE", ""), "")
            if others:
                rec["same_station_devices"] = others
        return {k: v for k, v in rec.items() if v not in ("", None)}

    # ---------- pass C: write -------------------------------------------------
    print("Pass 3: writing JSON ...")
    writer = JsonArrayWriter()
    total = 0
    for ch in read_device_chunks(dd_path, args.chunk):
        ch = freq_filter(ch, args.min_mhz, args.max_mhz)
        if ch.empty:
            continue
        buckets = defaultdict(list)
        for row in ch.to_dict("records"):
            rec = build(row)
            if args.layout == "single":
                path = args.out / "all_devices.json"
            elif args.layout == "state-type":
                path = args.out / safe_name(rec["STATE"]) / f"{safe_name(rec['TYPE'])}.json"
            else:
                path = args.out / f"{safe_name(rec['TYPE'])}.json"
            buckets[path].append(rec)
        for path, recs in buckets.items():
            writer.write(path, recs)
            total += len(recs)
        print(f"  wrote {total:,} / {kept:,}", end="\r", flush=True)

    writer.close_all()
    print(f"\nDone: {total:,} records in {len(writer.started)} file(s) under {args.out}/")


if __name__ == "__main__":
    main()
