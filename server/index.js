// CHRIST Smart Campus - ingestion service + API (MQTT -> validate -> SQLite -> React dashboard)
import express from 'express';
import mqtt from 'mqtt';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, REGISTRY } from './validate.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch { console.error('This project needs Node.js 22.13 or newer. Run "node -v" to check your version.'); process.exit(1); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';   // same broker as the Wokwi sketches
const STALE_MS = 120000;                                                    // spec: offline after 2 min without heartbeat

// ---------- Database (FR-03) ----------
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, '..', 'smart_campus.db'));
db.exec(`CREATE TABLE IF NOT EXISTS readings(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, received_at TEXT, module TEXT,
  building_id TEXT, zone_id TEXT, device_id TEXT, metric TEXT, value REAL, unit TEXT, status TEXT);
  CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY, ts TEXT, device_id TEXT, module TEXT, type TEXT,
  severity TEXT, status TEXT, acked_at TEXT);`);
const insReading = db.prepare('INSERT INTO readings(ts,received_at,module,building_id,zone_id,device_id,metric,value,unit,status) VALUES (?,?,?,?,?,?,?,?,?,?)');
const upsertAlert = db.prepare('INSERT OR REPLACE INTO alerts(id,ts,device_id,module,type,severity,status,acked_at) VALUES (?,?,?,?,?,?,?,?)');
const saveAlert = (a) => upsertAlert.run(a.id, a.ts, a.device_id, a.module, a.type, a.severity, a.status, a.acked_at || '');

// ---------- In-memory state ----------
const state = { devices: {}, latest: {}, series: {}, recent: [], rejected: [], rejectedCount: 0, mqtt: false,
  alerts: db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 100').all().map((a) => ({ ...a })) };
let alertCounter = state.alerts.reduce((m, a) => Math.max(m, a.id), 0);

function ingest(topic, text) {
  const r = validate(topic, text);
  if (!r.ok) {                                                              // FR-02: flag invalid messages (T2, T3)
    state.rejectedCount++;
    state.rejected.unshift({ at: new Date().toISOString(), topic, reason: r.reason, raw: text.slice(0, 160) });
    state.rejected.length = Math.min(state.rejected.length, 15);
    console.warn('REJECTED:', r.reason);
    return emit();
  }
  const { kind, d } = r;
  const dev = (state.devices[d.device_id] ||= {});
  Object.assign(dev, { module: d.module, last_seen: Date.now(), last_ts: d.timestamp, offlineAlerted: false });

  if (kind === 'alerts') handleAlert(d);
  if (kind === 'telemetry') {
    insReading.run(d.timestamp, new Date().toISOString(), d.module, d.building_id, d.zone_id, d.device_id, d.metric,
      typeof d.value === 'boolean' ? (d.value ? 1 : 0) : d.value, d.unit, d.status);
    ((state.latest[d.device_id] ||= {})[d.zone_id] ||= {})[d.metric] = { value: d.value, unit: d.unit, ts: d.timestamp, status: d.status, building: d.building_id };
    if (typeof d.value === 'number') {
      const arr = (state.series[`${d.device_id}/${d.zone_id}/${d.metric}`] ||= []);
      arr.push({ t: Date.parse(d.timestamp), v: d.value });
      if (arr.length > 80) arr.shift();
    }
    state.recent.unshift({ ts: d.timestamp, module: d.module, zone: d.zone_id, metric: d.metric, value: d.value, unit: d.unit });
    state.recent.length = Math.min(state.recent.length, 60);
    if ((d.module === 'parking' && (d.metric === 'slot_occupied' || d.metric === 'distance_cm')) ||
        (d.module === 'energy' && d.metric === 'power_w') || (d.module === 'water' && d.metric === 'tank_level_pct') ||
        (d.module === 'waste' && d.metric === 'bin_fill_pct') || (d.module === 'safety' && d.metric === 'temperature')) {
      // A sensor that keeps reporting readings is healthy: resolve a fault alert whose recovery message was lost.
      state.alerts.filter((a) => a.device_id === d.device_id &&
        (a.type === `sensor_fault [${d.zone_id}]` || a.type === `obstruction [${d.zone_id}]`) &&
        a.status !== 'resolved' && Date.parse(d.timestamp) - Date.parse(a.ts) >= 30000)
        .forEach((a) => { a.status = 'resolved'; a.acked_at ||= new Date().toISOString(); saveAlert(a); });
    }
  }
  emit();
}

// ---------- Alerts (FR-06, FR-07) ----------
function handleAlert(d) {
  const type = `${d.metric} [${d.zone_id}]`;
  if (d.value === false || d.status === 'normal') {                          // recovery message: resolves ALL open alerts of this type
    state.alerts.filter((a) => a.device_id === d.device_id && a.type === type && a.status !== 'resolved')
      .forEach((a) => { a.status = 'resolved'; a.acked_at ||= new Date().toISOString(); saveAlert(a); });
    return;
  }
  if (state.alerts.find((a) => a.device_id === d.device_id && a.type === type && a.status === 'active')) return;
  const rec = { id: ++alertCounter, ts: d.timestamp, device_id: d.device_id, module: d.module, type,
    severity: d.status === 'critical' ? 'critical' : 'warning', status: 'active', acked_at: '' };
  state.alerts.unshift(rec); saveAlert(rec);
}

// ---------- Stale / offline detection (FR-09) ----------
setInterval(() => {
  for (const [id, dv] of Object.entries(state.devices)) {
    if (Date.now() - dv.last_seen > STALE_MS && !dv.offlineAlerted) {
      dv.offlineAlerted = true;
      const rec = { id: ++alertCounter, ts: new Date().toISOString(), device_id: id, module: dv.module, type: 'device_offline',
        severity: 'critical', status: 'active', acked_at: '' };
      state.alerts.unshift(rec); saveAlert(rec);
    }
  }
  emit();
}, 10000);

// ---------- Live push to the browser ----------
function snapshot() {
  const now = Date.now(), devices = {};
  for (const [id, d] of Object.entries(state.devices)) {
    devices[id] = { module: d.module, last_ts: d.last_ts, age_s: Math.round((now - d.last_seen) / 1000), online: now - d.last_seen <= STALE_MS };
  }
  return { now, mqtt: state.mqtt, broker: MQTT_URL, registry: REGISTRY, devices, latest: state.latest, series: state.series,
    recent: state.recent, rejected: state.rejected, rejectedCount: state.rejectedCount, alerts: state.alerts.slice(0, 60) };
}
const clients = new Set();
let timer = null;
function emit() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const c of clients) c.write(msg);
  }, 150);
}

