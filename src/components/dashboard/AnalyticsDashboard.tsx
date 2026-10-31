import React, { useState, useEffect, useMemo } from 'react';
import { MediaItem } from '../../types/media';
import { fetchAnalytics } from '../../services/api';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

interface AnalyticsDashboardProps {
  mediaItems: MediaItem[];
}

interface BreakdownItem {
  name: string;
  views: number;
  percentage: number;
}

interface AnalyticsData {
  totalViews: number;
  mediaList: { id: string; title: string; views: number; size: number }[];
  countries: BreakdownItem[];
  devices: BreakdownItem[];
  operatingSystems: BreakdownItem[];
  recentEvents: {
    id: string;
    mediaId: string;
    mediaTitle: string;
    timestamp: string;
    country: string;
    device: string;
    os: string;
    browser: string;
    ip?: string;
  }[];
}

export const AnalyticsDashboard: React.FC<AnalyticsDashboardProps> = ({ mediaItems }) => {
  const [selectedMediaId, setSelectedMediaId] = useState<string>('all');
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const loadRealAnalytics = async (mediaId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchAnalytics(mediaId);
      setAnalyticsData(data);
    } catch (err: any) {
      console.error('Failed to load real analytics:', err);
      setError(err.message || 'Failed to load analytics from server');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadRealAnalytics(selectedMediaId);
  }, [selectedMediaId]);

  // Compute 30-day timeline chart data from real view events
  const timelineChartData = useMemo(() => {
    const days = 30;
    const dataMap: Record<string, { displayDate: string; views: number }> = {};
    const now = new Date();

    // Pre-populate last 30 days
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      const displayDate = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      dataMap[key] = { displayDate, views: 0 };
    }

    if (analyticsData?.recentEvents) {
      analyticsData.recentEvents.forEach((ev) => {
        const dateKey = ev.timestamp ? ev.timestamp.split('T')[0] : '';
        if (dataMap[dateKey]) {
          dataMap[dateKey].views += 1;
        }
      });
    }

    return Object.values(dataMap);
  }, [analyticsData]);

  const selectedVideo = useMemo(() => {
    if (selectedMediaId === 'all') return null;
    return mediaItems.find((m) => m.id === selectedMediaId) || null;
  }, [selectedMediaId, mediaItems]);

  const totalViews = analyticsData?.totalViews || 0;
  const uniqueCountriesCount = analyticsData?.countries?.length || 0;
  const topDevice = analyticsData?.devices?.[0]?.name || 'N/A';
  const topOS = analyticsData?.operatingSystems?.[0]?.name || 'N/A';

  return (
    <div className="space-y-6 animate-in fade-in">
      {/* Header & Per-Video Selector */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-zinc-900/40 border border-zinc-800 p-5 rounded-2xl">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-white tracking-tight">Real Video Analytics</h2>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              Live Firestore Telemetry
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Real user impressions, geographic country locations, devices, and operating systems.
          </p>
        </div>

        {/* Video Filter Dropdown */}
        <div className="w-full sm:w-auto flex items-center gap-2">
          <label className="text-xs font-semibold text-zinc-400 whitespace-nowrap">Filter Video:</label>
          <select
            value={selectedMediaId}
            onChange={(e) => setSelectedMediaId(e.target.value)}
            className="w-full sm:w-64 px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-xl text-xs text-white focus:outline-none focus:border-red-500 cursor-pointer truncate"
          >
            <option value="all">All Videos (Global Aggregate)</option>
            {mediaItems.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title} ({m.views || 0} views)
              </option>
            ))}
          </select>
        </div>
      </div>

      {selectedVideo && (
        <div className="p-4 bg-red-950/20 border border-red-500/30 rounded-xl flex items-center justify-between text-xs">
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-zinc-300">
              Viewing analytics for: <strong className="text-white">{selectedVideo.title}</strong>
            </span>
          </div>
          <button
            onClick={() => setSelectedMediaId('all')}
            className="text-red-400 hover:text-red-300 font-semibold cursor-pointer underline text-[11px]"
          >
            Reset to All Videos
          </button>
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-950/50 border border-red-500/40 rounded-xl text-xs text-red-200">
          {error}
        </div>
      )}

      {/* Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="p-5 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-1">
          <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Total Real Views</span>
          <div className="text-2xl sm:text-3xl font-extrabold text-white">
            {isLoading ? <div className="w-12 h-8 bg-zinc-800 animate-pulse rounded" /> : totalViews.toLocaleString()}
          </div>
          <span className="text-[10px] text-zinc-500">Verified player starts</span>
        </div>

        <div className="p-5 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-1">
          <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Unique Countries</span>
          <div className="text-2xl sm:text-3xl font-extrabold text-white">
            {isLoading ? <div className="w-12 h-8 bg-zinc-800 animate-pulse rounded" /> : uniqueCountriesCount}
          </div>
          <span className="text-[10px] text-zinc-500">Audience locations</span>
        </div>

        <div className="p-5 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-1">
          <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Top Device</span>
          <div className="text-xl sm:text-2xl font-bold text-white truncate">
            {isLoading ? <div className="w-16 h-8 bg-zinc-800 animate-pulse rounded" /> : topDevice}
          </div>
          <span className="text-[10px] text-zinc-500">
            {analyticsData?.devices?.[0]?.percentage ? `${analyticsData.devices[0].percentage}% of traffic` : 'Platform traffic'}
          </span>
        </div>

        <div className="p-5 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-1">
          <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Top OS</span>
          <div className="text-xl sm:text-2xl font-bold text-white truncate">
            {isLoading ? <div className="w-16 h-8 bg-zinc-800 animate-pulse rounded" /> : topOS}
          </div>
          <span className="text-[10px] text-zinc-500">
            {analyticsData?.operatingSystems?.[0]?.percentage ? `${analyticsData.operatingSystems[0].percentage}% of viewers` : 'Viewer systems'}
          </span>
        </div>
      </div>

      {/* 30-Day Views Timeline Chart */}
      <div className="p-5 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">30-Day Views Trend</h3>
          <span className="text-[10px] text-zinc-500 font-mono">Real daily stream events</span>
        </div>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={timelineChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="viewColor" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#dc2626" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#dc2626" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis dataKey="displayDate" stroke="#71717a" fontSize={11} tickLine={false} />
              <YAxis stroke="#71717a" fontSize={11} tickLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#18181b',
                  borderColor: '#27272a',
                  borderRadius: '0.75rem',
                  fontSize: '12px',
                  color: '#fff',
                }}
              />
              <Area type="monotone" dataKey="views" stroke="#ef4444" strokeWidth={2} fillOpacity={1} fill="url(#viewColor)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Country & Device Breakdown Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Country Breakdown */}
        <div className="p-5 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white">Viewer Countries</h3>
            <span className="text-[10px] text-zinc-500">{analyticsData?.countries?.length || 0} locations</span>
          </div>

          {!analyticsData?.countries?.length ? (
            <p className="text-xs text-zinc-500 py-8 text-center">No location events recorded yet.</p>
          ) : (
            <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
              {analyticsData.countries.map((c) => (
                <div key={c.name} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-300 font-medium">{c.name}</span>
                    <span className="text-zinc-400 font-mono text-[11px]">{c.views} views ({c.percentage}%)</span>
                  </div>
                  <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full bg-red-600 rounded-full" style={{ width: `${Math.min(c.percentage, 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Device Breakdown */}
        <div className="p-5 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white">Devices</h3>
            <span className="text-[10px] text-zinc-500">User Agents</span>
          </div>

          {!analyticsData?.devices?.length ? (
            <p className="text-xs text-zinc-500 py-8 text-center">No device events recorded yet.</p>
          ) : (
            <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
              {analyticsData.devices.map((d) => (
                <div key={d.name} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-300 font-medium">{d.name}</span>
                    <span className="text-zinc-400 font-mono text-[11px]">{d.views} views ({d.percentage}%)</span>
                  </div>
                  <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full bg-amber-500 rounded-full" style={{ width: `${Math.min(d.percentage, 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Operating Systems Breakdown */}
        <div className="p-5 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white">Operating Systems</h3>
            <span className="text-[10px] text-zinc-500">Platform OS</span>
          </div>

          {!analyticsData?.operatingSystems?.length ? (
            <p className="text-xs text-zinc-500 py-8 text-center">No OS events recorded yet.</p>
          ) : (
            <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
              {analyticsData.operatingSystems.map((os) => (
                <div key={os.name} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-300 font-medium">{os.name}</span>
                    <span className="text-zinc-400 font-mono text-[11px]">{os.views} views ({os.percentage}%)</span>
                  </div>
                  <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full bg-cyan-500 rounded-full" style={{ width: `${Math.min(os.percentage, 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Real-Time Live View Logs Table */}
      <div className="p-5 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">Recent Viewer Logs</h3>
          <span className="text-[10px] text-zinc-500">Last 50 real sessions</span>
        </div>

        {!analyticsData?.recentEvents?.length ? (
          <div className="py-10 text-center text-zinc-500 text-xs">
            No playback events recorded yet. Play a video in the player or embed to see live telemetry!
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500 font-mono text-[11px]">
                  <th className="pb-2.5 font-normal">Timestamp</th>
                  <th className="pb-2.5 font-normal">Video Title</th>
                  <th className="pb-2.5 font-normal">Country</th>
                  <th className="pb-2.5 font-normal">Device</th>
                  <th className="pb-2.5 font-normal">OS</th>
                  <th className="pb-2.5 font-normal">Browser</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {analyticsData.recentEvents.map((ev) => (
                  <tr key={ev.id} className="text-zinc-300 hover:bg-zinc-800/30 transition">
                    <td className="py-2.5 font-mono text-[11px] text-zinc-500 whitespace-nowrap">
                      {new Date(ev.timestamp).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="py-2.5 font-medium text-white max-w-[200px] truncate">
                      {ev.mediaTitle}
                    </td>
                    <td className="py-2.5">
                      <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-[10px] border border-zinc-700/60">
                        {ev.country}
                      </span>
                    </td>
                    <td className="py-2.5 text-zinc-400">{ev.device}</td>
                    <td className="py-2.5 text-zinc-400">{ev.os}</td>
                    <td className="py-2.5 text-zinc-400">{ev.browser}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
