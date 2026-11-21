"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Column positions inside each station array
const FIELD = {
    state: 0, siteName: 1, postcode: 2, lat: 3, lon: 4, callSign: 5, licenceNumber: 6,
    channel: 7, outputMhz: 8, powerWatts: 9, antennaHeightM: 10, polarisation: 11,
    licenceDate: 12, antennaType: 13, radioType: 14, emission: 15, bandwidthKhz: 16, band: 17,
    inputMhz: 18, // CB repeaters: the frequency you transmit on (the repeater's input), when known
    licensee: 19,
};

const STATE_ORDER = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT", "Unknown"];

// The radio types update_data.py writes (RADIO_TYPE). cb: true means the category has UHF CB
// channels (RX/TX channel numbers). Records without a known RADIO_TYPE get their own category
// (see addRecordsToCategories).
const DEFAULT_RADIO_TYPES = [
    { id: "cb", label: "UHF CB", color: "#0d6a5a", cb: true },
    { id: "mvhf", label: "Marine VHF", color: "#2f7de1" },
    { id: "mhf", label: "Marine HF", color: "#9a63d6" },
    { id: "ama", label: "Amateur", color: "#d9822b" },
    { id: "air", label: "Aeronautical", color: "#8a9a93" },
];
let RADIO_TYPES, TYPE_LABEL, TYPE_COLOR;
function setRadioTypes(list) {
    RADIO_TYPES = list;
    TYPE_LABEL = Object.fromEntries(list.map((t) => [t.id, t.label]));
    TYPE_COLOR = Object.fromEntries(list.map((t) => [t.id, t.color]));
}
setRadioTypes(DEFAULT_RADIO_TYPES);
const typeIsCb = (id) => RADIO_TYPES.some((t) => t.id === id && t.cb);

// Colours for categories that aren't one of the known radio types (UHF CB keeps its green)
const CATEGORY_PALETTE = [
    "#2f7de1", "#9a63d6", "#d9822b", "#c2417a", "#4f8f2f", "#b8860b",
    "#0e8aa8", "#7a5230", "#5b6bd6", "#a34f4f", "#3b8f86", "#6d7f2b",
];
const CB_COLOR = "#0d6a5a";
const EMERGENCY_COLOR = "#b3261e";

// UHF CB repeaters: you listen on the repeater channel and transmit 30 channels
// higher, which is 0.75 MHz ABOVE the repeater's output frequency (e.g. ch 43 listens on
// 476.4875 MHz and you transmit on ch 73, 477.2375 MHz).
const CB_TX_CHANNEL_OFFSET = 30;
const CB_TX_FREQUENCY_OFFSET_MHZ = 0.75;
const EMERGENCY_CHANNEL = 5;
const MAX_LABELLED_LINES = 25; // permanent labels on hundreds of lines are unreadable

const SETTINGS_KEY = "auRadioMap.settings.v1";
const DB_NAME = "auRadioMap";
const DB_STORE = "cache";
const DB_KEY = "stations2"; // { stations, types }