// ---------- MQTT ----------
const client = mqtt.connect(MQTT_URL, { reconnectPeriod: 3000, clientId: 'campus-dashboard-' + Math.random().toString(16).slice(2, 8) });
client.on('connect', () => { state.mqtt = true; client.subscribe('christ-smart-campus/v1/#', { qos: 1 }); console.log('MQTT connected:', MQTT_URL); emit(); });
client.on('close', () => { state.mqtt = false; emit(); });
client.on('error', (e) => {
  // Network failures often arrive as an AggregateError with an empty message, so print the real causes.
  const why = (e.errors && e.errors.map((x) => `${x.code || ''} ${x.address || ''}:${x.port || ''}`.trim()).join(' | ')) || e.code || e.message || String(e);
  console.error('MQTT error:', why);
});
client.on('message', (topic, buf, packet) => {
  if (packet.retain) return;   // retained messages are old state from earlier runs; ignore so stopped devices don't look ONLINE
  ingest(topic, buf.toString());
});

// ---------- Test messages (published through the real broker, for T2/T3/T6 evidence) ----------
function testMessage(name) {
  const ts = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const cb = 'christ-smart-campus/v1/classroom/block-a/CLASS-A-ESP32-01';
  const pb = 'christ-smart-campus/v1/parking/block-a/PARK-A-ESP32-01';
  const eb = 'christ-smart-campus/v1/energy/block-a/ENERGY-A-ESP32-01';
  const wb = 'christ-smart-campus/v1/water/block-a/WATER-A-ESP32-01';
  const sb = 'christ-smart-campus/v1/waste/block-a/WASTE-A-ESP32-01';
  const fb = 'christ-smart-campus/v1/safety/block-a/SAFE-A-ESP32-01';
  const c = (o) => ({ schema_version: '1.0', campus_id: 'CHRIST-DEMO', module: 'classroom', building_id: 'BLOCKA', zone_id: 'ROOM-204',
    device_id: 'CLASS-A-ESP32-01', timestamp: ts(), metric: 'temperature', value: 31.0, unit: 'C', status: 'normal', ...o });
  const p = (o) => ({ schema_version: '1.0', campus_id: 'CHRIST-DEMO', module: 'parking', building_id: 'BLOCKA', zone_id: 'SLOT-1',
    device_id: 'PARK-A-ESP32-01', timestamp: ts(), metric: 'slot_occupied', value: true, unit: 'bool', status: 'normal', ...o });
  const e = (o) => ({ schema_version: '1.0', campus_id: 'CHRIST-DEMO', module: 'energy', building_id: 'BLOCKA', zone_id: 'METER-1',
    device_id: 'ENERGY-A-ESP32-01', timestamp: ts(), metric: 'power_w', value: 30.0, unit: 'W', status: 'normal', ...o });
  const w = (o) => ({ schema_version: '1.0', campus_id: 'CHRIST-DEMO', module: 'water', building_id: 'BLOCKA', zone_id: 'TANK-1',
    device_id: 'WATER-A-ESP32-01', timestamp: ts(), metric: 'tank_level_pct', value: 55.0, unit: '%', status: 'normal', ...o });
  const b = (o) => ({ schema_version: '1.0', campus_id: 'CHRIST-DEMO', module: 'waste', building_id: 'BLOCKA', zone_id: 'BIN-1',
    device_id: 'WASTE-A-ESP32-01', timestamp: ts(), metric: 'bin_fill_pct', value: 60.0, unit: '%', status: 'normal', ...o });
  const f = (o) => ({ schema_version: '1.0', campus_id: 'CHRIST-DEMO', module: 'safety', building_id: 'BLOCKA', zone_id: 'LAB-101',
    device_id: 'SAFE-A-ESP32-01', timestamp: ts(), metric: 'temperature', value: 24.0, unit: 'C', status: 'normal', ...o });
  const del = (o, k) => { const x = { ...o }; delete x[k]; return x; };
  const T = {
    valid_sim: [cb + '/telemetry', c()],
    missing: [cb + '/telemetry', del(c(), 'unit')],
    unknown_module: ['christ-smart-campus/v1/cafeteria/block-a/CLASS-A-ESP32-01/telemetry', c({ module: 'cafeteria' })],
    unknown_device: ['christ-smart-campus/v1/classroom/block-a/CLASS-Z-ESP32-99/telemetry', c({ device_id: 'CLASS-Z-ESP32-99' })],
    out_of_range: [cb + '/telemetry', c({ value: 250 })],
    malformed: [cb + '/telemetry', '{"module":"classroom", "value": 29.2'],
    sensor_fault: [cb + '/alerts', c({ metric: 'sensor_fault', value: true, unit: 'bool', status: 'fault' })],
    sensor_ok: [cb + '/alerts', c({ metric: 'sensor_fault', value: false, unit: 'bool', status: 'normal' })],
    p_valid: [pb + '/telemetry', p()],
    p_free: [pb + '/telemetry', p({ value: false })],
    p_missing: [pb + '/telemetry', del(p(), 'unit')],
    p_unknown_device: ['christ-smart-campus/v1/parking/block-a/PARK-Z-ESP32-99/telemetry', p({ device_id: 'PARK-Z-ESP32-99' })],
    p_unknown_module: ['christ-smart-campus/v1/garage/block-a/PARK-A-ESP32-01/telemetry', p({ module: 'garage' })],
    p_range: [pb + '/telemetry', p({ metric: 'distance_cm', value: 900, unit: 'cm' })],
    p_fault: [pb + '/alerts', p({ zone_id: 'SLOT-2', metric: 'sensor_fault', value: true, unit: 'bool', status: 'fault' })],
    p_ok: [pb + '/alerts', p({ zone_id: 'SLOT-2', metric: 'sensor_fault', value: false, unit: 'bool', status: 'normal' })],
    e_valid: [eb + '/telemetry', e()],
    e_missing: [eb + '/telemetry', del(e(), 'unit')],
    e_unknown_device: ['christ-smart-campus/v1/energy/block-a/ENERGY-Z-ESP32-99/telemetry', e({ device_id: 'ENERGY-Z-ESP32-99' })],
    e_range: [eb + '/telemetry', e({ value: 999999 })],
    e_overload: [eb + '/alerts', e({ metric: 'overload', value: true, unit: 'bool', status: 'critical' })],
    e_overload_ok: [eb + '/alerts', e({ metric: 'overload', value: false, unit: 'bool', status: 'normal' })],
    e_fault: [eb + '/alerts', e({ metric: 'sensor_fault', value: true, unit: 'bool', status: 'fault' })],
    e_fault_ok: [eb + '/alerts', e({ metric: 'sensor_fault', value: false, unit: 'bool', status: 'normal' })],
    w_valid: [wb + '/telemetry', w()],
    w_missing: [wb + '/telemetry', del(w(), 'unit')],
    w_unknown_device: ['christ-smart-campus/v1/water/block-a/WATER-Z-ESP32-99/telemetry', w({ device_id: 'WATER-Z-ESP32-99' })],
    w_range: [wb + '/telemetry', w({ value: 150 })],
    w_low: [wb + '/alerts', w({ metric: 'low_level', value: true, unit: 'bool', status: 'warning' })],
    w_low_ok: [wb + '/alerts', w({ metric: 'low_level', value: false, unit: 'bool', status: 'normal' })],
    w_leak: [wb + '/alerts', w({ metric: 'leak', value: true, unit: 'bool', status: 'critical' })],
    w_leak_ok: [wb + '/alerts', w({ metric: 'leak', value: false, unit: 'bool', status: 'normal' })],
    b_valid: [sb + '/telemetry', b()],
    b_missing: [sb + '/telemetry', del(b(), 'unit')],
    b_unknown_device: ['christ-smart-campus/v1/waste/block-a/WASTE-Z-ESP32-99/telemetry', b({ device_id: 'WASTE-Z-ESP32-99' })],
    b_range: [sb + '/telemetry', b({ value: 150 })],
    b_collect: [sb + '/alerts', b({ metric: 'collection_required', value: true, unit: 'bool', status: 'warning' })],
    b_collect_ok: [sb + '/alerts', b({ metric: 'collection_required', value: false, unit: 'bool', status: 'normal' })],
    b_bin2: [sb + '/telemetry', b({ zone_id: 'BIN-2', value: 85.0, status: 'warning' })],
    b_bin3: [sb + '/telemetry', b({ zone_id: 'BIN-3', value: 30.0 })],
    f_valid: [fb + '/telemetry', f()],
    f_missing: [fb + '/telemetry', del(f(), 'unit')],
    f_unknown_device: ['christ-smart-campus/v1/safety/block-a/SAFE-Z-ESP32-99/telemetry', f({ device_id: 'SAFE-Z-ESP32-99' })],
    f_range: [fb + '/telemetry', f({ value: 500 })],
    f_smoke: [fb + '/alerts', f({ metric: 'smoke_detected', value: true, unit: 'bool', status: 'critical' })],
    f_smoke_ok: [fb + '/alerts', f({ metric: 'smoke_detected', value: false, unit: 'bool', status: 'normal' })],
    f_temp: [fb + '/alerts', f({ metric: 'high_temperature', value: true, unit: 'bool', status: 'critical' })],
    f_temp_ok: [fb + '/alerts', f({ metric: 'high_temperature', value: false, unit: 'bool', status: 'normal' })]
  };
  return T[name];
}

