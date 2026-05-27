import express from "express";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverLocalServer } from "./discovery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(rootDir, "data");
const appsPath = path.join(dataDir, "apps.json");
const eventsPath = path.join(dataDir, "events.jsonl");

const targetHost = process.env.TARGET_HOST || "10.4.51.232";
const managerPort = Number(process.env.MANAGER_PORT || process.env.PORT || 4180);
const adminToken = process.env.ADMIN_TOKEN || "";
const commandTimeoutMs = Number(process.env.COMMAND_TIMEOUT_MS || 20000);
const allowInsecureHttpsChecks = process.env.ALLOW_INSECURE_HTTPS_CHECKS !== "false";

const app = express();
app.use(express.json({ limit: "1mb" }));

function nowIso() {
  return new Date().toISOString();
}

async function ensureDataFiles() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(appsPath);
  } catch {
    await fs.writeFile(appsPath, "[]\n", "utf8");
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeApp(input) {
  const commands = input.commands || {};
  const createdAt = input.createdAt || nowIso();
  return {
    id: String(input.id || crypto.randomUUID()),
    name: String(input.name || "").trim(),
    group: String(input.group || "Apps").trim(),
    host: String(input.host || targetHost).trim(),
    port: Number(input.port),
    protocol: ["http", "https", "tcp"].includes(input.protocol)
      ? input.protocol
      : "http",
    healthPath: input.protocol === "tcp" ? "" : String(input.healthPath || "/").trim(),
    enabled: input.enabled !== false,
    workingDirectory: String(input.workingDirectory || "").trim(),
    commands: {
      start: String(commands.start || input.startCommand || "").trim(),
      stop: String(commands.stop || input.stopCommand || "").trim(),
      restart: String(commands.restart || input.restartCommand || "").trim()
    },
    notes: String(input.notes || "").trim(),
    runtime:
      input.runtime && typeof input.runtime === "object" && !Array.isArray(input.runtime)
        ? input.runtime
        : null,
    createdAt,
    updatedAt: input.updatedAt || createdAt
  };
}

function validateApp(input) {
  const normalized = normalizeApp(input);
  normalized.updatedAt = nowIso();
  if (!normalized.name) {
    throw Object.assign(new Error("Name is required."), { statusCode: 400 });
  }
  if (!normalized.host) {
    throw Object.assign(new Error("Host is required."), { statusCode: 400 });
  }
  if (!Number.isInteger(normalized.port) || normalized.port < 1 || normalized.port > 65535) {
    throw Object.assign(new Error("Port must be between 1 and 65535."), {
      statusCode: 400
    });
  }
  if (normalized.protocol !== "tcp" && !normalized.healthPath.startsWith("/")) {
    throw Object.assign(new Error("Health path must start with /."), {
      statusCode: 400
    });
  }
  return normalized;
}

async function readApps() {
  const apps = await readJson(appsPath, []);
  return apps.map(normalizeApp);
}

async function saveApps(apps) {
  await writeJson(appsPath, apps);
}

function requireAuth(req, res, next) {
  if (!adminToken) {
    next();
    return;
  }

  const header = req.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (token === adminToken) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized", authRequired: true });
}

function checkTcp(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (open, error = "") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        open,
        latencyMs: Date.now() - startedAt,
        error
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (error) => finish(false, error.code || error.message));
    socket.connect(port, host);
  });
}

const tlsCertificateErrorCodes = new Set([
  "CERT_CHAIN_TOO_LONG",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REJECTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);

function isTlsCertificateError(error) {
  if (!error) return false;
  if (tlsCertificateErrorCodes.has(error.code)) return true;
  if (error.cause && isTlsCertificateError(error.cause)) return true;
  return /certificate|self[- ]signed|tls|ssl/i.test(error.message || "");
}

function createTimeoutError() {
  const error = new Error("timeout");
  error.name = "AbortError";
  return error;
}

function requestHttpStatus(url, timeoutMs, { rejectUnauthorized = true } = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const startedAt = Date.now();
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const request = transport.request(
      parsedUrl,
      {
        method: "GET",
        timeout: timeoutMs,
        rejectUnauthorized
      },
      (response) => {
        response.resume();
        finish(null, {
          status: response.statusCode || 0,
          statusText: response.statusMessage || http.STATUS_CODES[response.statusCode] || "",
          latencyMs: Date.now() - startedAt
        });
      }
    );

    request.once("timeout", () => {
      request.destroy();
      finish(createTimeoutError());
    });
    request.once("error", (error) => finish(error));
    request.end();
  });
}

async function requestHttpStatusWithTlsFallback(url, timeoutMs, protocol) {
  try {
    return await requestHttpStatus(url, timeoutMs);
  } catch (error) {
    if (protocol !== "https" || !allowInsecureHttpsChecks || !isTlsCertificateError(error)) {
      throw error;
    }

    try {
      const result = await requestHttpStatus(url, timeoutMs, { rejectUnauthorized: false });
      return {
        ...result,
        tlsWarning: "TLS certificate not trusted; checked without verification"
      };
    } catch (retryError) {
      retryError.originalError = error;
      throw retryError;
    }
  }
}

