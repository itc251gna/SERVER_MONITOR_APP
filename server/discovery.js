import { exec } from "node:child_process";
import fs from "node:fs/promises";

const WEB_PORTS = new Set([
  80, 443, 3000, 3001, 4000, 4173, 4180, 5000, 5173, 5174, 7000, 8000, 8080,
  8081, 8443, 8888, 9000, 9090
]);

const GENERIC_PROCESS_NAMES = new Set([
  "bash",
  "docker-proxy",
  "java",
  "node",
  "python",
  "python3",
  "sh",
  "systemd"
]);

const INFRASTRUCTURE_PORTS = new Set([22, 53, 631, 9090]);
const DATABASE_PORTS = new Set([5432, 55432, 55433, 55434, 55435, 6379, 3306, 27017]);
const INFRASTRUCTURE_NAME_RE = /^(ssh|sshd|systemd|systemd-resolved|cups|dnsmasq|guacd)$/i;
const DATABASE_NAME_RE = /(^|[-_])(db|database|postgres|postgresql|pgsql|mysql|mariadb|redis|mongo)([-_]|$)/i;

function runDiscoveryCommand(command, timeoutMs = 7000) {
  return new Promise((resolve) => {
    exec(
      command,
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        resolve({
          command,
          ok: !error,
          stdout: String(stdout || ""),
          stderr: String(stderr || error?.message || ""),
          exitCode: error?.code ?? 0
        });
      }
    );
  });
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).find(Boolean) || "";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function commandSafeUnit(unit) {
  return /^[a-zA-Z0-9_.@:-]+$/.test(unit) ? unit : shellQuote(unit);
}

function parseAddressPort(value) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return null;

  let match = /^\[(.*)]:(\d+)$/.exec(cleaned);
  if (!match) match = /^(.*):(\d+)$/.exec(cleaned);
  if (!match) return null;

  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    address: match[1] || "*",
    port
  };
}

function parseSocketProcesses(line) {
  const processes = [];
  const regex = /"([^"]+)",pid=(\d+)/g;
  let match = regex.exec(line);

  while (match) {
    processes.push({
      name: match[1],
      pid: Number(match[2])
    });
    match = regex.exec(line);
  }

  return processes;
}

async function serviceUnitForPid(pid) {
  if (!pid || process.platform === "win32") return "";

  try {
    const cgroup = await fs.readFile(`/proc/${pid}/cgroup`, "utf8");
    const match = /(?:^|\/)([^/\n]+\.service)(?:$|\/)/m.exec(cgroup);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

async function enrichSocketsWithServiceUnits(items) {
  await Promise.all(
    items.map(async (item) => {
      item.serviceUnit = await serviceUnitForPid(item.pid);
    })
  );
  return items;
}

function parseSsLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 5 || !/^(tcp|udp)/i.test(tokens[0])) return null;

  const parsed = parseAddressPort(tokens[4]);
  if (!parsed) return null;

  const processes = parseSocketProcesses(trimmed);
  const firstProcess = processes[0] || {};

  return {
    source: "ss",
    protocol: tokens[0].toLowerCase(),
    state: tokens[1],
    address: parsed.address,
    port: parsed.port,
    processName: firstProcess.name || "",
    pid: firstProcess.pid || null,
    processes,
    raw: trimmed
  };
}

function parseLinuxNetstatLine(line) {
  const trimmed = line.trim();
  if (!/^(tcp|udp)/i.test(trimmed)) return null;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 4) return null;

  const parsed = parseAddressPort(tokens[3]);
  if (!parsed) return null;

  const processToken = tokens[tokens.length - 1] || "";
  const processMatch = /^(\d+)\/(.+)$/.exec(processToken);
  const process = processMatch
    ? {
        pid: Number(processMatch[1]),
        name: processMatch[2]
      }
    : null;

  return {
    source: "netstat",
    protocol: tokens[0].toLowerCase(),
    state: tokens.includes("LISTEN") ? "LISTEN" : tokens[5] || "",
    address: parsed.address,
    port: parsed.port,
    processName: process?.name || "",
    pid: process?.pid || null,
    processes: process ? [process] : [],
    raw: trimmed
  };
}

