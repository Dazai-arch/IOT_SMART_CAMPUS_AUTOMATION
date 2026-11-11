import React, { useEffect, useState } from 'react';

const CLASS = 'CLASS-A-ESP32-01';
const PARK = 'PARK-A-ESP32-01';
const ENERGY = 'ENERGY-A-ESP32-01';
const LABELS = { classroom: 'Intelligent Classroom', parking: 'Smart Parking', energy: 'Smart Energy', water: 'Smart Water', waste: 'Smart Waste', safety: 'Campus Safety' };

const val = (s, dev, zone, metric) => s.latest?.[dev]?.[zone]?.[metric];
const time = (ts) => (ts ? ts.replace('T', ' ').slice(0, 19) : '-');

// ---------- small components ----------
function Pill({ dev }) {
  if (!dev) return <span className="pill none">NO DATA YET</span>;
  return <span className={'pill ' + (dev.online ? 'on' : 'off')}>{dev.online ? 'ONLINE' : 'OFFLINE / STALE'}</span>;
}

function DeviceHealth({ id, dev }) {
  return (
    <div className="card" style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
      <span>Device <b>{id}</b></span>
      <span><Pill dev={dev} /> {dev && <span className="muted"> last message {dev.age_s} s ago</span>}</span>
    </div>
  );
}