async function checkHttp(appConfig, timeoutMs = 3000) {
  const healthPath = appConfig.healthPath || "/";
  const url = `${appConfig.protocol}://${appConfig.host}:${appConfig.port}${healthPath}`;

  try {
    const response = await requestHttpStatusWithTlsFallback(url, timeoutMs, appConfig.protocol);
    const online = response.status >= 200 && response.status < 400;
    const degraded = response.status >= 400 && response.status < 500;

    return {
      url,
      state: online ? "online" : degraded ? "degraded" : "offline",
      httpStatus: response.status,
      latencyMs: response.latencyMs,
      error: online ? "" : response.statusText,
      tlsWarning: response.tlsWarning || ""
    };
  } catch (error) {
    if (appConfig.protocol === "https") {
      const tcpResult = await checkTcp(appConfig.host, appConfig.port, 1200);
      if (tcpResult.open) {
        const originalError = error.originalError || error;
        const detail = originalError.code || originalError.message || "HTTPS check failed";
        return {
          url,
          state: "degraded",
          httpStatus: null,
          latencyMs: tcpResult.latencyMs,
          error: `HTTPS check failed (${detail}); TCP is open`
        };
      }
    }

    return {
      url,
      state: "offline",
      httpStatus: null,
      latencyMs: null,
      error: error.name === "AbortError" ? "timeout" : error.message
    };
  }
}

async function checkApp(appConfig) {
  if (!appConfig.enabled) {
    return {
      appId: appConfig.id,
      state: "disabled",
      checkedAt: nowIso(),
      latencyMs: null,
      httpStatus: null,
      error: ""
    };
  }

  if (appConfig.protocol === "tcp") {
    const result = await checkTcp(appConfig.host, appConfig.port);
    return {
      appId: appConfig.id,
      state: result.open ? "online" : "offline",
      checkedAt: nowIso(),
      latencyMs: result.latencyMs,
      httpStatus: null,
      error: result.error
    };
  }

  const result = await checkHttp(appConfig);
  return {
    appId: appConfig.id,
    checkedAt: nowIso(),
    ...result
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function summarize(statuses) {
  return statuses.reduce(
    (summary, status) => {
      summary[status.state] = (summary[status.state] || 0) + 1;
      summary.total += 1;
      return summary;
    },
    { total: 0, online: 0, degraded: 0, offline: 0, disabled: 0 }
  );
}

async function appendEvent(event) {
  await fs.appendFile(eventsPath, `${JSON.stringify({ ...event, createdAt: nowIso() })}\n`, "utf8");
}

function runCommand(command, workingDirectory) {
  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        cwd: workingDirectory || rootDir,
        timeout: commandTimeoutMs,
        maxBuffer: 1024 * 256,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error?.code ?? 0,
          signal: error?.signal || null,
          stdout: String(stdout || "").slice(-5000),
          stderr: String(stderr || error?.message || "").slice(-5000)
        });
      }
    );

    child.once("error", (error) => {
      resolve({
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: error.message
      });
    });
  });
}

function addUnique(list, value) {
  const normalized = String(value || "").trim();
  if (normalized && !list.includes(normalized)) {
    list.push(normalized);
  }
}

function discoveredTcpPorts(discovery) {
  const byPort = new Map();

  for (const socket of discovery.sockets || []) {
    if (!socket.protocol?.startsWith("tcp")) continue;
    if (!Number.isInteger(Number(socket.port))) continue;

    const port = Number(socket.port);
    if (!byPort.has(port)) {
      byPort.set(port, {
        port,
        addresses: [],
        processes: [],
        pids: [],
        serviceUnits: []
      });
    }

    const entry = byPort.get(port);
    addUnique(entry.addresses, socket.address || "*");
    addUnique(entry.serviceUnits, socket.serviceUnit || "");

    if (socket.processName) addUnique(entry.processes, socket.processName);
    for (const processInfo of socket.processes || []) {
      addUnique(entry.processes, processInfo.name || "");
      if (processInfo.pid) addUnique(entry.pids, processInfo.pid);
    }
    if (socket.pid) addUnique(entry.pids, socket.pid);
  }

  return Array.from(byPort.values()).sort((left, right) => left.port - right.port);
}

async function scanDiscoveredPorts({ timeoutMs, existingApps = [] }) {
  const startedAt = Date.now();
  const discovery = await discoverLocalServer({ targetHost, existingApps });
  const ports = discoveredTcpPorts(discovery);

  const checked = await mapLimit(ports, 80, async (entry) => {
    const result = await checkTcp(targetHost, entry.port, Number(timeoutMs || 500));
    return {
      ...entry,
      open: result.open,
      reachable: result.open,
      latencyMs: result.latencyMs,
      error: result.error
    };
  });

  return {
    mode: "discovered",
    host: targetHost,
    durationMs: Date.now() - startedAt,
    discoveredAt: discovery.discoveredAt,
    discoveredCount: checked.length,
    checkedCount: checked.length,
    listeningPorts: checked,
    openPorts: checked.filter((item) => item.open)
  };
}

