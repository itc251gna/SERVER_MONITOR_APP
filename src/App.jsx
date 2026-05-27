import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Cpu,
  ExternalLink,
  Gauge,
  Layers,
  LockKeyhole,
  Pencil,
  Play,
  Plus,
  Radar,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  ShieldCheck,
  Square,
  Trash2,
  X
} from "lucide-react";

const emptyForm = {
  name: "",
  group: "Apps",
  host: "10.4.51.232",
  port: "",
  protocol: "http",
  healthPath: "/",
  enabled: true,
  workingDirectory: "",
  commands: {
    start: "",
    stop: "",
    restart: ""
  },
  notes: ""
};

const labels = {
  online: "Online",
  degraded: "Degraded",
  offline: "Offline",
  disabled: "Disabled",
  unknown: "Unknown"
};

function buildUrl(app) {
  if (app.protocol === "tcp") return "";
  const path = app.healthPath || "/";
  return `${app.protocol}://${app.host}:${app.port}${path}`;
}

function endpointLabel(app) {
  if (!app) return "-";
  if (app.protocol === "tcp") return `${app.host}:${app.port}`;
  return `${app.protocol}://${app.host}:${app.port}${app.healthPath || "/"}`;
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("el-GR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("el-GR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function IconButton({ children, label, className = "", ...props }) {
  return (
    <button className={`icon-button ${className}`} title={label} aria-label={label} {...props}>
      {children}
    </button>
  );
}

function StatusPill({ state = "unknown" }) {
  return (
    <span className={`status-pill ${state}`}>
      <span className="status-dot" />
      {labels[state] || labels.unknown}
    </span>
  );
}

function SourceCard({ icon, title, count, ok, unavailable, error }) {
  return (
    <div className={`source-card ${ok ? "ok" : "muted"} ${unavailable ? "unavailable" : ""}`}>
      <div className="source-icon">{icon}</div>
      <div>
        <strong>{title}</strong>
        <span>{count}</span>
        {unavailable ? <small>Not installed</small> : error ? <small>{error}</small> : null}
      </div>
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-panel">
        <div className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <IconButton label="Κλείσιμο" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState({ targetHost: "10.4.51.232", authRequired: false });
  const [apps, setApps] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [summary, setSummary] = useState({ total: 0, online: 0, degraded: 0, offline: 0, disabled: 0 });
  const [events, setEvents] = useState([]);
  const [activeTab, setActiveTab] = useState("apps");
  const [formOpen, setFormOpen] = useState(false);
  const [editingApp, setEditingApp] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [token, setToken] = useState(() => localStorage.getItem("monitorAdminToken") || "");
  const [tokenInput, setTokenInput] = useState("");
  const [discovery, setDiscovery] = useState(null);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [reachability, setReachability] = useState(null);
  const [reachabilityBusy, setReachabilityBusy] = useState(false);
  const [importingIds, setImportingIds] = useState([]);

  const statusById = useMemo(
    () => Object.fromEntries(statuses.map((status) => [status.appId, status])),
    [statuses]
  );

  const newDiscoverySuggestions = useMemo(() => {
    return discovery?.suggestions?.filter((suggestion) => !suggestion.imported) || [];
  }, [discovery]);

  const recommendedDiscoverySuggestions = useMemo(() => {
    return newDiscoverySuggestions.filter((suggestion) => {
      return suggestion.recommended || suggestion.app?.runtime?.recommended;
    });
  }, [newDiscoverySuggestions]);

  const reachabilityByPort = useMemo(() => {
    return Object.fromEntries((reachability?.listeningPorts || []).map((item) => [item.port, item]));
  }, [reachability]);

  const api = useCallback(
    async (path, options = {}) => {
      const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {})
      };

      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(path, { ...options, headers });
      if (response.status === 401) {
        setAuthRequired(true);
        throw new Error("Unauthorized");
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Request failed.");
      }
      if (response.status === 204) return null;
      return response.json();
    },
    [token]
  );

  const showNotice = useCallback((message) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3000);
  }, []);

  const loadApps = useCallback(async () => {
    const payload = await api("/api/apps");
    setApps(payload.apps);
  }, [api]);

  const loadStatuses = useCallback(async () => {
    const payload = await api("/api/statuses");
    setStatuses(payload.statuses);
    setSummary(payload.summary);
  }, [api]);

  const loadEvents = useCallback(async () => {
    const payload = await api("/api/events?limit=60");
    setEvents(payload.events);
  }, [api]);

  const loadDiscovery = useCallback(async () => {
    setDiscoveryBusy(true);
    try {
      const payload = await api("/api/discovery");
      setDiscovery(payload);
      setReachability(null);
    } catch (error) {
      if (error.message !== "Unauthorized") showNotice(error.message);
    } finally {
      setDiscoveryBusy(false);
    }
  }, [api, showNotice]);

  const refreshAll = useCallback(async () => {
    setBusy(true);
    try {
      await Promise.all([loadApps(), loadStatuses(), loadEvents()]);
    } catch (error) {
      if (error.message !== "Unauthorized") showNotice(error.message);
    } finally {
      setBusy(false);
    }
  }, [loadApps, loadStatuses, loadEvents, showNotice]);

  useEffect(() => {
    async function boot() {
      const payload = await fetch("/api/config").then((response) => response.json());
      setConfig(payload);
      setForm((current) => ({ ...current, host: payload.targetHost || current.host }));
      if (payload.authRequired && !token) {
        setAuthRequired(true);
        return;
      }
      refreshAll();
    }

    boot().catch((error) => showNotice(error.message));
  }, [refreshAll, showNotice, token]);

  useEffect(() => {
    if (authRequired && !token) return undefined;
    const timer = window.setInterval(() => {
      loadStatuses().catch(() => {});
    }, 15000);
    return () => window.clearInterval(timer);
  }, [authRequired, loadStatuses, token]);

  useEffect(() => {
    if (activeTab !== "discovery" || discovery || (authRequired && !token)) return;
    loadDiscovery();
  }, [activeTab, authRequired, discovery, loadDiscovery, token]);

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateCommand(field, value) {
    setForm((current) => ({
      ...current,
      commands: { ...current.commands, [field]: value }
    }));
  }

  function openCreateForm(seed = {}) {
    setEditingApp(null);
    setForm({
      ...emptyForm,
      host: config.targetHost || emptyForm.host,
      ...seed,
      commands: { ...emptyForm.commands, ...(seed.commands || {}) }
    });
    setFormOpen(true);
  }

  function openEditForm(app) {
    setEditingApp(app);
    setForm({
      ...emptyForm,
      ...app,
      commands: { ...emptyForm.commands, ...(app.commands || {}) }
    });
    setFormOpen(true);
  }

  async function submitApp(event) {
    event.preventDefault();
    const payload = {
      ...form,
      port: Number(form.port),
      healthPath: form.protocol === "tcp" ? "" : form.healthPath || "/"
    };
    const path = editingApp ? `/api/apps/${editingApp.id}` : "/api/apps";
    const method = editingApp ? "PUT" : "POST";

    try {
      await api(path, {
        method,
        body: JSON.stringify(payload)
      });
      setFormOpen(false);
      showNotice(editingApp ? "Η εφαρμογή ενημερώθηκε." : "Η εφαρμογή προστέθηκε.");
      refreshAll();
    } catch (error) {
      showNotice(error.message);
    }
  }

  async function deleteApp(app) {
    const confirmed = window.confirm(`Διαγραφή "${app.name}";`);
    if (!confirmed) return;

    try {
      await api(`/api/apps/${app.id}`, { method: "DELETE" });
      showNotice("Η εφαρμογή διαγράφηκε.");
      refreshAll();
    } catch (error) {
      showNotice(error.message);
    }
  }

  async function runAction(app, action) {
    try {
      setBusy(true);
      const payload = await api(`/api/apps/${app.id}/action`, {
        method: "POST",
        body: JSON.stringify({ action })
      });
      const ok = payload.result.exitCode === 0;
      showNotice(ok ? `${app.name}: ${action} OK.` : `${app.name}: ${action} exit ${payload.result.exitCode}.`);
      await Promise.all([loadStatuses(), loadEvents()]);
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function checkReachability() {
    setReachabilityBusy(true);

    try {
      const payload = await api("/api/discovery/reachability", { method: "POST" });
      setReachability(payload);
      await loadEvents();
    } catch (error) {
      showNotice(error.message);
    } finally {
      setReachabilityBusy(false);
    }
  }

  async function importSuggestion(suggestion) {
    if (suggestion.imported) return;

    setImportingIds((current) => [...current, suggestion.id]);
    try {
      await api("/api/apps", {
        method: "POST",
        body: JSON.stringify(suggestion.app)
      });
      showNotice(`${suggestion.app.name} imported.`);
      await Promise.all([loadApps(), loadStatuses(), loadEvents(), loadDiscovery()]);
    } catch (error) {
      showNotice(error.message);
    } finally {
      setImportingIds((current) => current.filter((id) => id !== suggestion.id));
    }
  }

  async function importAllSuggestions() {
    if (!recommendedDiscoverySuggestions.length) return;

    setBusy(true);
    try {
      const result = await api("/api/discovery/import-recommended", { method: "POST" });
      showNotice(`${result.importedCount} apps imported.`);
      await Promise.all([loadApps(), loadStatuses(), loadEvents(), loadDiscovery()]);
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  function saveToken(event) {
    event.preventDefault();
    localStorage.setItem("monitorAdminToken", tokenInput);
    setToken(tokenInput);
    setAuthRequired(false);
    showNotice("Token ενεργό.");
  }

  function clearToken() {
    localStorage.removeItem("monitorAdminToken");
    setToken("");
    setTokenInput("");
    setAuthRequired(config.authRequired);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="app-kicker">Server App Monitor</span>
          <h1>{config.targetHost}</h1>
        </div>

        <div className="summary-grid" aria-label="Σύνοψη">
          <div className="metric">
            <span>{summary.total}</span>
            <small>Σύνολο</small>
          </div>
          <div className="metric good">
            <span>{summary.online}</span>
            <small>Online</small>
          </div>
          <div className="metric warn">
            <span>{summary.degraded}</span>
            <small>Degraded</small>
          </div>
          <div className="metric bad">
            <span>{summary.offline}</span>
            <small>Offline</small>
          </div>
        </div>

        <div className="top-actions">
          {config.authRequired ? (
            <IconButton label={token ? "Token αποθηκευμένο" : "Απαιτείται token"} onClick={clearToken}>
              {token ? <ShieldCheck size={18} /> : <LockKeyhole size={18} />}
            </IconButton>
          ) : null}
          <IconButton label="Ανανέωση" onClick={refreshAll} disabled={busy}>
            <RefreshCw size={18} className={busy ? "spin" : ""} />
          </IconButton>
          <button className="primary-action" onClick={() => openCreateForm()}>
            <Plus size={18} />
            Νέα εφαρμογή
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="Προβολές">
        <button className={activeTab === "apps" ? "active" : ""} onClick={() => setActiveTab("apps")}>
          <Server size={17} />
          Εφαρμογές
        </button>
        <button className={activeTab === "discovery" ? "active" : ""} onClick={() => setActiveTab("discovery")}>
          <Radar size={17} />
          Discovery
        </button>
        <button className={activeTab === "events" ? "active" : ""} onClick={() => setActiveTab("events")}>
          <Activity size={17} />
          Activity
        </button>
      </nav>

      {notice ? <div className="notice">{notice}</div> : null}

      {authRequired && !token ? (
        <section className="auth-panel">
          <LockKeyhole size={28} />
          <form onSubmit={saveToken}>
            <label htmlFor="token">Admin token</label>
            <div className="inline-form">
              <input
                id="token"
                type="password"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                autoFocus
              />
              <button className="primary-action" type="submit">
                <ShieldCheck size={18} />
                Σύνδεση
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {!authRequired || token ? (
        <>
          {activeTab === "apps" ? (
            <section className="content-panel">
              {apps.length === 0 ? (
                <div className="empty-state">
                  <CircleAlert size={24} />
                  <span>Δεν υπάρχουν εφαρμογές.</span>
                  <button className="primary-action" onClick={() => openCreateForm()}>
                    <Plus size={18} />
                    Προσθήκη
                  </button>
                </div>
              ) : (
                <div className="table-shell">
                  <table>
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Εφαρμογή</th>
                        <th>Endpoint</th>
                        <th>Latency</th>
                        <th>Τελευταίος έλεγχος</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {apps.map((app) => {
                        const status = statusById[app.id] || { state: "unknown" };
                        const url = buildUrl(app);
                        return (
                          <tr key={app.id}>
                            <td>
                              <StatusPill state={status.state} />
                            </td>
                            <td>
                              <div className="app-title">
                                <strong>{app.name}</strong>
                                <span>{app.group}</span>
                              </div>
                            </td>
                            <td>
                              <div className="endpoint">
                                <code>
                                  {app.protocol === "tcp"
                                    ? `${app.host}:${app.port}`
                                    : `${app.protocol}://${app.host}:${app.port}${app.healthPath || "/"}`}
                                </code>
                                {status.httpStatus ? <small>HTTP {status.httpStatus}</small> : null}
                                {status.tlsWarning ? <small className="warning-text">{status.tlsWarning}</small> : null}
                                {status.error ? <small className="error-text">{status.error}</small> : null}
                              </div>
                            </td>
                            <td>
                              <span className="latency">
                                <Gauge size={15} />
                                {status.latencyMs == null ? "-" : `${status.latencyMs} ms`}
                              </span>
                            </td>
                            <td>{formatTime(status.checkedAt)}</td>
                            <td>
                              <div className="row-actions">
                                {url ? (
                                  <a className="icon-button" href={url} target="_blank" rel="noreferrer" title="Άνοιγμα">
                                    <ExternalLink size={17} />
                                  </a>
                                ) : null}
                                <IconButton
                                  label="Start"
                                  onClick={() => runAction(app, "start")}
                                  disabled={!app.commands?.start || busy}
                                >
                                  <Play size={17} />
                                </IconButton>
                                <IconButton
                                  label="Stop"
                                  onClick={() => runAction(app, "stop")}
                                  disabled={!app.commands?.stop || busy}
                                >
                                  <Square size={17} />
                                </IconButton>
                                <IconButton
                                  label="Restart"
                                  onClick={() => runAction(app, "restart")}
                                  disabled={!app.commands?.restart || busy}
                                >
                                  <RotateCcw size={17} />
                                </IconButton>
                                <IconButton label="Edit" onClick={() => openEditForm(app)}>
                                  <Pencil size={17} />
                                </IconButton>
                                <IconButton label="Delete" className="danger" onClick={() => deleteApp(app)}>
                                  <Trash2 size={17} />
                                </IconButton>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          {activeTab === "discovery" ? (
            <section className="content-panel">
              <div className="discovery-toolbar">
                <div className="discovery-title">
                  <strong>Discovery</strong>
                  <span>
                    Local server inventory from sockets, systemd, Docker and PM2.{" "}
                    {discovery ? formatDateTime(discovery.discoveredAt) : "-"}
                  </span>
                </div>
                <div className="top-actions">
                  <button className="ghost-action" onClick={loadDiscovery} disabled={discoveryBusy}>
                    <RefreshCw size={18} className={discoveryBusy ? "spin" : ""} />
                    Run
                  </button>
                  <button
                    className="ghost-action"
                    onClick={checkReachability}
                    disabled={reachabilityBusy || discoveryBusy}
                  >
                    <Gauge size={18} className={reachabilityBusy ? "spin" : ""} />
                    Check reachability
                  </button>
                  <button
                    className="primary-action"
                    onClick={importAllSuggestions}
                    disabled={busy || discoveryBusy || recommendedDiscoverySuggestions.length === 0}
                  >
                    <Plus size={18} />
                    Import apps
                  </button>
                </div>
              </div>

              <div className="source-grid">
                <SourceCard
                  icon={<Radar size={20} />}
                  title="Sockets"
                  count={discovery?.sources?.sockets?.count || 0}
                  ok={discovery?.sources?.sockets?.ok}
                  unavailable={discovery?.sources?.sockets?.unavailable}
                  error={discovery?.sources?.sockets?.error}
                />
                <SourceCard
                  icon={<Server size={20} />}
                  title="Systemd"
                  count={discovery?.sources?.systemd?.count || 0}
                  ok={discovery?.sources?.systemd?.ok}
                  unavailable={discovery?.sources?.systemd?.unavailable}
                  error={discovery?.sources?.systemd?.error}
                />
                <SourceCard
                  icon={<Layers size={20} />}
                  title="Docker"
                  count={discovery?.sources?.docker?.count || 0}
                  ok={discovery?.sources?.docker?.ok}
                  unavailable={discovery?.sources?.docker?.unavailable}
                  error={discovery?.sources?.docker?.error}
                />
                <SourceCard
                  icon={<Cpu size={20} />}
                  title="PM2"
                  count={discovery?.sources?.pm2?.count || 0}
                  ok={discovery?.sources?.pm2?.ok}
                  unavailable={discovery?.sources?.pm2?.unavailable}
                  error={discovery?.sources?.pm2?.error}
                />
              </div>

              {reachability ? (
                <div className="reachability-summary">
                  <span>{reachability.checkedCount} checked</span>
                  <span>{reachability.discoveredCount} listening</span>
                  <span>{reachability.openPorts.length} reachable</span>
                  <span>{reachability.durationMs} ms</span>
                </div>
              ) : null}

              {discoveryBusy && !discovery ? (
                <div className="empty-state slim">
                  <RefreshCw size={24} className="spin" />
                  <span>Discovery running.</span>
                </div>
              ) : null}

              {discovery && discovery.suggestions.length === 0 ? (
                <div className="empty-state slim">
                  <CircleAlert size={22} />
                  <span>No app suggestions found.</span>
                </div>
              ) : null}

              {discovery?.suggestions?.length ? (
                <div className="table-shell">
                  <table>
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Kind</th>
                        <th>Source</th>
                        <th>App</th>
                        <th>Endpoint</th>
                        <th>Reachability</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {discovery.suggestions.map((suggestion) => {
                        const importing = importingIds.includes(suggestion.id);
                        const recommended = suggestion.recommended || suggestion.app.runtime?.recommended;
                        const kind = suggestion.kind || suggestion.app.runtime?.kind || "service";
                        const reachabilityItem = reachabilityByPort[suggestion.app.port];

                        return (
                          <tr key={suggestion.id}>
                            <td>
                              <span className={`import-pill ${suggestion.imported ? "done" : "new"}`}>
                                {suggestion.imported ? (
                                  <>
                                    <CheckCircle2 size={14} />
                                    Imported
                                  </>
                                ) : (
                                  <>
                                    <Plus size={14} />
                                    New
                                  </>
                                )}
                              </span>
                            </td>
                            <td>
                              <span className={`kind-pill ${kind} ${recommended ? "recommended" : ""}`}>
                                {recommended ? "App" : kind}
                              </span>
                            </td>
                            <td>
                              <div className="app-title">
                                <strong>{suggestion.source}</strong>
                                <span>{suggestion.sourceId}</span>
                              </div>
                            </td>
                            <td>
                              <div className="app-title">
                                <strong>{suggestion.app.name}</strong>
                                <span>{suggestion.app.group}</span>
                              </div>
                            </td>
                            <td>
                              <div className="endpoint">
                                <code>{endpointLabel(suggestion.app)}</code>
                                <small>{suggestion.reason || suggestion.app.runtime?.importReason || suggestion.app.protocol.toUpperCase()}</small>
                              </div>
                            </td>
                            <td>
                              {reachabilityItem ? (
                                <div className="endpoint">
                                  <StatusPill state={reachabilityItem.open ? "online" : "offline"} />
                                  <small>
                                    {reachabilityItem.open
                                      ? `${reachabilityItem.latencyMs} ms from ${reachability.host}`
                                      : reachabilityItem.error || "not reachable from server IP"}
                                  </small>
                                </div>
                              ) : (
                                <span className="muted-text">Not checked</span>
                              )}
                            </td>
                            <td>
                              <div className="row-actions">
                                <IconButton
                                  label="Import"
                                  onClick={() => importSuggestion(suggestion)}
                                  disabled={suggestion.imported || importing || busy}
                                >
                                  {importing ? <RefreshCw size={17} className="spin" /> : <Plus size={17} />}
                                </IconButton>
                                <IconButton label="Review" onClick={() => openCreateForm(suggestion.app)}>
                                  <Pencil size={17} />
                                </IconButton>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>
          ) : null}

          {activeTab === "events" ? (
            <section className="content-panel">
              {events.length ? (
                <div className="table-shell compact">
                  <table>
                    <thead>
                      <tr>
                        <th>Ώρα</th>
                        <th>Τύπος</th>
                        <th>Εφαρμογή</th>
                        <th>Λεπτομέρεια</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((event, index) => (
                        <tr key={`${event.createdAt}-${index}`}>
                          <td>{formatDateTime(event.createdAt)}</td>
                          <td>
                            <code>{event.type}</code>
                          </td>
                          <td>{event.appName || event.host || "-"}</td>
                          <td>
                            {event.action ? `${event.action} ` : ""}
                            {event.exitCode != null ? `exit ${event.exitCode}` : ""}
                            {event.openPorts ? `reachable: ${event.openPorts.join(", ") || "-"}` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-state slim">
                  <Activity size={24} />
                  <span>Δεν υπάρχει activity.</span>
                </div>
              )}
            </section>
          ) : null}
        </>
      ) : null}

      {formOpen ? (
        <Modal title={editingApp ? "Επεξεργασία εφαρμογής" : "Νέα εφαρμογή"} onClose={() => setFormOpen(false)}>
          <form className="app-form" onSubmit={submitApp}>
            <div className="form-grid">
              <label>
                Όνομα
                <input value={form.name} onChange={(event) => updateForm("name", event.target.value)} required />
              </label>
              <label>
                Ομάδα
                <input value={form.group} onChange={(event) => updateForm("group", event.target.value)} />
              </label>
              <label>
                Host
                <input value={form.host} onChange={(event) => updateForm("host", event.target.value)} required />
              </label>
              <label>
                Port
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={form.port}
                  onChange={(event) => updateForm("port", event.target.value)}
                  required
                />
              </label>
              <label>
                Πρωτόκολλο
                <select
                  value={form.protocol}
                  onChange={(event) => {
                    const protocol = event.target.value;
                    setForm((current) => ({
                      ...current,
                      protocol,
                      healthPath: protocol === "tcp" ? "" : current.healthPath || "/"
                    }));
                  }}
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="tcp">TCP</option>
                </select>
              </label>
              <label>
                Health path
                <input
                  value={form.healthPath}
                  disabled={form.protocol === "tcp"}
                  onChange={(event) => updateForm("healthPath", event.target.value)}
                />
              </label>
            </div>

            <label className="check-row">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => updateForm("enabled", event.target.checked)}
              />
              Ενεργή
            </label>

            <label>
              Working directory
              <input
                value={form.workingDirectory}
                onChange={(event) => updateForm("workingDirectory", event.target.value)}
              />
            </label>

            <div className="command-grid">
              <label>
                Start command
                <input value={form.commands.start} onChange={(event) => updateCommand("start", event.target.value)} />
              </label>
              <label>
                Stop command
                <input value={form.commands.stop} onChange={(event) => updateCommand("stop", event.target.value)} />
              </label>
              <label>
                Restart command
                <input
                  value={form.commands.restart}
                  onChange={(event) => updateCommand("restart", event.target.value)}
                />
              </label>
            </div>

            <label>
              Notes
              <textarea value={form.notes} onChange={(event) => updateForm("notes", event.target.value)} rows="3" />
            </label>

            <div className="form-actions">
              <button type="button" className="ghost-action" onClick={() => setFormOpen(false)}>
                Άκυρο
              </button>
              <button className="primary-action" type="submit">
                <Save size={18} />
                Αποθήκευση
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </main>
  );
}
