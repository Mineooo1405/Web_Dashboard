// ============================================================
// Robot Web Dashboard - Frontend JavaScript
// ============================================================

// --- State ---
let ws = null;
let selectedRobot = 1;
let selectedArmRobot = 1;
let kbActive = false;
let activeKeys = new Set();
const ROBOT_IDS = [1, 2, 3];
const ROBOT_COLORS = { 1: '#f06565', 2: '#34d399', 3: '#60a5fa' };

// Viz state (mirrors server)
let vizState = {
    positions: {},
    trajectories: {},
    ground_truth: {},
    object: null,
    obstacles: [],
    grip_positions: {},
    destination: null,
    centroid_path: [],
    formation_circle: null,
    ekf: {},
    bno055: {},
    odometry: {},
    localization: {}
};

// RPM chart data
let rpmChart = null;
let rpmData = { labels: [], datasets: [] };
let rpmStartTime = Date.now();
const RPM_MAX_POINTS = 200;
let rpmDirty = false;
let rpmThrottleTimer = null;
const RPM_THROTTLE_MS = 150;

// ============================================================
// Theme
// ============================================================
function getTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('robot-dash-theme', theme);
    updateThemeIcon(theme);
    updateChartTheme();
    requestRedraw();
}

function toggleTheme() {
    setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

function updateThemeIcon(theme) {
    const dark = document.getElementById('theme-icon-dark');
    const light = document.getElementById('theme-icon-light');
    if (dark) dark.style.display = theme === 'dark' ? 'block' : 'none';
    if (light) light.style.display = theme === 'light' ? 'block' : 'none';
}

function initTheme() {
    const saved = localStorage.getItem('robot-dash-theme');
    if (saved) {
        setTheme(saved);
    } else {
        const prefer = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        setTheme(prefer);
    }
}

/** Read a CSS variable from computed body style */
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ============================================================
// Monitor toggle
// ============================================================
function toggleMonitor() {
    const bar = document.getElementById('monitor-bar');
    const chev = document.getElementById('monitor-chevron');
    bar.classList.toggle('collapsed');
    chev.innerHTML = bar.classList.contains('collapsed') ? '&#9650;' : '&#9660;';
}

// ============================================================
// WebSocket
// ============================================================
function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    
    ws.onopen = () => {
        document.getElementById('ws-indicator').className = 'indicator on';
        document.getElementById('ws-text').textContent = 'Connected';
    };
    
    ws.onclose = () => {
        document.getElementById('ws-indicator').className = 'indicator off';
        document.getElementById('ws-text').textContent = 'Disconnected';
        setTimeout(connectWS, 2000);
    };
    
    ws.onerror = () => ws.close();
    
    ws.onmessage = (evt) => {
        try {
            const msg = JSON.parse(evt.data);
            handleMessage(msg);
        } catch(e) { console.error('WS parse error:', e); }
    };
}