function parseWindowsNetstatLine(line) {
  const trimmed = line.trim();
  if (!/^TCP/i.test(trimmed)) return null;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 5 || tokens[3] !== "LISTENING") return null;

  const parsed = parseAddressPort(tokens[1]);
  if (!parsed) return null;

  return {
    source: "netstat",
    protocol: "tcp",
    state: "LISTEN",
    address: parsed.address,
    port: parsed.port,
    processName: "",
    pid: Number(tokens[4]) || null,
    processes: Number(tokens[4]) ? [{ name: "", pid: Number(tokens[4]) }] : [],
    raw: trimmed
  };
}

async function discoverSockets() {
  if (process.platform === "win32") {
    const result = await runDiscoveryCommand("netstat -ano -p tcp");
    return {
      result,
      items: await enrichSocketsWithServiceUnits(
        result.stdout
          .split(/\r?\n/)
          .map(parseWindowsNetstatLine)
          .filter(Boolean)
      )
    };
  }

  const ssResult = await runDiscoveryCommand("ss -H -lntup");
  if (ssResult.ok && ssResult.stdout.trim()) {
    return {
      result: ssResult,
      items: await enrichSocketsWithServiceUnits(
        ssResult.stdout
          .split(/\r?\n/)
          .map(parseSsLine)
          .filter(Boolean)
      )
    };
  }

  const netstatResult = await runDiscoveryCommand("netstat -tulpn");
  return {
    result: netstatResult,
    items: await enrichSocketsWithServiceUnits(
      netstatResult.stdout
        .split(/\r?\n/)
        .map(parseLinuxNetstatLine)
        .filter(Boolean)
    )
  };
}

function parseSystemdServices(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;

      const tokens = trimmed.split(/\s+/);
      if (!tokens[0]?.endsWith(".service") && tokens[1]?.endsWith(".service")) {
        tokens.shift();
      }
      if (tokens.length < 4 || !tokens[0].endsWith(".service")) return null;

      const unit = tokens[0];
      return {
        unit,
        load: tokens[1],
        active: tokens[2],
        sub: tokens[3],
        description: tokens.slice(4).join(" "),
        commands: {
          start: `systemctl start ${commandSafeUnit(unit)}`,
          stop: `systemctl stop ${commandSafeUnit(unit)}`,
          restart: `systemctl restart ${commandSafeUnit(unit)}`
        }
      };
    })
    .filter(Boolean);
}

async function discoverSystemd() {
  if (process.platform === "win32") {
    return {
      result: {
        command: "systemctl list-units",
        ok: false,
        stderr: "systemd is not available on Windows."
      },
      items: []
    };
  }

  const result = await runDiscoveryCommand(
    "systemctl list-units --type=service --all --no-pager --no-legend"
  );
  return {
    result,
    items: result.ok ? parseSystemdServices(result.stdout) : []
  };
}

function parseDockerPorts(value) {
  const ports = [];
  const mappedRegex = /(?:^|,\s*)(?:([^\s,]+):)?(\d+)->(\d+)\/(tcp|udp)/g;
  let match = mappedRegex.exec(value || "");

  while (match) {
    ports.push({
      bindAddress: match[1] || "",
      publicPort: Number(match[2]),
      targetPort: Number(match[3]),
      protocol: match[4]
    });
    match = mappedRegex.exec(value || "");
  }

  return ports;
}

function parseDockerLabels(value) {
  const labels = {};
  for (const part of String(value || "").split(",")) {
    const [key, ...rest] = part.split("=");
    if (!key || !rest.length) continue;
    labels[key.trim()] = rest.join("=").trim();
  }
  return labels;
}

