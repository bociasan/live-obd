# BMW DPF Live

Reads diesel particulate filter values (soot mass, ash, differential pressure, regeneration status, …) and other
engine-ECU live data from BMW cars through an ELM327 adapter, directly in the browser.

**Open:** https://bociasan.github.io/live-obd/

## Requirements

| Device | Browser | Adapter |
|---|---|---|
| Windows / macOS / Linux | Chrome or Edge | USB ELM327, Bluetooth Classic ELM327 (paired, as COM port), Bluetooth LE ELM327 |
| Android | Chrome | Bluetooth LE ELM327 |
| iPhone / iPad | [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) | Bluetooth LE ELM327 |

Wi-Fi ELM327 adapters cannot be used from a browser.

Supported cars: BMW with D-CAN on the OBD port (E-series from about 2007, F- and G-series). The engine ECU is
identified automatically (`22 F1 50` on UDS ECUs, `1A 80` on KWP2000 ECUs).

## ECU data

The page does not include the ECU description table. Load your `ecu-data.json` (or `ecu-data.json.gz`) once with
**Load ECU data file**; the browser keeps it in its own storage until you press **Remove**.

## Safety

The page only sends read requests (`22`, `1A`, `2C 10`); it never writes to the car. Do not operate it while
driving.

## Development

- `node test/sim.test.js <ecu-data.json>`: protocol stack against the built-in simulator
- `node test/browser.test.js <chrome.exe> <ecu-data.json.gz>`: end-to-end run in headless Chrome

Not affiliated with BMW AG.