app.get("/api/config", (req, res) => {
  res.json({
    targetHost,
    managerPort,
    authRequired: Boolean(adminToken)
  });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, checkedAt: nowIso() });
});

app.use("/api", requireAuth);

app.get("/api/apps", async (req, res, next) => {
  try {
    res.json({ apps: await readApps() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/apps", async (req, res, next) => {
  try {
    const apps = await readApps();
    const nextApp = validateApp(req.body);
    apps.push(nextApp);
    await saveApps(apps);
    await appendEvent({ type: "app.created", appId: nextApp.id, appName: nextApp.name });
    res.status(201).json({ app: nextApp });
  } catch (error) {
    next(error);
  }
});

app.put("/api/apps/:id", async (req, res, next) => {
  try {
    const apps = await readApps();
    const index = apps.findIndex((item) => item.id === req.params.id);
    if (index === -1) {
      res.status(404).json({ error: "App not found." });
      return;
    }

    const updated = validateApp({
      ...apps[index],
      ...req.body,
      id: req.params.id,
      createdAt: apps[index].createdAt
    });
    apps[index] = updated;
    await saveApps(apps);
    await appendEvent({ type: "app.updated", appId: updated.id, appName: updated.name });
    res.json({ app: updated });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/apps/:id", async (req, res, next) => {
  try {
    const apps = await readApps();
    const appToDelete = apps.find((item) => item.id === req.params.id);
    if (!appToDelete) {
      res.status(404).json({ error: "App not found." });
      return;
    }
    await saveApps(apps.filter((item) => item.id !== req.params.id));
    await appendEvent({ type: "app.deleted", appId: appToDelete.id, appName: appToDelete.name });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/statuses", async (req, res, next) => {
  try {
    const apps = await readApps();
    const statuses = await mapLimit(apps, 16, checkApp);
    res.json({
      checkedAt: nowIso(),
      summary: summarize(statuses),
      statuses
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/apps/:id/action", async (req, res, next) => {
  try {
    const action = String(req.body?.action || "");
    if (!["start", "stop", "restart"].includes(action)) {
      res.status(400).json({ error: "Invalid action." });
      return;
    }

    const apps = await readApps();
    const appConfig = apps.find((item) => item.id === req.params.id);
    if (!appConfig) {
      res.status(404).json({ error: "App not found." });
      return;
    }

    const command = appConfig.commands?.[action];
    if (!command) {
      res.status(400).json({ error: `No ${action} command configured.` });
      return;
    }

    const result = await runCommand(command, appConfig.workingDirectory);
    await appendEvent({
      type: "app.action",
      appId: appConfig.id,
      appName: appConfig.name,
      action,
      command,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr
    });
    res.json({ action, result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/discovery/reachability", async (req, res, next) => {
  try {
    const apps = await readApps();
    const result = await scanDiscoveredPorts({ timeoutMs: req.body?.timeoutMs, existingApps: apps });

    await appendEvent({
      type: "discovery.reachability",
      host: result.host,
      discoveredCount: result.discoveredCount,
      openPorts: result.openPorts.map((item) => item.port)
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/discovery", async (req, res, next) => {
  try {
    const apps = await readApps();
    const discovery = await discoverLocalServer({
      targetHost,
      existingApps: apps
    });

    await appendEvent({
      type: "discovery.ran",
      host: targetHost,
      suggestions: discovery.suggestions.length,
      sockets: discovery.sources.sockets.count,
      docker: discovery.sources.docker.count,
      pm2: discovery.sources.pm2.count,
      systemd: discovery.sources.systemd.count
    });

    res.json(discovery);
  } catch (error) {
    next(error);
  }
});

app.post("/api/discovery/import-recommended", async (req, res, next) => {
  try {
    const apps = await readApps();
    const discovery = await discoverLocalServer({
      targetHost,
      existingApps: apps
    });

    const candidates = discovery.suggestions.filter((suggestion) => {
      return !suggestion.imported && (suggestion.recommended || suggestion.app?.runtime?.recommended);
    });

    const importedApps = candidates.map((suggestion) => validateApp(suggestion.app));
    await saveApps([...apps, ...importedApps]);
    await appendEvent({
      type: "discovery.imported",
      host: targetHost,
      importedCount: importedApps.length,
      appNames: importedApps.map((item) => item.name)
    });

    res.status(201).json({
      importedCount: importedApps.length,
      apps: importedApps
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/events", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 40), 200);
    let lines = [];
    try {
      const raw = await fs.readFile(eventsPath, "utf8");
      lines = raw.trim().split("\n").filter(Boolean);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const events = lines
      .slice(-limit)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    res.json({ events });
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(rootDir, "dist");
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

if (await fileExists(path.join(distDir, "index.html"))) {
  app.use(express.static(distDir));
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.use((error, req, res, next) => {
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    error: error.message || "Unexpected server error."
  });
});

await ensureDataFiles();
app.listen(managerPort, () => {
  console.log(`Server App Monitor API listening on http://localhost:${managerPort}`);
});