function sendAction(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

// ============================================================
// Message Handler
// ============================================================
function handleMessage(msg) {
    switch(msg.type) {
        case 'monitor':
            appendMonitor(msg.message);
            break;
        case 'status':
            updateConnectionStatus(msg.robot_id, msg.status);
            break;
        case 'encoders':
            updateEncoders(msg.robot_id, msg.data);
            break;
        case 'heading':
            updateHeading(msg.robot_id, msg.value);
            break;
        case 'calibration':
            updateCalibration(msg.robot_id, msg.calibrated);
            break;
        case 'pid_update':
            updatePID(msg.robot_id, msg.motor, msg.p, msg.i, msg.d);
            break;
        case 'arrival':
            updateArrival(msg.robot_id, msg.arrived);
            break;
        case 'phase2_status':
            updatePhase2(msg.status, msg.completed);
            break;
        case 'buttons':
            updateButtons(msg.robot_id, msg.enabled);
            break;
        case 'arm_ik_result':
            updateArmResult(msg.robot_id, msg.data);
            break;
        case 'notification':
            showNotification(msg.level, msg.title, msg.message);
            break;
        case 'progress':
            // Could add progress bar UI
            break;
        case 'viz':
            handleVizUpdate(msg.method, msg.args);
            break;
        case 'full_state':
            handleFullState(msg);
            break;
        case 'viz_full_state':
            handleVizFullState(msg);
            break;
    }
}

function handleFullState(state) {
    // Restore connection statuses
    if (state.connections) {
        for (const [rid, status] of Object.entries(state.connections))
            updateConnectionStatus(parseInt(rid), status);
    }
    // Restore monitor logs
    if (state.monitor) {
        state.monitor.forEach(m => appendMonitor(m));
    }
    // Restore viz
    if (state.viz) handleVizFullState(state.viz);
}

function handleVizFullState(state) {
    if (state.object) vizState.object = state.object;
    if (state.obstacles) vizState.obstacles = state.obstacles;
    if (state.grip_positions) vizState.grip_positions = state.grip_positions;
    if (state.destination) vizState.destination = state.destination;
    if (state.centroid_path) vizState.centroid_path = state.centroid_path;
    if (state.formation_circle) vizState.formation_circle = state.formation_circle;
    if (state.ground_truth) vizState.ground_truth = state.ground_truth;
    if (state.positions) {
        for (const [rid, pos] of Object.entries(state.positions))
            vizState.positions[parseInt(rid)] = pos;
    }
    if (state.trajectories) {
        for (const [rid, pts] of Object.entries(state.trajectories))
            vizState.trajectories[parseInt(rid)] = pts;
    }
    requestRedraw();
}

// ============================================================
// Viz Updates
// ============================================================
function handleVizUpdate(method, args) {
    switch(method) {
        case 'update_position': {
            const [rid, x, y, theta] = args;
            vizState.positions[rid] = [x, y, theta];
            if (!vizState.trajectories[rid]) vizState.trajectories[rid] = [];
            vizState.trajectories[rid].push([x, y]);
            if (vizState.trajectories[rid].length > 2000)
                vizState.trajectories[rid] = vizState.trajectories[rid].slice(-1500);
            updateSensorCard(rid, 'ekf', { x, y });
            requestRedraw();
            break;
        }
        case 'update_ekf': {
            const [rid, x, y] = args;
            vizState.ekf[rid] = [x, y];
            updateSensorCard(rid, 'ekf', { x, y });
            break;
        }
        case 'update_bno055': {
            const [rid, x, y, vx, vy] = args;
            vizState.bno055[rid] = [x, y, vx, vy];
            updateSensorCard(rid, 'bno055', { x, y, vx, vy });
            break;
        }
        case 'update_odometry': {
            const [rid, x, y, vx, vy] = args;
            vizState.odometry[rid] = [x, y, vx, vy];
            updateSensorCard(rid, 'odo', { x, y, vx, vy });
            break;
        }
        case 'update_localization': {
            const [rid, x, y] = args;
            vizState.localization[rid] = [x, y];
            updateSensorCard(rid, 'loc', { x, y });
            break;
        }
        case 'set_object_position':
            vizState.object = args;
            requestRedraw();
            break;
        case 'set_obstacles':
            vizState.obstacles = args[0];
            requestRedraw();
            break;
        case 'set_grip_positions':
            vizState.grip_positions = args[0];
            requestRedraw();
            break;
        case 'set_ground_truth_path':
            vizState.ground_truth[args[0]] = args[1];
            requestRedraw();
            break;
        case 'clear_ground_truth_path':
            delete vizState.ground_truth[args[0]];
            requestRedraw();
            break;
        case 'set_destination_position':
            vizState.destination = [args[0], args[1]];
            requestRedraw();
            break;
        case 'set_centroid_path':
            vizState.centroid_path = args[0];
            requestRedraw();
            break;
        case 'set_formation_circle':
            vizState.formation_circle = [args[0], args[1], args[2]];
            requestRedraw();
            break;
    }
}

// ============================================================
// Canvas Map
// ============================================================
const MAP_RANGE = { xMin: -1, xMax: 7, yMin: -1, yMax: 7 };
let mapNeedsRedraw = false;

function requestRedraw() { mapNeedsRedraw = true; }

function worldToCanvas(x, y, canvas) {
    const w = canvas.width, h = canvas.height;
    const sx = w / (MAP_RANGE.xMax - MAP_RANGE.xMin);
    const sy = h / (MAP_RANGE.yMax - MAP_RANGE.yMin);
    return [
        (x - MAP_RANGE.xMin) * sx,
        h - (y - MAP_RANGE.yMin) * sy  // flip Y
    ];
}

function drawMap() {
    const canvas = document.getElementById('map-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    
    // Theme-aware colors
    const gridColor = cssVar('--map-grid');
    const labelColor = cssVar('--map-label');
    const isDark = getTheme() === 'dark';
    
    ctx.clearRect(0, 0, w, h);
    
    // Grid
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    const gridSize = 0.5;
    for (let gx = Math.ceil(MAP_RANGE.xMin / gridSize) * gridSize; gx <= MAP_RANGE.xMax; gx += gridSize) {
        const [px] = worldToCanvas(gx, 0, canvas);
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
    }
    for (let gy = Math.ceil(MAP_RANGE.yMin / gridSize) * gridSize; gy <= MAP_RANGE.yMax; gy += gridSize) {
        const [, py] = worldToCanvas(0, gy, canvas);
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke();
    }
    
    // Axes labels
    ctx.fillStyle = labelColor;
    ctx.font = '10px Inter, sans-serif';
    for (let gx = 0; gx <= MAP_RANGE.xMax; gx += 1) {
        const [px, py] = worldToCanvas(gx, 0, canvas);
        ctx.fillText(gx.toString(), px + 2, py - 3);
    }
    for (let gy = 0; gy <= MAP_RANGE.yMax; gy += 1) {
        const [px, py] = worldToCanvas(0, gy, canvas);
        ctx.fillText(gy.toString(), px + 3, py - 3);
    }
    
    // Obstacles
    const obsColor = isDark ? 'rgba(240,101,101,0.25)' : 'rgba(220,50,50,0.15)';
    const obsStroke = '#f06565';
    for (const obs of vizState.obstacles) {
        if (obs.type === 'circle') {
            const [cx, cy] = worldToCanvas(obs.cx, obs.cy, canvas);
            const r = obs.radius * w / (MAP_RANGE.xMax - MAP_RANGE.xMin);
            ctx.fillStyle = obsColor;
            ctx.strokeStyle = obsStroke;
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        } else if (obs.type === 'rectangle') {
            const [x1, y1] = worldToCanvas(obs.x1, obs.y2, canvas);
            const [x2, y2] = worldToCanvas(obs.x2, obs.y1, canvas);
            ctx.fillStyle = obsColor;
            ctx.strokeStyle = obsStroke;
            ctx.lineWidth = 1.5;
            ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        }
    }
    
    // Object
    if (vizState.object) {
        const [ox, oy, ol, ow_] = vizState.object;
        const [cx, cy] = worldToCanvas(ox, oy, canvas);
        const scale = w / (MAP_RANGE.xMax - MAP_RANGE.xMin);
        const rw = ol * scale, rh = ow_ * scale;
        ctx.fillStyle = isDark ? 'rgba(251,191,36,0.3)' : 'rgba(230,140,0,0.2)';
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.fillRect(cx - rw/2, cy - rh/2, rw, rh);
        ctx.strokeRect(cx - rw/2, cy - rh/2, rw, rh);
        ctx.fillStyle = '#fbbf24';
        ctx.font = '600 11px Inter, sans-serif';
        ctx.fillText('Object', cx - 18, cy - rh/2 - 5);
    }
    
    // Grip positions
    for (const [rid, pos] of Object.entries(vizState.grip_positions)) {
        const [gx, gy] = worldToCanvas(pos[0], pos[1], canvas);
        const color = ROBOT_COLORS[parseInt(rid)] || '#fff';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        // Draw X marker
        ctx.beginPath(); ctx.moveTo(gx-6, gy-6); ctx.lineTo(gx+6, gy+6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(gx+6, gy-6); ctx.lineTo(gx-6, gy+6); ctx.stroke();
    }
    
    // Destination
    if (vizState.destination) {
        const [dx, dy] = worldToCanvas(vizState.destination[0], vizState.destination[1], canvas);
        ctx.fillStyle = '#a855f7';
        ctx.beginPath(); ctx.arc(dx, dy, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = isDark ? '#c084fc' : '#7c3aed';
        ctx.font = '600 11px Inter, sans-serif';
        ctx.fillText('DEST', dx + 10, dy + 4);
    }
    
    // Formation circle
    if (vizState.formation_circle) {
        const [fcx, fcy, fr] = vizState.formation_circle;
        const [cx, cy] = worldToCanvas(fcx, fcy, canvas);
        const scale = w / (MAP_RANGE.xMax - MAP_RANGE.xMin);
        ctx.strokeStyle = isDark ? 'rgba(100,200,255,0.3)' : 'rgba(60,130,200,0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath(); ctx.arc(cx, cy, fr * scale, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
    }
    
    // Centroid path
    if (vizState.centroid_path && vizState.centroid_path.length > 1) {
        ctx.strokeStyle = '#a855f7';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.beginPath();
        for (let i = 0; i < vizState.centroid_path.length; i++) {
            const p = vizState.centroid_path[i];
            const [px, py] = worldToCanvas(p[0], p[1], canvas);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }
    
    // Ground truth paths
    for (const [rid, path] of Object.entries(vizState.ground_truth)) {
        if (!path || path.length < 2) continue;
        const color = ROBOT_COLORS[parseInt(rid)] || '#fff';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        for (let i = 0; i < path.length; i++) {
            const [px, py] = worldToCanvas(path[i][0], path[i][1], canvas);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }
    
    // Trajectory trails
    for (const [rid, pts] of Object.entries(vizState.trajectories)) {
        if (!pts || pts.length < 2) continue;
        const color = ROBOT_COLORS[parseInt(rid)] || '#fff';
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const start = Math.max(0, pts.length - 500);
        for (let i = start; i < pts.length; i++) {
            const [px, py] = worldToCanvas(pts[i][0], pts[i][1], canvas);
            if (i === start) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
    
    // Robots
    for (const [rid, pos] of Object.entries(vizState.positions)) {
        const [rx, ry, theta] = pos;
        const [cx, cy] = worldToCanvas(rx, ry, canvas);
        const scale = w / (MAP_RANGE.xMax - MAP_RANGE.xMin);
        const robotR = 0.15 * scale;
        const color = ROBOT_COLORS[parseInt(rid)] || '#fff';
        
        // Body
        ctx.fillStyle = color + '40';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, robotR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        
        // Direction arrow
        const arrowLen = robotR * 1.3;
        const ax = cx + arrowLen * Math.cos(-theta + Math.PI/2);
        const ay = cy + arrowLen * Math.sin(-theta + Math.PI/2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ax, ay); ctx.stroke();
        
        // Arrow head
        const headLen = 6;
        const angle = Math.atan2(ay - cy, ax - cx);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - headLen * Math.cos(angle - 0.4), ay - headLen * Math.sin(angle - 0.4));
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - headLen * Math.cos(angle + 0.4), ay - headLen * Math.sin(angle + 0.4));
        ctx.stroke();
        
        // Label
        ctx.fillStyle = color;
        ctx.font = '600 11px Inter, sans-serif';
        ctx.fillText(`R${rid}`, cx + robotR + 4, cy - 4);
    }
}

function resetMapView() {
    // Clear trajectories and redraw
    vizState.trajectories = {};
    requestRedraw();
}

function clearTrajectories() {
    vizState.trajectories = {};
    requestRedraw();
}

// Map animation loop
function mapLoop() {
    if (mapNeedsRedraw) {
        drawMap();
        mapNeedsRedraw = false;
    }
    requestAnimationFrame(mapLoop);
}

// ============================================================
// Monitor
// ============================================================
function appendMonitor(msg) {
    const log = document.getElementById('monitor-log');
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.textContent = msg;
    log.appendChild(div);
    // Keep max 300 entries
    while (log.children.length > 300) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
}

function clearMonitor() {
    document.getElementById('monitor-log').innerHTML = '';
}

// ============================================================
// Connection Status
// ============================================================
function updateConnectionStatus(rid, status) {
    // Update connection tab
    const badge = document.getElementById(`conn-status-${rid}`);
    if (badge) {
        badge.textContent = status;
        badge.className = 'status-badge' + (status === 'Connected' ? ' connected' : '');
    }
    // Update control tab status
    if (rid === selectedRobot) {
        const ctrl = document.getElementById('ctrl-status');
        if (ctrl) {
            ctrl.textContent = status;
            ctrl.className = 'status-badge' + (status === 'Connected' ? ' connected' : '');
        }
    }
}

function updateButtons(rid, enabled) {
    // Could enable/disable specific buttons per robot
}

// ============================================================
// Encoder / Heading / Calibration
// ============================================================
function updateEncoders(rid, data) {
    if (rid === selectedRobot) {
        for (let i = 0; i < 4; i++) {
            const el = document.getElementById(`rpm-${i}`);
            if (el) el.textContent = data[i].toFixed(2) + ' RPM';
        }
        // Push to RPM chart (throttled to avoid lag)
        if (rpmChart) {
            const t = ((Date.now() - rpmStartTime) / 1000).toFixed(1);
            rpmData.labels.push(t);
            for (let i = 0; i < 4; i++) {
                rpmData.datasets[i].data.push(data[i]);
            }
            while (rpmData.labels.length > RPM_MAX_POINTS) {
                rpmData.labels.shift();
                rpmData.datasets.forEach(ds => ds.data.shift());
            }
            rpmDirty = true;
            if (!rpmThrottleTimer) {
                rpmThrottleTimer = setTimeout(() => {
                    if (rpmDirty && rpmChart) {
                        rpmChart.update('none');
                        rpmDirty = false;
                    }
                    rpmThrottleTimer = null;
                }, RPM_THROTTLE_MS);
            }
        }
    }
}

function updateHeading(rid, value) {
    if (rid === selectedRobot) {
        const el = document.getElementById('heading-value');
        if (el) el.textContent = value.toFixed(1) + '°';
    }
}

function updateCalibration(rid, calibrated) {
    if (rid === selectedRobot) {
        const el = document.getElementById('calib-status');
        if (el) {
            el.textContent = calibrated ? 'Calibrated' : 'Not Calibrated';
            el.className = 'calib-badge ' + (calibrated ? 'calibrated' : 'not-cal');
        }
    }
}

function updatePID(rid, motor, p, i, d) {
    if (rid === selectedRobot) {
        const pEl = document.getElementById(`pid-p-${motor}`);
        const iEl = document.getElementById(`pid-i-${motor}`);
        const dEl = document.getElementById(`pid-d-${motor}`);
        if (pEl) pEl.value = p;
        if (iEl) iEl.value = i;
        if (dEl) dEl.value = d;
    }
}

// ============================================================
// Arrival / Phase 2
// ============================================================
function updateArrival(rid, arrived) {
    const el = document.getElementById(`arrival-${rid}`);
    if (el) {
        el.textContent = `R${rid}: ${arrived ? 'Arrived' : 'In Progress'}`;
        el.className = 'arrival-badge ' + (arrived ? 'arrived' : 'in-progress');
    }
}

function updatePhase2(status, completed) {
    const el = document.getElementById('phase2-status');
    if (el) {
        el.textContent = completed ? 'Transport Complete!' : status;
        el.style.color = completed ? 'var(--success)' : 'var(--accent)';
    }
}

// ============================================================
// Arm Result
// ============================================================
function updateArmResult(rid, data) {
    if (rid === selectedArmRobot) {
        for (let i = 0; i < 6; i++) {
            const el = document.getElementById(`res-j${i}`);
            const val = data[`j${i}`];
            if (el) el.textContent = `J${i}: ${val !== undefined ? val.toFixed(1) : '--'}°`;
        }
    }
}

// ============================================================
// Sensor Cards (Dashboard)
// ============================================================
function updateSensorCard(rid, source, data) {
    const card = document.querySelector(`.sensor-card[data-rid="${rid}"]`);
    if (!card) return;
    
    if (source === 'ekf' && data.x !== undefined) {
        const xEl = card.querySelector('.ekf-x');
        const yEl = card.querySelector('.ekf-y');
        if (xEl) xEl.textContent = data.x.toFixed(3);
        if (yEl) yEl.textContent = data.y.toFixed(3);
    }
}

// ============================================================
// Notifications
// ============================================================
function showNotification(level, title, message) {
    appendMonitor(`[${level.toUpperCase()}] ${title}: ${message}`);
}

// ============================================================
// Dashboard Actions
// ============================================================
function setObject() {
    sendAction({
        action: 'set_object',
        x: parseFloat(document.getElementById('obj-x').value),
        y: parseFloat(document.getElementById('obj-y').value),
        length: parseFloat(document.getElementById('obj-length').value),
        width: parseFloat(document.getElementById('obj-width').value)
    });
}

function applyConfig() {
    sendAction({
        action: 'set_config',
        num_robots: parseInt(document.getElementById('num-robots').value),
        gripper_length: parseFloat(document.getElementById('gripper-length').value)
    });
}

function addObstacle() {
    sendAction({
        action: 'add_obstacle',
        x: parseFloat(document.getElementById('obs-x').value),
        y: parseFloat(document.getElementById('obs-y').value),
        r: parseFloat(document.getElementById('obs-r').value)
    });
}

function clearObstacles() {
    sendAction({ action: 'clear_obstacles' });
}

function startApproach() {
    ROBOT_IDS.forEach(rid => {
        const el = document.getElementById(`arrival-${rid}`);
        if (el) { el.textContent = `R${rid}: In Progress`; el.className = 'arrival-badge in-progress'; }
    });
    sendAction({ action: 'start_approach', use_vector_field: true });
}

function abortApproach() {
    sendAction({ action: 'abort_approach' });
    ROBOT_IDS.forEach(rid => {
        const el = document.getElementById(`arrival-${rid}`);
        if (el) { el.textContent = `R${rid}: Aborted`; el.className = 'arrival-badge aborted'; }
    });
}

function setDestination() {
    sendAction({
        action: 'set_destination',
        x: parseFloat(document.getElementById('dest-x').value),
        y: parseFloat(document.getElementById('dest-y').value)
    });
}

function startTransport() {
    setDestination();
    sendAction({ action: 'start_transport' });
}

function abortTransport() {
    sendAction({ action: 'abort_transport' });
}

// Test mode
function testApplyPositions() {
    document.querySelectorAll('#test-positions .form-row').forEach(row => {
        const rid = parseInt(row.dataset.rid);
        const x = parseFloat(row.querySelector('.test-x').value);
        const y = parseFloat(row.querySelector('.test-y').value);
        sendAction({ action: 'set_manual_position', robot_id: rid, x, y, theta: 0 });
    });
}

function testComputeTrajectories() {
    testApplyPositions();
    setTimeout(() => {
        sendAction({ action: 'compute_trajectories', use_vector_field: true });
    }, 100);
}

// ============================================================
// Robot Control Tab
// ============================================================
function selectRobotTab(rid) {
    selectedRobot = rid;
    document.querySelectorAll('#tab-control .robot-tab-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.robot) === rid);
    });
    buildMotorGrid();
    buildPIDGrid();
    rpmStartTime = Date.now();
    if (rpmChart) {
        rpmData.labels = [];
        rpmData.datasets.forEach(ds => ds.data = []);
        rpmChart.update();
    }
}

function buildMotorGrid() {
    const container = document.getElementById('motor-grid');
    container.innerHTML = '';
    for (let i = 0; i < 4; i++) {
        const row = document.createElement('div');
        row.className = 'motor-row';
        row.innerHTML = `
            <label>Motor ${i+1}:</label>
            <span class="rpm-value" id="rpm-${i}">0.00 RPM</span>
            <label>Speed:</label>
            <input type="number" id="speed-${i}" value="0" class="input-sm">
            <button class="btn btn-sm btn-primary" onclick="setMotorSpeed(${i})">Set</button>
        `;
        container.appendChild(row);
    }
}

function buildPIDGrid() {
    const container = document.getElementById('pid-grid');
    container.innerHTML = '';
    for (let i = 0; i < 4; i++) {
        const row = document.createElement('div');
        row.className = 'pid-row';
        row.innerHTML = `
            <label>M${i+1}:</label>
            <label>P:</label><input type="number" id="pid-p-${i}" value="1.0" step="0.1" class="input-xs">
            <label>I:</label><input type="number" id="pid-i-${i}" value="0.0" step="0.01" class="input-xs">
            <label>D:</label><input type="number" id="pid-d-${i}" value="0.0" step="0.01" class="input-xs">
            <button class="btn btn-sm btn-primary" onclick="setPIDMotor(${i})">Set</button>
        `;
        container.appendChild(row);
    }
}

function setMotorSpeed(motor) {
    const speed = parseFloat(document.getElementById(`speed-${motor}`).value);
    sendAction({ action: 'set_motor_speed', robot_id: selectedRobot, motor, speed });
}

function setPIDMotor(motor) {
    sendAction({
        action: 'set_pid', robot_id: selectedRobot, motor,
        p: parseFloat(document.getElementById(`pid-p-${motor}`).value),
        i: parseFloat(document.getElementById(`pid-i-${motor}`).value),
        d: parseFloat(document.getElementById(`pid-d-${motor}`).value)
    });
}

function savePID() { sendAction({ action: 'save_pid', robot_id: selectedRobot }); }
function loadPID() { sendAction({ action: 'load_pid', robot_id: selectedRobot }); }

function emergencyStop() { sendAction({ action: 'emergency_stop', robot_id: selectedRobot }); }
function resetESP() { sendAction({ action: 'send_command', robot_id: selectedRobot, command: 'reset' }); }
function runTestSquare() { sendAction({ action: 'test_trajectory', robot_id: selectedRobot, shape: 'square' }); }
function runTestCircle() { sendAction({ action: 'test_trajectory', robot_id: selectedRobot, shape: 'circle' }); }

// ============================================================
// Arm Tab
// ============================================================
function selectArmTab(rid) {
    selectedArmRobot = rid;
    document.querySelectorAll('#tab-arm .robot-tab-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.robot) === rid);
    });
}

function sendArmIK() {
    sendAction({
        action: 'arm_ik', robot_id: selectedArmRobot,
        x: parseFloat(document.getElementById('arm-x').value),
        y: parseFloat(document.getElementById('arm-y').value),
        z: parseFloat(document.getElementById('arm-z').value),
        pitch: parseFloat(document.getElementById('arm-pitch').value)
    });
}

function sendArmServo() {
    const data = { action: 'arm_servo', robot_id: selectedArmRobot };
    for (let i = 0; i < 6; i++) data[`j${i}`] = parseFloat(document.getElementById(`arm-j${i}`).value);
    sendAction(data);
}

function sendArmPick() {
    sendAction({
        action: 'arm_pick', robot_id: selectedArmRobot,
        x: parseFloat(document.getElementById('arm-x').value),
        y: parseFloat(document.getElementById('arm-y').value),
        z: parseFloat(document.getElementById('arm-z').value)
    });
}

function sendArmPlace() {
    sendAction({
        action: 'arm_place', robot_id: selectedArmRobot,
        x: parseFloat(document.getElementById('arm-x').value),
        y: parseFloat(document.getElementById('arm-y').value),
        z: parseFloat(document.getElementById('arm-z').value)
    });
}

function sendArmGripper(action) {
    sendAction({ action: 'arm_gripper', robot_id: selectedArmRobot, gripper_action: action });
}

function sendArmRest() {
    sendAction({ action: 'arm_rest', robot_id: selectedArmRobot });
}

// ============================================================
// Connection Tab
// ============================================================
function buildConnectionPanels() {
    const container = document.getElementById('connection-panels');
    container.innerHTML = '';
    
    ROBOT_IDS.forEach(rid => {
        const panel = document.createElement('div');
        panel.className = 'conn-panel';
        panel.innerHTML = `
            <div class="panel-header">Robot ${rid} <span class="status-badge" id="conn-status-${rid}">Disconnected</span></div>
            <div class="form-row">
                <label>Host:</label>
                <input type="text" id="conn-host-${rid}" value="192.168.1.21${rid}" class="input-sm" style="width:140px">
                <label>Port:</label>
                <input type="number" id="conn-port-${rid}" value="2004" class="input-sm" style="width:70px">
                <button class="btn btn-success" onclick="connectRobot(${rid})">Connect</button>
                <button class="btn btn-danger" onclick="disconnectRobot(${rid})">Disconnect</button>
            </div>
        `;
        container.appendChild(panel);
    });
}

function connectRobot(rid) {
    sendAction({
        action: 'connect', robot_id: rid,
        host: document.getElementById(`conn-host-${rid}`).value,
        port: parseInt(document.getElementById(`conn-port-${rid}`).value)
    });
}

function disconnectRobot(rid) {
    sendAction({ action: 'disconnect', robot_id: rid });
}

function disconnectAll() {
    sendAction({ action: 'disconnect_all' });
}

// ============================================================
// Settings
// ============================================================
function setLogging() {
    sendAction({ action: 'set_logging', enabled: document.getElementById('logging-enabled').checked });
}

function setExecOffset() {
    sendAction({ action: 'set_execution_offset', offset: parseFloat(document.getElementById('exec-offset').value) });
}

function setApproachVel() {
    sendAction({ action: 'set_approach_velocity', velocity: parseFloat(document.getElementById('approach-vel').value) });
}

function setTransportVel() {
    sendAction({ action: 'set_transport_velocity', velocity: parseFloat(document.getElementById('transport-vel').value) });
}

// ============================================================
// Keyboard Control
// ============================================================
function openKeyboardControl() {
    kbActive = true;
    document.getElementById('kb-robot-id').textContent = selectedRobot;
    document.getElementById('keyboard-modal').classList.remove('hidden');
    document.getElementById('kb-speed').oninput = (e) => {
        document.getElementById('kb-speed-val').textContent = e.target.value;
    };
}

function closeKeyboardControl() {
    kbActive = false;
    activeKeys.clear();
    sendAction({ action: 'kinematic', robot_id: selectedRobot, dot_x: 0, dot_y: 0, dot_theta: 0 });
    document.getElementById('keyboard-modal').classList.add('hidden');
    document.querySelectorAll('.kb-key').forEach(k => k.classList.remove('active'));
}

function handleKeyboard() {
    if (!kbActive) return;
    const speed = parseFloat(document.getElementById('kb-speed').value);
    let dx = 0, dy = 0, dtheta = 0;
    
    if (activeKeys.has('w')) dy = speed;
    if (activeKeys.has('s')) dy = -speed;
    if (activeKeys.has('a')) dx = -speed;
    if (activeKeys.has('d')) dx = speed;
    if (activeKeys.has('q')) dtheta = speed * 3;
    if (activeKeys.has('e')) dtheta = -speed * 3;
    
    // Normalize diagonal
    if (dx !== 0 && dy !== 0) {
        const norm = Math.sqrt(dx*dx + dy*dy);
        dx = dx / norm * speed;
        dy = dy / norm * speed;
    }
    
    sendAction({ action: 'kinematic', robot_id: selectedRobot, dot_x: dx, dot_y: dy, dot_theta: dtheta });
}

document.addEventListener('keydown', (e) => {
    if (!kbActive) return;
    const key = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', ' '].includes(key)) {
        e.preventDefault();
        if (key === ' ') {
            activeKeys.clear();
            sendAction({ action: 'kinematic', robot_id: selectedRobot, dot_x: 0, dot_y: 0, dot_theta: 0 });
        } else {
            activeKeys.add(key);
        }
        updateKeyVisual();
    }
});

document.addEventListener('keyup', (e) => {
    if (!kbActive) return;
    const key = e.key.toLowerCase();
    activeKeys.delete(key);
    updateKeyVisual();
});

function updateKeyVisual() {
    const keyMap = { w: 'key-w', a: 'key-a', s: 'key-s', d: 'key-d', q: 'key-q', e: 'key-e' };
    for (const [k, id] of Object.entries(keyMap)) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', activeKeys.has(k));
    }
}

// Keyboard control loop at 20Hz
setInterval(handleKeyboard, 50);

// ============================================================
// Tab Switching
// ============================================================
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
});

