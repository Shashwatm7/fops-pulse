// IMF PortWatch — GCC port activity ingestion + throughput-anomaly computation.
//
// Source: IMF PortWatch "Daily Ports Data" ArcGIS FeatureServer (public, keyless,
// refreshed weekly on Tuesdays; ~1 week lag). It publishes per port-day:
//   - portcalls (+ by vessel type)  — count of ship arrivals (satellite AIS)
//   - import/export trade estimates — in metric tons
// It does NOT publish queue length or dwell time. What we surface as "congestion"
// is a THROUGHPUT ANOMALY: recent port-call/import volume vs a trailing baseline.
// A sharp drop (or spike) is the supply-disruption signal a planner cares about.
//
// Grain stored: one row per portid per date in port_activity_snapshots.

import axios from 'axios';
import { pool } from '../../db.js';

const FEATURESERVER =
    'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services/Daily_Ports_Data/FeatureServer/0/query';

// GCC port catalog, baked from the confirmed FeatureServer distinct-value query
// (ISO3 IN ARE,SAU,QAT,OMN,KWT,BHR). Kept static so the type-ahead needs no live
// call. Refresh by re-running that query if PortWatch adds GCC ports.
export const GCC_PORTS = [
    { portid: 'port2012', portname: 'Khalifa Bin Salman', country: 'Bahrain', iso3: 'BHR' },
    { portid: 'port2060', portname: 'Mina Salman', country: 'Bahrain', iso3: 'BHR' },
    { portid: 'port1203', portname: 'Sitrah', country: 'Bahrain', iso3: 'BHR' },
    { portid: 'port743', portname: 'Mina Al Ahmadi', country: 'Kuwait', iso3: 'KWT' },
    { portid: 'port2493', portname: 'Mina Al Zour', country: 'Kuwait', iso3: 'KWT' },
    { portid: 'port2067', portname: 'Shuaiba', country: 'Kuwait', iso3: 'KWT' },
    { portid: 'port25', portname: 'Shuwaikh', country: 'Kuwait', iso3: 'KWT' },
    { portid: 'port984', portname: 'Duqm', country: 'Oman', iso3: 'OMN' },
    { portid: 'fso151', portname: 'Oman - Offshore Oil Terminal 1', country: 'Oman', iso3: 'OMN' },
    { portid: 'port745', portname: 'Port Sultan Qaboos', country: 'Oman', iso3: 'OMN' },
    { portid: 'port988', portname: 'Port of Sohar', country: 'Oman', iso3: 'OMN' },
    { portid: 'port1068', portname: 'Qalhat LNG Terminal', country: 'Oman', iso3: 'OMN' },
    { portid: 'port746', portname: 'Salalah', country: 'Oman', iso3: 'OMN' },
    { portid: 'port1117', portname: 'Al Ruwais', country: 'Qatar', iso3: 'QAT' },
    { portid: 'port1342', portname: 'Doha-Umm Said', country: 'Qatar', iso3: 'QAT' },
    { portid: 'port2026', portname: 'Hamad Port', country: 'Qatar', iso3: 'QAT' },
    { portid: 'port1090', portname: 'Ras Laffan', country: 'Qatar', iso3: 'QAT' },
    { portid: 'port275', portname: 'Dammam', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port304', portname: 'Duba (Port of Neom)', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port305', portname: 'Duba Bulk Plant Tanker Terminal', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port2074', portname: 'Jazan', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port518', portname: 'Jeddah', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port526', portname: 'Juaymah', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port24', portname: 'Jubail', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port2031', portname: 'King Abdullah Port', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port1081', portname: 'Rabigh', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port2217', portname: 'Ras Al Khafji', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port1088', portname: 'Ras Al Mishab', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port1089', portname: 'Ras Al-Khair', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port1091', portname: 'Ras Tanura', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'fso158', portname: 'Saudi Arabia - Offshore Oil Terminal 1', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port519', portname: 'Shoaiba', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port2218', portname: 'Shuqaiq', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port570', portname: 'Yanbu (King Fahd Port)', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port1408', portname: 'Yanbu (Yanbu city)', country: 'Saudi Arabia', iso3: 'SAU' },
    { portid: 'port5', portname: 'Abu Dhabi', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port13', portname: 'Ajman', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port22', portname: 'Al Hamriyah LPG Terminal', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port2237', portname: 'Das Island', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port306', portname: 'Dubai', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port362', portname: 'Fujairah', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port512', portname: 'Jabal Az Zannah-Ruways', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port744', portname: 'Jebel Ali', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port2236', portname: 'Jebel Dhanna', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port2025', portname: 'Khalifa Port', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port561', portname: 'Khor Fakkan', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port747', portname: 'Mina Saqr', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port72', portname: 'Sharjah', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port1340', portname: 'Umm al Qaiwain', country: 'United Arab Emirates', iso3: 'ARE' },
    { portid: 'port2235', portname: 'Zirku Island', country: 'United Arab Emirates', iso3: 'ARE' },
];

// Ports pre-seeded onto a new user so the panel is non-empty on first load:
// the major GCC container/general-cargo gateways relevant to food imports.
export const DEFAULT_TRACKED_PORTIDS = [
    'port744',  // Jebel Ali (UAE)
    'port2025', // Khalifa Port (UAE)
    'port275',  // Dammam (KSA)
    'port518',  // Jeddah (KSA)
    'port2031', // King Abdullah Port (KSA)
    'port2026', // Hamad Port (Qatar)
    'port988',  // Sohar (Oman)
];

const PORT_BY_ID = new Map(GCC_PORTS.map(p => [p.portid, p]));
export const isGccPort = (portid) => PORT_BY_ID.has(portid);
export const lookupPort = (portid) => PORT_BY_ID.get(portid) || null;

const TRAILING_DAYS = 35; // ~5 weeks of daily rows: 7-day recent window + 28-day baseline

// Fetch the trailing window for one port from PortWatch and upsert each day.
async function ingestPort(portid) {
    const { data } = await axios.get(FEATURESERVER, {
        params: {
            where: `portid='${portid}'`,
            outFields: 'date,portid,portname,country,ISO3,portcalls,portcalls_container,import,export',
            orderByFields: 'date DESC',
            resultRecordCount: TRAILING_DAYS,
            returnGeometry: false,
            f: 'json',
        },
        timeout: 15000,
    });
    const feats = data?.features || [];
    for (const f of feats) {
        const a = f.attributes;
        // ArcGIS dateOnly comes back as an epoch-ms number; take the UTC date part.
        const iso = new Date(a.date).toISOString().slice(0, 10);
        await pool.query(
            `INSERT INTO port_activity_snapshots
               (portid, portname, country, iso3, activity_date, portcalls, portcalls_container, import_tons, export_tons)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (portid, activity_date) DO UPDATE SET
               portcalls = EXCLUDED.portcalls,
               portcalls_container = EXCLUDED.portcalls_container,
               import_tons = EXCLUDED.import_tons,
               export_tons = EXCLUDED.export_tons,
               fetched_at = now()`,
            [portid, a.portname, a.country, a.ISO3, iso,
             a.portcalls ?? null, a.portcalls_container ?? null, a.import ?? null, a.export ?? null]
        );
    }
    return feats.length;
}

// Refresh a set of ports (defaults to all GCC ports). Failures on one port do
// not abort the others.
export async function ingestPortActivity(portids = GCC_PORTS.map(p => p.portid)) {
    let ok = 0, fail = 0;
    for (const pid of portids) {
        try { await ingestPort(pid); ok++; }
        catch (err) { fail++; console.error(`PortWatch ingest failed for ${pid}:`, err.message); }
    }
    return { ok, fail };
}

const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// Compute the throughput anomaly for one port from its stored snapshots:
// recent 7-day average port calls & import tons vs the prior 28-day baseline.
// Status band is derived from the port-calls delta (the most robust signal;
// import tonnage is noisier day to day).
export async function getPortActivity(portid) {
    const meta = lookupPort(portid);
    const { rows } = await pool.query(
        `SELECT activity_date, portcalls, portcalls_container, import_tons, export_tons
         FROM port_activity_snapshots
         WHERE portid = $1
         ORDER BY activity_date DESC
         LIMIT $2`,
        [portid, TRAILING_DAYS]
    );
    const base = {
        portid,
        portname: meta?.portname || rows[0]?.portname || portid,
        country: meta?.country || rows[0]?.country || '',
        iso3: meta?.iso3 || null,
    };
    if (rows.length === 0) {
        return { ...base, hasData: false, status: 'No data', latestDate: null };
    }

    const recent = rows.slice(0, 7);
    const baseline = rows.slice(7); // prior ~28 days

    const recentCalls = avg(recent.map(r => r.portcalls ?? 0));
    const baseCalls = avg(baseline.map(r => r.portcalls ?? 0));
    const recentImport = avg(recent.map(r => Number(r.import_tons ?? 0)));
    const baseImport = avg(baseline.map(r => Number(r.import_tons ?? 0)));

    // % change of recent window vs baseline (null when baseline is empty/zero).
    const pct = (r, b) => (b && b > 0 && r != null) ? Math.round(((r - b) / b) * 100) : null;
    const callsDelta = pct(recentCalls, baseCalls);
    const importDelta = pct(recentImport, baseImport);

    // Status band from the port-calls delta. Bands chosen to flag material
    // moves without firing on normal weekly noise.
    let status = 'Normal';
    if (callsDelta != null) {
        if (callsDelta <= -40) status = 'Severely reduced';
        else if (callsDelta <= -20) status = 'Reduced';
        else if (callsDelta >= 40) status = 'Surging';
        else if (callsDelta >= 20) status = 'Elevated';
    } else {
        status = 'Insufficient baseline';
    }

    return {
        ...base,
        hasData: true,
        latestDate: rows[0].activity_date,
        recentCallsPerDay: recentCalls != null ? Math.round(recentCalls * 10) / 10 : null,
        baselineCallsPerDay: baseCalls != null ? Math.round(baseCalls * 10) / 10 : null,
        callsDeltaPct: callsDelta,
        importDeltaPct: importDelta,
        recentImportTonsPerDay: recentImport != null ? Math.round(recentImport) : null,
        status,
    };
}