const DEFAULT_SETTINGS = {
    radioType: "cb",
    state: "All",
    channel: "",
    filterText: "",
    nearestCount: "5",
    showLines: true,
    showDistanceLabels: true,
    showChannelLabels: true,
    baseMap: "Streets (Esri)",
    compassMode: "north", // "north" or "follow"
    liveGps: false, // true: keep following your position; false: take one reading
    location: null, // { lat, lon, label, query }
    view: null, // { lat, lon, zoom }
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const el = (id) => document.getElementById(id);

function escapeHtml(text) {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
    return String(text).replace(/[&<>"]/g, (c) => entities[c]);
}

function distanceKm(from, to) {
    const toRad = Math.PI / 180;
    const dLat = (to[0] - from[0]) * toRad;
    const dLon = (to[1] - from[1]) * toRad;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(from[0] * toRad) * Math.cos(to[0] * toRad) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
}

function formatKm(km) {
    return (km < 10 ? km.toFixed(1) : Math.round(km)) + " km";
}

const hasPosition = (s) => s[FIELD.lat] != null;
const isCb = (s) => s[FIELD.channel] != null;
const isEmergency = (s) => s[FIELD.channel] === EMERGENCY_CHANNEL;
const cbTxChannel = (s) => s[FIELD.channel] + CB_TX_CHANNEL_OFFSET;
const cbTxMhz = (s) =>
    s[FIELD.inputMhz] != null ? s[FIELD.inputMhz] : s[FIELD.outputMhz] + CB_TX_FREQUENCY_OFFSET_MHZ;
// Exact frequency text: shows every decimal place the licence actually has (up to 6, e.g. the
// 6.25 kHz steps like 477.43125), never fewer than minDecimals. toFixed(3) used to turn
// 476.4875 into 476.488.
function fmtMhz(value, minDecimals = 3) {
    let text = value.toFixed(6);
    let trim = 0;
    while (trim < 6 - minDecimals && text.endsWith("0", text.length - trim)) trim++;
    return trim ? text.slice(0, text.length - trim) : text;
}
const mhz = (value) => fmtMhz(value, 4) + " MHz";

// Short badge text: CB channel number, or frequency for other radio types
const badgeText = (s) => (isCb(s) ? s[FIELD.channel] : fmtMhz(s[FIELD.outputMhz]));

// One-line RX / TX summary with channels and frequencies
function frequencySummary(s) {
    if (!isCb(s)) {
        return `${TYPE_LABEL[s[FIELD.radioType]]} &middot; station transmits ${mhz(s[FIELD.outputMhz])}`;
    }
    return (
        `RX ch ${s[FIELD.channel]} (${mhz(s[FIELD.outputMhz])}) &middot; ` +
        `TX ch ${cbTxChannel(s)} (${mhz(cbTxMhz(s))})`
    );
}

// ---------------------------------------------------------------------------
// Saved settings (localStorage)
// ---------------------------------------------------------------------------

let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
    try {
        settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
    } catch (error) {
        settings = { ...DEFAULT_SETTINGS };
    }
    // The map API key box has been removed: drop any key an earlier version saved in this browser
    if ("apiKeys" in settings) {
        delete settings.apiKeys;
        saveSettings();
    }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
        /* storage unavailable (private mode etc.), carry on without saving */
    }
}

// ---------------------------------------------------------------------------
// Station data cache: the last data loaded is kept in IndexedDB so the page still opens offline
// ---------------------------------------------------------------------------

function openCacheDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function writeCache(stations, types) {
    const db = await openCacheDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).put({ stations, types }, DB_KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function readCache() {
    const db = await openCacheDb();
    return new Promise((resolve, reject) => {
        const request = db.transaction(DB_STORE).objectStore(DB_STORE).get(DB_KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ---------------------------------------------------------------------------
// Data: data/repeaters.json (written by update_data.py), one category per TYPE
// ---------------------------------------------------------------------------

const DATA_DIR = "./data/";
const MAIN_DATA_FILE = "repeaters.json";
const CB_LABEL_PATTERN = /cbrs|uhf[\s_-]*cb/i;
const isDataFile = (name) => /\.json$/i.test(name) && name.toLowerCase() !== "manifest.json";
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

// Fetches one JSON file from the data folder. Returns the array of records, or null.
async function fetchRecords(file) {
    try {
        const response = await fetch(DATA_DIR + encodePath(file));
        if (!response.ok) return null;
        const data = await response.json();
        return Array.isArray(data) ? data : null;
    } catch (error) {
        return null; // one bad file shouldn't stop the others
    }
}

// Fallback for older layouts (one JSON file per type): read the folder's directory listing.
// Static hosts like GitHub Pages don't offer a listing, which is fine, repeaters.json is tried first.
async function listDataFiles() {
    try {
        const response = await fetch(DATA_DIR);
        if (!response.ok) return [];
        const doc = new DOMParser().parseFromString(await response.text(), "text/html");
        const names = [...doc.querySelectorAll("a[href]")]
            .map((a) => a.getAttribute("href").split(/[?#]/)[0].split("/").pop())
            .map((name) => {
                try {
                    return decodeURIComponent(name);
                } catch (error) {
                    return name;
                }
            })
            .filter((name) => name && isDataFile(name));
        return [...new Set(names)];
    } catch (error) {
        return [];
    }
}

// UHF CB repeater outputs (what you listen on). Channels 1-8 are on the 25 kHz grid from
// 476.425 MHz; channels 41-48 are the 12.5 kHz-offset block from 476.4375 MHz. Used only when
// a record has no CB_CHANNEL of its own.
function cbChannelFromMhz(mhzValue) {
    const slot = (start) => {
        const n = (mhzValue - start) / 0.025;
        return Math.abs(n - Math.round(n)) < 0.01 && Math.round(n) >= 0 && Math.round(n) <= 7 ? Math.round(n) : null;
    };
    const low = slot(476.425);
    if (low != null) return low + 1;
    const high = slot(476.4375);
    if (high != null) return high + 41;
    return null;
}

const toNumber = (value) => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
};

function powerInWatts(record) {
    const power = toNumber(record.TRANSMITTER_POWER);
    if (power == null) return null;
    const unit = String(record.TRANSMITTER_POWER_UNIT || "W").toLowerCase();
    return unit === "w" ? power : unit === "kw" ? power * 1000 : null;
}

// A record's frequency in MHz (FREQUENCY_MHZ, or FREQUENCY which the ACMA gives in Hz)
function recordMhz(record) {
    const mhzValue = toNumber(record.FREQUENCY_MHZ);
    if (mhzValue != null) return mhzValue;
    const hz = toNumber(record.FREQUENCY);
    return hz != null ? hz / 1e6 : null;
}

// Converts one record from data/repeaters.json to the array form used by the page.
// The extra fields written by update_data.py (CB_CHANNEL, POWER_WATTS, BAND) are used when present.
function stationFromRecord(record, typeId, cbType) {
    const site = record.site || {};
    const frequency = recordMhz(record);
    if (frequency == null) return null;
    const antenna = record.antenna || {};
    const receiveSide = (record.same_station_devices || []).find((d) => d.DEVICE_TYPE === "R");
    const receiveMhz = receiveSide ? recordMhz(receiveSide) : null;
    const stateName = record.STATE && record.STATE !== "NO_SITE" ? record.STATE : site.STATE || "Unknown";
    const bandwidthHz = toNumber(record.BANDWIDTH);

    const s = new Array(Object.keys(FIELD).length).fill(null);
    s[FIELD.state] = stateName;
    s[FIELD.siteName] = site.NAME || "";
    s[FIELD.postcode] = site.POSTCODE || "";
    s[FIELD.lat] = toNumber(site.LATITUDE);
    s[FIELD.lon] = toNumber(site.LONGITUDE);
    s[FIELD.callSign] = record.CALL_SIGN || "";
    s[FIELD.licenceNumber] = record.LICENCE_NO || "";
    s[FIELD.channel] = cbType ? toNumber(record.CB_CHANNEL) ?? cbChannelFromMhz(frequency) : null;
    s[FIELD.outputMhz] = frequency;
    s[FIELD.powerWatts] = toNumber(record.POWER_WATTS) ?? powerInWatts(record);
    s[FIELD.antennaHeightM] = toNumber(record.HEIGHT);
    s[FIELD.polarisation] = record.POLARISATION || "";
    s[FIELD.licenceDate] = (record.licence && record.licence.DATE_ISSUED) || record.AUTHORISATION_DATE || "";
    s[FIELD.antennaType] = [antenna.ANTENNA_TYPE, antenna.MODEL].filter(Boolean).join(" ");
    s[FIELD.radioType] = typeId;
    s[FIELD.emission] = (record.EMISSION || "").trim();
    s[FIELD.bandwidthKhz] = bandwidthHz != null ? bandwidthHz / 1000 : null;
    s[FIELD.band] = record.BAND || record.SERVICE_NAME || record.SUBSERVICE_NAME || "";
    s[FIELD.inputMhz] = receiveMhz;
    s[FIELD.licensee] = (record.client && record.client.LICENCEE) || "";
    return s;
}

// Sorts records into categories. Records from update_data.py carry a RADIO_TYPE, which keeps the
// familiar labels (UHF CB, Marine VHF, Marine HF, Amateur, Aeronautical). Anything without one
// falls back to its TYPE field, then to the file name.
const KNOWN_TYPES = Object.fromEntries(DEFAULT_RADIO_TYPES.map((t, index) => [t.id, { ...t, order: index }]));

function addRecordsToCategories(categories, records, file) {
    const fileLabel = file.split("/").pop().replace(/\.json$/i, "");
    const groups = new Map(); // category id -> { label, known, records }
    records.forEach((record) => {
        const known = KNOWN_TYPES[record.RADIO_TYPE];
        const label = known
            ? known.label
            : String(record.TYPE || fileLabel).replace(/_/g, " ").replace(/\s+/g, " ").trim() || fileLabel;
        const id = known ? known.id : label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "other";
        if (!groups.has(id)) groups.set(id, { label, known, records: [] });
        groups.get(id).records.push(record);
    });

    groups.forEach(({ label, known, records: groupRecords }, id) => {
        if (!categories.has(id)) {
            const isCbType = known ? !!known.cb : CB_LABEL_PATTERN.test(label);
            categories.set(id, { id, label, cb: isCbType, color: known ? known.color : null, order: known ? known.order : 99, stations: [] });
        }
        const category = categories.get(id);
        // Repeaters have a transmit and a receive row; show each station once, by its transmit row
        const hasTransmit = groupRecords.some((r) => r.DEVICE_TYPE === "T");
        groupRecords.forEach((record) => {
            if (hasTransmit && record.DEVICE_TYPE !== "T") return;
            const station = stationFromRecord(record, id, category.cb);
            if (station) category.stations.push(station);
        });
    });
}

async function loadDataFolder() {
    if (location.protocol === "file:") return null; // browsers block fetch() on file:// pages

    el("status").textContent = "Loading station data...";
    let sources = [];
    const main = await fetchRecords(MAIN_DATA_FILE);
    if (main) {
        sources = [{ file: MAIN_DATA_FILE, records: main }];
    } else {
        const files = await listDataFiles();
        const loaded = await Promise.all(files.map(async (file) => ({ file, records: await fetchRecords(file) })));
        sources = loaded.filter((entry) => entry.records);
    }
    if (!sources.length) return null;

    const categories = new Map(); // id -> { id, label, cb, color, stations }
    sources.forEach(({ file, records }) => addRecordsToCategories(categories, records, file));

    const types = [...categories.values()]
        .filter((c) => c.stations.length)
        .sort((a, b) => (a.order - b.order) || (b.cb - a.cb) || a.label.localeCompare(b.label));
    let paletteIndex = 0;
    types.forEach((t) => {
        if (!t.color) t.color = t.cb ? CB_COLOR : CATEGORY_PALETTE[paletteIndex++ % CATEGORY_PALETTE.length];
    });

    const stationList = types.flatMap((t) => t.stations);
    if (!stationList.length) return null;
    return {
        stations: stationList,
        types: types.map(({ id, label, color, cb }) => ({ id, label, color, cb })),
        source: sources.length === 1 ? `data/${sources[0].file}` : `data folder (${sources.length} JSON files)`,
    };
}

async function loadStations() {
    const fromFolder = await loadDataFolder();
    if (fromFolder) {
        writeCache(fromFolder.stations, fromFolder.types).catch(() => {});
        return fromFolder;
    }
    try {
        const cached = await readCache();
        if (cached && cached.stations && cached.stations.length) {
            return { stations: cached.stations, types: cached.types || DEFAULT_RADIO_TYPES, source: "browser cache" };
        }
    } catch (error) {
        /* no cache available */
    }
    return { stations: [], types: DEFAULT_RADIO_TYPES, source: "none" };
}

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------

let stations = [];
let userPosition = null; // [lat, lon]
let statusMessage = "";
let userLabel = ""; // text shown when you tap your own dot
let userAccuracy = 0; // GPS accuracy in metres (0 = don't draw a circle)
let nearestShown = []; // { km, station } for the stations the lines and labels are drawn to
let geolocationWatchId = null;
let firstFixPending = true;
let locationCandidates = [];
let candidateSource = "";
let heading = null; // degrees clockwise from north, from the phone compass

const map = L.map("map", {
    rotate: true, // leaflet-rotate plugin options
    bearing: 0,
    touchRotate: true, // two-finger twist on a phone
    shiftKeyRotate: true, // Shift + drag on a computer
    rotateControl: false,
}).setView([-26, 134], 4);
// If the plugin failed to load, the map still works but can't rotate
const rotationSupported = typeof map.setBearing === "function";
const currentBearing = () => (rotationSupported ? map.getBearing() : 0);

const esriTiles = (service) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`;

const BASE_MAPS = {
    "Streets (Esri)": L.tileLayer(esriTiles("World_Street_Map"), { maxZoom: 19, attribution: "Tiles &copy; Esri" }),
    "Satellite (Esri)": L.tileLayer(esriTiles("World_Imagery"), { maxZoom: 19, attribution: "Tiles &copy; Esri" }),
    OpenStreetMap: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
    }),
};

let tileErrorCount = 0;
Object.values(BASE_MAPS).forEach((layer) =>
    layer.on("tileerror", () => {
        if (++tileErrorCount === 6) {
            el("tilemsg").textContent =
                "Map tiles aren’t loading. Try another map style (top right of the map), or open the file in your normal browser.";
        }
    })
);

// ---------------------------------------------------------------------------
// Compass: visual in the map corner plus a north-lock / follow-phone toggle
// ---------------------------------------------------------------------------


function compassSvg() {
    let ticks = "";

    for (let degrees = 0; degrees < 360; degrees += 10) {
        const cardinal = degrees % 90 === 0;
        const major = degrees % 30 === 0;
        const length = cardinal ? 8 : major ? 5 : 3;

        ticks += `
            <line x1="50" y1="7"
                x2="50" y2="${7 + length}"
                stroke="#555"
                stroke-width="${cardinal ? 1.4 : 0.8}"
                transform="rotate(${degrees} 50 50)"/>
        `;
    }

    const letter = (text, x, y, colour = "#333") => `
        <text x="${x}" y="${y}"
            text-anchor="middle"
            dominant-baseline="central"
            font-family="Arial, sans-serif"
            font-size="9"
            font-weight="600"
            fill="${colour}">${text}</text>
    `;

    return `
    <svg viewBox="0 0 100 100"
        width="92" height="92"
        role="img" aria-label="Compass">

        <circle cx="50" cy="50" r="47"
            fill="#fff"
            stroke="#bbb"
            stroke-width="1"/>

        <circle cx="50" cy="50" r="42"
            fill="none"
            stroke="#ddd"
            stroke-width="0.8"/>

        <g id="compassRose">
            ${ticks}

            ${letter("N", 50, 21, "#c0392b")}
            ${letter("E", 79, 50)}
            ${letter("S", 50, 79)}
            ${letter("W", 21, 50)}

            <polygon points="50,30 56,50 50,46 44,50"
                fill="#c0392b"/>

            <polygon points="50,70 56,50 50,54 44,50"
                fill="#555"/>

            <circle cx="50" cy="50" r="2.5"
                fill="#fff"
                stroke="#555"
                stroke-width="1"/>
        </g>

        <!-- Fixed screen direction -->
        <polygon points="50,2 45,10 55,10"
            fill="#3388ff"/>

    </svg>`;
}


const CompassControl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
        const box = L.DomUtil.create("div", "compass");
        box.innerHTML =
            compassSvg() +
            '<button type="button" id="compassReset" aria-label="Reset map to north">Reset north</button>' +
            '<button type="button" id="compassBtn"></button>';
        L.DomEvent.disableClickPropagation(box);
        return box;
    },
});
new CompassControl().addTo(map);

// Recenter: pan back to your position (searched address, saved location or GPS) without changing zoom
function recenterOnPosition() {
    if (!userPosition) {
        el("status").textContent = "No position to centre on yet. Search a suburb or address, or tap Find me.";
        return;
    }
    map.setView(userPosition, map.getZoom(), { animate: true });
}

const RecenterControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
        const bar = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        const link = L.DomUtil.create("a", "", bar);
        link.href = "#";
        link.role = "button";
        link.title = "Recenter on my position";
        link.setAttribute("aria-label", "Recenter on my position");
        link.innerHTML =
            '<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
            '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>' +
            '<path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
        link.style.display = "flex";
        link.style.alignItems = "center";
        link.style.justifyContent = "center";
        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.on(link, "click", (event) => {
            L.DomEvent.preventDefault(event);
            recenterOnPosition();
        });
        return bar;
    },
});
new RecenterControl().addTo(map);

// ---------------------------------------------------------------------------
// Full screen. The map fills the screen. Where the browser has the Fullscreen API (Android, desktop,
// iPad) that is used, which also hides the browser's own bars. Elsewhere (iPhone) the map is stretched
// over the whole window with a fixed layout, so the button works everywhere. Esc or the button exits.
// ---------------------------------------------------------------------------

const FULLSCREEN_ICONS = {
    enter:
        '<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    exit:
        '<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
};
let mapIsFullscreen = false;
let usingNativeFullscreen = false;
let fullscreenLink = null;
const nativeFullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

function updateFullscreenButton() {
    if (!fullscreenLink) return;
    const label = mapIsFullscreen ? "Exit full screen" : "Full screen";
    fullscreenLink.innerHTML = mapIsFullscreen ? FULLSCREEN_ICONS.exit : FULLSCREEN_ICONS.enter;
    fullscreenLink.title = label;
    fullscreenLink.setAttribute("aria-label", label);
    fullscreenLink.setAttribute("aria-pressed", mapIsFullscreen);
}

function setMapFullscreen(on) {
    if (on === mapIsFullscreen) return;
    mapIsFullscreen = on;
    const container = map.getContainer();
    container.classList.toggle("is-fullscreen", on); // the fixed full-window layout (see style.css)
    document.body.classList.toggle("map-fullscreen-open", on); // stops the page scrolling behind the map
    updateFullscreenButton();

    if (on) {
        const request = container.requestFullscreen || container.webkitRequestFullscreen;
        if (request) {
            // Must run inside the tap. If the browser refuses, the fixed layout still fills the window.
            Promise.resolve(request.call(container))
                .then(() => (usingNativeFullscreen = true))
                .catch(() => {});
        }
    } else {
        if (nativeFullscreenElement()) {
            const exit = document.exitFullscreen || document.webkitExitFullscreen;
            if (exit) Promise.resolve(exit.call(document)).catch(() => {});
        }
        usingNativeFullscreen = false;
    }
    // Tell Leaflet the map's size changed. A second pass catches the end of the browser's own animation.
    setTimeout(() => map.invalidateSize(), 60);
    setTimeout(() => map.invalidateSize(), 400);
}

// Leaving the browser's full screen with Esc or a swipe: leave our layout too
function handleNativeFullscreenChange() {
    if (mapIsFullscreen && usingNativeFullscreen && !nativeFullscreenElement()) setMapFullscreen(false);
    else setTimeout(() => map.invalidateSize(), 60);
}
document.addEventListener("fullscreenchange", handleNativeFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleNativeFullscreenChange);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mapIsFullscreen && !usingNativeFullscreen) setMapFullscreen(false);
});

const FullscreenControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
        const bar = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        fullscreenLink = L.DomUtil.create("a", "", bar);
        fullscreenLink.href = "#";
        fullscreenLink.setAttribute("role", "button");
        fullscreenLink.style.display = "flex";
        fullscreenLink.style.alignItems = "center";
        fullscreenLink.style.justifyContent = "center";
        updateFullscreenButton();
        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.on(fullscreenLink, "click", (event) => {
            L.DomEvent.preventDefault(event);
            setMapFullscreen(!mapIsFullscreen);
        });
        return bar;
    },
});
new FullscreenControl().addTo(map);

let lastRoseAngle = null;
let lastCompassLabel = "";
function updateCompass() {
    const following = settings.compassMode === "follow";
    // The rose turns so "N" always points at true north, whatever way the map is turned
    let roseAngle = 0;
    if (rotationSupported) roseAngle = currentBearing();
    else if (following && heading != null) roseAngle = -heading;
    if (roseAngle !== lastRoseAngle) {
        lastRoseAngle = roseAngle;
        el("compassRose").setAttribute("transform", `rotate(${roseAngle} 50 50)`);
    }
    const label = following ? "Following compass" : "North locked";
    if (label !== lastCompassLabel) {
        lastCompassLabel = label;
        el("compassBtn").textContent = label;
        el("compassBtn").setAttribute("aria-pressed", following);
    }
}

function setMapBearing(degrees) {
    if (rotationSupported) map.setBearing(((degrees % 360) + 360) % 360);
}

// Turning the map yourself hands control back to you, so it switches off compass-following
function leaveFollowMode() {
    if (settings.compassMode !== "follow") return;
    settings.compassMode = "north";
    stopCompass();
    saveSettings();
    requestStationRepaint(); // the heading arrow goes away
}

function pointMapNorth() {
    leaveFollowMode();
    setMapBearing(0);
    updateCompass();
}

function handleOrientation(event) {
    // iOS gives webkitCompassHeading; Android gives an absolute alpha (counter-clockwise)
    let value = event.webkitCompassHeading;
    if (value == null && (event.absolute || event.type === "deviceorientationabsolute") && event.alpha != null) {
        value = 360 - event.alpha;
    }
    if (value == null || Number.isNaN(value)) return;
    heading = value;
    if (settings.compassMode === "follow" && rotationSupported) {
        const difference = Math.abs(((value - currentBearing() + 540) % 360) - 180);
        if (difference > 2) setMapBearing(-value); // ignore sensor jitter
    }
    updateCompass();
    requestStationRepaint(); // the heading arrow
}

async function startCompass() {
    if (typeof DeviceOrientationEvent === "undefined") {
        statusMessage = "This device or browser has no compass sensor.";
        return false;
    }
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
        // iOS Safari: must be asked from a tap, and needs a secure (https) page
        const answer = await DeviceOrientationEvent.requestPermission();
        if (answer !== "granted") {
            statusMessage = "Compass permission was denied.";
            return false;
        }
    }
    window.addEventListener("deviceorientationabsolute", handleOrientation);
    window.addEventListener("deviceorientation", handleOrientation);
    return true;
}

function stopCompass() {
    window.removeEventListener("deviceorientationabsolute", handleOrientation);
    window.removeEventListener("deviceorientation", handleOrientation);
    heading = null;
}

async function toggleCompassMode() {
    if (settings.compassMode === "follow") {
        settings.compassMode = "north";
        stopCompass();
        setMapBearing(0);
    } else {
        try {
            settings.compassMode = (await startCompass()) ? "follow" : "north";
        } catch (error) {
            settings.compassMode = "north";
            statusMessage = "Couldn’t start the compass: " + error.message;
        }
    }
    saveSettings();
    updateCompass();
    drawStations(false);
}

// ---------------------------------------------------------------------------
// Station filtering, markers and popups
// ---------------------------------------------------------------------------

function filteredStations() {
    const text = settings.filterText.trim().toLowerCase();
    return stations.filter(
        (s) =>
            hasPosition(s) &&
            (settings.radioType === "all" || s[FIELD.radioType] === settings.radioType) &&
            (settings.state === "All" || s[FIELD.state] === settings.state) &&
            (!settings.channel || s[FIELD.channel] == settings.channel) &&
            (!text || `${s[FIELD.siteName]} ${s[FIELD.callSign]} ${s[FIELD.postcode]}`.toLowerCase().includes(text))
    );
}

// The emergency note and the rows of details for one station
function stationDetailsHtml(s, showDistance = true) {
    const row = (label, value) => (value === "" || value == null ? "" : `<dt>${label}</dt><dd>${value}</dd>`);
    const cb = isCb(s);

    const frequencyRows = cb
        ? row("RX (you listen)", `ch ${s[FIELD.channel]} &middot; ${mhz(s[FIELD.outputMhz])}`) +
          row("TX (you transmit)", `ch ${cbTxChannel(s)} &middot; ${mhz(cbTxMhz(s))}`)
        : row("Radio type", TYPE_LABEL[s[FIELD.radioType]]) +
          row("Band", escapeHtml(s[FIELD.band])) +
          row("Station transmits", mhz(s[FIELD.outputMhz])) +
          row("Emission", escapeHtml(s[FIELD.emission])) +
          row("Bandwidth", s[FIELD.bandwidthKhz] != null ? s[FIELD.bandwidthKhz] + " kHz" : "");

    const distanceRow = userPosition && showDistance
        ? row("Distance from you", formatKm(distanceKm(userPosition, [s[FIELD.lat], s[FIELD.lon]])))
        : "";
    const polarisation = { V: "Vertical", H: "Horizontal" }[s[FIELD.polarisation]] || "";

    return `${isEmergency(s) ? '<p class="em">Emergency use only</p>' : ""}<dl>
${row("State", s[FIELD.state])}${row("Postcode", escapeHtml(s[FIELD.postcode] || ""))}${distanceRow}
${row("Call sign", escapeHtml(s[FIELD.callSign]))}${row("Licensee", escapeHtml(s[FIELD.licensee] || ""))}${frequencyRows}
${row("Power", s[FIELD.powerWatts] ? s[FIELD.powerWatts] + " W" : "")}
${row("Antenna height", s[FIELD.antennaHeightM] != null ? s[FIELD.antennaHeightM] + " m" : "")}
${row("Polarisation", polarisation)}${row("Licence", escapeHtml(s[FIELD.licenceNumber] || ""))}
${row("Licence date", escapeHtml(s[FIELD.licenceDate] || ""))}${row("Antenna", escapeHtml(s[FIELD.antennaType] || ""))}
</dl>`;
}

const directionsLink = (lat, lon) =>
    `<p><a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}" target="_blank" rel="noopener">Directions</a></p>`;

function popupHtml(s) {
    return `<h2>${escapeHtml(s[FIELD.siteName] || "Site not recorded")}</h2>${stationDetailsHtml(s)}${directionsLink(s[FIELD.lat], s[FIELD.lon])}`;
}

const stationColour = (s) => (isEmergency(s) ? EMERGENCY_COLOR : TYPE_COLOR[s[FIELD.radioType]]);

// Several stations at one position share one popup. Each gets its own collapsible section, headed by a
// dot in its type's colour (the same colours as the map and legend) and the type's name.
// "focus" is the station to leave open (the first one when not given).
function spotPopupHtml(spot, focus) {
    if (spot.stations.length === 1) return popupHtml(spot.stations[0]);
    const siteName = spot.stations.map((s) => s[FIELD.siteName]).find(Boolean) || "Site not recorded";
    const away = userPosition ? ` &middot; ${formatKm(distanceKm(userPosition, [spot.lat, spot.lon]))} away` : "";
    const items = spot.stations
        .map((s, index) => {
            const open = focus ? s === focus : index === 0;
            const detail = [isCb(s) ? `ch ${s[FIELD.channel]}` : `${fmtMhz(s[FIELD.outputMhz])} MHz`, s[FIELD.callSign]]
                .filter(Boolean)
                .map(escapeHtml)
                .join(" &middot; ");
            return (
                `<details class="spot-item"${open ? " open" : ""}><summary>` +
                `<span class="type-dot" style="background:${stationColour(s)}"></span><b>${escapeHtml(TYPE_LABEL[s[FIELD.radioType]] || "Station")}</b>` +
                `<span class="spot-sub">${detail}</span></summary>${stationDetailsHtml(s, false)}</details>`
            );
        })
        .join("");
    return (
        `<h2>${escapeHtml(siteName)}</h2><p class="spot-count">${spot.stations.length} stations at this site${away}</p>` +
        items +
        directionsLink(spot.lat, spot.lon)
    );
}

function openSpotPopup(spot, focus) {
    L.popup({ maxWidth: 320, maxHeight: spot.stations.length > 1 ? 340 : null })
        .setLatLng([spot.lat, spot.lon])
        .setContent(spotPopupHtml(spot, focus))
        .openOn(map);
}

// ---------------------------------------------------------------------------
// Everything drawn over the map: station dots, lines to the nearest stations, their labels, your
// position and the compass arrow. It is all painted on one canvas in screen coordinates and
// repainted on every frame the map moves, so it stays locked to the tiles while pinching, panning
// and rotating. (Leaflet's own markers, lines and tooltips only catch up when a gesture ends,
// which is why they lagged behind the map on a phone.)
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const stationCanvas = document.createElement("canvas");
stationCanvas.className = "station-canvas";
stationCanvas.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:401;transform-origin:0 0;";
map.getContainer().appendChild(stationCanvas);

const MAX_PIXEL_RATIO = 2; // 3x phone screens look the same at 2x and paint far faster
const DOT_RADIUS = 6.5;
const EMERGENCY_DOT_RADIUS = 8.5;
const DOT_RING_WIDTH = 1.5;
const SPRITE_PADDING = 6; // room around a dot for its halo
const USER_DOT_RADIUS = 9;
const USER_COLOUR = "#1a73e8";
const SPOT_DOT_RADIUS = 10; // marker for several stations at one position

let visibleStations = []; // stations passing the current filters
let visibleSpots = []; // [{ key, lat, lon, stations }]: stations at the same position share one marker
let spotByKey = new Map();
let visibleWorld = new Float64Array(0); // x, y of each visible spot in unit Web Mercator (0 to 1)
let visibleGroups = []; // [{ colours, count, radius, emergency, indices }]: one group per marker style
let repaintQueued = false;
let lastPaintedView = null;

// ---------------------------------------------------------------------------
// Fast projection. Leaflet's latLngToContainerPoint is slow (it allocates and, with the rotate
// plugin, rotates every point), and a map can have thousands of dots. Every station's position
// is worked out once as unit Web Mercator. Each frame we then ask Leaflet where three reference
// points land on screen and derive a plain affine transform, which also covers rotation. Placing
// a dot is then four multiplications.
// ---------------------------------------------------------------------------

function unitMercator(lat, lon) {
    const sine = Math.sin((lat * Math.PI) / 180);
    return [(lon + 180) / 360, 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)];
}

function getViewTransform() {
    const zoom = map.getZoom();
    const centre = map.getCenter();
    const centreWorld = map.project(centre, zoom);
    const origin = map.latLngToContainerPoint(centre);
    const probe = 256;
    const alongX = map.latLngToContainerPoint(map.unproject(centreWorld.add([probe, 0]), zoom));
    const alongY = map.latLngToContainerPoint(map.unproject(centreWorld.add([0, probe]), zoom));
    return {
        scale: 256 * 2 ** zoom,
        centreX: centreWorld.x,
        centreY: centreWorld.y,
        originX: origin.x,
        originY: origin.y,
        xx: (alongX.x - origin.x) / probe,
        xy: (alongX.y - origin.y) / probe,
        yx: (alongY.x - origin.x) / probe,
        yy: (alongY.y - origin.y) / probe,
    };
}

function toScreen(view, u, v, out) {
    const dx = u * view.scale - view.centreX;
    const dy = v * view.scale - view.centreY;
    out.x = view.originX + view.xx * dx + view.yx * dy;
    out.y = view.originY + view.xy * dx + view.yy * dy;
    return out;
}

// ---------------------------------------------------------------------------
// Dot sprites. Each dot style is drawn once to a small canvas (shadow, white ring, shaded body)
// and stamped onto the map with drawImage, which is much cheaper than rebuilding paths.
// ---------------------------------------------------------------------------

const spriteCache = new Map();

function makeSprite(key, radius, ratio, draw) {
    if (spriteCache.has(key)) return spriteCache.get(key);
    const cssSize = (radius + SPRITE_PADDING) * 2;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.ceil(cssSize * ratio);
    const c = canvas.getContext("2d");
    c.scale(canvas.width / cssSize, canvas.width / cssSize);
    draw(c, cssSize / 2);
    const sprite = { canvas, size: canvas.width / ratio };
    spriteCache.set(key, sprite);
    return sprite;
}

function dotSprite(colour, radius, emergency, ratio) {
    return makeSprite(`dot|${colour}|${radius}|${emergency}|${ratio}`, radius, ratio, (c, centre) => {
        if (emergency) {
            c.beginPath(); // pale halo so channel 5 stands out
            c.arc(centre, centre, radius + 4.5, 0, TAU);
            c.fillStyle = "rgba(179,38,30,0.2)";
            c.fill();
        }
        c.beginPath(); // white ring
        c.arc(centre, centre, radius + DOT_RING_WIDTH, 0, TAU);
        c.fillStyle = "#fff";
        c.fill();
        c.beginPath(); // flat colour
        c.arc(centre, centre, radius, 0, TAU);
        c.fillStyle = colour;
        c.fill();
        if (emergency) {
            c.fillStyle = "#fff";
            c.font = `800 ${Math.round(radius * 1.3)}px system-ui, sans-serif`;
            c.textAlign = "center";
            c.textBaseline = "middle";
            c.fillText("!", centre, centre + 0.5);
        }
    });
}

function userSprite(ratio) {
    return makeSprite(`user|${ratio}`, USER_DOT_RADIUS + 8, ratio, (c, centre) => {
        c.beginPath(); // pale ring around your dot
        c.arc(centre, centre, USER_DOT_RADIUS + 8, 0, TAU);
        c.fillStyle = "rgba(26,115,232,0.16)";
        c.fill();
        c.beginPath(); // white ring
        c.arc(centre, centre, USER_DOT_RADIUS + 2.5, 0, TAU);
        c.fillStyle = "#fff";
        c.fill();
        c.beginPath(); // flat blue
        c.arc(centre, centre, USER_DOT_RADIUS, 0, TAU);
        c.fillStyle = USER_COLOUR;
        c.fill();
    });
}

// A marker for several stations at one position: a pie of their type colours (the colours in
// the legend) around a white centre showing how many there are
function spotSprite(group, ratio) {
    const { colours, count, radius, emergency } = group;
    return makeSprite(`spot|${colours.join(",")}|${count}|${emergency}|${radius}|${ratio}`, radius, ratio, (c, centre) => {
        if (emergency) {
            c.beginPath();
            c.arc(centre, centre, radius + 4.5, 0, TAU);
            c.fillStyle = "rgba(179,38,30,0.2)";
            c.fill();
        }
        c.beginPath(); // white ring
        c.arc(centre, centre, radius + DOT_RING_WIDTH, 0, TAU);
        c.fillStyle = "#fff";
        c.fill();
        const slice = TAU / colours.length;
        colours.forEach((colour, index) => {
            c.beginPath();
            c.moveTo(centre, centre);
            c.arc(centre, centre, radius, -Math.PI / 2 + index * slice, -Math.PI / 2 + (index + 1) * slice);
            c.closePath();
            c.fillStyle = colour;
            c.fill();
        });
        if (colours.length > 1) {
            c.strokeStyle = "#fff"; // thin white lines between the colours
            c.lineWidth = 1.5;
            colours.forEach((colour, index) => {
                const angle = -Math.PI / 2 + index * slice;
                c.beginPath();
                c.moveTo(centre, centre);
                c.lineTo(centre + radius * Math.cos(angle), centre + radius * Math.sin(angle));
                c.stroke();
            });
        }
        c.beginPath(); // white centre with the count
        c.arc(centre, centre, radius * 0.6, 0, TAU);
        c.fillStyle = "#fff";
        c.fill();
        c.fillStyle = "#17231f";
        c.font = `800 ${Math.round(radius * 0.95)}px system-ui, sans-serif`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(count > 9 ? "9+" : String(count), centre, centre + 0.5);
    });
}

// Work out each marker's position and style once per filter change, not per frame. Stations at the
// same position (to about a metre) are merged into one marker.
const spotKeyFor = (station) => station[FIELD.lat].toFixed(5) + "," + station[FIELD.lon].toFixed(5);

function buildVisibleIndex() {
    spotByKey = new Map();
    visibleSpots = [];
    visibleStations.forEach((station) => {
        const key = spotKeyFor(station);
        let spot = spotByKey.get(key);
        if (!spot) {
            spot = { key, lat: station[FIELD.lat], lon: station[FIELD.lon], stations: [] };
            spotByKey.set(key, spot);
            visibleSpots.push(spot);
        }
        spot.stations.push(station);
    });

    const typeOrder = (station) => RADIO_TYPES.findIndex((t) => t.id === station[FIELD.radioType]);
    visibleWorld = new Float64Array(visibleSpots.length * 2);
    const byStyle = new Map();
    visibleSpots.forEach((spot, index) => {
        spot.stations.sort((a, b) => typeOrder(a) - typeOrder(b) || (a[FIELD.channel] || 0) - (b[FIELD.channel] || 0));
        const [u, v] = unitMercator(spot.lat, spot.lon);
        visibleWorld[index * 2] = u;
        visibleWorld[index * 2 + 1] = v;

        const colours = [];
        spot.stations.forEach((station) => {
            const colour = stationColour(station);
            if (!colours.includes(colour)) colours.push(colour);
        });
        const count = spot.stations.length;
        const emergency = spot.stations.some(isEmergency);
        const key = colours.join(",") + "#" + count + "#" + emergency;
        if (!byStyle.has(key)) {
            const radius = count > 1 ? SPOT_DOT_RADIUS : emergency ? EMERGENCY_DOT_RADIUS : DOT_RADIUS;
            byStyle.set(key, { colours, count, emergency, radius, indices: [] });
        }
        byStyle.get(key).indices.push(index);
    });
    // Merged markers and emergency markers last, so they sit on top
    const weight = (group) => (group.count > 1 ? 1 : 0) + (group.emergency ? 2 : 0);
    visibleGroups = [...byStyle.values()].sort((a, b) => weight(a) - weight(b));
}

// Positions for the nearest-station lines and your own dot, cached until they change
let cachedNearest = null;
let nearestWorld = new Float64Array(0);
function nearestUnits() {
    if (cachedNearest !== nearestShown) {
        cachedNearest = nearestShown;
        nearestWorld = new Float64Array(nearestShown.length * 2);
        nearestShown.forEach(({ station }, index) => {
            const [u, v] = unitMercator(station[FIELD.lat], station[FIELD.lon]);
            nearestWorld[index * 2] = u;
            nearestWorld[index * 2 + 1] = v;
        });
    }
    return nearestWorld;
}
// The nearest stations grouped by position: stations at the same spot are one node, with one line and
// one bubble. Cached until the list changes. Each group: { km, index (of its first entry), stations }.
let cachedGroupsFor = null;
let nearestGroupList = [];
function nearestGroups() {
    if (cachedGroupsFor !== nearestShown) {
        cachedGroupsFor = nearestShown;
        nearestGroupList = [];
        const byKey = new Map();
        nearestShown.forEach(({ km, station }, index) => {
            const key = spotKeyFor(station);
            if (!byKey.has(key)) {
                const group = { km, index, stations: [] };
                byKey.set(key, group);
                nearestGroupList.push(group);
            }
            byKey.get(key).stations.push(station);
        });
        const typeOrder = (station) => RADIO_TYPES.findIndex((t) => t.id === station[FIELD.radioType]);
        nearestGroupList.forEach((group) =>
            group.stations.sort((a, b) => typeOrder(a) - typeOrder(b) || (a[FIELD.channel] || 0) - (b[FIELD.channel] || 0))
        );
    }
    return nearestGroupList;
}
let cachedUserPosition = null;
let cachedUserUnit = null;
function userUnits() {
    if (cachedUserPosition !== userPosition) {
        cachedUserPosition = userPosition;
        cachedUserUnit = userPosition ? unitMercator(userPosition[0], userPosition[1]) : null;
    }
    return cachedUserUnit;
}

// ---------------------------------------------------------------------------
// Repainting
// ---------------------------------------------------------------------------

// For data changes (filters, your position): repaint on the next frame
function requestStationRepaint() {
    lastPaintedView = null;
    if (repaintQueued) return;
    repaintQueued = true;
    requestAnimationFrame(paintStations);
}

// For map movement: repaint right now, inside the same event the tiles move in. Scheduling it
// for the next frame (as before) always left the dots one frame behind the map. Events that
// leave the view unchanged (moveend after a pan, say) are skipped.
function repaintForViewChange() {
    const centre = map.getCenter();
    const size = map.getSize();
    const last = lastPaintedView;
    if (
        last &&
        last.zoom === map.getZoom() &&
        last.lat === centre.lat &&
        last.lng === centre.lng &&
        last.bearing === currentBearing() &&
        last.width === size.x &&
        last.height === size.y
    ) {
        return;
    }
    paintStations();
}

// The areas the open popup covers (its box and its tip), in screen coordinates. This canvas sits
// above the popup, so nothing is painted inside these areas.
function openPopupHoles() {
    const popup = map._popup;
    const node = popup && popup.isOpen() && popup._container;
    if (!node) return [];
    const outer = map.getContainer().getBoundingClientRect();
    const holes = [];
    [[".leaflet-popup-content-wrapper", 12], [".leaflet-popup-tip-container", 0]].forEach(([selector, radius]) => {
        const part = node.querySelector(selector);
        if (!part) return;
        const box = part.getBoundingClientRect();
        holes.push({ x: box.left - outer.left, y: box.top - outer.top, width: box.width, height: box.height, radius });
    });
    return holes;
}

function roundedRectPath(ctx, x, y, width, height, radius) {
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
}

// ---------------------------------------------------------------------------
// Bubbles on the lines. Every node gets its own bubble, sitting on its line. A node with a single
// station shows that station: a marker in its type colour, the type's name, the distance and RX / TX.
// A node with several stations shows a header (distance and count) and a row for each. When bubbles
// would overlap, the ones that overlap are joined into a single bubble that lists all their nodes.
// ---------------------------------------------------------------------------

const BUBBLE_FONT = "600 12px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const BUBBLE_SMALL_FONT = "400 11px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const BUBBLE_PADDING = 9;
const BUBBLE_MARKER_COLUMN = 20; // space for the coloured marker at the start of each row
const BUBBLE_ROW_GAP = 6;
const BUBBLE_SECTION_GAP = 12; // between the nodes of a joined bubble
const BUBBLE_TITLE_HEIGHT = 15;
const BUBBLE_DETAIL_HEIGHT = 13;
const MAX_BUBBLE_ROWS = 4; // stations shown in a bubble for one node
const MAX_JOINED_ROWS = 8; // stations shown in a joined bubble; the rest are in the markers' popups
const LABEL_GAP = 4; // bubbles closer than this count as overlapping
const JOINED_ACCENT = "#17231f";
const NARROW_MAP_WIDTH = 520; // below this, RX and TX go on separate lines so bubbles are narrower

const textWidths = new Map(); // measuring text is slow, so remember each width
function textWidth(ctx, font, text) {
    const key = font + "|" + text;
    if (!textWidths.has(key)) {
        ctx.font = font;
        textWidths.set(key, ctx.measureText(text).width);
    }
    return textWidths.get(key);
}

const spotRadius = (spot) => (spot.stations.length > 1 ? SPOT_DOT_RADIUS : isEmergency(spot.stations[0]) ? EMERGENCY_DOT_RADIUS : DOT_RADIUS);

// What a bubble says. spots = the node or nodes it covers, nearest first; spot = { km, stations }.
// One section per node, one row per station.
function bubbleContentFor(spots) {
    const joined = spots.length > 1;
    let budget = joined ? MAX_JOINED_ROWS : MAX_BUBBLE_ROWS;
    let hidden = 0;
    const sections = [];
    spots.forEach((spot) => {
        const multi = spot.stations.length > 1;
        const distance = settings.showDistanceLabels ? formatKm(spot.km) : "";
        const shown = spot.stations.slice(0, Math.max(0, budget));
        budget -= shown.length;
        hidden += spot.stations.length - shown.length;
        if (!shown.length) return;
        sections.push({
            header: multi ? [distance, `${spot.stations.length} stations`].filter(Boolean).join(" \u00b7 ") : "",
            rows: shown.map((station) => {
                const type = TYPE_LABEL[station[FIELD.radioType]] || "Station";
                let details = [];
                if (settings.showChannelLabels) {
                    if (isCb(station)) {
                        const rx = `RX ${station[FIELD.channel]} \u00b7 ${fmtMhz(station[FIELD.outputMhz])}`;
                        const tx = `TX ${cbTxChannel(station)} \u00b7 ${fmtMhz(cbTxMhz(station))}`;
                        details = map.getSize().x < NARROW_MAP_WIDTH ? [rx, tx] : [`${rx}   ${tx}`];
                    } else {
                        details = [`RX ${fmtMhz(station[FIELD.outputMhz])} MHz`];
                    }
                }
                return {
                    colour: stationColour(station),
                    emergency: isEmergency(station),
                    title: isCb(station) ? `${type} ch ${station[FIELD.channel]}` : type,
                    distance: multi ? "" : distance, // a node with several stations shows its distance once, in its header
                    details,
                };
            }),
        });
    });
    return {
        sections,
        // A bubble for one node is outlined in its line's colour so it can be matched to the line
        accent: joined ? JOINED_ACCENT : stationColour(spots[0].stations[0]),
        hiddenText: hidden ? `+${hidden} more (tap the markers)` : "",
    };
}

function bubbleSize(ctx, content) {
    let widest = 0;
    let height = BUBBLE_PADDING * 2;
    content.sections.forEach((section, sectionIndex) => {
        if (sectionIndex > 0) height += BUBBLE_SECTION_GAP;
        if (section.header) {
            widest = Math.max(widest, textWidth(ctx, BUBBLE_FONT, section.header) - BUBBLE_MARKER_COLUMN);
            height += BUBBLE_TITLE_HEIGHT + 4;
        }
        section.rows.forEach((row, rowIndex) => {
            const top = textWidth(ctx, BUBBLE_FONT, row.title) + (row.distance ? 12 + textWidth(ctx, BUBBLE_FONT, row.distance) : 0);
            const detail = Math.max(0, ...row.details.map((line) => textWidth(ctx, BUBBLE_SMALL_FONT, line)));
            widest = Math.max(widest, top, detail);
            height += BUBBLE_TITLE_HEIGHT + row.details.length * BUBBLE_DETAIL_HEIGHT;
            if (rowIndex < section.rows.length - 1) height += BUBBLE_ROW_GAP;
        });
    });
    if (content.hiddenText) {
        widest = Math.max(widest, textWidth(ctx, BUBBLE_SMALL_FONT, content.hiddenText));
        height += BUBBLE_DETAIL_HEIGHT + 4;
    }
    return { width: BUBBLE_PADDING * 2 + BUBBLE_MARKER_COLUMN + widest, height };
}

function drawBubble(ctx, content, box) {
    const left = box.x - box.width / 2;
    const top = box.y - box.height / 2;
    const textLeft = left + BUBBLE_PADDING + BUBBLE_MARKER_COLUMN;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.28)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    roundedRectPath(ctx, left, top, box.width, box.height, 9);
    ctx.fillStyle = "rgba(255,255,255,0.97)";
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    roundedRectPath(ctx, left, top, box.width, box.height, 9);
    ctx.strokeStyle = content.accent;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textBaseline = "middle";
    let y = top + BUBBLE_PADDING;
    content.sections.forEach((section, sectionIndex) => {
        if (sectionIndex > 0) {
            ctx.beginPath(); // thin line between the nodes of a joined bubble
            ctx.moveTo(left + BUBBLE_PADDING, y + BUBBLE_SECTION_GAP / 2);
            ctx.lineTo(left + box.width - BUBBLE_PADDING, y + BUBBLE_SECTION_GAP / 2);
            ctx.strokeStyle = "rgba(0,0,0,0.15)";
            ctx.lineWidth = 1;
            ctx.stroke();
            y += BUBBLE_SECTION_GAP;
        }
        if (section.header) {
            ctx.fillStyle = "#17231f";
            ctx.font = BUBBLE_FONT;
            ctx.textAlign = "left";
            ctx.fillText(section.header, left + BUBBLE_PADDING, y + BUBBLE_TITLE_HEIGHT / 2);
            y += BUBBLE_TITLE_HEIGHT + 4;
        }
        section.rows.forEach((row, rowIndex) => {
            const middle = y + BUBBLE_TITLE_HEIGHT / 2;
            const markerX = left + BUBBLE_PADDING + 6;
            ctx.beginPath(); // marker: white ring, then the type colour
            ctx.arc(markerX, middle, 7, 0, TAU);
            ctx.fillStyle = "#fff";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(markerX, middle, 5.5, 0, TAU);
            ctx.fillStyle = row.colour;
            ctx.fill();
            if (row.emergency) {
                ctx.fillStyle = "#fff";
                ctx.font = "800 8px system-ui, sans-serif";
                ctx.textAlign = "center";
                ctx.fillText("!", markerX, middle + 0.5);
            }
            ctx.fillStyle = "#17231f";
            ctx.font = BUBBLE_FONT;
            ctx.textAlign = "left";
            ctx.fillText(row.title, textLeft, middle);
            if (row.distance) {
                ctx.textAlign = "right";
                ctx.fillText(row.distance, left + box.width - BUBBLE_PADDING, middle);
            }
            y += BUBBLE_TITLE_HEIGHT;
            row.details.forEach((line) => {
                ctx.fillStyle = "#5a6a64";
                ctx.font = BUBBLE_SMALL_FONT;
                ctx.textAlign = "left";
                ctx.fillText(line, textLeft, y + BUBBLE_DETAIL_HEIGHT / 2);
                y += BUBBLE_DETAIL_HEIGHT;
            });
            if (rowIndex < section.rows.length - 1) y += BUBBLE_ROW_GAP;
        });
    });
    if (content.hiddenText) {
        ctx.fillStyle = "#5a6a64";
        ctx.font = BUBBLE_SMALL_FONT;
        ctx.textAlign = "left";
        ctx.fillText(content.hiddenText, textLeft, y + 4 + BUBBLE_DETAIL_HEIGHT / 2);
    }
}

// Boxes are { x, y, width, height } with (x, y) at the centre. How much do two overlap, counting
// anything closer than LABEL_GAP as overlapping? 0 means they are clear of each other.
function overlapArea(a, b) {
    const across = Math.min(a.x + a.width / 2, b.x + b.width / 2) - Math.max(a.x - a.width / 2, b.x - b.width / 2) + LABEL_GAP;
    const down = Math.min(a.y + a.height / 2, b.y + b.height / 2) - Math.max(a.y - a.height / 2, b.y - b.height / 2) + LABEL_GAP;
    return across > 0 && down > 0 ? across * down : 0;
}

// Positions to try for a bubble, best first. With lines: along the node's line (the middle first), then
// pushed to either side of it. Without lines: above the marker, then below, then to each side.
function labelCandidates(from, to, dotRadius, size) {
    const spots = [];
    if (settings.showLines && from) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy) || 1;
        const nx = -dy / length;
        const ny = dx / length;
        // How far to push sideways so the bubble's edge clears the line, whatever angle the line is at
        const sideways = Math.abs(nx) * (size.width / 2) + Math.abs(ny) * (size.height / 2) + 6;
        [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88].forEach((t) =>
            [0, 1, -1, 2, -2].forEach((side) =>
                spots.push({ x: from.x + dx * t + nx * sideways * side, y: from.y + dy * t + ny * sideways * side })
            )
        );
    } else {
        const up = dotRadius + 6 + size.height / 2;
        const across = size.width / 2 + dotRadius + 6;
        [0, 1, 2].forEach((ring) => {
            const lift = up + ring * (size.height + 4);
            const side = across + ring * 8;
            [[0, -lift], [0, lift], [side, 0], [-side, 0], [side, -lift], [-side, -lift], [side, lift], [-side, lift]].forEach(([ox, oy]) =>
                spots.push({ x: to.x + ox, y: to.y + oy })
            );
        });
    }
    return spots;
}

// Nodes whose markers sit on top of each other on screen (touching, or closer than this many pixels
// apart) are in the same position as far as the eye can tell, so they share one bubble.
const MARKER_TOUCH_GAP = 4;

// Works out the bubbles to draw. Every node gets its own bubble, except nodes whose markers overlap each
// other on screen: those share one bubble listing all of them. Bubbles of nodes that are in different
// positions are never joined. Each bubble goes on the first position along its line (or along any of
// its nodes' lines) that is clear of the other bubbles, your dot and the markers; when there is none it
// goes where it overlaps least. Nearest first, so the nearest nodes get the best spots.
// Returns [{ spots, content, box }].
function layoutBubbles(ctx, nearestSpots, from, canvasSize) {
    const fixed = [{ x: from.x, y: from.y, width: 2 * (USER_DOT_RADIUS + 8), height: 2 * (USER_DOT_RADIUS + 8) }];
    nearestSpots.forEach((spot) => {
        const side = 2 * (spotRadius(spot) + 3);
        fixed.push({ x: spot.point.x, y: spot.point.y, width: side, height: side });
    });

    // Group the nodes whose markers touch (a chain of touching markers is one group)
    const touching = (a, b) => Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) < spotRadius(a) + spotRadius(b) + MARKER_TOUCH_GAP;
    let groups = [];
    nearestSpots.forEach((spot) => {
        const touched = groups.filter((group) => group.some((other) => touching(other, spot)));
        groups = groups.filter((group) => !touched.includes(group));
        groups.push([spot, ...touched.flat()].sort((a, b) => a.km - b.km));
    });
    groups.sort((a, b) => a[0].km - b[0].km);

    const placed = [];
    groups.forEach((members) => {
        const content = bubbleContentFor(members);
        const size = bubbleSize(ctx, content);
        let best = null;
        for (const member of members) {
            for (const spotPosition of labelCandidates(from, member.point, spotRadius(member), size)) {
                const box = { x: spotPosition.x, y: spotPosition.y, width: size.width, height: size.height };
                const offX = Math.max(0, size.width / 2 - box.x, box.x + size.width / 2 - canvasSize.x);
                const offY = Math.max(0, size.height / 2 - box.y, box.y + size.height / 2 - canvasSize.y);
                let cost = (offX + offY) * 1000;
                fixed.forEach((other) => (cost += overlapArea(box, other)));
                placed.forEach((other) => (cost += overlapArea(box, other.box)));
                if (!best || cost < best.cost) best = { ...box, cost };
                if (cost === 0) break;
            }
            if (best.cost === 0) break;
        }
        placed.push({ spots: members, content, box: best });
    });
    return placed;
}

// A line of round dots with a pale halo, so it reads on streets and satellite imagery alike
function strokeDottedLine(ctx, x0, y0, x1, y1, colour) {
    ctx.lineCap = "round";
    ctx.setLineDash([0.01, 10]); // zero-length dashes with round caps are dots
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineWidth = 7;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.stroke();
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, USER_COLOUR);
    gradient.addColorStop(1, colour);
    ctx.lineWidth = 4;
    ctx.strokeStyle = gradient;
    ctx.stroke();
    ctx.setLineDash([]);
}

const metresToPixels = (metres, latitude) =>
    metres / ((40075016.686 * Math.cos((latitude * Math.PI) / 180)) / (256 * 2 ** map.getZoom()));

function paintStations() {
    repaintQueued = false;
    const size = map.getSize();
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const pixelWidth = Math.round(size.x * ratio);
    const pixelHeight = Math.round(size.y * ratio);
    if (stationCanvas.width !== pixelWidth || stationCanvas.height !== pixelHeight) {
        stationCanvas.width = pixelWidth;
        stationCanvas.height = pixelHeight;
        stationCanvas.style.width = size.x + "px";
        stationCanvas.style.height = size.y + "px";
    }
    stationCanvas.style.transition = "none";
    stationCanvas.style.transform = "";
    stationCanvas.style.visibility = "visible";

    const ctx = stationCanvas.getContext("2d");
    ctx.setTransform(pixelWidth / size.x, 0, 0, pixelHeight / size.y, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    // Everything below is painted with the open popup's area cut out, so the popup stays on top
    const holes = openPopupHoles();
    ctx.save();
    if (holes.length) {
        ctx.beginPath();
        ctx.rect(0, 0, size.x, size.y);
        holes.forEach((hole) => roundedRectPath(ctx, hole.x, hole.y, hole.width, hole.height, hole.radius));
        ctx.clip("evenodd");
    }
    paintOverlays(ctx, size, ratio);
    ctx.restore();

    const centre = map.getCenter();
    lastPaintedView = { zoom: map.getZoom(), lat: centre.lat, lng: centre.lng, bearing: currentBearing(), width: size.x, height: size.y };
}

function paintOverlays(ctx, size, ratio) {
    const view = getViewTransform();
    const point = { x: 0, y: 0 };

    // Your position and the nearest stations, as screen points
    const userUnit = userUnits();
    const userPoint = userUnit ? toScreen(view, userUnit[0], userUnit[1], { x: 0, y: 0 }) : null;
    const nearestUnit = userPoint ? nearestUnits() : null;
    const nearestSpots = userPoint
        ? nearestGroups().map((group) => ({
              km: group.km,
              stations: group.stations,
              point: toScreen(view, nearestUnit[group.index * 2], nearestUnit[group.index * 2 + 1], { x: 0, y: 0 }),
          }))
        : [];
    const labelled = nearestSpots.length <= MAX_LABELLED_LINES; // bubbles on hundreds of lines are unreadable

    if (userPoint && userAccuracy) {
        ctx.beginPath();
        ctx.arc(userPoint.x, userPoint.y, metresToPixels(userAccuracy, userPosition[0]), 0, TAU);
        ctx.fillStyle = "rgba(26,115,232,0.1)";
        ctx.fill();
        ctx.strokeStyle = "rgba(26,115,232,0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    if (userPoint && settings.showLines) {
        if (labelled) {
            nearestSpots.forEach(({ stations, point: end }) =>
                strokeDottedLine(ctx, userPoint.x, userPoint.y, end.x, end.y, stationColour(stations[0]))
            );
        } else {
            // Hundreds of lines: thin solid lines, one stroke per colour
            const byColour = new Map();
            nearestSpots.forEach(({ stations, point: end }) => {
                const colour = stationColour(stations[0]);
                if (!byColour.has(colour)) byColour.set(colour, []);
                byColour.get(colour).push(end);
            });
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.45;
            byColour.forEach((ends, colour) => {
                ctx.beginPath();
                ends.forEach((end) => {
                    ctx.moveTo(userPoint.x, userPoint.y);
                    ctx.lineTo(end.x, end.y);
                });
                ctx.strokeStyle = colour;
                ctx.stroke();
            });
            ctx.globalAlpha = 1;
        }
    }

    // Station dots
    for (const group of visibleGroups) {
        const sprite = group.count > 1 ? spotSprite(group, ratio) : dotSprite(group.colours[0], group.radius, group.emergency, ratio);
        const half = sprite.size / 2;
        const margin = half + 2;
        const indices = group.indices;
        for (let k = 0; k < indices.length; k++) {
            const index = indices[k];
            toScreen(view, visibleWorld[index * 2], visibleWorld[index * 2 + 1], point);
            if (point.x < -margin || point.y < -margin || point.x > size.x + margin || point.y > size.y + margin) continue;
            // Snap to whole device pixels so the sprite stays sharp
            ctx.drawImage(
                sprite.canvas,
                Math.round((point.x - half) * ratio) / ratio,
                Math.round((point.y - half) * ratio) / ratio,
                sprite.size,
                sprite.size
            );
        }
    }

    if (!userPoint) return;

    // The bubbles, drawn under your dot so your position stays visible
    if (labelled && (settings.showDistanceLabels || settings.showChannelLabels)) {
        layoutBubbles(ctx, nearestSpots, userPoint, size).forEach((bubble) => drawBubble(ctx, bubble.content, bubble.box));
    }

    // Heading arrow while following the phone's compass. True north sits at +bearing on screen (the
    // compass rose turns by the same amount), so the way you face is heading + bearing. Following
    // turns the map to bearing = -heading, which puts the arrow straight up.
    if (settings.compassMode === "follow" && heading != null) {
        ctx.save();
        ctx.translate(userPoint.x, userPoint.y);
        ctx.rotate(((heading + currentBearing()) * Math.PI) / 180);
        ctx.beginPath();
        ctx.moveTo(0, -30);
        ctx.lineTo(11, -13);
        ctx.lineTo(-11, -13);
        ctx.closePath();
        ctx.fillStyle = "rgba(26,115,232,0.9)";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.restore();
    }

    // Your dot
    const user = userSprite(ratio);
    ctx.drawImage(user.canvas, userPoint.x - user.size / 2, userPoint.y - user.size / 2, user.size, user.size);
}

// Animated zooms (buttons, double tap, the snap at the end of a pinch): slide the canvas along
// with the tiles. When the map is rotated the maths differs, so just hide the dots until it lands.
map.on("zoomanim", (event) => {
    lastPaintedView = null; // the canvas is about to be moved, so the next map event must repaint it
    if (rotationSupported && Math.abs(currentBearing()) > 0.01) {
        stationCanvas.style.visibility = "hidden";
        return;
    }
    const scale = map.getZoomScale(event.zoom);
    const size = map.getSize();
    const oldCentre = map.project(map.getCenter(), map.getZoom());
    const newCentre = map.project(event.center, event.zoom);
    const shiftX = (size.x / 2) * (1 - scale) + scale * oldCentre.x - newCentre.x;
    const shiftY = (size.y / 2) * (1 - scale) + scale * oldCentre.y - newCentre.y;
    stationCanvas.style.transition = "transform 0.25s cubic-bezier(0, 0, 0.25, 1)";
    stationCanvas.style.transform = `translate(${shiftX}px, ${shiftY}px) scale(${scale})`;
});
map.on("move zoom rotate resize viewreset zoomend moveend", repaintForViewChange);
map.on("popupopen popupclose", requestStationRepaint);

// Tapping the map opens the nearest dot's popup (the dots are painted, so they have no click events)
map.on("click", (event) => {
    const tap = map.latLngToContainerPoint(event.latlng);
    const reach = L.Browser.touch ? 20 : 12;
    if (userPosition) {
        const dot = map.latLngToContainerPoint(userPosition);
        if ((dot.x - tap.x) ** 2 + (dot.y - tap.y) ** 2 < (USER_DOT_RADIUS + reach / 2) ** 2) {
            L.popup().setLatLng(userPosition).setContent(escapeHtml(userLabel)).openOn(map);
            return;
        }
    }
    const view = getViewTransform();
    const point = { x: 0, y: 0 };
    let bestIndex = -1;
    let bestDistance = reach * reach;
    for (let index = 0; index < visibleSpots.length; index++) {
        toScreen(view, visibleWorld[index * 2], visibleWorld[index * 2 + 1], point);
        const distance = (point.x - tap.x) ** 2 + (point.y - tap.y) ** 2;
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    }
    if (bestIndex >= 0) openSpotPopup(visibleSpots[bestIndex]);
});

function drawStations(fitToResults) {
    visibleStations = filteredStations();
    buildVisibleIndex();
    requestStationRepaint();

    if (fitToResults && visibleStations.length) {
        map.fitBounds(L.latLngBounds(visibleStations.map((s) => [s[FIELD.lat], s[FIELD.lon]])), {
            padding: [30, 30],
            maxZoom: 10,
        });
    }

    const noun = typeIsCb(settings.radioType) ? "repeater" : "station";
    el("status").textContent =
        statusMessage ||
        `${visibleStations.length} ${noun}${visibleStations.length === 1 ? "" : "s"} shown` +
            (settings.state === "All" ? "" : " in " + settings.state);
}

// ---------------------------------------------------------------------------
// Filter buttons
// ---------------------------------------------------------------------------

function countByState() {
    const counts = { All: 0 };
    stations.forEach((s) => {
        if (hasPosition(s) && (settings.radioType === "all" || s[FIELD.radioType] === settings.radioType)) {
            counts.All++;
            counts[s[FIELD.state]] = (counts[s[FIELD.state]] || 0) + 1;
        }
    });
    return counts;
}

function buildTypeButtons() {
    const counts = { all: 0 };
    stations.forEach((s) => {
        if (!hasPosition(s)) return;
        counts.all++;
        counts[s[FIELD.radioType]] = (counts[s[FIELD.radioType]] || 0) + 1;
    });
    const options = [{ id: "all", label: "All types" }, ...RADIO_TYPES];
    el("types").innerHTML = options
        .map(
            (t) =>
                `<button data-type="${t.id}" aria-pressed="${t.id === settings.radioType}">${t.label}<b>${counts[t.id] || 0}</b></button>`
        )
        .join("");
}

function buildStateButtons() {
    const counts = countByState();
    const otherStates = Object.keys(counts).filter((s) => s !== "All" && !STATE_ORDER.includes(s)).sort();
    el("states").innerHTML = ["All", ...STATE_ORDER.filter((s) => counts[s]), ...otherStates]
        .map((s) => `<button data-state="${s}" aria-pressed="${s === settings.state}">${s}<b>${counts[s]}</b></button>`)
        .join("");
}

function buildChannelOptions() {
    const channels = [...new Set(stations.map((s) => s[FIELD.channel]).filter((c) => c != null))].sort((a, b) => a - b);
    el("ch").insertAdjacentHTML("beforeend", channels.map((c) => `<option value="${c}">Channel ${c}</option>`).join(""));
}

function applyRadioTypeToChannelFilter() {
    const channelsApply = settings.radioType === "all" || typeIsCb(settings.radioType);
    el("ch").hidden = !channelsApply;
    if (!channelsApply) {
        el("ch").value = "";
        settings.channel = "";
    }
}

// ---------------------------------------------------------------------------
// Nearest stations: lines, labels and the collapsible list
// ---------------------------------------------------------------------------

function nearestStations() {
    const wanted = settings.nearestCount === "all" ? Infinity : +settings.nearestCount;
    return filteredStations()
        .map((s) => ({ km: distanceKm(userPosition, [s[FIELD.lat], s[FIELD.lon]]), station: s }))
        .sort((a, b) => a.km - b.km)
        .slice(0, wanted);
}

function updateNearest() {
    el("opts").hidden = !userPosition;
    if (!userPosition) {
        nearestShown = [];
        requestStationRepaint();
        el("near").innerHTML = "";
        el("nearBox").hidden = true;
        return;
    }
    el("nearBox").hidden = false;

    const nearest = nearestStations();

    // The lines and labels are painted with the dots (see paintStations)
    nearestShown = nearest;
    requestStationRepaint();

    el("nearSummary").textContent = `Nearest to you (${nearest.length})`;
    el("near").innerHTML = nearest
        .map(
            ({ km, station }) =>
                `<button data-index="${stations.indexOf(station)}">` +
                `<span class="chb${isEmergency(station) ? " em" : ""}">${badgeText(station)}</span>` +
                `<span>${escapeHtml(station[FIELD.siteName] || station[FIELD.callSign])}<br>` +
                `<small>${station[FIELD.state]} &middot; ${frequencySummary(station)}</small></span>` +
                `<span class="km">${formatKm(km)}</span></button>`
        )
        .join("");
}

// ---------------------------------------------------------------------------
// User position: search by address, saved location, GPS
// ---------------------------------------------------------------------------

function setUserPosition(position, label, accuracyMetres) {
    userPosition = position;
    userLabel = label;
    userAccuracy = accuracyMetres || 0;
    requestStationRepaint();
}

function rememberLocation(label, query) {
    settings.location = { lat: userPosition[0], lon: userPosition[1], label, query: query || "" };
    saveSettings();
}

function stopGps() {
    if (geolocationWatchId != null) {
        navigator.geolocation.clearWatch(geolocationWatchId);
        geolocationWatchId = null;
    }
}

function useCandidate(index) {
    const candidate = locationCandidates[index];
    const shortName = candidate.display_name.split(",").slice(0, 3).join(",");
    setUserPosition([+candidate.lat, +candidate.lon], "Searching from " + shortName, 0);
    rememberLocation(shortName, el("aq").value.trim());
    statusMessage =
        "Showing stations near " + shortName + "." +
        (candidateSource === "local" ? " (Matched to a listed station site, because the online address lookup wasn’t available.)" : "");
    map.setView(userPosition, 10);
    drawStations(false);
    updateNearest();
}

// Offline fallback: match a postcode or site name from the station list itself
function localSearch(query) {
    const cleaned = query
        .toLowerCase()
        .replace(/,/g, " ")
        .replace(/\b(nsw|vic|qld|sa|wa|tas|nt|act|australia)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) return [];
    const located = stations.filter(hasPosition);

    if (/^\d{4}$/.test(cleaned)) {
        const matches = located.filter((s) => s[FIELD.postcode] === cleaned);
        if (matches.length) {
            return [{
                lat: matches.reduce((sum, s) => sum + s[FIELD.lat], 0) / matches.length,
                lon: matches.reduce((sum, s) => sum + s[FIELD.lon], 0) / matches.length,
                display_name: "Postcode " + cleaned + ", " + matches[0][FIELD.state],
            }];
        }
    }
    const seen = new Set();
    const results = [];
    for (const s of located) {
        if (s[FIELD.siteName].toLowerCase().includes(cleaned)) {
            const key = s[FIELD.lat] + "," + s[FIELD.lon];
            if (!seen.has(key)) {
                seen.add(key);
                results.push({ lat: s[FIELD.lat], lon: s[FIELD.lon], display_name: s[FIELD.siteName] + ", " + s[FIELD.state] });
            }
        }
        if (results.length >= 5) break;
    }
    return results;
}

// Tries Photon, then Open-Meteo, then Nominatim, then the local station list
async function geocode(query) {
    try {
        const response = await fetch(
            "https://photon.komoot.io/api/?limit=6&lang=en&bbox=112,-44.5,154.5,-9&q=" + encodeURIComponent(query)
        );
        if (response.ok) {
            const json = await response.json();
            const results = [];
            (json.features || []).forEach((feature) => {
                const p = feature.properties || {};
                if (p.countrycode && p.countrycode !== "AU") return;
                const parts = [
                    p.name,
                    [p.housenumber, p.street].filter(Boolean).join(" "),
                    p.city || p.district,
                    p.state,
                    p.postcode,
                ].filter(Boolean);
                results.push({
                    lat: feature.geometry.coordinates[1],
                    lon: feature.geometry.coordinates[0],
                    display_name: [...new Set(parts)].join(", "),
                });
            });
            if (results.length) return [results, "online"];
        }
    } catch (error) { /* try the next service */ }

    try {
        const placeName = query
            .replace(/,/g, " ")
            .replace(/\b(nsw|vic|qld|sa|wa|tas|nt|act|australia)\b/gi, " ")
            .replace(/\s+/g, " ")
            .trim();
        const response = await fetch(
            "https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&country_code=AU&name=" +
                encodeURIComponent(placeName)
        );
        if (response.ok) {
            const json = await response.json();
            const results = (json.results || []).map((p) => ({
                lat: p.latitude,
                lon: p.longitude,
                display_name: [p.name, p.admin1, (p.postcodes || [])[0]].filter(Boolean).join(", "),
            }));
            if (results.length) return [results, "online"];
        }
    } catch (error) { /* try the next service */ }

    try {
        const response = await fetch(
            "https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=au&limit=5&q=" + encodeURIComponent(query)
        );
        if (response.ok) {
            const json = await response.json();
            if (json.length) return [json, "online"];
        }
    } catch (error) { /* fall back to local data */ }

    return [localSearch(query), "local"];
}

// Show the best match, with the other matches tucked into a collapsed section
function renderAlternatives() {
    if (!locationCandidates.length) {
        el("alts").innerHTML = "";
        return;
    }
    const button = (candidate, index) =>
        `<button type="button" data-index="${index}">${escapeHtml(candidate.display_name)}</button>`;
    const others = locationCandidates.slice(1);
    el("alts").innerHTML =
        button(locationCandidates[0], 0) +
        (others.length
            ? `<details class="more"><summary>${others.length} other match${others.length === 1 ? "" : "es"}</summary>` +
              others.map((c, i) => button(c, i + 1)).join("") +
              "</details>"
            : "");
}

function clearUserPosition() {
    stopGps();
    userPosition = null;
    userAccuracy = 0;
    statusMessage = "";
    locationCandidates = [];
    settings.location = null;
    saveSettings();
    renderAlternatives();
    updateNearest();
    drawStations(false);
}

// ---------------------------------------------------------------------------
// GPS. The position comes from the browser's Geolocation API. getCurrentPosition takes one reading;
// watchPosition keeps calling back every time the device reports a new fix. "Live updates" in the
// Location options picks between the two. Both go through applyFix().
// ---------------------------------------------------------------------------

const LIVE_MIN_MOVE_METRES = 5; // smaller changes are GPS jitter, so only the accuracy circle is refreshed
const SAVE_MIN_MOVE_METRES = 25; // how far you move before the saved location is rewritten
let lastFix = null; // [lat, lon] of the last position that was applied

function applyFix(position) {
    statusMessage = "";
    const here = [position.coords.latitude, position.coords.longitude];
    const movedMetres = lastFix ? distanceKm(lastFix, here) * 1000 : Infinity;

    if (movedMetres < LIVE_MIN_MOVE_METRES && userPosition) {
        userAccuracy = position.coords.accuracy;
        requestStationRepaint();
        return;
    }
    lastFix = here;
    setUserPosition(here, "You are here", position.coords.accuracy);
    if (firstFixPending || movedMetres > SAVE_MIN_MOVE_METRES) rememberLocation("Your location", "");
    if (firstFixPending) {
        map.setView(userPosition, 9); // only the first fix moves the map; use the recentre button after that
        firstFixPending = false;
    }
    drawStations(false);
    updateNearest();
}

function handleGpsError(error) {
    if (error.code === 1 && settings.liveGps) {
        // Permission denied: live can't work, so turn it off and bring Find me back
        settings.liveGps = false;
        saveSettings();
        updateLiveControls();
    }
    statusMessage =
        error.code === 1
            ? "Location permission was denied. Allow location for this page, or enter a suburb above."
            : "Couldn’t get your location. Check GPS or signal, or enter a suburb above.";
    drawStations(false);
}

// options.resume: carry on from the position already on screen (no "finding" message, no recentre)
// options.keepAlternatives: leave the address matches as they are (Live greys them out instead)
function startGps(options = {}) {
    if (!navigator.geolocation) {
        statusMessage = "Location is not available in this browser. Enter a suburb above instead.";
        return drawStations(false);
    }
    stopGps();
    if (options.resume) {
        firstFixPending = false;
        lastFix = userPosition;
    } else {
        firstFixPending = true;
        lastFix = null;
        statusMessage = "Finding your location…";
        if (!options.keepAlternatives) {
            locationCandidates = [];
            renderAlternatives();
        }
        drawStations(false);
    }

    if (settings.liveGps) {
        geolocationWatchId = navigator.geolocation.watchPosition(applyFix, handleGpsError, {
            enableHighAccuracy: true,
            maximumAge: 2000,
            timeout: 30000,
        });
    } else {
        navigator.geolocation.getCurrentPosition(applyFix, handleGpsError, {
            enableHighAccuracy: true,
            maximumAge: 10000,
            timeout: 30000,
        });
    }
}

const positionIsFromGps = () => !!(settings.location && settings.location.label === "Your location");

// Shows the Live button's state. While live is on, your position comes from the GPS, so the manual
// ways of setting it (Find me, the address box, the Search button and the list of matches) are
// greyed out and can't be used. Turning Live off switches them all back on.
function updateLiveControls() {
    const live = settings.liveGps;
    el("live").setAttribute("aria-pressed", live);
    ["me", "aq", "search"].forEach((id) => {
        el(id).disabled = live;
        el(id).title = live ? "Switched off while Live is on" : "";
    });
    el("alts").inert = live;
    el("alts").classList.toggle("is-disabled", live);
}

// The Live button: on starts following you straight away (it takes the place of Find me),
// off stops following and keeps the last position on screen
function handleLiveToggle() {
    if (!settings.liveGps && !navigator.geolocation) {
        statusMessage = "Location is not available in this browser. Enter a suburb above instead.";
        return drawStations(false);
    }
    settings.liveGps = !settings.liveGps;
    saveSettings();
    updateLiveControls();
    if (settings.liveGps) {
        startGps({ resume: !!userPosition && positionIsFromGps(), keepAlternatives: true });
    } else {
        stopGps();
        if (positionIsFromGps()) statusMessage = "Live updates off. Showing your last position.";
        drawStations(false);
    }
}

async function handleAddressSearch(event) {
    event.preventDefault();
    if (settings.liveGps) return; // switched off while Live is on
    const query = el("aq").value.trim();
    if (!query) return;
    stopGps();
    statusMessage = "Searching…";
    locationCandidates = [];
    renderAlternatives();
    drawStations(false);
    try {
        const [results, source] = await geocode(query);
        candidateSource = source;
        if (!results.length) {
            statusMessage = "No match found. Try the suburb and state (for example Alice Springs NT) or a 4-digit postcode.";
            return drawStations(false);
        }
        locationCandidates = results;
        useCandidate(0);
        renderAlternatives();
    } catch (error) {
        statusMessage = "Search failed: " + (error && error.message ? error.message : "unknown error") + ". Check the browser console for details.";
        drawStations(false);
    }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function wireEvents() {
    el("types").onclick = (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        settings.radioType = button.dataset.type;
        applyRadioTypeToChannelFilter();
        if (settings.state !== "All" && !countByState()[settings.state]) settings.state = "All";
        saveSettings();
        buildTypeButtons();
        buildStateButtons();
        map.closePopup(); // the selected marker may no longer be shown
        drawStations(false); // leave the map where it is
        updateNearest();
    };

    el("states").onclick = (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        settings.state = button.dataset.state;
        saveSettings();
        buildStateButtons();
        map.closePopup();
        drawStations(true);
        updateNearest();
    };

    el("q").addEventListener("input", () => {
        settings.filterText = el("q").value;
        saveSettings();
        drawStations(false);
        updateNearest();
    });
    el("ch").addEventListener("input", () => {
        settings.channel = el("ch").value;
        saveSettings();
        drawStations(false);
        updateNearest();
    });

    el("addr").onsubmit = handleAddressSearch;
    el("me").onclick = () => startGps();
    el("live").onclick = handleLiveToggle;
    el("aq").addEventListener("input", () => {
        if (!el("aq").value.trim() && (userPosition || locationCandidates.length || statusMessage)) clearUserPosition();
    });

    el("alts").onclick = (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        const index = +button.dataset.index;
        el("aq").value = locationCandidates[index].display_name;
        useCandidate(index);
    };

    // Display options
    const optionInputs = {
        olines: ["showLines", "checked"],
        olabels: ["showDistanceLabels", "checked"],
        ochan: ["showChannelLabels", "checked"],
        ncount: ["nearestCount", "value"],
    };
    Object.entries(optionInputs).forEach(([id, [key, prop]]) =>
        el(id).addEventListener("change", () => {
            settings[key] = el(id)[prop];
            saveSettings();
            updateNearest();
        })
    );

    el("near").onclick = (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        const station = stations[+button.dataset.index];
        map.setView([station[FIELD.lat], station[FIELD.lon]], Math.max(map.getZoom(), 11));
        const spot = spotByKey.get(spotKeyFor(station)) || { lat: station[FIELD.lat], lon: station[FIELD.lon], stations: [station] };
        openSpotPopup(spot, station);
    };

    el("compassBtn").onclick = toggleCompassMode;
    el("compassReset").onclick = pointMapNorth;
    map.on("rotate", updateCompass);
    // A two-finger twist means you want to steer: stop the compass fighting your fingers
    map.getContainer().addEventListener(
        "touchstart",
        (event) => {
            if (event.touches.length >= 2 && settings.compassMode === "follow") {
                leaveFollowMode();
                updateCompass();
            }
        },
        { passive: true }
    );

    map.on("baselayerchange", (event) => {
        settings.baseMap = event.name;
        saveSettings();
    });
    map.on("moveend", () => {
        const centre = map.getCenter();
        settings.view = { lat: centre.lat, lon: centre.lng, zoom: map.getZoom() };
        saveSettings();
    });
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

function applySettingsToControls() {
    el("q").value = settings.filterText;
    updateLiveControls();
    el("olines").checked = settings.showLines;
    el("olabels").checked = settings.showDistanceLabels;
    el("ochan").checked = settings.showChannelLabels;
    el("ncount").value = settings.nearestCount;
    el("ch").value = settings.channel;
    applyRadioTypeToChannelFilter();
}

async function init() {
    loadSettings();
    const loaded = await loadStations();
    stations = loaded.stations;
    if (!stations.length) {
        el("status").textContent =
            "No station data found. Serve this page over http(s) with data/repeaters.json next to it (run update_data.py to create it), or open the page once with the data present so it can be cached.";
        return;
    }
    setRadioTypes(loaded.types);
    // A saved category may no longer exist: fall back to the first UHF CB category, else all
    if (settings.radioType !== "all" && !RADIO_TYPES.some((t) => t.id === settings.radioType)) {
        const firstCb = RADIO_TYPES.find((t) => t.cb);
        settings.radioType = firstCb ? firstCb.id : "all";
    }

    // Restore the saved map style (a style that no longer exists falls back to the default)
    if (!BASE_MAPS[settings.baseMap]) settings.baseMap = DEFAULT_SETTINGS.baseMap;
    BASE_MAPS[settings.baseMap].addTo(map);
    L.control.layers(BASE_MAPS, null, { position: "topright" }).addTo(map);

    buildChannelOptions();
    if (settings.state !== "All" && !countByState()[settings.state]) settings.state = "All";
    applySettingsToControls();
    buildTypeButtons();
    buildStateButtons();

    el("legend").innerHTML =
        RADIO_TYPES.map((t) => `<i style="background:${t.color}"></i>${t.label}`).join("") +
        (RADIO_TYPES.some((t) => t.cb) || stations.some(isEmergency) ? `<i style="background:${EMERGENCY_COLOR}"></i>Emergency (CB ch 5)` : "");
    el("datasource").textContent = "Station data loaded from the " + loaded.source + ".";

    wireEvents();

    // Restore the last search location and map view
    const hadSavedView = !!settings.view;
    if (hadSavedView) map.setView([settings.view.lat, settings.view.lon], settings.view.zoom);
    if (settings.location) {
        const saved = settings.location;
        el("aq").value = saved.query || (saved.label !== "Your location" ? saved.label : "");
        setUserPosition([saved.lat, saved.lon], saved.label === "Your location" ? "Last known location" : "Searching from " + saved.label, 0);
        statusMessage = "Showing stations near " + saved.label + " (saved from last time).";
    }

    drawStations(!hadSavedView);
    updateNearest();
    updateCompass();

    if (settings.compassMode === "follow") {
        // Browsers (iOS especially) need a tap to start the compass again
        settings.compassMode = "north";
        updateCompass();
    }

    // Live updates were on last time: carry on if the browser already allows location,
    // otherwise switch it off so Find me is available again
    if (settings.liveGps) {
        const turnOff = () => {
            settings.liveGps = false;
            saveSettings();
            updateLiveControls();
        };
        if (positionIsFromGps() && navigator.permissions) {
            navigator.permissions
                .query({ name: "geolocation" })
                .then((result) => (result.state === "granted" ? startGps({ resume: true }) : turnOff()))
                .catch(turnOff);
        } else {
            turnOff();
        }
    }
}

init();

// Installable app: the service worker (sw.js) caches the page and data so the app opens quickly
// and keeps working with a weak signal. It needs http(s), so it is skipped for file:// pages.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
