import React, { useState, useEffect, useCallback } from 'react';
import { AdminUserItem, ApiKeyItem, AuditLogItem } from '../../types/media';
import {
  fetchTelemetryReport,
  fetchSecurityAdmins,
  saveSecurityAdmin,
  deleteSecurityAdmin,
  fetchApiKeys,
  createApiKey,
  revokeApiKeyById,
  fetchAuditLogs,
} from '../../services/api';
import { useToast } from '../common/Toast';

export const SecurityAndHealth: React.FC = () => {
  const toast = useToast();
  const [telemetryData, setTelemetryData] = useState<any>(null);
  const [admins, setAdmins] = useState<AdminUserItem[]>([]);
  const [bootstrapEmail, setBootstrapEmail] = useState<string>('');
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [rbacDenied, setRbacDenied] = useState(false);

  // Add Admin/Editor form
  const [newUid, setNewUid] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'editor'>('editor');

  // Create API Key form
  const [keyName, setKeyName] = useState('');
  const [keyRole, setKeyRole] = useState<'admin' | 'editor' | 'playback'>('editor');
  const [createdPlaintextKey, setCreatedPlaintextKey] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setIsLoading(true);
    try {
      const [tel, logs] = await Promise.all([
        fetchTelemetryReport().catch(() => null),
        fetchAuditLogs(40).catch(() => []),
      ]);
      setTelemetryData(tel);
      setAuditLogs(logs);

      try {
        const [admRes, keysRes] = await Promise.all([fetchSecurityAdmins(), fetchApiKeys()]);
        setAdmins(admRes.admins || []);
        setBootstrapEmail(admRes.bootstrapAdminEmail || '');
        setApiKeys(keysRes || []);
        setRbacDenied(false);
      } catch {
        setRbacDenied(true);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleAddAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUid.trim() || !newEmail.trim()) return;
    try {
      await saveSecurityAdmin({ uid: newUid.trim(), email: newEmail.trim(), role: newRole });
      setNewUid('');
      setNewEmail('');
      toast.success('Operator RBAC role saved.', 'RBAC Updated');
      loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to add operator', 'RBAC Error');
    }
  };

  const handleRemoveAdmin = async (uid: string) => {
    try {
      await deleteSecurityAdmin(uid);
      toast.success('Operator access revoked.', 'RBAC Updated');
      loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to remove operator', 'RBAC Error');
    }
  };

  const handleCreateApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyName.trim()) return;
    const scopes =
      keyRole === 'playback'
        ? ['media:read', 'playback:sign']
        : keyRole === 'editor'
        ? ['media:read', 'media:write', 'jobs:write']
        : ['*'];
    try {
      const res = await createApiKey({ name: keyName.trim(), role: keyRole, scopes });
      setKeyName('');
      setCreatedPlaintextKey(res.plaintextKey);
      toast.success('API key generated. Copy it now—it will not be shown again.', 'API Key Created');
      loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to generate API key', 'Key Error');
    }
  };

  const handleRevokeKey = async (id: string) => {
    try {
      await revokeApiKeyById(id);
      toast.success('API key revoked.', 'Revoked');
      loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to revoke API key', 'Error');
    }
  };

  const checks = telemetryData?.checks || {};
  const tel = telemetryData?.telemetry || {};

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="p-5 bg-zinc-900/70 border border-zinc-800 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-white">System Health, Telemetry & Zero-Trust Security</h2>
          <p className="text-xs text-zinc-400">
            Live readiness probes, API latency percentiles, operator RBAC, scoped API keys, and immutable audit logs.
          </p>
        </div>
        <button
          onClick={loadAll}
          className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-xl text-xs font-semibold transition cursor-pointer self-start sm:self-auto"
        >
          {isLoading ? 'Refreshing...' : 'Refresh Diagnostics'}
        </button>
      </div>

      {/* System Readiness Checks */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
        {[
          { label: 'Firestore DB', ok: Boolean(checks.firestore?.ok), detail: checks.firestore?.detail || telemetryData?.firestoreDatabaseId || 'Checking' },
          { label: 'FFmpeg & FFprobe', ok: Boolean(checks.ffmpeg?.ok), detail: checks.ffmpeg?.detail || 'Checking binary' },
          { label: 'HMAC Signing Key', ok: Boolean(checks.signingSecret?.ok), detail: checks.signingSecret?.detail || 'Checking HMAC' },
          { label: 'Gemini AI API', ok: Boolean(checks.geminiKey?.ok), detail: checks.geminiKey?.detail || 'Optional AI features' },
        ].map((item) => (
          <div key={item.label} className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-white">{item.label}</span>
              <span
                className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                  item.ok
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                    : 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                }`}
              >
                {item.ok ? 'HEALTHY' : 'ATTENTION'}
              </span>
            </div>
            <p className="text-[11px] font-mono text-zinc-400 break-words">{item.detail}</p>
          </div>
        ))}
      </div>

      {/* Telemetry Percentile Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
        {[
          { label: 'Requests Recorded', value: tel.totalRequests ?? 0 },
          { label: 'p50 Latency', value: `${tel.p50LatencyMs ?? 0} ms` },
          { label: 'p95 Latency', value: `${tel.p95LatencyMs ?? 0} ms` },
          { label: 'Error Rate (5xx)', value: `${tel.errorRatePercent ?? 0}%` },
          { label: 'Player Buffer/Err', value: `${tel.playbackBuffers ?? 0} / ${tel.playbackErrors ?? 0}` },
        ].map((metric) => (
          <div key={metric.label} className="p-4 bg-zinc-950/80 border border-zinc-800/80 rounded-2xl">
            <span className="text-[10px] uppercase font-mono text-zinc-500 block">{metric.label}</span>
            <span className="text-lg font-bold text-white font-mono mt-1 block">{metric.value}</span>
          </div>
        ))}
      </div>

      {/* RBAC & API Keys (Admin Only) */}
      {rbacDenied ? (
        <div className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-2xl text-xs text-zinc-400">
          RBAC and API Key management require <code className="font-mono text-zinc-200">admin</code> role. Signed in as an editor.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* RBAC Operators */}
          <div className="p-5 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-4">
            <div>
              <h3 className="text-sm font-bold text-white">Operator Role-Based Access (RBAC)</h3>
              <p className="text-[11px] text-zinc-400">
                Bootstrap Super Admin: <code className="font-mono text-zinc-200">{bootstrapEmail || 'Configured'}</code>
              </p>
            </div>

            <form onSubmit={handleAddAdmin} className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <input
                type="text"
                placeholder="Firebase UID"
                value={newUid}
                onChange={(e) => setNewUid(e.target.value)}
                className="px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono"
                required
              />
              <input
                type="email"
                placeholder="operator@domain.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white"
                required
              />
              <div className="flex gap-1.5">
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as 'admin' | 'editor')}
                  className="flex-1 px-2.5 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-200"
                >
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  type="submit"
                  className="px-3 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl font-semibold cursor-pointer"
                >
                  Save
                </button>
              </div>
            </form>

            <div className="space-y-2 max-h-56 overflow-y-auto custom-scrollbar">
              {admins.map((adm) => (
                <div
                  key={adm.uid}
                  className="p-3 bg-zinc-950/70 border border-zinc-800 rounded-xl flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-white truncate">{adm.email}</div>
                    <div className="text-[10px] font-mono text-zinc-500 truncate">
                      UID: {adm.uid} • Role: {adm.role}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemoveAdmin(adm.uid)}
                    className="px-2.5 py-1 bg-zinc-900 hover:bg-red-950 text-zinc-400 hover:text-red-300 border border-zinc-800 rounded-lg text-[11px] cursor-pointer"
                  >
                    Revoke
                  </button>
                </div>
              ))}
              {admins.length === 0 && (
                <p className="text-[11px] text-zinc-500">Only bootstrap owner is currently registered.</p>
              )}
            </div>
          </div>

          {/* Scoped API Keys */}
          <div className="p-5 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-4">
            <div>
              <h3 className="text-sm font-bold text-white">Programmatic Scoped API Keys</h3>
              <p className="text-[11px] text-zinc-400">
                Issue SHA-256 hashed <code className="font-mono text-zinc-300">vf_live_</code> keys for automation or playback token signing.
              </p>
            </div>

            {createdPlaintextKey && (
              <div className="p-3.5 bg-emerald-950/40 border border-emerald-500/40 rounded-xl space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-emerald-300">Copy New API Key Now (Shown Once)</span>
                  <button
                    onClick={() => setCreatedPlaintextKey(null)}
                    className="text-emerald-400 hover:text-white cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
                <div className="p-2 bg-black/50 rounded-lg font-mono text-[11px] text-white break-all select-all">
                  {createdPlaintextKey}
                </div>
              </div>
            )}

            <form onSubmit={handleCreateApiKey} className="flex flex-col sm:flex-row gap-2 text-xs">
              <input
                type="text"
                placeholder="Key label (e.g. CI Ingest Bot)"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white"
                required
              />
              <select
                value={keyRole}
                onChange={(e) => setKeyRole(e.target.value as 'admin' | 'editor' | 'playback')}
                className="px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-200"
              >
                <option value="editor">Editor Scoped</option>
                <option value="playback">Playback Signing</option>
                <option value="admin">Admin Full</option>
              </select>
              <button
                type="submit"
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl font-semibold cursor-pointer"
              >
                Generate Key
              </button>
            </form>

            <div className="space-y-2 max-h-56 overflow-y-auto custom-scrollbar">
              {apiKeys.map((k) => (
                <div
                  key={k.id}
                  className="p-3 bg-zinc-950/70 border border-zinc-800 rounded-xl flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white truncate">{k.name}</span>
                      <span className="text-[10px] font-mono text-zinc-400">{k.role}</span>
                      {k.revokedAt && (
                        <span className="text-[10px] font-mono text-red-400">REVOKED</span>
                      )}
                    </div>
                    <div className="text-[10px] font-mono text-zinc-500">
                      Prefix: {k.keyPrefix} • Scopes: {k.scopes.join(', ')}
                    </div>
                  </div>
                  {!k.revokedAt && (
                    <button
                      onClick={() => handleRevokeKey(k.id)}
                      className="px-2.5 py-1 bg-zinc-900 hover:bg-red-950 text-zinc-400 hover:text-red-300 border border-zinc-800 rounded-lg text-[11px] cursor-pointer"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
              {apiKeys.length === 0 && (
                <p className="text-[11px] text-zinc-500">No programmatic API keys issued yet.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Audit Logs */}
      <div className="p-5 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-3">
        <h3 className="text-sm font-bold text-white">Recent Control-Plane Audit Log</h3>
        <div className="max-h-72 overflow-y-auto space-y-1.5 custom-scrollbar">
          {auditLogs.map((log) => (
            <div
              key={log.id}
              className="p-2.5 bg-zinc-950/70 border border-zinc-800/80 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[11px] font-mono"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-red-400 font-semibold">{log.action}</span>
                <span className="text-zinc-300">{log.actorEmail}</span>
                <span className="text-zinc-500">
                  → {log.resourceType}:{log.resourceId}
                </span>
              </div>
              <span className="text-zinc-500 text-[10px]">
                {new Date(log.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
          {auditLogs.length === 0 && (
            <p className="text-xs text-zinc-500">No audit entries recorded yet.</p>
          )}
        </div>
      </div>
    </div>
  );
};
