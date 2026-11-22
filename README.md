# Australian Radio Map
 
A single-page street map of licensed radio stations in Australia, built mainly for finding **UHF CB repeaters**. Pick a radio type and a state, search a suburb or tap **Find me**, and the map shows the nearest stations with the channels and frequencies you need to use them.
 
It is a static site: plain HTML, CSS and JavaScript with no build step and no server code, so it runs on GitHub Pages.
 
> The data comes from the ACMA Register of Radiocommunications Licences. It shows licensed entries, **not live status**. Never rely on this map alone in an emergency. Channel 5 repeaters are for emergencies only.
 
## Features
 
- **Five radio types:** UHF CB, Marine VHF, Marine HF, Amateur and Aeronautical, filterable by state, channel, site name, call sign or postcode.
- **UHF CB RX / TX:** for each repeater it shows the channel you listen on and the channel you transmit on (30 higher), with both frequencies. Channel 5 is flagged as emergency use only.
- **Nearest stations:** search a suburb or address, or use your device location. It draws lines to the nearest 3, 5, 10 or all shown stations, with distance and RX / TX labels.
- **Collapsible lists:** the nearest list and a distance bar chart sit under the map, collapsed by default.
- **Map rotation and compass:** rotate the map with the compass buttons, a two-finger twist on a phone, or Shift + drag on a computer. A compass rose shows north, and a toggle switches between **North locked** and **Following compass** (turns the map with your phone's heading).
- **Popups:** site details, power, antenna height, polarisation, licence, distance from you and a Google Maps directions link.
- **Line of sight:** once you have a position, each station's popup has a *Line of sight from you* button. It draws a chart of the ground between you and that station, with the earth's curve, the first Fresnel zone and a straight line between the two antennas, and says whether the path is clear, marginal or blocked. You can change both antenna heights.
- **Remembers your settings:** radio type, state, channel, filter text, map style, line options, last location and map view are saved in your browser, so it reopens where you left off.
- **Four map styles:** Esri Streets, CARTO, Esri Satellite and OpenStreetMap.
## Files
 
```
AustralianRadioMap/
├── index.html            the page
├── app.js                all of the JavaScript
├── style.css             all of the styling
├── manifest.webmanifest  makes the page installable as an app
├── sw.js                 service worker: caches the app so it opens fast and works offline
├── icons/                app icon (SVG and PNG sizes) and favicon
├── update_data.py        downloads the ACMA data and builds data/repeaters.json
├── data/
│   └── repeaters.json    all stations, one full ACMA-style record each (written by update_data.py)
├── cache/                downloaded ACMA zip (created by the script, not committed)
├── README.md
├── LICENSE
└── .gitignore
```
 
## Install as an app
 
The page is a progressive web app. It must be served over https (GitHub Pages is) or from `localhost`.
 
- **Android (Chrome):** open the page, then use the browser menu and choose *Install app* (or *Add to Home screen*).
- **iPhone / iPad (Safari):** tap Share, then *Add to Home Screen*.
- **Desktop (Chrome or Edge):** use the install icon at the right of the address bar.
Once installed it opens full screen with its own icon. The page, scripts and station data are cached, so it starts quickly and the list of stations is available without a signal. Map tiles and address search still need a connection. When you publish new data, the installed app shows it the second time it is opened. To force an update of the cached app files, change `VERSION` at the top of `sw.js`.
 
## Running it
 
**The page must be served over http(s)** so it can read `data/repeaters.json`. Opening `index.html` straight from disk won't load the data, because browsers block `fetch()` on `file://` pages.
 
To run it locally (this is also needed to test location and the compass on a phone):
 
```
python -m http.server 8000
```
 
then open `http://localhost:8000`. 
 
**On GitHub Pages:** commit the whole folder (including `data/`), then in the repository go to *Settings → Pages* and publish from your branch. All paths are relative, so it works under an address like `username.github.io/AustralianRadioMap/`. Pages uses https, which phones require for location and for the iPhone compass.
 
## Updating the data
 
`update_data.py` needs Python 3 and nothing else.
 
```
python update_data.py              # download (if the cache is over 24 hours old) and build
python update_data.py --force      # always download a fresh copy
python update_data.py --zip C:\path\to\spectra_rrl.zip   # use a zip you already have
python update_data.py --inspect    # list the CSV files and columns inside the zip
```
 
What it does:
 
1. Downloads the ACMA's daily `spectra_rrl.zip` and caches it in `cache/`.
2. Streams `device_details.csv` and keeps transmitting devices on granted licences whose site has coordinates.
3. Sorts each device into a radio type from its frequency and licence service wording. UHF CB repeaters are the "CBRS Repeater" subservice, and the channel number is worked out from the output frequency (476.4125–476.6125 MHz).
4. Adds everything linked to each device (site, licence, client, antenna, access area, licence conditions and the other devices on the same station), in the same layout as `split_device_details.py`.
5. Writes **one** file, `data/repeaters.json`, sorted so each radio type is bundled together (cb, mvhf, mhf, ama, air), then by subservice, state and site name.
Each record also gets four fields for the map: `RADIO_TYPE`, `BAND`, `POWER_WATTS` and `CB_CHANNEL`. Useful options: `--include-receivers` keeps receive-side rows, `--no-text` leaves out licence conditions (much smaller file), and `--no-pairs` skips `same_station_devices`. The full records make the file much larger than before, so `--no-text` is worth using for hosting.
 
If the ACMA changes its column names, the script says which column is missing. Run `--inspect` to see the real names and adjust the `COLUMNS` block at the top of the script. The type rules are an approximation, so check the counts after a run.
 
If the download fails with `getaddrinfo failed`, your computer could not look up the ACMA address (a network, VPN or DNS problem). Download the zip by hand from the ACMA page and use `--zip`.
 
## Notes and limits
 
- Distances are straight-line, not driving distance.
- Line of sight uses ground heights only (no buildings or trees), assumes the licensed antenna height or a 10 m default, and needs an internet connection to fetch the terrain tiles.
- To use a UHF CB repeater, press the duplex button on your radio.
- The compass needs a device with a compass sensor. On iPhone it needs https and a tap to grant permission. Compass mode always starts as North locked.
- Map rotation uses the leaflet-rotate plugin. If it fails to load, the map still works but cannot rotate.
- Settings are stored per browser and per address, so the file on disk and the GitHub Pages copy do not share them.
## Data sources and credits
 
- [ACMA Register of Radiocommunications Licences](https://www.acma.gov.au/radiocomms-licence-data), the source of the station data
- [Leaflet](https://leafletjs.com/) and [leaflet-rotate](https://github.com/Raruto/leaflet-rotate)
- Map tiles: [OpenStreetMap](https://www.openstreetmap.org/copyright), [Esri](https://www.esri.com/), [CARTO](https://carto.com/basemaps/)
- Address search: [Photon](https://photon.komoot.io/), [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) and [Nominatim](https://nominatim.org/)
- Directions links: [Google Maps URLs](https://developers.google.com/maps/documentation/urls/get-started)
- Ground heights for line of sight: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
The map tile and search services have their own usage policies. They suit light personal use.
 
## Licence
 
The code is released under the MIT licence, see [LICENSE](LICENSE). The ACMA licence data is not covered by it. It remains subject to the ACMA's own terms: <https://www.acma.gov.au/radiocomms-licence-data>.
 
## AI disclosure
 
This project was written and modified with the help of Claude, an AI assistant made by Anthropic. The code and the way the register data is processed (including how station type is worked out) may contain mistakes. Check details against the official register before relying on them.
 