function parseDockerContainers(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return null;

      try {
        const item = JSON.parse(line);
        return {
          id: item.ID,
          image: item.Image,
          name: item.Names,
          status: item.Status,
          state: item.State,
          labels: parseDockerLabels(item.Labels || ""),
          portsText: item.Ports || "",
          ports: parseDockerPorts(item.Ports || ""),
          commands: {
            start: `docker start ${shellQuote(item.Names)}`,
            stop: `docker stop ${shellQuote(item.Names)}`,
            restart: `docker restart ${shellQuote(item.Names)}`
          }
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function discoverDocker() {
  const result = await runDiscoveryCommand('docker ps -a --format "{{json .}}"');
  return {
    result,
    items: result.ok ? parseDockerContainers(result.stdout) : []
  };
}

function findEnvPort(pm2Env) {
  const env = pm2Env?.env || {};
  const candidates = [
    pm2Env?.PORT,
    pm2Env?.port,
    env.PORT,
    env.port,
    env.APP_PORT,
    env.HTTP_PORT
  ];

  const direct = candidates.find((value) => Number.isInteger(Number(value)));
  if (direct != null) return Number(direct);

  const envPair = Object.entries(env).find(([key, value]) => {
    return key.toLowerCase().includes("port") && Number.isInteger(Number(value));
  });

  return envPair ? Number(envPair[1]) : null;
}

function parsePm2Processes(stdout) {
  let items = [];
  try {
    items = JSON.parse(stdout || "[]");
  } catch {
    return [];
  }

  return items.map((item) => {
    const pm2Env = item.pm2_env || {};
    const name = item.name || pm2Env.name || `pm2-${item.pm_id}`;
    const selector = Number.isInteger(Number(item.pm_id)) ? String(item.pm_id) : name;

    return {
      id: item.pm_id,
      name,
      pid: Number(item.pid) || null,
      status: pm2Env.status || item.status || "unknown",
      cwd: pm2Env.pm_cwd || pm2Env.cwd || "",
      script: pm2Env.pm_exec_path || "",
      port: findEnvPort(pm2Env),
      commands: {
        start: `pm2 start ${shellQuote(selector)}`,
        stop: `pm2 stop ${shellQuote(selector)}`,
        restart: `pm2 restart ${shellQuote(selector)}`
      }
    };
  });
}

async function discoverPm2() {
  const result = await runDiscoveryCommand("pm2 jlist");
  return {
    result,
    items: result.ok ? parsePm2Processes(result.stdout) : []
  };
}

function inferProtocol(port, label = "") {
  const lowerLabel = label.toLowerCase();
  if (port === 443 || String(port).endsWith("443") || lowerLabel.includes("https")) return "https";
  if (
    WEB_PORTS.has(port) ||
    lowerLabel.includes("http") ||
    lowerLabel.includes("nginx") ||
    lowerLabel.includes("apache") ||
    lowerLabel.includes("node") ||
    lowerLabel.includes("vite")
  ) {
    return "http";
  }
  return "tcp";
}

function classifyCandidate({ name, group, source, port, protocol, processName }) {
  const label = `${name || ""} ${group || ""} ${source || ""} ${processName || ""}`.trim();

  if (INFRASTRUCTURE_PORTS.has(port) || INFRASTRUCTURE_NAME_RE.test(name || processName || "")) {
    return {
      kind: "infrastructure",
      recommended: false,
      reason: "Infrastructure/system service"
    };
  }

  if (DATABASE_PORTS.has(port) || DATABASE_NAME_RE.test(label)) {
    return {
      kind: "database",
      recommended: false,
      reason: "Database/backend dependency"
    };
  }

  if (protocol === "http" || protocol === "https") {
    return {
      kind: "application",
      recommended: true,
      reason: "HTTP application endpoint"
    };
  }

  if (source === "systemd" && port >= 1024) {
    return {
      kind: "application",
      recommended: true,
      reason: "Systemd application service"
    };
  }

  if (source === "docker" || source === "pm2") {
    return {
      kind: "application",
      recommended: true,
      reason: `${source.toUpperCase()} application candidate`
    };
  }

  return {
    kind: "service",
    recommended: false,
    reason: "Service candidate; review manually"
  };
}

function existingAppFor(existingApps, host, port) {
  return existingApps.find((app) => {
    return String(app.host) === String(host) && Number(app.port) === Number(port);
  });
}

function hostForSocket(targetHost, socket) {
  const address = String(socket.address || "");
  if (address === "127.0.0.1" || address === "::1" || address.startsWith("127.")) {
    return "127.0.0.1";
  }
  return targetHost;
}

function findSystemdService(socket, services) {
  if (socket.serviceUnit) {
    const direct = services.find((service) => service.unit === socket.serviceUnit);
    if (direct) return direct;
  }

  const processName = socket.processName?.toLowerCase();
  if (!processName) return null;
  if (GENERIC_PROCESS_NAMES.has(processName)) return null;

  return (
    services.find((service) => {
      const unitBase = service.unit.replace(/\.service$/, "").toLowerCase();
      return (
        unitBase === processName ||
        unitBase.startsWith(`${processName}-`) ||
        unitBase.startsWith(`${processName}@`) ||
        unitBase.endsWith(`-${processName}`)
      );
    }) || null
  );
}

function appSuggestion({
  host,
  port,
  source,
  sourceId,
  name,
  group,
  protocol,
  workingDirectory = "",
  commands = {},
  notes = "",
  existingApps,
  runtime = {}
}) {
  const classification = classifyCandidate({ name, group, source, port, protocol });
  const app = {
    name,
    group,
    host,
    port,
    protocol,
    healthPath: protocol === "tcp" ? "" : "/",
    enabled: true,
    workingDirectory,
    commands: {
      start: commands.start || "",
      stop: commands.stop || "",
      restart: commands.restart || ""
    },
    notes,
    runtime: {
      source,
      sourceId,
      kind: classification.kind,
      recommended: classification.recommended,
      importReason: classification.reason,
      discoveredAt: new Date().toISOString(),
      ...runtime
    }
  };

  const existing = existingAppFor(existingApps, host, port);
  return {
    id: `${source}:${sourceId}:${port}`,
    source,
    sourceId,
    kind: classification.kind,
    recommended: classification.recommended,
    reason: classification.reason,
    imported: Boolean(existing),
    existingAppId: existing?.id || null,
    app
  };
}

function buildSuggestions({ host, sockets, services, containers, pm2Processes, existingApps }) {
  const suggestionsByKey = new Map();
  const containersByPublicPort = new Map();
  const pm2ByPid = new Map();
  const pm2ByPort = new Map();

  for (const container of containers) {
    for (const mapping of container.ports) {
      if (mapping.protocol === "tcp" && mapping.publicPort) {
        containersByPublicPort.set(mapping.publicPort, { container, mapping });
      }
    }
  }

  for (const processInfo of pm2Processes) {
    if (processInfo.pid) pm2ByPid.set(processInfo.pid, processInfo);
    if (processInfo.port) pm2ByPort.set(processInfo.port, processInfo);
  }

  function setSuggestion(suggestion) {
    const key = `${suggestion.app.host}:${suggestion.app.port}`;
    const existing = suggestionsByKey.get(key);
    if (!existing || existing.source === "socket") {
      suggestionsByKey.set(key, suggestion);
    }
  }

  for (const socket of sockets) {
    if (!socket.protocol.startsWith("tcp")) continue;

    const dockerMatch = containersByPublicPort.get(socket.port);
    const pm2Match = socket.pid ? pm2ByPid.get(socket.pid) : pm2ByPort.get(socket.port);
    const serviceMatch = findSystemdService(socket, services);

    let source = "socket";
    let sourceId = `${socket.processName || "process"}:${socket.pid || socket.port}`;
    let group = "Discovered";
    let name = socket.processName || `Port ${socket.port}`;
    let commands = {};
    let workingDirectory = "";

    if (dockerMatch) {
      source = "docker";
      sourceId = dockerMatch.container.id;
      group = "Docker";
      name = dockerMatch.container.name || name;
      commands = dockerMatch.container.commands;
      workingDirectory = dockerMatch.container.labels["com.docker.compose.project.working_dir"] || "";
    } else if (pm2Match) {
      source = "pm2";
      sourceId = String(pm2Match.id ?? pm2Match.name);
      group = "PM2";
      name = pm2Match.name;
      commands = pm2Match.commands;
      workingDirectory = pm2Match.cwd;
    } else if (serviceMatch) {
      source = "systemd";
      sourceId = serviceMatch.unit;
      group = "Systemd";
      name = serviceMatch.unit.replace(/\.service$/, "");
      commands = serviceMatch.commands;
    }

    const protocol = inferProtocol(socket.port, `${name} ${socket.processName}`);
    const appHost = hostForSocket(host, socket);
    setSuggestion(
      appSuggestion({
        host: appHost,
        port: socket.port,
        source,
        sourceId,
        name,
        group,
        protocol,
        commands,
        workingDirectory,
        notes: `Discovered from ${socket.source}${socket.processName ? ` process ${socket.processName}` : ""}${
          socket.pid ? ` pid ${socket.pid}` : ""
        }.`,
        runtime: dockerMatch
          ? {
              composeProject: dockerMatch.container.labels["com.docker.compose.project"] || "",
              composeService: dockerMatch.container.labels["com.docker.compose.service"] || "",
              composeConfigFiles: dockerMatch.container.labels["com.docker.compose.project.config_files"] || ""
            }
          : {},
        existingApps
      })
    );
  }

  for (const container of containers) {
    for (const mapping of container.ports) {
      if (mapping.protocol !== "tcp" || !mapping.publicPort) continue;
      const protocol = inferProtocol(mapping.publicPort, container.name);
      setSuggestion(
        appSuggestion({
          host,
          port: mapping.publicPort,
          source: "docker",
          sourceId: container.id,
          name: container.name || `Container ${mapping.publicPort}`,
          group: "Docker",
          protocol,
          workingDirectory: container.labels["com.docker.compose.project.working_dir"] || "",
          commands: container.commands,
          notes: `Discovered from Docker container ${container.name || container.id}.`,
          runtime: {
            composeProject: container.labels["com.docker.compose.project"] || "",
            composeService: container.labels["com.docker.compose.service"] || "",
            composeConfigFiles: container.labels["com.docker.compose.project.config_files"] || ""
          },
          existingApps
        })
      );
    }
  }

  for (const processInfo of pm2Processes) {
    if (!processInfo.port) continue;
    const protocol = inferProtocol(processInfo.port, processInfo.name);
    setSuggestion(
      appSuggestion({
        host,
        port: processInfo.port,
        source: "pm2",
        sourceId: String(processInfo.id ?? processInfo.name),
        name: processInfo.name,
        group: "PM2",
        protocol,
        workingDirectory: processInfo.cwd,
        commands: processInfo.commands,
        notes: `Discovered from PM2 process ${processInfo.name}.`,
        existingApps
      })
    );
  }

  const suggestions = Array.from(suggestionsByKey.values()).sort((left, right) => {
    return left.app.port - right.app.port || left.app.name.localeCompare(right.app.name);
  });

  const httpsCompanions = new Set(
    suggestions
      .filter((suggestion) => suggestion.app.port === 443)
      .map((suggestion) => `${suggestion.source}:${suggestion.sourceId}`)
  );

  for (const suggestion of suggestions) {
    if (suggestion.app.port === 80 && httpsCompanions.has(`${suggestion.source}:${suggestion.sourceId}`)) {
      suggestion.recommended = false;
      suggestion.reason = "HTTP companion for HTTPS endpoint";
      suggestion.app.runtime.recommended = false;
      suggestion.app.runtime.importReason = suggestion.reason;
    }
  }

  return suggestions;
}

function sourceSummary(result, items) {
  const unavailable = !result.ok && /not found|not recognized|No such file/i.test(result.stderr || "");
  return {
    ok: Boolean(result.ok),
    unavailable,
    command: result.command,
    count: items.length,
    error: result.ok ? "" : unavailable ? "Not installed" : firstLine(result.stderr)
  };
}

export async function discoverLocalServer({ targetHost, existingApps = [] }) {
  const [socketDiscovery, systemdDiscovery, dockerDiscovery, pm2Discovery] = await Promise.all([
    discoverSockets(),
    discoverSystemd(),
    discoverDocker(),
    discoverPm2()
  ]);

  const sockets = socketDiscovery.items;
  const services = systemdDiscovery.items;
  const containers = dockerDiscovery.items;
  const pm2Processes = pm2Discovery.items;

  const suggestions = buildSuggestions({
    host: targetHost,
    sockets,
    services,
    containers,
    pm2Processes,
    existingApps
  });

  return {
    discoveredAt: new Date().toISOString(),
    host: targetHost,
    platform: process.platform,
    sources: {
      sockets: sourceSummary(socketDiscovery.result, sockets),
      systemd: sourceSummary(systemdDiscovery.result, services),
      docker: sourceSummary(dockerDiscovery.result, containers),
      pm2: sourceSummary(pm2Discovery.result, pm2Processes)
    },
    sockets,
    services: services.slice(0, 250),
    containers,
    pm2Processes,
    suggestions
  };
}
