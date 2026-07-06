import React, { useState, useEffect } from 'react';
import axios from 'axios';

export default function PipelineAnalyticsPage({ onBack }) {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

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
        try {
            await axios.post('/api/trigger-scan', {}, { withCredentials: true });
            alert('Scanner triggered! Wait a moment and then refresh this page.');
        } catch (err) {
            console.error('Failed to trigger scan:', err);
            alert('Failed to trigger scan.');
        }
    };

    const getStageBadge = (log) => {
        if (log.is_accepted) return <span className="badge" style={{background: '#10b981', padding: '4px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 600}}>✅ Accepted</span>;
        const stageNames = { 3: 'Rules', 5: 'Scoring', 6: 'Semantic', 6.5: 'ML Spam', 7: 'LLM', 8: 'Priority', 9: 'Duplicate' };
        const label = stageNames[log.stage_dropped] || `Stage ${log.stage_dropped}`;
        return <span className="badge" style={{background: '#ef4444', padding: '4px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 600}}>❌ {label}</span>;
    };

    return (
        <div className="container" style={{ maxWidth: '1200px', margin: '0 auto', padding: '24px' }}>
            <div className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <h1 style={{ margin: 0, fontSize: '24px', color: '#f8fafc' }}>Pipeline Analytics & Storage</h1>
                <div style={{ display: 'flex', gap: '12px' }}>
                    <button className="btn-primary" onClick={handleTriggerScan} style={{ background: '#3b82f6' }}>🚀 Run Scanner Now</button>
                    <button className="btn-secondary" onClick={fetchLogs}>🔄 Refresh</button>
                    <button className="btn-secondary" onClick={onBack}>← Back to Dashboard</button>
                </div>
            </div>
            
            <p style={{ color: '#94a3b8', marginBottom: '32px' }}>
                This table shows the exact flow of articles through your custom pipeline. See exactly which filter caught the noise before it reached the Gemini LLM.
            </p>

            {loading && <p>Loading analytics from PostgreSQL...</p>}
            {error && <p style={{ color: '#ef4444' }}>{error}</p>}
            
            {!loading && !error && logs.length === 0 && (
                <div style={{ padding: '32px', textAlign: 'center', color: '#64748b', background: '#1e293b', borderRadius: '8px' }}>
                    No audit logs available yet. The background scanner runs every 30 minutes.
                </div>
            )}

            {!loading && !error && logs.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', color: '#e2e8f0', background: '#1e293b', borderRadius: '8px', overflow: 'hidden' }}>
                        <thead style={{ background: '#0f172a' }}>
                            <tr>
                                <th style={{ padding: '16px', borderBottom: '1px solid #334155' }}>Time</th>
                                <th style={{ padding: '16px', borderBottom: '1px solid #334155' }}>Article Title</th>
                                <th style={{ padding: '16px', borderBottom: '1px solid #334155' }}>Status</th>
                                <th style={{ padding: '16px', borderBottom: '1px solid #334155' }}>Rejection Reason</th>
                            </tr>
                        </thead>
                        <tbody>
                            {logs.map(log => (
                                <tr key={log.id} style={{ borderBottom: '1px solid #334155' }}>
                                    <td style={{ padding: '16px', whiteSpace: 'nowrap', color: '#94a3b8', fontSize: '14px' }}>
                                        {new Date(log.scanned_at).toLocaleString()}
                                    </td>
                                    <td style={{ padding: '16px', fontSize: '14px', maxWidth: '400px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {log.article_url ? (
                                            <a href={log.article_url} target="_blank" rel="noopener noreferrer" style={{ color: '#38bdf8', textDecoration: 'none' }}>
                                                {log.article_title}
                                            </a>
                                        ) : log.article_title}
                                    </td>
                                    <td style={{ padding: '16px' }}>
                                        {getStageBadge(log)}
                                    </td>
                                    <td style={{ padding: '16px', fontSize: '13px', color: '#94a3b8' }}>
                                        {log.rejection_reason || '-'}
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
