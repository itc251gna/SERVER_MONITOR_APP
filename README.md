# Server App Monitor

Dashboard για inventory, health checks, self-discovery, reachability checks και χειρισμό εφαρμογών στον `10.4.51.232`.

## Local development

```bash
npm install
npm run dev
```

UI: `http://localhost:5173`
API: `http://localhost:4180`

## Local checks before production

```powershell
.\scripts\test-local.ps1
```

This runs:

- `npm ci`
- `npm run build`
- `node --check server/index.js`
- `node --check server/discovery.js`

## Deploy to production

```powershell
.\scripts\deploy-production.ps1
```

The deploy script packages the current workspace, uploads it to `10.4.51.232`, installs it under `/home/kmh251/deployment/server_app_monitor`, runs `npm ci`, builds the UI, and restarts `server-app-monitor.service`.

For GitHub, use SSH keys or a Personal Access Token. GitHub no longer accepts account passwords for Git pushes over HTTPS.

## GitHub CI

`.github/workflows/ci.yml` runs `npm ci` and `npm run local:check` on push, pull request, or manual workflow dispatch.

Because `10.4.51.232` is an intranet address, production deploy from GitHub needs either a self-hosted runner inside the same network or the manual SSH deploy script above.

## Production στον server

```bash
npm install
npm run build
export TARGET_HOST=10.4.51.232
export MANAGER_PORT=4180
export ADMIN_TOKEN='change-this-long-random-token'
npm start
```

Το production UI σερβίρεται από το Express server στο `http://10.4.51.232:4180`.

## Self-discovery

Το tab `Discovery` τρέχει τοπική ανίχνευση πάνω στον server όπου είναι εγκατεστημένο το dashboard.

Πηγές που διαβάζει:

- listening sockets από `ss -H -lntup` ή fallback `netstat -tulpn`
- services από `systemctl list-units --type=service --all`
- containers από `docker ps -a`
- PM2 apps από `pm2 jlist`

Στο production VM εγκαταστάθηκε PM2. Σε άλλα περιβάλλοντα, αν το PM2 λείπει, εμφανίζεται ως `Not installed` ώστε το Discovery να συνεχίζει χωρίς σφάλμα.

Από αυτά δημιουργεί προτάσεις import με host, port, protocol και, όπου μπορεί, start/stop/restart commands:

```bash
systemctl restart my-app.service
docker restart my-container
pm2 restart my-app
```

Το tab `Applications` είναι το curated/managed inventory. Δεν πρέπει να συμπληρώνεται χειροκίνητα ένα-ένα από την αρχή. Το σωστό flow είναι:

1. Τρέχεις `Discovery`.
2. Ελέγχεις τις προτάσεις.
3. Πατάς `Import apps` για να περάσουν μόνο τα recommended application endpoints στο `Applications`.

Το Discovery ταξινομεί τις προτάσεις σε `application`, `database`, `infrastructure` ή `service`, ώστε SSH/DNS/CUPS/DB ports να μην μπαίνουν μαζικά σαν εφαρμογές.

Για να εμφανίζονται process names και PID στα listening sockets, το dashboard ίσως χρειαστεί να τρέχει με αρκετά δικαιώματα ή το `ss -p` να επιτρέπεται από το σύστημα.

## Systemd service για το monitor

Παράδειγμα unit file:

```ini
[Unit]
Description=Server App Monitor
After=network.target

[Service]
WorkingDirectory=/home/kmh251/deployment/server_app_monitor
Environment=TARGET_HOST=10.4.51.232
Environment=MANAGER_PORT=4180
Environment=ADMIN_TOKEN=change-this-long-random-token
ExecStart=/usr/bin/node /home/kmh251/deployment/server_app_monitor/server/index.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

Αν δεν θέλεις να τρέχει ως `root`, άφησέ το με dedicated user και δώσε συγκεκριμένα sudoers permissions μόνο για τα services/containers που θέλεις να διαχειρίζεται.

## Data files

- `data/apps.json`: inventory εφαρμογών
- `data/events.jsonl`: activity log

Το dashboard εκτελεί μόνο commands που υπάρχουν στο `data/apps.json` ή μπήκαν από import/edit στο UI.

HTTP/TCP health checks can use internal server-local endpoints such as `http://127.0.0.1:18085/health`. User-facing links should be stored separately in `publicUrl`, for example `https://10.4.51.232:18443/` for Portal Search Agent.

## Discovery reachability

`Discovery` είναι inventory από το ίδιο το Linux μηχάνημα: processes, systemd services, Docker containers, PM2 apps και listening sockets.

Το `Check reachability` μέσα στο `Discovery` κάνει ενεργό TCP check στις ίδιες discovered TCP πόρτες και δείχνει ποιες απαντούν από την IP του server. Έτσι φαίνονται καθαρά οι πόρτες που ακούνε μόνο τοπικά ή σε Docker/internal bindings.

Δεν υπάρχει πλέον ξεχωριστό `Ports` tab ή custom range scan στο κύριο UI.

HTTPS health checks retry certificate-related failures without certificate verification, so internal/self-signed certificates do not incorrectly mark an otherwise reachable app as degraded. Set `ALLOW_INSECURE_HTTPS_CHECKS=false` in the service environment to disable that fallback.

## Unified Docker NGINX gateway

Production ingress is served by one Dockerized NGINX gateway:

```text
/home/kmh251/deployment/app_gateway
container: app-gateway-nginx
compose: /home/kmh251/deployment/app_gateway/compose.yml
nginx: /home/kmh251/deployment/app_gateway/nginx.conf
```

Source-controlled templates live in:

```text
ops/app-gateway/compose.yml
ops/app-gateway/nginx.conf
```

The older `kai-nginx` container was replaced by `app-gateway-nginx`. The system `nginx.service` is stopped and disabled. The KAI compose file no longer owns an nginx service.

Included gateway routes:

- `https://10.4.51.232` -> Server App Monitor
- `https://kai-app` -> KAI
- `https://10.4.51.232:15443/` -> KAI direct IP fallback
- `https://kai-app/guacamole/` -> Guacamole
- `https://chatty` -> Chatty
- `https://10.4.51.232:13443/` -> Chatty direct IP fallback
- `https://dny-portal` / `https://dny` -> DNY Portal
- `https://10.4.51.232:16443/` -> DNY Portal direct IP fallback
- `https://portal-search` / `https://search-agent` / `https://knowledgebase` -> Portal Search Agent
- `https://10.4.51.232:18443/` -> Portal Search Agent direct IP fallback for clients without local DNS/hosts aliases
- `https://net-agent` -> Net Agent
- `https://10.4.51.232:17443/` -> Net Agent direct IP fallback

Intentionally excluded from gateway config:

- tickets
- assets
- csv-viewer
