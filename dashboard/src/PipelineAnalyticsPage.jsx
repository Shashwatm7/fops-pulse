import React, { useState, useEffect } from 'react';

export default function PipelineAnalyticsPage({ onBack }) {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [scanning, setScanning] = useState(false);
    const [scanResult, setScanResult] = useState(null);

    const fetchLogs = () => {
        fetch('/api/pipeline-audit', { credentials: 'include' })
            .then(res => res.json())
            .then(data => {
                setLogs(data.logs || []);
                setLoading(false);
            })
            .catch(err => {
                console.error(err);
                setError('Failed to load analytics.');
                setLoading(false);
            });
    };

    // Poll /api/scan-status until the scan finishes. A single Groq 429 during
    // labeling triggers a 60s backoff+retry (by design), and a scan can hit
    // this more than once across several accepted articles — so this must be
    // patient rather than declaring failure while the backend is still
    // legitimately working.
    const pollScanStatus = (startedAt) => {
        const HARD_CAP_MS = 8 * 60 * 1000; // 8 min — generous vs. stacked 60s backoffs
        const check = async () => {
            try {
                const r = await fetch('/api/scan-status', { credentials: 'include' });
                const d = await r.json();
                if (!d.running) {
                    setScanResult(d.stats || { error: 'Scan finished with no stats recorded.' });
                    fetchLogs();
                    setScanning(false);
                    return;
                }
            } catch (err) {
                console.error('scan-status poll failed:', err);
                // transient network hiccup — keep polling, don't give up
            }
            if (Date.now() - startedAt > HARD_CAP_MS) {
                // Not a failure — the backend keeps running regardless. Just
                // stop watching; Refresh or reopening this page will pick up
                // the result once it lands (see resume-on-mount below).
                setScanResult({ stillRunning: true });
                setScanning(false);
                return;
            }
            setTimeout(check, 4000);
        };
        setTimeout(check, 4000);
    };

    useEffect(() => {
        fetchLogs();
        // Resume watching if a scan was already running (e.g. page reloaded
        // mid-scan) instead of leaving the user with no feedback at all.
        fetch('/api/scan-status', { credentials: 'include' })
            .then(r => r.json())
            .then(d => { if (d.running) { setScanning(true); pollScanStatus(Date.now()); } })
            .catch(() => {});
    }, []);

    const handleTriggerScan = async () => {
        setScanning(true);
        setScanResult(null);
        try {
            await fetch('/api/trigger-scan', { method: 'POST', credentials: 'include' });
            // The scan runs in the background (it can exceed the HTTP gateway
            // timeout), so poll for its result rather than awaiting the POST.
            pollScanStatus(Date.now());
        } catch (err) {
            console.error('Failed to trigger scan:', err);
            setScanResult({ error: err.message || 'request failed' });
            setScanning(false);
        }
    };

    const accepted = logs.filter(l => l.is_accepted).length;

    const getStageBadge = (log) => {
        if (log.is_accepted) return <span style={{ background: 'rgba(16,185,129,0.12)', color: '#34d399', border: '1px solid rgba(16,185,129,0.35)', padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap' }}>✓ Accepted</span>;
        const stageNames = { 3: 'Rules', 4: 'Region', 5: 'Scoring', 6: 'Semantic', 6.5: 'ML Spam', 7: 'LLM', 8: 'Priority', 9: 'Duplicate' };
        const label = stageNames[log.stage_dropped] || `Stage ${log.stage_dropped}`;
        return <span style={{ background: 'rgba(244,63,94,0.1)', color: '#fb7185', border: '1px solid rgba(244,63,94,0.3)', padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap' }}>✕ {label}</span>;
    };

    return (
        <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '32px 24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '12px' }}>
                <h1 style={{ margin: 0, fontSize: '22px' }}>Pipeline Analytics</h1>
                <div style={{ display: 'flex', gap: '10px' }}>
                    <button className="btn-accent" onClick={handleTriggerScan} disabled={scanning}>{scanning ? 'Scanning…' : '🚀 Run Scanner Now'}</button>
                    <button className="btn-secondary" onClick={fetchLogs}>Refresh</button>
                    <button className="btn-secondary" onClick={onBack}>← Dashboard</button>
                </div>
            </div>

            <p style={{ color: 'var(--text-muted)', marginBottom: '24px', fontSize: '14px', maxWidth: '720px' }}>
                Every article your profile scanner evaluated, and exactly which filter stage caught the noise.
                {logs.length > 0 && (
                    <span style={{ color: 'var(--text-secondary)' }}> Last {logs.length} scanned — <span style={{ color: '#34d399', fontWeight: 600 }}>{accepted} accepted</span>, {logs.length - accepted} filtered.</span>
                )}
            </p>

            {scanResult && (
                <div className="intel-card" style={{ marginBottom: '20px', padding: '14px 16px', fontSize: '13px', fontFamily: 'var(--font-mono)', borderLeft: `2px solid ${scanResult.error ? 'var(--danger)' : scanResult.stillRunning ? 'var(--accent-amber)' : '#34d399'}` }}>
                    <div style={{ fontWeight: 700, marginBottom: '6px', color: 'var(--text-secondary)' }}>Last scan result</div>
                    {scanResult.stillRunning ? (
                        <div style={{ color: 'var(--accent-amber)' }}>
                            Still running in the background (a Groq rate-limit backoff can add a minute or two per hit). It hasn't failed — click <b>Refresh</b> in a bit, or reopen this page to resume watching.
                        </div>
                    ) : scanResult.error ? (
                        <div style={{ color: 'var(--danger)' }}>Error: {scanResult.error}</div>
                    ) : scanResult.skippedReason ? (
                        <div style={{ color: 'var(--accent-amber)' }}>Skipped: {scanResult.skippedReason}</div>
                    ) : (
                        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                            Fetched <b>{scanResult.fetched}</b> articles · accepted <b style={{ color: '#34d399' }}>{scanResult.accepted}</b>
                            {' · labeling '}<b>{scanResult.labelingEnabled ? 'ON' : 'OFF'}</b>
                            {scanResult.labelingEnabled && <> · labeled <b>{scanResult.labeled}</b></>}
                            {scanResult.labelErrors?.length > 0 && (
                                <div style={{ color: 'var(--danger)', marginTop: '4px' }}>Label errors: {scanResult.labelErrors.slice(0, 3).join(' | ')}</div>
                            )}
                            {scanResult.fetched === 0 && <div style={{ color: 'var(--accent-amber)', marginTop: '4px' }}>0 articles fetched — Google News RSS may be rate-limiting this server's IP.</div>}
                            {scanResult.fetched > 0 && scanResult.accepted === 0 && <div style={{ color: 'var(--text-dim)', marginTop: '4px' }}>Articles fetched but none passed the relevance pipeline this run.</div>}
                        </div>
                    )}
                </div>
            )}

            {loading && <p style={{ color: 'var(--text-muted)' }}>Loading analytics…</p>}
            {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

            {!loading && !error && logs.length === 0 && (
                <div className="intel-card" style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: '28px', marginBottom: '12px' }}>📭</div>
                    No audit logs yet. Hit <strong>Run Scanner Now</strong> — or wait for the scheduled background scan, if enabled.
                </div>
            )}

            {!loading && !error && logs.length > 0 && (
                <div className="intel-card" style={{ padding: 0, overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                        <thead>
                            <tr>
                                {['Time', 'Article', 'Status', 'Rejection Reason'].map(h => (
                                    <th key={h} style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {logs.map(log => (
                                <tr key={log.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                                    <td style={{ padding: '12px 16px', whiteSpace: 'nowrap', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                                        {new Date(log.scanned_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                    </td>
                                    <td style={{ padding: '12px 16px', maxWidth: '420px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {log.article_url ? (
                                            <a href={log.article_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-primary)', textDecoration: 'none' }} title={log.article_title}>
                                                {log.article_title}
                                            </a>
                                        ) : log.article_title}
                                        {log.source && <span style={{ color: 'var(--text-dim)', marginLeft: '8px', fontSize: '12px' }}>· {log.source}</span>}
                                    </td>
                                    <td style={{ padding: '12px 16px' }}>
                                        {getStageBadge(log)}
                                    </td>
                                    <td style={{ padding: '12px 16px', color: 'var(--text-muted)', maxWidth: '340px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={log.rejection_reason || ''}>
                                        {log.rejection_reason || '—'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
