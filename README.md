# CHRIST Smart Campus – Integrated IoT-Based Campus Management System

> **MCA523B-5 – Internet of Things | 5 MCA B | CHRIST (Deemed to be University)**
> Educational prototype using **synthetic data only**. This is *not* an approved live campus deployment and *not* a certified life-safety system.

**Team:** Alok, Kunnal, Pranav

---

## 🔗 Quick Links

| Resource | Link |
|---|---|
| Live Dashboard (Render) | https://iot-smart-campus-automation.onrender.com/ |
| Module 1 – Intelligent Classroom (Wokwi) | https://wokwi.com/projects/480180098834231297 |
| Module 2 – Smart Parking (Wokwi) | https://wokwi.com/projects/480188099032470529 |
| Module 3 – Smart Energy (Wokwi) | https://wokwi.com/projects/480396928403601409 |
| Module 4 – Smart Water (Wokwi) | https://wokwi.com/projects/480460219960602625 |
| Module 5 – Smart Waste (Wokwi) | https://wokwi.com/projects/480462153809318913 |
| Module 6 – Campus Safety (Wokwi) | https://wokwi.com/projects/480490262108451841 |
| Source Code (GitHub) | https://github.com/Dazai-arch/IOT_SMART_CAMPUS_AUTOMATION |

> ℹ️ The Render free tier may sleep when idle – the first page load can take ~30–60 s.

---

## 📖 Overview

Campus operations generate data across classrooms, parking, energy, water, waste and safety systems. This project connects **six ESP32-based IoT modules** to **one shared MQTT broker and Node-RED dashboard**, giving a consolidated operational view with live values, device health, alerts and history.

All six modules follow a common **device identity, MQTT topic convention and JSON telemetry schema** (Section 5 of the project specification), so any module can be added or replaced without changing the dashboard.

## 🏗️ System Architecture

```
 Sensors / Actuators
        │
     ESP32 (Wokwi simulation)
        │   Wi-Fi  (MQTT, QoS-tolerant, JSON)
        ▼
 MQTT Broker (broker.hivemq.com:1883)
        │
        ▼
 Node-RED  ──► validation / processing ──► storage ──► Dashboard + Alerts
                                                       (deployed on Render)
```

| Layer | Technology |
|---|---|
| Physical | ESP32 DevKit C v4, PIR, LDR, DHT22, HC-SR04, NTC, gas sensor, LEDs, buzzer, push buttons, potentiometer |
| Connectivity | Wi-Fi (`Wokwi-GUEST`), MQTT via PubSubClient |
| Integration | Public HiveMQ broker (synthetic data only), Node-RED flows (`flows.json`) |
| Application | Node-RED dashboard hosted on Render |
| Tooling | Arduino C++ firmware, Wokwi simulator, Git/GitHub |

## 🧩 Modules

| # | Module | Device ID | Zone | Key Metrics |
|---|---|---|---|---|
| 1 | Intelligent Classroom | `CLASS-A-ESP32-01` | `ROOM-204` | `occupancy_detected`, `light_level`, `temperature`, `light_state`, `fan_state` |
| 2 | Smart Parking (3 slots) | `PARK-A-ESP32-01` | `LOT-A`, `SLOT-1..3` | `slot_occupied`, `distance_cm`, `occupancy_count`, `slots_available`, `slots_total` |
| 3 | Smart Energy *(simulated)* | `ENERGY-A-ESP32-01` | `METER-1` | `power_w`, `energy_kwh` |
| 4 | Smart Water | `WATER-A-ESP32-01` | `TANK-1` | `tank_level_pct`, `water_flow_lpm`, leak / low-level alerts |
| 5 | Smart Waste | `WASTE-A-ESP32-01` | `BIN-1` | `bin_fill_pct`, collection / obstruction alerts |
| 6 | Campus Safety | `SAFE-A-ESP32-01` | `LAB-101` | `temperature`, `gas_level_pct`, `smoke_detected`, `high_temperature` |

All modules also publish a `device_online` heartbeat on the `/status` topic.

