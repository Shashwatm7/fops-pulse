import React, { useState, useEffect } from 'react';
import axios from 'axios';

export default function PipelineAnalyticsPage({ onBack }) {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [scanning, setScanning] = useState(false);

    const fetchLogs = () => {
        axios.get('/api/pipeline-audit', { withCredentials: true })
            .then(res => {
                setLogs(res.data.logs || []);
                setLoading(false);
            })
            .catch(err => {
                console.error(err);
                setError('Failed to load analytics.');
                setLoading(false);
            });
    };

    useEffect(() => {
        fetchLogs();
    }, []);

    const handleTriggerScan = async () => {
        setScanning(true);
        try {
            await axios.post('/api/trigger-scan', {}, { withCredentials: true });
            fetchLogs();
        } catch (err) {
            console.error('Failed to trigger scan:', err);
            alert('Failed to trigger scan.');
        }
        setScanning(false);
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

            {loading && <p style={{ color: 'var(--text-muted)' }}>Loading analytics…</p>}
            {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

            {!loading && !error && logs.length === 0 && (
                <div className="intel-card" style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: '28px', marginBottom: '12px' }}>📭</div>
                    No audit logs yet. Hit <strong>Run Scanner Now</strong> or wait for the background scan (every 30 min).
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