function Tile({ label, value, sub, cls }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className={'value ' + (cls || '')}>{value ?? '-'}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function Chart({ points = [], title, unit, step }) {
  const W = 360, H = 140, P = 26;
  if (points.length < 2) return <div className="card"><h4>{title}</h4><div className="muted">Waiting for data...</div></div>;
  const xs = points.map((p) => p.t), ys = points.map((p) => p.v);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const rx = x1 - x0 || 1, ry = y1 - y0 || 1;
  const px = (t) => P + ((t - x0) / rx) * (W - 2 * P);
  const py = (v) => H - P - ((v - y0) / ry) * (H - 2 * P);
  let d = '';
  points.forEach((p, i) => { const x = px(p.t), y = py(p.v); d += i ? (step ? ` H${x} V${y}` : ` L${x} ${y}`) : `M${x} ${y}`; });
  const fmt = (t) => new Date(t).toISOString().slice(11, 19);
  return (
    <div className="card">
      <h4>{title} <span className="muted">({unit})</span></h4>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart">
        <path d={d} fill="none" stroke="#0b7285" strokeWidth="2" />
        <text x={P} y={H - 6} fontSize="9">{fmt(x0)}</text>
        <text x={W - P} y={H - 6} fontSize="9" textAnchor="end">{fmt(x1)}</text>
        <text x="2" y={P} fontSize="9">{y1.toFixed(1)}</text>
        <text x="2" y={H - P} fontSize="9">{y0.toFixed(1)}</text>
      </svg>
    </div>
  );
}

function AlertsTable({ alerts, role, onAck }) {
  return (
    <div className="card">
      <table>
        <thead><tr><th>Time (UTC)</th><th>Source device</th><th>Alert</th><th>Severity</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.id}>
              <td>{time(a.ts)}</td><td>{a.device_id}</td><td>{a.type}</td>
              <td className={a.severity === 'critical' ? 'badc' : 'warn'}><b>{a.severity}</b></td>
              <td>{a.status}</td>
              <td>{a.status === 'active' && (role === 'viewer'
                ? <span className="muted">operator only</span>
                : <button className="act" onClick={() => onAck(a.id)}>Acknowledge</button>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!alerts.length && <div className="muted">No alerts</div>}
    </div>
  );
}

function Recent({ rows }) {
  return (
    <div className="card">
      <table>
        <thead><tr><th>Time (UTC)</th><th>Zone</th><th>Metric</th><th>Value</th><th>Unit</th></tr></thead>
        <tbody>
          {rows.slice(0, 12).map((r, i) => (
            <tr key={i}><td>{time(r.ts)}</td><td>{r.zone}</td><td>{r.metric}</td><td>{String(r.value)}</td><td>{r.unit}</td></tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="muted">No readings yet</div>}
      <div style={{ marginTop: 8 }}><a href="/api/export/readings.csv" target="_blank" rel="noreferrer">Download CSV export</a></div>
    </div>
  );
}

// ---------- pages ----------
function Overview({ s }) {
  return (
    <>
      <h2>Campus overview</h2>
      <div className="grid">
        {Object.entries(LABELS).map(([mod, label]) => {
          const id = Object.keys(s.registry).find((k) => s.registry[k] === mod);
          const dev = s.devices[id];
          const open = s.alerts.filter((a) => a.module === mod && a.status !== 'resolved').length;
          return (
            <div className="card tile" key={mod}>
              <div className="label">{label}</div>
              <div style={{ margin: '6px 0' }}><Pill dev={dev} /></div>
              <div className="sub">{id}</div>
              <div className="sub">{dev ? 'Last update ' + time(dev.last_ts) : 'Not connected'}</div>
              <div className="sub">Open alerts: <b>{open}</b></div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Classroom({ s, role, onAck }) {
  const g = (m) => val(s, CLASS, 'ROOM-204', m);
  const occ = g('occupancy_detected'), temp = g('temperature'), lux = g('light_level'), light = g('light_state'), fan = g('fan_state');
  const lastTs = Object.values(s.latest[CLASS]?.['ROOM-204'] || {}).map((x) => x.ts).sort().pop();
  const tcls = temp ? (temp.value > 30 ? 'badc' : temp.value < 27 ? 'good' : 'warn') : '';
  const onoff = (x) => (x ? (x.value ? 'ON' : 'OFF') : '-');
  return (
    <>
      <h2>Intelligent Classroom - ROOM-204</h2>
      <DeviceHealth id={CLASS} dev={s.devices[CLASS]} />
      <div className="grid">
        <Tile label="Occupancy" value={occ ? (occ.value ? 'Occupied' : 'Empty') : '-'} />
        <Tile label="Temperature" value={temp ? temp.value.toFixed(1) + ' °C' : '-'} cls={tcls} sub="fan on above 30, off below 27" />
        <Tile label="Light level" value={lux ? lux.value.toFixed(1) + ' lux' : '-'} />
        <Tile label="Light (actuator)" value={onoff(light)} />
        <Tile label="Fan (actuator)" value={onoff(fan)} />
        <Tile label="Last update (UTC)" value={<span style={{ fontSize: 15 }}>{time(lastTs)}</span>} />
      </div>
      <h3>Trends</h3>
      <div className="grid2">
        <Chart title="Temperature" unit="°C" points={s.series[`${CLASS}/ROOM-204/temperature`]} />
        <Chart title="Light level" unit="lux" points={s.series[`${CLASS}/ROOM-204/light_level`]} />
      </div>
      <h3>Alerts</h3>
      <AlertsTable alerts={s.alerts.filter((a) => a.module === 'classroom')} role={role} onAck={onAck} />
      <h3>Recent readings</h3>
      <Recent rows={s.recent.filter((r) => r.module === 'classroom')} />
    </>
  );
}

function Parking({ s, role, onAck }) {
  const zones = s.latest[PARK] || {};
  const slotNames = Object.keys(zones).filter((z) => z.startsWith('SLOT-')).sort();
  const faulty = (z) => s.alerts.some((a) => a.device_id === PARK && a.type === `sensor_fault [${z}]` && a.status !== 'resolved');
  const slots = slotNames.map((z) => ({ name: z, occ: zones[z].slot_occupied?.value, cm: zones[z].distance_cm?.value, fault: faulty(z) }));
  const lot = zones['LOT-A'] || {};
  const healthy = slots.filter((x) => !x.fault && x.occ !== undefined);
  const total = lot.slots_total?.value ?? slots.length;
  const occupied = lot.occupancy_count?.value ?? healthy.filter((x) => x.occ).length;
  const available = lot.slots_available?.value ?? healthy.filter((x) => !x.occ).length;
  const last = lot.occupancy_count?.ts || lot.slots_available?.ts;
  return (
    <>
      <h2>Smart Parking - BLOCK A</h2>
      <DeviceHealth id={PARK} dev={s.devices[PARK]} />
      <div className="card">
        <div className="slots">
          {slots.map((x) => (
            <div key={x.name} className={'slot ' + (x.fault ? 'fault' : x.occ ? 'occ' : 'free')}>
              <b>{x.name}</b>{x.fault ? 'FAULT' : x.occ ? 'OCCUPIED' : 'FREE'}
              <br /><span>{x.cm != null ? x.cm + ' cm' : '-'}</span>
            </div>
          ))}
          {!slots.length && <div className="muted">Waiting for data...</div>}
        </div>
        <div>Total: <b>{total}</b> &nbsp; Occupied: <b>{occupied}</b> &nbsp; Available: <b>{available}</b></div>
        <div className="muted">Last update (UTC): {time(last)}</div>
      </div>
      <h3>Trends</h3>
      <div className="grid2">
        <Chart title="Occupied slots" unit="slots" step points={s.series[`${PARK}/LOT-A/occupancy_count`]} />
      </div>
      <h3>Alerts</h3>
      <AlertsTable alerts={s.alerts.filter((a) => a.module === 'parking')} role={role} onAck={onAck} />
      <h3>Recent readings</h3>
      <Recent rows={s.recent.filter((r) => r.module === 'parking')} />
    </>
  );
}

function Energy({ s, role, onAck }) {
  const g = (m) => val(s, ENERGY, 'METER-1', m);
  const p = g('power_w'), e = g('energy_kwh');
  const open = (t) => s.alerts.some((a) => a.device_id === ENERGY && a.type === `${t} [METER-1]` && a.status !== 'resolved');
  const status = open('sensor_fault') ? ['SENSOR FAULT', 'badc'] : open('overload') ? ['OVERLOAD', 'badc'] : p ? ['NORMAL', 'good'] : ['-', ''];
  const last = p?.ts || e?.ts;
  return (
    <>
      <h2>Smart Energy - METER-1</h2>
      <DeviceHealth id={ENERGY} dev={s.devices[ENERGY]} />
      <div className="card muted" style={{ marginBottom: 12 }}>
        SIMULATED DATA: a potentiometer stands in for a current sensor (0-5 A at a nominal 12 V DC, so power = 12 x current).
      </div>
      <div className="grid">
        <Tile label="Live power" value={p ? p.value.toFixed(1) + ' W' : '-'} cls={p ? (p.value > 50 ? 'badc' : 'good') : ''} sub="overload above 50 W" />
        <Tile label="Energy (cumulative)" value={e ? e.value.toFixed(4) + ' kWh' : '-'} />
        <Tile label="Status" value={status[0]} cls={status[1]} />
        <Tile label="Last update (UTC)" value={<span style={{ fontSize: 15 }}>{time(last)}</span>} />
      </div>
      <h3>Trends</h3>
      <div className="grid2">
        <Chart title="Power" unit="W" points={s.series[`${ENERGY}/METER-1/power_w`]} />
        <Chart title="Energy" unit="kWh" points={s.series[`${ENERGY}/METER-1/energy_kwh`]} />
      </div>
      <h3>Alerts</h3>
      <AlertsTable alerts={s.alerts.filter((a) => a.module === 'energy')} role={role} onAck={onAck} />
      <h3>Recent readings</h3>
      <Recent rows={s.recent.filter((r) => r.module === 'energy')} />
    </>
  );
}

const TESTS = [
  ['Classroom', [['valid_sim', 'Valid reading (31 C)'], ['missing', 'T2: missing field'], ['unknown_module', 'T3: unknown module'], ['unknown_device', 'T3: unknown device'],
    ['out_of_range', 'Out-of-range temperature'], ['malformed', 'Malformed JSON'], ['sensor_fault', 'T6: sensor fault alert'], ['sensor_ok', 'Fault recovery']]],
  ['Parking', [['p_valid', 'Slot 1 occupied'], ['p_free', 'Slot 1 free'], ['p_missing', 'T2: missing field'], ['p_unknown_device', 'T3: unknown device'],
    ['p_unknown_module', 'T3: unknown module'], ['p_range', 'Out-of-range distance'], ['p_fault', 'T6: slot 2 fault alert'], ['p_ok', 'Slot 2 recovery']]],
  ['Energy', [['e_valid', 'Valid reading (30 W)'], ['e_missing', 'T2: missing field'], ['e_unknown_device', 'T3: unknown device'], ['e_range', 'Out-of-range power'],
    ['e_overload', 'T6: overload alert'], ['e_overload_ok', 'Overload cleared'], ['e_fault', 'Sensor fault alert'], ['e_fault_ok', 'Sensor fault recovery']]]
];

function System({ s, role, onTest, sent }) {
  return (
    <>
      <h2>Flagged messages and test tools</h2>
      <div className="card">
        <b>Total flagged: {s.rejectedCount}</b>
        <table>
          <thead><tr><th>Time (UTC)</th><th>Reason</th><th>Topic</th></tr></thead>
          <tbody>{s.rejected.map((r, i) => <tr key={i}><td>{time(r.at)}</td><td>{r.reason}</td><td className="muted">{r.topic}</td></tr>)}</tbody>
        </table>
      </div>
      <h3>Test tools {role === 'viewer' && <span className="muted">(switch role to Operator to use)</span>}</h3>
      {TESTS.map(([name, list]) => (
        <div className="card" key={name} style={{ marginBottom: 10 }}>
          <h4>{name}</h4>
          <div className="tests">{list.map(([id, label]) => <button key={id} disabled={role === 'viewer'} onClick={() => onTest(id)}>{label}</button>)}</div>
        </div>
      ))}
      {sent && <div className="muted">{sent}</div>}
    </>
  );
}

// ---------- app ----------
export function Dashboard({ s, err, role, setRole, tab, setTab, onAck, onTest, sent }) {
  const tabs = [['overview', 'Campus overview'], ['classroom', 'Classroom (Module 1)'], ['parking', 'Parking (Module 2)'], ['energy', 'Energy (Module 3)'], ['system', 'Flagged / Tests']];
  return (
    <>
      <header>
        <h1>CHRIST Smart Campus</h1>
        <div>
          <span className={'pill ' + (s && s.mqtt && !err ? 'on' : 'off')}>{s && s.mqtt && !err ? 'BROKER CONNECTED' : 'BROKER DISCONNECTED'}</span>{' '}
          Role: <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Administrator</option>
          </select>
        </div>
      </header>
      <nav>{tabs.map(([id, label]) => <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
      <main>
        {!s ? <div className="card">Connecting to the dashboard server...</div> : (
          <>
            {tab === 'overview' && <Overview s={s} />}
            {tab === 'classroom' && <Classroom s={s} role={role} onAck={onAck} />}
            {tab === 'parking' && <Parking s={s} role={role} onAck={onAck} />}
            {tab === 'energy' && <Energy s={s} role={role} onAck={onAck} />}
            {tab === 'system' && <System s={s} role={role} onTest={onTest} sent={sent} />}
          </>
        )}
      </main>
    </>
  );
}

export default function App() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState(false);
  const [role, setRole] = useState('viewer');
  const [tab, setTab] = useState('overview');
  const [sent, setSent] = useState('');

  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => { setS(JSON.parse(e.data)); setErr(false); };
    es.onerror = () => setErr(true);
    return () => es.close();
  }, []);

  const post = (url) => fetch(url, { method: 'POST', headers: { 'x-role': role } });
  const onAck = (id) => post(`/api/alerts/${id}/ack`);
  const onTest = async (id) => { const r = await post(`/api/test/${id}`); setSent(r.ok ? `Sent test "${id}" through the broker.` : 'Not allowed for this role.'); };

  return <Dashboard {...{ s, err, role, setRole, tab, setTab, onAck, onTest, sent }} />;
}