### Module logic summary

**1 – Intelligent Classroom**
- Occupied **and** dark (< 100 lux) → light ON; bright (> 200 lux) → OFF (hysteresis band 100–200).
- No motion for 30 s → light OFF.
- Occupied and temp > 30 °C → fan ON; temp < 27 °C → fan OFF.
- DHT22 failure (3 consecutive bad reads) → `sensor_fault` alert, fan forced to safe OFF state.

**2 – Smart Parking**
- Ultrasonic per slot: `< 20 cm` occupied, `> 25 cm` free (20–25 cm hysteresis), 3-sample debounce.
- Faulty slots are excluded from available/occupied counts. No number plates or personal data.

**3 – Smart Energy**
- Potentiometer simulates current (0–5 A) on a 12 V low-voltage supply → 0–60 W.
- Overload alert > 50 W (clears < 45 W). Push button simulates sensor disconnect.
- Cumulative `energy_kwh` is integrated over time. Clearly labelled **simulated** measurement.

**4 – Smart Water**
- Ultrasonic tank level (10 cm = 100 %, 100 cm = 0 %). Low-level alert < 20 % (clears > 25 %).
- Simulated flow sensor (button pulses), leak detection, demo pump ON < 30 % / OFF > 90 %.

**5 – Smart Waste**
- Fill % from ultrasonic distance (50 cm = empty, 5 cm = full).
- `collection_required` above 80 % (clears below 70 %); obstruction (< 3.5 cm) and invalid-reading detection.

**6 – Campus Safety**
- High temperature alarm > 50 °C (clears < 45 °C); gas alarm when level rises 10 points above a clean-air baseline.
- Buzzer + LED local alarm, event button, reset button (refused while the condition persists), repeated-event handling.
- Long-press reset simulates **network loss**; alerts are queued and re-sent when the link returns, and the local alarm keeps working offline.

## 📡 Common Integration Specification

### Device identity
`{BLOCK}-{TYPE}-ESP32-{NN}` e.g. `CLASS-A-ESP32-01`. Campus ID: `CHRIST-DEMO`, building: `BLOCKA`.

### MQTT topics
```
christ-smart-campus/v1/{module}/{building}/{device_id}/telemetry
christ-smart-campus/v1/{module}/{building}/{device_id}/status
christ-smart-campus/v1/{module}/{building}/{device_id}/alerts
```
Example: `christ-smart-campus/v1/classroom/block-a/CLASS-A-ESP32-01/telemetry`

### JSON payload
```json
{
  "schema_version": "1.0",
  "campus_id": "CHRIST-DEMO",
  "module": "classroom",
  "building_id": "BLOCKA",
  "zone_id": "ROOM-204",
  "device_id": "CLASS-A-ESP32-01",
  "timestamp": "2026-11-01T08:30:00Z",
  "metric": "temperature",
  "value": 29.2,
  "unit": "C",
  "status": "normal"
}
```

- Timestamps are ISO 8601 **UTC** (synced via NTP `pool.ntp.org`).
- `value` uses native JSON types (number / boolean).
- Metric names use `lower_snake_case`.

### Publishing behaviour
| Type | Interval |
|---|---|
| Periodic telemetry | 5–10 s |
| Event messages | Immediately on state change (or on a significant delta, rate-limited to 1/s) |
| Heartbeat (`device_online`, retained) | 30 s |
| Stale/offline | After 2 min without heartbeat |

## 🚀 Getting Started

