// ============================================================
// Analytics Module — Log Viewer, Replay, Metrics, Comparison
// ============================================================

const Analytics = (() => {
    // --- State ---
    let positionChart = null;
    let velocityChart = null;
    let imuChart = null;

    // Log data
    let loadedLog = null; // { filename, type, headers, rows }
    let replayData = null; // parsed position data for replay
    let replayIndex = 0;
    let replayPlaying = false;
    let replayTimer = null;
    let replayTrail = [];

    // Real-time analytics buffers
    const RT_MAX = 300;
    let rtPosition = { labels: [], x: [], y: [] };
    let rtVelocity = { labels: [], vx: [], vy: [], speed: [] };
    let rtIMU = { labels: [], heading: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [] };

    // Session comparison
    let compSessions = []; // [{ filename, color, data, metrics }]
    const COMP_COLORS = ['#f06565', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f472b6'];

    let chartsInited = false;

    // ============================================================
    // Initialization
    // ============================================================
    function init() {
        // Charts are lazy-inited on first tab open (canvas is hidden at page load)
        refreshLogList();
    }

    // Called by app.js whenever the Analytics tab is clicked
    function onTabActivated() {
        if (!chartsInited) {
            initPositionChart();
            initVelocityChart();
            initIMUChart();
            chartsInited = true;
        }
        refreshLogList();
    }

    function getCC() {
        const cv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
        return {
            grid: cv('--chart-grid') || 'rgba(255,255,255,.06)',
            label: cv('--chart-label') || '#8b8d98',
        };
    }

    // ============================================================
    // Charts Setup
    // ============================================================
    function initPositionChart() {
        const ctx = document.getElementById('position-chart');
        if (!ctx) return;
        const cc = getCC();
        positionChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    { label: 'X (m)', data: [], borderColor: '#f06565', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
                    { label: 'Y (m)', data: [], borderColor: '#60a5fa', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
                ]
            },
            options: chartOptions(cc, 'Position (m)')
        });
    }

    function initVelocityChart() {
        const ctx = document.getElementById('velocity-chart');
        if (!ctx) return;
        const cc = getCC();
        velocityChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    { label: 'Vx (m/s)', data: [], borderColor: '#f06565', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
                    { label: 'Vy (m/s)', data: [], borderColor: '#60a5fa', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
                    { label: 'Speed (m/s)', data: [], borderColor: '#34d399', borderWidth: 2, pointRadius: 0, tension: 0.3 },
                ]
            },
            options: chartOptions(cc, 'Velocity (m/s)')
        });
    }

    function initIMUChart() {
        const ctx = document.getElementById('imu-chart');
        if (!ctx) return;
        const cc = getCC();
        imuChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    { label: 'Heading (°)', data: [], borderColor: '#fbbf24', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
                ]
            },
            options: chartOptions(cc, 'Heading (°)')
        });
    }

    function chartOptions(cc, yTitle) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: { display: false },
                y: {
                    title: { display: true, text: yTitle, color: cc.label, font: { size: 10, family: 'Inter' } },
                    ticks: { color: cc.label, font: { size: 10, family: 'Inter' } },
                    grid: { color: cc.grid }
                }
            },
            plugins: {
                legend: {
                    labels: { color: cc.label, font: { size: 10, family: 'Inter' }, boxWidth: 10, padding: 12 }
                }
            }
        };
    }

    // ============================================================
    // Real-time data feed (called from main app.js)
    // ============================================================
    function pushPositionData(time, x, y) {
        const t = time.toFixed(1);
        rtPosition.labels.push(t);
        rtPosition.x.push(x);
        rtPosition.y.push(y);
        if (rtPosition.labels.length > RT_MAX) {
            rtPosition.labels.shift();
            rtPosition.x.shift();
            rtPosition.y.shift();
        }
        if (positionChart) {
            positionChart.data.labels = rtPosition.labels;
            positionChart.data.datasets[0].data = rtPosition.x;
            positionChart.data.datasets[1].data = rtPosition.y;
            positionChart.update('none');
        }
    }

    function pushVelocityData(time, vx, vy) {
        const t = time.toFixed(1);
        const speed = Math.sqrt(vx * vx + vy * vy);
        rtVelocity.labels.push(t);
        rtVelocity.vx.push(vx);
        rtVelocity.vy.push(vy);
        rtVelocity.speed.push(speed);
        if (rtVelocity.labels.length > RT_MAX) {
            rtVelocity.labels.shift();
            rtVelocity.vx.shift();
            rtVelocity.vy.shift();
            rtVelocity.speed.shift();
        }
        if (velocityChart) {
            velocityChart.data.labels = rtVelocity.labels;
            velocityChart.data.datasets[0].data = rtVelocity.vx;
            velocityChart.data.datasets[1].data = rtVelocity.vy;
            velocityChart.data.datasets[2].data = rtVelocity.speed;
            velocityChart.update('none');
        }
    }

    function pushIMUData(time, heading, accel, gyro) {
        const t = time.toFixed(1);
        rtIMU.labels.push(t);
        rtIMU.heading.push(heading || 0);
        if (accel) {
            rtIMU.ax.push(accel[0]);
            rtIMU.ay.push(accel[1]);
            rtIMU.az.push(accel[2]);
        } else {
            rtIMU.ax.push(0);
            rtIMU.ay.push(0);
            rtIMU.az.push(0);
        }
        if (gyro) {
            rtIMU.gx.push(gyro[0]);
            rtIMU.gy.push(gyro[1]);
            rtIMU.gz.push(gyro[2]);
        } else {
            rtIMU.gx.push(0);
            rtIMU.gy.push(0);
            rtIMU.gz.push(0);
        }

        if (rtIMU.labels.length > RT_MAX) {
            rtIMU.labels.shift();
            rtIMU.heading.shift();
            rtIMU.ax.shift();
            rtIMU.ay.shift();
            rtIMU.az.shift();
            rtIMU.gx.shift();
            rtIMU.gy.shift();
            rtIMU.gz.shift();
        }
        updateIMUChartData();
    }

    function updateIMUChartData() {
        if (!imuChart) return;
        const imuModeEl = document.getElementById('imu-mode');
        const mode = imuModeEl ? imuModeEl.value || 'heading' : 'heading';
        imuChart.data.labels = rtIMU.labels;

        if (mode === 'heading') {
            imuChart.data.datasets = [
                { label: 'Heading (°)', data: rtIMU.heading, borderColor: '#fbbf24', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
            ];
            imuChart.options.scales.y.title.text = 'Heading (°)';
        } else if (mode === 'accel') {
            imuChart.data.datasets = [
                { label: 'Accel X', data: rtIMU.ax, borderColor: '#f06565', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
                { label: 'Accel Y', data: rtIMU.ay, borderColor: '#60a5fa', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
                { label: 'Accel Z', data: rtIMU.az, borderColor: '#34d399', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
            ];
            imuChart.options.scales.y.title.text = 'Acceleration (m/s²)';
        } else if (mode === 'gyro') {
            imuChart.data.datasets = [
                { label: 'Gyro X', data: rtIMU.gx, borderColor: '#f06565', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
                { label: 'Gyro Y', data: rtIMU.gy, borderColor: '#60a5fa', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
                { label: 'Gyro Z', data: rtIMU.gz, borderColor: '#34d399', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
            ];
            imuChart.options.scales.y.title.text = 'Gyroscope (°/s)';
        }
        imuChart.update('none');
    }

    function switchIMUMode() { updateIMUChartData(); }

    function clearPositionChart() {
        rtPosition = { labels: [], x: [], y: [] };
        if (positionChart) {
            positionChart.data.labels = [];
            positionChart.data.datasets.forEach(ds => ds.data = []);
            positionChart.update('none');
        }
    }

    function clearVelocityChart() {
        rtVelocity = { labels: [], vx: [], vy: [], speed: [] };
        if (velocityChart) {
            velocityChart.data.labels = [];
            velocityChart.data.datasets.forEach(ds => ds.data = []);
            velocityChart.update('none');
        }
    }

    function clearIMUChart() {
        rtIMU = { labels: [], heading: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [] };
        if (imuChart) {
            imuChart.data.labels = [];
            imuChart.data.datasets.forEach(ds => ds.data = []);
            imuChart.update('none');
        }
    }

    // ============================================================
    // Log File Management
    // ============================================================
    async function refreshLogList() {
        const infoEl = document.getElementById('log-file-info');
        try {
            const resp = await fetch('/api/logs');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const files = await resp.json();
            const sel = document.getElementById('log-file-select');
            const cmpSel = document.getElementById('compare-file-select');
            sel.innerHTML = '<option value="">-- Select log file --</option>';
            cmpSel.innerHTML = '<option value="">-- Select session --</option>';
            files.forEach(f => {
                sel.innerHTML += `<option value="${f}">${f}</option>`;
                // position logs eligible for comparison (both old and new naming)
                if (f.includes('_position.csv') || f.includes('position_log')) {
                    cmpSel.innerHTML += `<option value="${f}">${f}</option>`;
                }
            });
            if (infoEl) infoEl.textContent = files.length ? `${files.length} log file(s) found.` : 'No log files found.';
        } catch (e) {
            console.error('Failed to fetch log files:', e);
            if (infoEl) infoEl.textContent = `⚠ Cannot reach server: ${e.message}`;
        }
    }

    async function loadSelectedLog() {
        const sel = document.getElementById('log-file-select');
        const infoEl = document.getElementById('log-file-info');
        const filename = sel ? sel.value : '';
        if (!filename) {
            if (infoEl) infoEl.textContent = '⚠ Please select a log file first.';
            return;
        }

        try {
            const resp = await fetch(`/api/logs/${encodeURIComponent(filename)}`);
            const text = await resp.text();
            const lines = text.trim().split('\n');
            if (lines.length < 2) {
                document.getElementById('log-file-info').textContent = 'Empty log file';
                return;
            }

            const headers = lines[0].trim().split(',').map(h => h.trim());
            const rows = lines.slice(1).map(l => l.trim().split(','));
            loadedLog = { filename, headers, rows };

            document.getElementById('log-file-info').textContent =
                `✓ Loaded: ${filename} — ${rows.length} rows, ${headers.length} cols`;

            // Lazy-init charts if tab was never activated before
            if (!chartsInited) {
                initPositionChart();
                initVelocityChart();
                initIMUChart();
                chartsInited = true;
            }

            // If position log, prepare replay (new name: _position.csv, legacy: position_log)
            const isPosition = filename.includes('_position.csv') || filename.includes('position_log');
            const isIMU = filename.includes('_imu.csv') || filename.includes('bno055_log');

            if (isPosition) {
                prepareReplay(headers, rows);
            }

            // If IMU/bno055 log, load into IMU chart
            if (isIMU) {
                loadBNO055ToChart(headers, rows);
            }

            // Compute metrics for position logs
            if (isPosition) {
                computeMetrics(rows, headers);
            }

        } catch (e) {
            console.error('Failed to load log:', e);
            document.getElementById('log-file-info').textContent = 'Error loading file';
        }
    }

    // ============================================================
    // Helpers
    // ============================================================
    // New-format files have 'source' in the header → no offset needed.
    // Legacy files have a hidden type column at index 1 not in the header → offset = 1.
    function detectTypeOffset(headers, rows) {
        if (headers && headers.indexOf('source') !== -1) return 0;
        if (!rows || rows.length === 0) return 0;
        const v = (rows[0][1] || '').trim();
        return isNaN(parseFloat(v)) ? 1 : 0;
    }

    // ============================================================
    // Replay System
    // ============================================================
    function prepareReplay(headers, rows) {
        // Parse EKF rows with valid x,y
        replayData = [];
        const off = detectTypeOffset(headers, rows);
        const iTime = 0;
        const iX = headers.indexOf('x') + off;
        const iY = headers.indexOf('y') + off;
        const iTheta = headers.indexOf('theta') + off;

        rows.forEach(r => {
            // Only use EKF rows — skips optical_flow, odometry, localization etc.
            if (off > 0 && (r[1] || '').trim() !== 'ekf') return;
            const t = parseFloat(r[iTime]);
            const x = parseFloat(r[iX]);
            const y = parseFloat(r[iY]);
            const theta = parseFloat(r[iTheta]) || 0;
            if (!isNaN(t) && !isNaN(x) && !isNaN(y)) {
                replayData.push({ t, x, y, theta });
            }
        });

        if (replayData.length === 0) {
            document.getElementById('log-file-info').textContent += ' (No valid position data for replay)';
            return;
        }

        replayIndex = 0;
        replayTrail = [];
        replayPlaying = false;
        document.getElementById('replay-controls').style.display = 'block';
        document.getElementById('replay-slider').max = replayData.length - 1;
        updateReplayTime();
        drawReplayFrame();
    }

    function toggleReplay() {
        if (!replayData || replayData.length === 0) return;
        replayPlaying = !replayPlaying;
        document.getElementById('replay-play-btn').innerHTML = replayPlaying ? '&#9646;&#9646; Pause' : '&#9654; Play';
        if (replayPlaying) runReplay();
        else if (replayTimer) {
            clearTimeout(replayTimer);
            replayTimer = null;
        }
    }

    function runReplay() {
        if (!replayPlaying || replayIndex >= replayData.length - 1) {
            replayPlaying = false;
            document.getElementById('replay-play-btn').innerHTML = '&#9654; Play';
            return;
        }

        const speed = parseFloat(document.getElementById('replay-speed').value) || 1;
        const curr = replayData[replayIndex];
        const next = replayData[replayIndex + 1];
        const dt = Math.min(200, Math.max(10, ((next.t - curr.t) * 1000) / speed));

        replayTrail.push({ x: curr.x, y: curr.y });
        replayIndex++;
        document.getElementById('replay-slider').value = replayIndex;
        updateReplayTime();
        drawReplayFrame();

        replayTimer = setTimeout(runReplay, dt);
    }

    function seekReplay(val) {
        replayIndex = parseInt(val);
        // Rebuild trail up to this point
        replayTrail = replayData.slice(0, replayIndex).map(d => ({ x: d.x, y: d.y }));
        updateReplayTime();
        drawReplayFrame();
    }

    function resetReplay() {
        if (replayTimer) {
            clearTimeout(replayTimer);
            replayTimer = null;
        }
        replayPlaying = false;
        replayIndex = 0;
        replayTrail = [];
        document.getElementById('replay-play-btn').innerHTML = '&#9654; Play';
        document.getElementById('replay-slider').value = 0;
        updateReplayTime();
        drawReplayFrame();
    }

    function clearReplay() {
        resetReplay();
        replayData = null;
        document.getElementById('replay-controls').style.display = 'none';
        const canvas = document.getElementById('replay-canvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function updateReplayTime() {
        if (!replayData || replayData.length === 0) return;
        const curr = replayData[replayIndex] || replayData[0];
        const total = replayData[replayData.length - 1];
        const elapsed = (curr.t - replayData[0].t).toFixed(1);
        const duration = (total.t - replayData[0].t).toFixed(1);
        document.getElementById('replay-time').textContent = `${elapsed}s / ${duration}s`;
    }

    function drawReplayFrame() {
        const canvas = document.getElementById('replay-canvas');
        // Sync drawing buffer to CSS display size (fixes blurry/misaligned rendering)
        if (canvas.clientWidth > 0) {
            canvas.width = canvas.clientWidth;
            canvas.height = canvas.clientWidth; // keep square
        }
        const ctx = canvas.getContext('2d');
        const W = canvas.width,
            H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        const hasReplay = replayData && replayData.length > 0;
        const hasComp = compSessions.length > 0;

        // Empty state hint
        if (!hasReplay && !hasComp) {
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim() || '#5c5e6a';
            ctx.font = '13px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Load a position log to view replay', W / 2, H / 2);
            return;
        }

        // Compute bounds across all available data
        let minX = Infinity,
            maxX = -Infinity,
            minY = Infinity,
            maxY = -Infinity;
        if (hasReplay) {
            replayData.forEach(d => {
                if (d.x < minX) minX = d.x;
                if (d.x > maxX) maxX = d.x;
                if (d.y < minY) minY = d.y;
                if (d.y > maxY) maxY = d.y;
            });
        }
        compSessions.forEach(s => {
            s.data.forEach(d => {
                if (d.x < minX) minX = d.x;
                if (d.x > maxX) maxX = d.x;
                if (d.y < minY) minY = d.y;
                if (d.y > maxY) maxY = d.y;
            });
        });

        const padding = 40;
        const range = Math.max(maxX - minX, maxY - minY, 0.5);
        const padded = range * 1.1; // 10% breathing room
        const scale = (W - 2 * padding) / padded;
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        const toCanvasX = (x) => padding + (x - cx + padded / 2) * scale;
        const toCanvasY = (y) => H - padding - (y - cy + padded / 2) * scale;

        // Grid
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--map-grid').trim() || '#1a1e2e';
        ctx.lineWidth = 0.5;
        const gridStep = range > 5 ? 1 : range > 2 ? 0.5 : 0.1;
        const gxStart = Math.ceil(minX / gridStep) * gridStep;
        const gyStart = Math.ceil(minY / gridStep) * gridStep;
        for (let gx = gxStart; gx <= maxX + gridStep; gx += gridStep) {
            const sx = toCanvasX(gx);
            ctx.beginPath();
            ctx.moveTo(sx, 0);
            ctx.lineTo(sx, H);
            ctx.stroke();
        }
        for (let gy = gyStart; gy <= maxY + gridStep; gy += gridStep) {
            const sy = toCanvasY(gy);
            ctx.beginPath();
            ctx.moveTo(0, sy);
            ctx.lineTo(W, sy);
            ctx.stroke();
        }

        // Draw comparison sessions
        compSessions.forEach(s => {
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 2;
            ctx.globalAlpha = 0.65;
            ctx.beginPath();
            s.data.forEach((d, i) => {
                const sx = toCanvasX(d.x),
                    sy = toCanvasY(d.y);
                i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
            });
            ctx.stroke();
            ctx.globalAlpha = 1;
        });

        if (hasReplay) {
            // Full trajectory (faint ghost)
            ctx.strokeStyle = 'rgba(96,165,250,.20)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            replayData.forEach((d, i) => {
                const sx = toCanvasX(d.x),
                    sy = toCanvasY(d.y);
                i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
            });
            ctx.stroke();

            // Replayed trail
            if (replayTrail.length > 1) {
                ctx.strokeStyle = '#f06565';
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                replayTrail.forEach((p, i) => {
                    const sx = toCanvasX(p.x),
                        sy = toCanvasY(p.y);
                    i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
                });
                ctx.stroke();
            }

            // Current robot position
            const curr = replayData[replayIndex];
            if (curr) {
                const sx = toCanvasX(curr.x),
                    sy = toCanvasY(curr.y);
                ctx.fillStyle = '#f06565';
                ctx.beginPath();
                ctx.arc(sx, sy, 8, 0, Math.PI * 2);
                ctx.fill();
                // Direction arrow
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(sx, sy);
                ctx.lineTo(sx + Math.cos(curr.theta) * 14, sy - Math.sin(curr.theta) * 14);
                ctx.stroke();
                // Coords label
                ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-2').trim() || '#8b8d98';
                ctx.font = '11px Inter, sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText(`(${curr.x.toFixed(3)}, ${curr.y.toFixed(3)})`, sx + 14, sy - 4);
            }
        }

        // Axis labels
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim() || '#5c5e6a';
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`X: ${minX.toFixed(2)} → ${maxX.toFixed(2)} m`, W / 2, H - 8);
        ctx.save();
        ctx.translate(12, H / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(`Y: ${minY.toFixed(2)} → ${maxY.toFixed(2)} m`, 0, 0);
        ctx.restore();
    }

    // ============================================================
    // BNO055 Log → IMU Chart
    // ============================================================
    function loadBNO055ToChart(headers, rows) {
        const iTime = headers.indexOf('time');
        const iHeading = headers.indexOf('heading');
        const iRoll = headers.indexOf('roll');
        const iPitch = headers.indexOf('pitch');

        // Clear and load
        rtIMU = { labels: [], heading: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [] };

        // Sample at most 500 points
        const step = Math.max(1, Math.floor(rows.length / 500));
        for (let i = 0; i < rows.length; i += step) {
            const r = rows[i];
            const t = parseFloat(r[iTime]);
            if (isNaN(t)) continue;
            rtIMU.labels.push(t.toFixed(1));
            rtIMU.heading.push(parseFloat(r[iHeading]) || 0);
            rtIMU.ax.push(parseFloat(r[iRoll]) || 0);
            rtIMU.ay.push(parseFloat(r[iPitch]) || 0);
            rtIMU.az.push(0);
            rtIMU.gx.push(0);
            rtIMU.gy.push(0);
            rtIMU.gz.push(0);
        }
        updateIMUChartData();
    }

    // ============================================================
    // Performance Metrics
    // ============================================================
    function computeMetrics(rows, headers) {
        const off = detectTypeOffset(headers, rows);
        const iTime = 0;
        const iX = headers.indexOf('x') + off;
        const iY = headers.indexOf('y') + off;
        const iVx = headers.indexOf('vx') + off;
        const iVy = headers.indexOf('vy') + off;

        // Only use EKF rows — skips optical_flow, odometry, localization etc.
        const pts = [];
        rows.forEach(r => {
            if (off > 0 && (r[1] || '').trim() !== 'ekf') return;
            const t = parseFloat(r[iTime]);
            const x = parseFloat(r[iX]);
            const y = parseFloat(r[iY]);
            if (!isNaN(t) && !isNaN(x) && !isNaN(y)) {
                const vx = parseFloat(r[iVx]) || 0;
                const vy = parseFloat(r[iVy]) || 0;
                pts.push({ t, x, y, vx, vy });
            }
        });

        if (pts.length < 2) return null;

        // Total distance
        let totalDist = 0;
        let speeds = [];
        for (let i = 1; i < pts.length; i++) {
            const dx = pts[i].x - pts[i - 1].x;
            const dy = pts[i].y - pts[i - 1].y;
            const d = Math.sqrt(dx * dx + dy * dy);
            totalDist += d;
            const dt = pts[i].t - pts[i - 1].t;
            if (dt > 0) speeds.push(d / dt);
        }

        const duration = pts[pts.length - 1].t - pts[0].t;
        const avgSpeed = duration > 0 ? totalDist / duration : 0;
        const maxSpeed = speeds.length > 0 ? Math.max(...speeds) : 0;

        // Path efficiency: straight-line / actual
        const straightDist = Math.sqrt(
            Math.pow(pts[pts.length - 1].x - pts[0].x, 2) +
            Math.pow(pts[pts.length - 1].y - pts[0].y, 2)
        );
        const efficiency = totalDist > 0 ? (straightDist / totalDist) * 100 : 0;

        const metrics = {
            totalDist: totalDist.toFixed(3),
            avgSpeed: avgSpeed.toFixed(4),
            maxSpeed: maxSpeed.toFixed(4),
            duration: duration.toFixed(1),
            efficiency: efficiency.toFixed(1),
            points: pts.length
        };

        // Update UI
        document.getElementById('metric-distance').textContent = metrics.totalDist;
        document.getElementById('metric-avg-speed').textContent = metrics.avgSpeed;
        document.getElementById('metric-max-speed').textContent = metrics.maxSpeed;
        document.getElementById('metric-duration').textContent = metrics.duration;
        document.getElementById('metric-efficiency').textContent = metrics.efficiency;
        document.getElementById('metric-points').textContent = metrics.points;

        // Also load position data into position chart
        clearPositionChart();
        const step = Math.max(1, Math.floor(pts.length / 500));
        for (let i = 0; i < pts.length; i += step) {
            const p = pts[i];
            rtPosition.labels.push((p.t - pts[0].t).toFixed(1));
            rtPosition.x.push(p.x);
            rtPosition.y.push(p.y);
        }
        if (positionChart) {
            positionChart.data.labels = rtPosition.labels;
            positionChart.data.datasets[0].data = rtPosition.x;
            positionChart.data.datasets[1].data = rtPosition.y;
            positionChart.update('none');
        }

        // Velocity chart from data
        clearVelocityChart();
        for (let i = 0; i < pts.length; i += step) {
            const p = pts[i];
            rtVelocity.labels.push((p.t - pts[0].t).toFixed(1));
            rtVelocity.vx.push(p.vx);
            rtVelocity.vy.push(p.vy);
            rtVelocity.speed.push(Math.sqrt(p.vx * p.vx + p.vy * p.vy));
        }
        if (velocityChart) {
            velocityChart.data.labels = rtVelocity.labels;
            velocityChart.data.datasets[0].data = rtVelocity.vx;
            velocityChart.data.datasets[1].data = rtVelocity.vy;
            velocityChart.data.datasets[2].data = rtVelocity.speed;
            velocityChart.update('none');
        }

        return metrics;
    }

    // ============================================================
    // Session Comparison
    // ============================================================
    async function addComparison() {
        const sel = document.getElementById('compare-file-select');
        const filename = sel.value;
        if (!filename) return;
        if (compSessions.find(s => s.filename === filename)) return; // Already added

        try {
            const resp = await fetch(`/api/logs/${encodeURIComponent(filename)}`);
            const text = await resp.text();
            const lines = text.trim().split('\n');
            if (lines.length < 2) return;

            const headers = lines[0].trim().split(',').map(h => h.trim());
            const rows = lines.slice(1).map(l => l.trim().split(','));

            const off = detectTypeOffset(headers, rows);
            const iTime = 0;
            const iX = headers.indexOf('x') + off;
            const iY = headers.indexOf('y') + off;

            const data = [];
            rows.forEach(r => {
                if (off > 0 && (r[1] || '').trim() !== 'ekf') return;
                const t = parseFloat(r[iTime]);
                const x = parseFloat(r[iX]);
                const y = parseFloat(r[iY]);
                if (!isNaN(t) && !isNaN(x) && !isNaN(y)) {
                    data.push({ t, x, y });
                }
            });

            if (data.length === 0) return;

            const color = COMP_COLORS[compSessions.length % COMP_COLORS.length];
            const metrics = computeSessionMetrics(data);
            compSessions.push({ filename, color, data, metrics });
            renderComparisonUI();
            drawReplayFrame(); // Redraw with comparison overlays
        } catch (e) {
            console.error('Failed to load comparison:', e);
        }
    }

    function computeSessionMetrics(data) {
        let totalDist = 0;
        for (let i = 1; i < data.length; i++) {
            const dx = data[i].x - data[i - 1].x;
            const dy = data[i].y - data[i - 1].y;
            totalDist += Math.sqrt(dx * dx + dy * dy);
        }
        const duration = data[data.length - 1].t - data[0].t;
        const avgSpeed = duration > 0 ? totalDist / duration : 0;
        const straightDist = Math.sqrt(
            Math.pow(data[data.length - 1].x - data[0].x, 2) +
            Math.pow(data[data.length - 1].y - data[0].y, 2)
        );
        const efficiency = totalDist > 0 ? (straightDist / totalDist) * 100 : 0;
        return {
            totalDist: totalDist.toFixed(3),
            avgSpeed: avgSpeed.toFixed(4),
            duration: duration.toFixed(1),
            efficiency: efficiency.toFixed(1),
            points: data.length
        };
    }

    function renderComparisonUI() {
        const list = document.getElementById('comparison-list');
        const table = document.getElementById('comparison-table');

        // Badges
        list.innerHTML = compSessions.map((s, i) => `
            <span class="compare-badge">
                <span class="compare-dot" style="background:${s.color}"></span>
                ${s.filename.replace('robot1_position_log_', '').replace('.csv', '')}
                <span class="remove-btn" onclick="Analytics.removeComparison(${i})">&times;</span>
            </span>
        `).join('');

        // Table
        if (compSessions.length === 0) {
            table.innerHTML = '';
            return;
        }

        let html = `<table class="compare-table">
            <thead><tr>
                <th></th><th>Session</th><th>Distance</th><th>Avg Speed</th><th>Duration</th><th>Efficiency</th><th>Points</th>
            </tr></thead><tbody>`;

        compSessions.forEach(s => {
            const label = s.filename.replace('robot1_position_log_', '').replace('.csv', '');
            html += `<tr>
                <td><span class="compare-dot" style="background:${s.color}"></span></td>
                <td>${label}</td>
                <td>${s.metrics.totalDist} m</td>
                <td>${s.metrics.avgSpeed} m/s</td>
                <td>${s.metrics.duration} s</td>
                <td>${s.metrics.efficiency}%</td>
                <td>${s.metrics.points}</td>
            </tr>`;
        });

        html += '</tbody></table>';
        table.innerHTML = html;
    }

    function removeComparison(index) {
        compSessions.splice(index, 1);
        renderComparisonUI();
        drawReplayFrame();
    }

    function clearComparison() {
        compSessions = [];
        renderComparisonUI();
        drawReplayFrame();
    }

    // ============================================================
    // Theme update
    // ============================================================
    function updateChartsTheme() {
        const cc = getCC();
        [positionChart, velocityChart, imuChart].forEach(chart => {
            if (!chart) return;
            chart.options.scales.y.ticks.color = cc.label;
            chart.options.scales.y.title.color = cc.label;
            chart.options.scales.y.grid.color = cc.grid;
            chart.options.plugins.legend.labels.color = cc.label;
            chart.update('none');
        });
    }

    // ============================================================
    // Public API
    // ============================================================
    return {
        onTabActivated,
        init,
        refreshLogList,
        loadSelectedLog,
        toggleReplay,
        resetReplay,
        clearReplay,
        seekReplay,
        switchIMUMode,
        clearPositionChart,
        clearVelocityChart,
        clearIMUChart,
        addComparison,
        removeComparison,
        clearComparison,
        pushPositionData,
        pushVelocityData,
        pushIMUData,
        updateChartsTheme,
    };
})();