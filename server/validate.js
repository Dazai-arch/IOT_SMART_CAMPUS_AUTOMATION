// Schema validation (spec Section 5). Edit REGISTRY to add/remove allowed devices (T3: unknown device flagged).
export const REGISTRY = {
  'CLASS-A-ESP32-01': 'classroom',
  'PARK-A-ESP32-01': 'parking',
  'ENERGY-A-ESP32-01': 'energy',
  'WATER-A-ESP32-01': 'water',
  'WASTE-A-ESP32-01': 'waste',
  'SAFE-A-ESP32-01': 'safety'
};
const MODULES = ['classroom', 'parking', 'energy', 'water', 'waste', 'safety'];
const REQUIRED = ['schema_version', 'campus_id', 'module', 'building_id', 'zone_id', 'device_id', 'timestamp', 'metric', 'value', 'unit', 'status'];
const BOOL_METRICS = ['occupancy_detected', 'slot_occupied', 'smoke_detected', 'device_online', 'light_state', 'fan_state', 'sensor_fault', 'overload', 'pump_state', 'leak', 'low_level'];
const RANGES = {
  occupancy_count: [0, 1000], temperature: [-40, 80], light_level: [0, 100000], co2_ppm: [0, 10000],
  power_w: [0, 100000], energy_kwh: [0, 1e9], tank_level_pct: [0, 100], water_flow_lpm: [0, 1000],
  bin_fill_pct: [0, 100], distance_cm: [0, 500], slots_total: [0, 100], slots_available: [0, 100]
};
const KNOWN = BOOL_METRICS.concat(Object.keys(RANGES));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const bad = (reason) => ({ ok: false, reason });

export function validate(topic, text) {
  const parts = (topic || '').split('/');
  if (parts.length !== 6 || parts[0] !== 'christ-smart-campus' || parts[1] !== 'v1') return bad('bad topic structure');
  const kind = parts[5];
  if (!['telemetry', 'status', 'alerts'].includes(kind)) return bad('unknown topic type: ' + kind);

  let d;
  try { d = JSON.parse(text); } catch { return bad('malformed JSON'); }
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return bad('payload is not a JSON object');

  const missing = REQUIRED.filter((k) => d[k] === undefined || d[k] === null || d[k] === '');
  if (missing.length) return bad('missing field(s): ' + missing.join(', '));
  if (!MODULES.includes(d.module)) return bad('unknown module: ' + d.module);
  if (parts[2] !== d.module) return bad('topic/payload module mismatch');
  if (parts[4] !== d.device_id) return bad('topic/payload device_id mismatch');
  if (!REGISTRY[d.device_id]) return bad('unknown device_id: ' + d.device_id);
  if (REGISTRY[d.device_id] !== d.module) return bad('device_id does not belong to module ' + d.module);
  if (typeof d.timestamp !== 'string' || !ISO.test(d.timestamp) || isNaN(Date.parse(d.timestamp))) return bad('invalid timestamp');
  if (Date.parse(d.timestamp) > Date.now() + 5 * 60 * 1000) return bad('timestamp in the future');

  if (kind !== 'alerts' && !KNOWN.includes(d.metric)) return bad('unknown metric: ' + d.metric);
  if (BOOL_METRICS.includes(d.metric)) {
    if (typeof d.value !== 'boolean') return bad('value must be boolean for ' + d.metric);
  } else if (kind !== 'alerts' || RANGES[d.metric]) {
    if (typeof d.value !== 'number' || !Number.isFinite(d.value)) return bad('value must be numeric for ' + d.metric);
    const r = RANGES[d.metric];
    if (r && (d.value < r[0] || d.value > r[1])) return bad('out-of-range ' + d.metric + ': ' + d.value);
  }
  return { ok: true, kind, d };
}