// ============================================================
// Sensor Grid (Dashboard)
// ============================================================
function buildSensorGrid() {
    const container = document.getElementById('sensor-grid');
    container.innerHTML = '';
    ROBOT_IDS.forEach(rid => {
        const card = document.createElement('div');
        card.className = 'sensor-card';
        card.dataset.rid = rid;
        card.innerHTML = `
            <div class="sc-header">Robot ${rid}</div>
            <div class="sc-row"><span class="sc-label">EKF X:</span><span class="sc-val ekf-x">--</span></div>
            <div class="sc-row"><span class="sc-label">EKF Y:</span><span class="sc-val ekf-y">--</span></div>
            <div class="sc-row"><span class="sc-label">Heading:</span><span class="sc-val heading">--</span></div>
        `;
        container.appendChild(card);
    });
}

// ============================================================
// RPM Chart (Chart.js) — theme-aware
// ============================================================
function getChartColors() {
    return {
        grid: cssVar('--chart-grid') || 'rgba(255,255,255,.06)',
        label: cssVar('--chart-label') || '#8b8d98',
    };
}

function initRPMChart() {
    const ctx = document.getElementById('rpm-chart');
    if (!ctx) return;
    
    const motorColors = ['#f06565', '#60a5fa', '#34d399', '#fbbf24'];
    const cc = getChartColors();
    rpmData = {
        labels: [],
        datasets: [0,1,2,3].map(i => ({
            label: `Motor ${i+1}`,
            data: [],
            borderColor: motorColors[i],
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3
        }))
    };
    
    rpmChart = new Chart(ctx, {
        type: 'line',
        data: rpmData,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: { display: false },
                y: {
                    title: { display: true, text: 'RPM', color: cc.label, font: { size: 10, family: 'Inter' } },
                    ticks: { color: cc.label, font: { size: 10, family: 'Inter' } },
                    grid: { color: cc.grid }
                }
            },
            plugins: {
                legend: {
                    labels: { color: cc.label, font: { size: 10, family: 'Inter' }, boxWidth: 10, padding: 12 }
                }
            }
        }
    });
}

function updateChartTheme() {
    if (!rpmChart) return;
    const cc = getChartColors();
    rpmChart.options.scales.y.ticks.color = cc.label;
    rpmChart.options.scales.y.title.color = cc.label;
    rpmChart.options.scales.y.grid.color = cc.grid;
    rpmChart.options.plugins.legend.labels.color = cc.label;
    rpmChart.update('none');
}

// ============================================================
// Load Profiles
// ============================================================
async function loadProfiles() {
    try {
        const resp = await fetch('/api/profiles');
        const profiles = await resp.json();
        
        let rid = 1;
        for (const [name, info] of Object.entries(profiles)) {
            const hostEl = document.getElementById(`conn-host-${rid}`);
            const portEl = document.getElementById(`conn-port-${rid}`);
            if (hostEl) hostEl.value = info.host;
            if (portEl) portEl.value = info.port;
            rid++;
            if (rid > 3) break;
        }
    } catch(e) { /* ignore */ }
}

// ============================================================
// Initialization
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
    initTheme();
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
    buildSensorGrid();
    buildConnectionPanels();
    buildMotorGrid();
    buildPIDGrid();
    initRPMChart();
    connectWS();
    requestRedraw();
    mapLoop();
    loadProfiles();
});