// ---------- HTTP API ----------
const app = express();
const canOperate = (req) => ['operator', 'admin'].includes(req.get('x-role'));     // role simulation (spec: roles may be simulated)

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
app.get('/api/state', (req, res) => res.json(snapshot()));

app.post('/api/alerts/:id/ack', (req, res) => {
  if (!canOperate(req)) return res.status(403).json({ error: 'Operator or Administrator role required' });
  const a = state.alerts.find((x) => x.id === Number(req.params.id));
  if (!a || a.status !== 'active') return res.status(404).json({ error: 'No active alert with that id' });
  a.status = 'acknowledged'; a.acked_at = new Date().toISOString(); saveAlert(a);
  emit(); res.json({ ok: true });
});

app.post('/api/test/:name', (req, res) => {
  if (!canOperate(req)) return res.status(403).json({ error: 'Operator or Administrator role required' });
  const t = testMessage(req.params.name);
  if (!t) return res.status(404).json({ error: 'Unknown test' });
  client.publish(t[0], typeof t[1] === 'string' ? t[1] : JSON.stringify(t[1]), { qos: 1 });
  res.json({ ok: true });
});

app.get('/api/export/readings.csv', (req, res) => {                          // FR-08
  const rows = db.prepare('SELECT ts,received_at,module,building_id,zone_id,device_id,metric,value,unit,status FROM readings ORDER BY id DESC LIMIT 5000').all();
  const cols = ['ts', 'received_at', 'module', 'building_id', 'zone_id', 'device_id', 'metric', 'value', 'unit', 'status'];
  const esc = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="smart_campus_readings.csv"' });
  res.send([cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n'));
});

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}   (broker: ${MQTT_URL})`));