import React, { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from 'recharts';
import { AlertTriangle, TrendingUp, TrendingDown, Target } from 'lucide-react';

const API_BASE = '/api';

export default function EventForecastEngine({ category = 'Dairy' }) {
  const [forecasts, setForecasts] = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchEngineData = async () => {
      setLoading(true);
      try {
        const [fRes, rRes] = await Promise.all([
          fetch(`${API_BASE}/forecast/${category}`).then(res => res.json()),
          fetch(`${API_BASE}/recommendations/${category}`).then(res => res.json())
        ]);
        
        if (fRes.success) {
          // Format for Recharts
          const formatted = fRes.data.map(d => ({
            horizon: `Day ${d.horizon_days}`,
            'Baseline Demand': parseFloat(d.baseline_demand),
            'Adjusted Demand': parseFloat(d.adjusted_demand),
            demandScore: d.demand_score,
            supplyRisk: d.supply_score
          })).sort((a, b) => parseInt(a.horizon.split(' ')[1]) - parseInt(b.horizon.split(' ')[1]));
          
          setForecasts(formatted);
        }
        
        if (rRes.success) {
          setRecommendations(rRes.data);
        }
      } catch (e) {
        console.error("Error fetching event engine data:", e);
      } finally {
        setLoading(false);
      }
    };
    
    fetchEngineData();
  }, [category]);

  if (loading) {
    return <div style={{ padding: '20px', color: '#94a3b8' }}>Loading Event-Aware Engine...</div>;
  }

  return (
    <div style={{ marginTop: '20px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
        
        {/* Left Column: The Chart */}
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '12px', padding: '20px' }}>
          <h3 style={{ color: '#e2e8f0', margin: '0 0 16px 0', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Target size={16} color="#60a5fa" />
            Event-Adjusted Demand Curve ({category})
          </h3>
          <div style={{ height: '300px', width: '100%' }}>
            <ResponsiveContainer>
              <AreaChart data={forecasts} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorBase" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#475569" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#475569" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorAdj" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                <XAxis dataKey="horizon" stroke="#94a3b8" fontSize={11} tickLine={false} />
                <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip 
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '8px' }}
                  itemStyle={{ fontSize: '12px' }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                <Area type="monotone" dataKey="Baseline Demand" stroke="#64748b" fillOpacity={1} fill="url(#colorBase)" strokeDasharray="5 5" />
                <Area type="monotone" dataKey="Adjusted Demand" stroke="#8b5cf6" strokeWidth={3} fillOpacity={1} fill="url(#colorAdj)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Right Column: Recommendations */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 style={{ color: '#e2e8f0', margin: '0', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={16} color="#f59e0b" />
            Active Market Signals & Actions
          </h3>
          
          {recommendations.length === 0 ? (
            <div style={{ padding: '20px', background: '#1e293b', borderRadius: '8px', border: '1px dashed #334155', color: '#94a3b8', fontSize: '13px' }}>
              No active market disruptions detected for {category}. Baseline forecast holds.
            </div>
          ) : (
            recommendations.map((rec, i) => (
              <div key={rec.rec_id || i} style={{ 
                background: rec.priority === 'High' ? 'rgba(244, 63, 94, 0.1)' : '#1e293b', 
                border: `1px solid ${rec.priority === 'High' ? 'rgba(244, 63, 94, 0.3)' : '#334155'}`, 
                borderRadius: '12px', 
                padding: '16px' 
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <span style={{ fontWeight: '600', color: rec.priority === 'High' ? '#f43f5e' : '#e2e8f0', fontSize: '14px' }}>
                    {rec.scenario_type}
                  </span>
                  <span style={{ 
                    fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', padding: '2px 8px', borderRadius: '4px',
                    background: rec.priority === 'High' ? '#f43f5e' : '#f59e0b', color: '#fff'
                  }}>
                    {rec.priority} PRIORITY
                  </span>
                </div>
                
                <div style={{ display: 'flex', gap: '16px', marginBottom: '12px', fontSize: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: rec.predicted_demand_impact_pct > 0 ? '#10b981' : '#f43f5e' }}>
                    {rec.predicted_demand_impact_pct > 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                    {Math.abs(rec.predicted_demand_impact_pct)}% Demand Shift
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: rec.predicted_cost_impact_pct > 0 ? '#f43f5e' : '#10b981' }}>
                    {rec.predicted_cost_impact_pct > 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                    {Math.abs(rec.predicted_cost_impact_pct)}% Cost Shift
                  </div>
                </div>

                <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '8px' }}>
                  <strong>Drivers:</strong> {(rec.drivers_json || []).join(' • ')}
                </div>

                <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {(rec.actions_json || []).map((action, j) => (
                    <div key={j} style={{ display: 'flex', gap: '8px', fontSize: '13px', color: '#f8fafc', alignItems: 'flex-start' }}>
                      <div style={{ width: '6px', height: '6px', background: '#3b82f6', borderRadius: '50%', marginTop: '6px' }} />
                      {action}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
        
      </div>
    </div>
  );
}