### Option A – Run the simulations (easiest)
1. Open any Wokwi link from the table above.
2. Click **▶ Start Simulation**. The ESP32 connects to `Wokwi-GUEST` Wi-Fi and the public MQTT broker.
3. Open the [live dashboard](https://iot-smart-campus-automation.onrender.com/) and watch values update.
4. Interact with the simulated parts (PIR, potentiometer, buttons, sensors) to trigger logic and alerts.

### Option B – Run locally
```bash
# 1. Clone the repository
git clone https://github.com/Dazai-arch/IOT_SMART_CAMPUS_AUTOMATION.git
cd IOT_SMART_CAMPUS_AUTOMATION

# 2. Install Node-RED (if not installed)
npm install -g --unsafe-perm node-red

# 3. Start Node-RED and import flows.json via the menu (Import → select file → Deploy)
node-red
```
Then open the Node-RED editor at `http://localhost:1880` and the dashboard at `http://localhost:1880/ui` *(path may differ depending on your dashboard version – check your flow)*.

### Option C – Flash real hardware
1. Install Arduino IDE / PlatformIO with the **ESP32 board package**.
2. Install libraries: `PubSubClient`, `DHT sensor library` (Module 1).
3. Edit `WIFI_SSID`, `WIFI_PASS`, and MQTT settings at the top of the sketch.
4. Wire per the pin table below and upload.

> The **MQTT broker in every sketch must match the broker configured in the Node-RED flow.**

## 🔌 Pin Mapping

| Module | Pins (ESP32 GPIO) |
|---|---|
| 1 Classroom | PIR 27, LDR 34, DHT22 15, Light LED 25, Fan LED 26 |
| 2 Parking | TRIG 5/19/22, ECHO 18/21/23, LEDs 27/26/25 |
| 3 Energy | Potentiometer 34, Button 27, LED 26 |
| 4 Water | TRIG 5, ECHO 18, Flow 14, Leak 27, Pump LED 25, Alert LED 26 |
| 5 Waste | TRIG 5, ECHO 18, OK LED 25, Collect LED 26 |
| 6 Safety | NTC 34, Gas 35, Event 27, Reset 14, Buzzer 25, LED 26 |

## 🧪 Testing

Each module was tested for: **normal operation, threshold/event, boundary condition, sensor disconnect / invalid reading, and recovery/reset**. Built-in test switches in the firmware:

| Module | Test switch |
|---|---|
| 1 | `TEST_FORCE_DHT_FAULT = true` |
| 2 | `TEST_FORCE_FAULT_SLOT = 1..3` |
| 3 | Push button toggles "sensor disconnected" |
| 4, 5, 6 | `TEST_FORCE_SENSOR_FAULT = true` |
| 6 | Long-press Reset = simulate network loss |

Platform-level tests (valid feed, malformed/missing field, stale/offline after timeout, reconnect, alert source/time/severity, units & last-updated) and all screenshots/evidence are in the project report.

## 🔐 Security, Privacy & Safety

- Uses **synthetic data only** – no personal or identifiable data is collected.
- No credentials are committed; `MQTT_USER`/`MQTT_PASS` are blank for the public broker. **Do not reuse this setup with real credentials.**
- `broker.hivemq.com` is a **public** broker: anyone can read or publish to topics. It is used here only for a simulation. A real deployment would need a private broker with TLS and authentication.
- Alerts are retried until delivered so a network drop does not lose an alarm.
- No mains voltage, real pumps, gas or smoke are used. Energy is a **simulated** low-voltage measurement.

## ⚠️ Limitations & Future Work

- Simulated hardware (Wokwi); real sensors would need calibration and noise filtering.
- Public broker with no auth/TLS.
- Single device per module; one building (`BLOCKA`).
- **Future work:** private broker with TLS and ACLs, authenticated command channel, persistent database (PostgreSQL), role-based access, OTA firmware updates, real current sensor (e.g. ACS712/INA219) on an approved isolated circuit.

## 📁 Repository Structure *(update to match your repo)*

```
IOT_SMART_CAMPUS_AUTOMATION/
├── module1_classroom/    # ESP32 firmware
├── module2_parking/
├── module3_energy/
├── module4_water/
├── module5_waste/
├── module6_safety/
├── node-red/flows.json   # dashboard + ingestion flow
├── docs/                 # report, diagrams, test evidence
└── README.md
```

## 📄 License & Acknowledgement

Developed as an academic project for **MCA523B-5 Internet of Things**, CHRIST (Deemed to be University), based on the *CHRIST Smart Campus Student Project Implementation Specification v1.0*. Add a license of your choice (e.g. MIT) if you publish the repository.