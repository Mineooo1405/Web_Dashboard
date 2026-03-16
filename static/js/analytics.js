// ============================================================
// Analytics Module — Log Viewer, Replay, Metrics, Comparison
// ============================================================

const Analytics = (() => {
    // --- State ---
    let positionChart = null;
    let velocityChart = null;
    let imuChart = null;

    // Session management
    // sessionGroups: { sid: { id, files: { position, imu, pid, monitor, encoder } } }
    let sessionGroups = {};
    // sessionCache: { sid: { posHeaders, posRows, imuHeaders, imuRows } }
    let sessionCache = {};
    let activeSessionId = null;

    // Log data
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
    // ============================================================
    // Session Grouping Helpers
    // ============================================================
    function getFileType(f) {
        if (f.includes('_position.csv') || f.includes('position_log')) return 'position';
        if (f.includes('_imu.csv') || f.includes('bno055_log')) return 'imu';
        if (f.includes('_pid.csv') || f.includes('pid_log')) return 'pid';
        if (f.includes('_monitor.csv') || f.includes('log_log')) return 'monitor';
        if (f.includes('_encoder.csv')) return 'encoder';
        return null;
    }

    function formatSid(sid) {
        // '20260303_145155' → '2026-03-03 14:51:55'
        const m = sid.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
        return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : sid;
    }

    async function refreshLogList() {
        const infoEl = document.getElementById('log-file-info');
        try {
            const resp = await fetch('/api/logs');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const files = await resp.json();

            // Group files by session timestamp (YYYYMMDD_HHMMSS)
            sessionGroups = {};
            files.forEach(f => {
                const m = f.match(/(\d{8}_\d{6})/);
                if (!m) return;
                const sid = m[1];
                if (!sessionGroups[sid]) sessionGroups[sid] = { id: sid, files: {} };
                const type = getFileType(f);
                if (type) sessionGroups[sid].files[type] = f;
            });

            const sids = Object.keys(sessionGroups).sort().reverse();
            const sel = document.getElementById('log-file-select');
            const cmpSel = document.getElementById('compare-file-select');
            sel.innerHTML = '<option value="">-- Select session --</option>';
            cmpSel.innerHTML = '<option value="">-- Select session --</option>';

            sids.forEach(sid => {
                const sg = sessionGroups[sid];
                const types = Object.keys(sg.files).join(', ');
                const cached = sessionCache[sid] ? ' ✓' : '';
                const label = `${formatSid(sid)}  [${types}]${cached}`;
                sel.innerHTML += `<option value="${sid}">${label}</option>`;
                if (sg.files.position) {
                    cmpSel.innerHTML += `<option value="${sid}">${label}</option>`;
                }
            });

            if (infoEl) infoEl.textContent = sids.length ?
                `${sids.length} session(s) found (${files.length} files)` :
                'No log files found.';

            renderLoadedSessionsUI();
        } catch (e) {
            console.error('Failed to fetch log files:', e);
            if (infoEl) infoEl.textContent = `⚠ Cannot reach server: ${e.message}`;
        }
    }

    async function loadSelectedLog() {
        const sel = document.getElementById('log-file-select');
        const infoEl = document.getElementById('log-file-info');
        const sid = sel ? sel.value : '';
        if (!sid) {
            if (infoEl) infoEl.textContent = '⚠ Please select a session first.';
            return;
        }

        // If already cached, just re-activate — no network requests needed
        if (sessionCache[sid]) {
            activateSession(sid);
            if (infoEl) {
                const sg = sessionGroups[sid];
                const types = sg ? Object.keys(sg.files).join(', ') : '';
                const a = sessionCache[sid].posAnalysis;
                const ekfInfo = a ? ` | EKF ${a.ekfRows}/${a.parsedRows}` : '';
                infoEl.textContent = `✓ Session ${formatSid(sid)} re-activated  [${types}]${ekfInfo}`;
            }
            return;
        }

        const sg = sessionGroups[sid];
        if (!sg) { if (infoEl) infoEl.textContent = '⚠ Session not found.'; return; }

        if (infoEl) infoEl.textContent = `Loading session ${formatSid(sid)}…`;

        // Fetch all file types for this session in parallel
        const [posData, imuData] = await Promise.all([
            sg.files.position ? fetchCSV(sg.files.position) : Promise.resolve(null),
            sg.files.imu ? fetchCSV(sg.files.imu) : Promise.resolve(null),
        ]);

        const cache = { sid };
        if (posData) {
            cache.posHeaders = posData.headers;
            cache.posRows = posData.rows;
            cache.posAnalysis = analyzePositionRows(posData.headers, posData.rows);
        }
        if (imuData) { cache.imuHeaders = imuData.headers;
            cache.imuRows = imuData.rows; }
        sessionCache[sid] = cache;

        activateSession(sid);

        const loadedTypes = [];
        if (posData) loadedTypes.push(`position (${posData.rows.length} rows)`);
        if (imuData) loadedTypes.push(`imu (${imuData.rows.length} rows)`);
        const a = cache.posAnalysis;
        const ekfInfo = a ? ` | EKF ${a.ekfRows}/${a.parsedRows}` : '';
        if (infoEl) infoEl.textContent = loadedTypes.length ?
            `✓ Session ${formatSid(sid)} loaded — ${loadedTypes.join(', ')}${ekfInfo}` :
            `⚠ Session ${formatSid(sid)}: no usable data found.`;

        // Refresh dropdown labels to show ✓ for cached sessions
        refreshLogList();
    }

    // Fetch a CSV file and return { filename, headers, rows }
    async function fetchCSV(filename) {
        try {
            const resp = await fetch(`/api/logs/${encodeURIComponent(filename)}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const text = await resp.text();
            const lines = text.trim().split('\n');
            if (lines.length < 2) return null;
            const headers = lines[0].trim().split(',').map(h => h.trim());
            const rows = lines.slice(1).map(l => l.trim().split(','));
            return { filename, headers, rows };
        } catch (e) {
            console.error(`Failed to load ${filename}:`, e);
            return null;
        }
    }

    // Activate a cached session: load its data into replay, metrics, and charts
    function activateSession(sid) {
        activeSessionId = sid;
        const cache = sessionCache[sid];
        if (!cache) return;

        // Lazy-init charts
        if (!chartsInited) {
            initPositionChart();
            initVelocityChart();
            initIMUChart();
            chartsInited = true;
        }

        if (cache.posHeaders && cache.posRows) {
            cache.posAnalysis = analyzePositionRows(cache.posHeaders, cache.posRows);
            renderLogInsights(cache.posAnalysis);
            prepareReplay(cache.posHeaders, cache.posRows);
            computeMetrics(cache.posRows, cache.posHeaders);
        } else {
            renderLogInsights(null);
        }
        if (cache.imuHeaders && cache.imuRows) {
            loadBNO055ToChart(cache.imuHeaders, cache.imuRows);
        }

        renderLoadedSessionsUI();
    }

    // Render the quick-access bar of previously loaded sessions
    function renderLoadedSessionsUI() {
        const container = document.getElementById('loaded-sessions-list');
        if (!container) return;
        const sids = Object.keys(sessionCache);
        if (sids.length === 0) { container.innerHTML = ''; return; }

        container.innerHTML = '<div class="text-muted" style="font-size:11px;margin-bottom:4px">Loaded sessions (click to switch):</div>' +
            sids.map(sid => {
                const sg = sessionGroups[sid];
                const types = sg ? Object.keys(sg.files).join(', ') : '';
                const active = sid === activeSessionId ? ' style="border-color:#60a5fa;background:rgba(96,165,250,.12)"' : '';
                return `<span class="compare-badge" onclick="Analytics.switchSession('${sid}')"${active}>${formatSid(sid)} [${types}]</span>`;
            }).join('');
    }

    // Switch to an already-cached session
    function switchSession(sid) {
        if (!sessionCache[sid]) return;
        activateSession(sid);
        const infoEl = document.getElementById('log-file-info');
        if (infoEl) {
            const sg = sessionGroups[sid];
            const types = sg ? Object.keys(sg.files).join(', ') : '';
            const cache = sessionCache[sid] || {};
            const a = cache.posAnalysis;
            const ekfInfo = a ? ` | EKF ${a.ekfRows}/${a.parsedRows}` : '';
            infoEl.textContent = `✓ Switched to session ${formatSid(sid)}  [${types}]`;
            if (ekfInfo) infoEl.textContent += ekfInfo;
        }
    }

    // ============================================================
    // Helpers
    // ============================================================
    function isFiniteNumber(v) {
        return Number.isFinite(v);
    }

    function isEKFSource(source) {
        if (!source) return false;
        const s = String(source).trim().toLowerCase();
        return s === 'ekf' || s.includes('ekf');
    }

    // Supports mixed datasets observed in logs:
    // 1) time, source, x, y, vx, vy                     (6 cols)
    // 2) time, source, x, y, theta, vx, vy             (7 cols)
    // 3) time, source, x, y, vx, vy, theta, pos, vel   (9 cols)
    // 4) legacy rows without source token               (time, x, y, theta, vx, vy)
    function parsePositionRow(headers, row) {
        if (!row || row.length < 3) return null;

        const t = parseFloat((row[0] || '').trim());
        if (!isFiniteNumber(t)) return null;

        const col1 = (row[1] || '').trim();
        const hasSourceToken = col1 !== '' && !isFiniteNumber(parseFloat(col1));
        let source = 'unknown';
        let x = NaN;
        let y = NaN;
        let theta = 0;
        let vx = 0;
        let vy = 0;

        if (hasSourceToken) {
            source = col1.toLowerCase();
            x = parseFloat((row[2] || '').trim());
            y = parseFloat((row[3] || '').trim());

            if (isEKFSource(source)) {
                if (row.length >= 9) {
                    // Legacy EKF payload: x, y, vx, vy, theta, ...
                    vx = parseFloat((row[4] || '').trim());
                    vy = parseFloat((row[5] || '').trim());
                    theta = parseFloat((row[6] || '').trim());
                } else if (row.length >= 7) {
                    // Mixed 7-col EKF layouts observed:
                    // A) x,y,theta,vx,vy  or  B) x,y,vx,vy,theta
                    const c4 = parseFloat((row[4] || '').trim());
                    const c5 = parseFloat((row[5] || '').trim());
                    const c6 = parseFloat((row[6] || '').trim());

                    const abs4 = Math.abs(c4 || 0);
                    const abs5 = Math.abs(c5 || 0);
                    const abs6 = Math.abs(c6 || 0);
                    const looksAngle4 = abs4 > 1.5 && abs5 < 1.0 && abs6 < 1.0;
                    const looksAngle6 = abs6 > 1.5 && abs4 < 1.0 && abs5 < 1.0;

                    if (looksAngle6) {
                        vx = c4;
                        vy = c5;
                        theta = c6;
                    } else if (looksAngle4) {
                        theta = c4;
                        vx = c5;
                        vy = c6;
                    } else {
                        const speedA = Math.hypot(c5 || 0, c6 || 0); // theta,vx,vy
                        const speedB = Math.hypot(c4 || 0, c5 || 0); // vx,vy,theta
                        if (speedB < speedA) {
                            vx = c4;
                            vy = c5;
                            theta = c6;
                        } else {
                            theta = c4;
                            vx = c5;
                            vy = c6;
                        }
                    }
                } else if (row.length >= 6) {
                    // Minimal source payload: x, y, vx, vy
                    vx = parseFloat((row[4] || '').trim());
                    vy = parseFloat((row[5] || '').trim());
                }
            } else {
                // optical_flow / odometry rows can be 6-col (x,y,vx,vy) or 7-col (x,y,theta,vx,vy)
                if (row.length >= 7) {
                    theta = parseFloat((row[4] || '').trim());
                    vx = parseFloat((row[5] || '').trim());
                    vy = parseFloat((row[6] || '').trim());
                } else if (row.length >= 6) {
                    vx = parseFloat((row[4] || '').trim());
                    vy = parseFloat((row[5] || '').trim());
                }
            }
        } else {
            // Legacy rows without source token
            source = 'ekf';
            x = parseFloat((row[1] || '').trim());
            y = parseFloat((row[2] || '').trim());
            if (row.length >= 6) {
                theta = parseFloat((row[3] || '').trim());
                vx = parseFloat((row[4] || '').trim());
                vy = parseFloat((row[5] || '').trim());
            } else if (row.length >= 5) {
                vx = parseFloat((row[3] || '').trim());
                vy = parseFloat((row[4] || '').trim());
            }
        }

        if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;

        return {
            t,
            source,
            rowCols: row.length,
            x,
            y,
            theta: isFiniteNumber(theta) ? theta : 0,
            vx: isFiniteNumber(vx) ? vx : 0,
            vy: isFiniteNumber(vy) ? vy : 0,
        };
    }

    function parsePositionRows(headers, rows, opts = {}) {
        const onlyEkf = !!opts.onlyEkf;
        const pts = [];

        (rows || []).forEach(r => {
            const p = parsePositionRow(headers, r);
            if (!p) return;
            if (onlyEkf && !isEKFSource(p.source)) return;
            pts.push(p);
        });

        pts.sort((a, b) => a.t - b.t);
        return pts;
    }

    // Some sessions log a long EKF placeholder at origin before actual map lock.
    // Trim only when there is a sufficiently long leading near-origin streak and later points move away.
    function trimLeadingOriginRows(points, opts = {}) {
        if (!Array.isArray(points) || points.length < 3) return points || [];

        const minLeadingRows = Number.isFinite(opts.minLeadingRows) ? opts.minLeadingRows : 8;
        const nearOriginPosEps = Number.isFinite(opts.nearOriginPosEps) ? opts.nearOriginPosEps : 0.02;
        const nearOriginVelEps = Number.isFinite(opts.nearOriginVelEps) ? opts.nearOriginVelEps : 0.02;
        const unlockRadius = Number.isFinite(opts.unlockRadius) ? opts.unlockRadius : 0.25;
        const longOriginRows = Number.isFinite(opts.longOriginRows) ? opts.longOriginRows : 100;
        const postOriginRadiusFactor = Number.isFinite(opts.postOriginRadiusFactor) ? opts.postOriginRadiusFactor : 0.15;
        const postOriginMinRadius = Number.isFinite(opts.postOriginMinRadius) ? opts.postOriginMinRadius : 0.05;

        let cut = 0;
        while (cut < points.length) {
            const p = points[cut];
            const posNorm = Math.hypot(p.x || 0, p.y || 0);
            const velNorm = Math.hypot(p.vx || 0, p.vy || 0);
            if (posNorm <= nearOriginPosEps && velNorm <= nearOriginVelEps) cut += 1;
            else break;
        }

        if (cut < minLeadingRows || cut >= points.length - 1) return points;

        const hasFarPoint = points.slice(cut).some((p) => Math.hypot(p.x || 0, p.y || 0) >= unlockRadius);
        if (!hasFarPoint) return points;

        let trimmed = points.slice(cut);

        // If origin streak is very long, skip the low-radius startup ramp as well.
        if (cut >= longOriginRows && trimmed.length > 2) {
            const maxRadius = trimmed.reduce((m, p) => Math.max(m, Math.hypot(p.x || 0, p.y || 0)), 0);
            const startupRadius = Math.max(postOriginMinRadius, maxRadius * postOriginRadiusFactor);

            let rampCut = 0;
            while (rampCut < trimmed.length) {
                const p = trimmed[rampCut];
                const r = Math.hypot(p.x || 0, p.y || 0);
                if (r < startupRadius) rampCut += 1;
                else break;
            }

            if (rampCut > 0 && rampCut < trimmed.length - 1) {
                trimmed = trimmed.slice(rampCut);
            }
        }

        return trimmed;
    }

    function getConfiguredSpeedProfile() {
        const aEl = document.getElementById('approach-vel');
        const tEl = document.getElementById('transport-vel');
        const a = parseFloat(aEl ? aEl.value : '');
        const t = parseFloat(tEl ? tEl.value : '');

        const candidates = [a, t].filter((v) => Number.isFinite(v) && v > 0);
        const nominal = candidates.length > 0 ? Math.max(...candidates) : 0.2;

        return {
            nominal,
            movingThreshold: Math.max(0.01, nominal * 0.08),
            maxReasonable: Math.max(0.3, nominal * 2.0),
            peakCap: Math.max(0.25, nominal * 1.4),
        };
    }

    function analyzePositionRows(headers, rows) {
        const sourceCounts = {};
        const schemaCounts = {};
        let totalRows = 0;
        let parsedRows = 0;
        let ekfRows = 0;
        let nonEkfRows = 0;
        let nonZeroRows = 0;
        let nonZeroEkfRows = 0;

        (rows || []).forEach(r => {
            totalRows += 1;
            const cols = Array.isArray(r) ? r.length : 0;
            schemaCounts[cols] = (schemaCounts[cols] || 0) + 1;

            const p = parsePositionRow(headers, r);
            if (!p) return;
            parsedRows += 1;

            const src = p.source || 'unknown';
            sourceCounts[src] = (sourceCounts[src] || 0) + 1;

            const moved = Math.abs(p.x) + Math.abs(p.y) > 1e-9;
            if (moved) nonZeroRows += 1;

            if (isEKFSource(src)) {
                ekfRows += 1;
                if (moved) nonZeroEkfRows += 1;
            } else {
                nonEkfRows += 1;
            }
        });

        const rawEkfPoints = parsePositionRows(headers, rows, { onlyEkf: true });
        const trimmedEkfPoints = trimLeadingOriginRows(rawEkfPoints);
        const startupTrimmedRows = Math.max(0, rawEkfPoints.length - trimmedEkfPoints.length);

        return {
            totalRows,
            parsedRows,
            droppedRows: Math.max(0, totalRows - parsedRows),
            sourceCounts,
            schemaCounts,
            ekfRows,
            ekfRowsAfterTrim: trimmedEkfPoints.length,
            nonEkfRows,
            nonZeroRows,
            nonZeroEkfRows,
            startupTrimmedRows,
            replayReady: trimmedEkfPoints.length >= 2,
        };
    }

    function renderBadgeMap(obj) {
        const escapeHtml = (s) => String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        const entries = Object.entries(obj || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        if (entries.length === 0) return '<span class="text-muted">none</span>';
        return entries
            .map(([k, v]) => `<span class="compare-badge" style="margin-right:4px;margin-bottom:4px;display:inline-flex">${escapeHtml(k)}: ${v}</span>`)
            .join('');
    }

    function renderLogInsights(stats) {
        const box = document.getElementById('log-data-insights');
        if (!box) return;

        if (!stats) {
            box.innerHTML = '';
            return;
        }

        const replayText = stats.replayReady ? 'ready' : 'insufficient EKF rows';
        const motionText = stats.nonZeroEkfRows > 0 ? `${stats.nonZeroEkfRows} moving EKF rows` : 'EKF rows mostly zero';
        const trimText = stats.startupTrimmedRows > 0 ? ` | startup rows trimmed: ${stats.startupTrimmedRows}` : '';

        box.innerHTML = `
            <div class="text-muted" style="font-size:11px;margin-top:8px">Log Insights</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px;margin-top:4px">
                <div>Total rows: <strong>${stats.totalRows}</strong></div>
                <div>Parsed rows: <strong>${stats.parsedRows}</strong></div>
                <div>EKF rows: <strong>${stats.ekfRows}</strong></div>
                <div>Non-EKF rows: <strong>${stats.nonEkfRows}</strong></div>
                <div>EKF after trim: <strong>${stats.ekfRowsAfterTrim}</strong></div>
                <div>Dropped rows: <strong>${stats.droppedRows}</strong></div>
                <div>Replay status: <strong>${replayText}</strong></div>
            </div>
            <div class="text-muted" style="font-size:11px;margin-top:6px">${motionText}${trimText}</div>
            <div style="margin-top:6px">
                <div class="text-muted" style="font-size:11px;margin-bottom:2px">Sources</div>
                <div>${renderBadgeMap(stats.sourceCounts)}</div>
            </div>
            <div style="margin-top:6px">
                <div class="text-muted" style="font-size:11px;margin-bottom:2px">Row Column Counts</div>
                <div>${renderBadgeMap(stats.schemaCounts)}</div>
            </div>
        `;
    }

    function smoothTrajectory(points, windowSize = 5) {
        if (!points || points.length < 3 || windowSize <= 1) {
            return points ? points.slice() : [];
        }

        const half = Math.floor(windowSize / 2);
        return points.map((p, idx) => {
            let sx = 0;
            let sy = 0;
            let n = 0;
            const start = Math.max(0, idx - half);
            const end = Math.min(points.length - 1, idx + half);
            for (let i = start; i <= end; i++) {
                sx += points[i].x;
                sy += points[i].y;
                n += 1;
            }
            return { ...p, x: sx / n, y: sy / n };
        });
    }

    function quantile(values, q) {
        if (!Array.isArray(values) || values.length === 0) return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        const clampedQ = Math.max(0, Math.min(1, q));
        const idx = Math.floor(clampedQ * (sorted.length - 1));
        return sorted[idx];
    }

    function computeRobustPathStats(points, opts = {}) {
        if (!points || points.length < 2) return null;

        const minStepMeters = Number.isFinite(opts.minStepMeters) ? opts.minStepMeters : 0.01;
        const maxReasonableSpeed = Number.isFinite(opts.maxReasonableSpeed) ? opts.maxReasonableSpeed : 2.0;
        const smoothWindow = Number.isFinite(opts.smoothWindow) ? opts.smoothWindow : 5;
        const movingSpeedThreshold = Number.isFinite(opts.movingSpeedThreshold) ? opts.movingSpeedThreshold : 0.02;
        const speedOutlierFactor = Number.isFinite(opts.speedOutlierFactor) ? opts.speedOutlierFactor : 1.35;
        const speedPercentile = Number.isFinite(opts.speedPercentile) ? opts.speedPercentile : 0.99;
        const peakSpeedCap = Number.isFinite(opts.peakSpeedCap) ? opts.peakSpeedCap : (maxReasonableSpeed * speedOutlierFactor);

        const smoothed = smoothTrajectory(points, smoothWindow);
        const filtered = [smoothed[0]];
        let totalDist = 0;
        let speedIntegral = 0;
        let speedDuration = 0;
        const speedSamples = [];

        for (let i = 1; i < smoothed.length; i++) {
            const prev = smoothed[i - 1];
            const curr = smoothed[i];
            const dt = curr.t - prev.t;
            if (dt <= 0) continue;

            const dx = curr.x - prev.x;
            const dy = curr.y - prev.y;
            const d = Math.hypot(dx, dy);
            const speedPos = d / dt;

            const hasPrevVel = Number.isFinite(prev.vx) && Number.isFinite(prev.vy);
            const hasCurrVel = Number.isFinite(curr.vx) && Number.isFinite(curr.vy);
            let speedVel = NaN;
            if (hasPrevVel && hasCurrVel) {
                speedVel = 0.5 * (Math.hypot(prev.vx, prev.vy) + Math.hypot(curr.vx, curr.vy));
            } else if (hasCurrVel) {
                speedVel = Math.hypot(curr.vx, curr.vy);
            } else if (hasPrevVel) {
                speedVel = Math.hypot(prev.vx, prev.vy);
            }

            let speedUsed = Number.isFinite(speedVel) ? speedVel : speedPos;
            // If EKF velocity is near zero but geometry shows movement, fallback to positional speed.
            if (Number.isFinite(speedVel) && speedVel < movingSpeedThreshold * 0.5 && speedPos > movingSpeedThreshold * 2) {
                speedUsed = speedPos;
            }

            if (d >= minStepMeters && speedPos <= maxReasonableSpeed) {
                totalDist += d;
                filtered.push(curr);
            }

            if (!Number.isFinite(speedUsed)) continue;
            const speedCap = maxReasonableSpeed * speedOutlierFactor;
            if (speedUsed > speedCap || speedUsed > peakSpeedCap) continue;

            const speedForMotion = Number.isFinite(speedVel) ? speedUsed : speedPos;
            const moving = speedForMotion >= movingSpeedThreshold;
            if (!moving) continue;

            speedSamples.push(speedUsed);
            speedIntegral += speedUsed * dt;
            speedDuration += dt;
        }

        if (filtered.length < 2) {
            const first = smoothed[0];
            const last = smoothed[smoothed.length - 1];
            const d = Math.hypot(last.x - first.x, last.y - first.y);
            const dt = Math.max(0, last.t - first.t);
            const fallbackSpeeds = smoothed
                .map((p) => Number.isFinite(p.vx) && Number.isFinite(p.vy) ? Math.hypot(p.vx, p.vy) : NaN)
                .filter((v) => Number.isFinite(v));
            const fallbackMaxRaw = fallbackSpeeds.length > 0 ? quantile(fallbackSpeeds, speedPercentile) : (dt > 0 ? d / dt : 0);
            const fallbackMax = Math.min(fallbackMaxRaw, peakSpeedCap);
            return {
                totalDist: d,
                avgSpeed: dt > 0 ? d / dt : 0,
                maxSpeed: fallbackMax,
                duration: dt,
                efficiency: d > 0 ? 100 : 0,
                series: [first, last],
            };
        }

        const first = filtered[0];
        const last = filtered[filtered.length - 1];
        const duration = Math.max(0, last.t - first.t);
        const straightDist = Math.hypot(last.x - first.x, last.y - first.y);
        const avgSpeed = speedDuration > 0 ? speedIntegral / speedDuration : (duration > 0 ? totalDist / duration : 0);
        const maxSpeedRaw = speedSamples.length > 0 ? quantile(speedSamples, speedPercentile) : 0;
        const maxSpeed = Math.min(maxSpeedRaw, peakSpeedCap);
        const efficiency = totalDist > 0 ? Math.max(0, Math.min(100, (straightDist / totalDist) * 100)) : 0;

        return {
            totalDist,
            avgSpeed,
            maxSpeed,
            duration,
            efficiency,
            series: filtered,
        };
    }

    // ============================================================
    // Replay System
    // ============================================================
    function prepareReplay(headers, rows) {
        // Parse EKF rows then trim leading origin placeholders if present.
        const rawEkfPts = parsePositionRows(headers, rows, { onlyEkf: true });
        const ekfPts = trimLeadingOriginRows(rawEkfPts);
        replayData = ekfPts.map(p => ({ t: p.t, x: p.x, y: p.y, theta: p.theta }));

        if (replayData.length === 0) {
            replayTrail = [];
            replayIndex = 0;
            replayPlaying = false;
            document.getElementById('replay-controls').style.display = 'none';
            const canvas = document.getElementById('replay-canvas');
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            document.getElementById('log-file-info').textContent += ' (No EKF position data for replay)';
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

    function resetMetricsUI() {
        document.getElementById('metric-distance').textContent = '--';
        document.getElementById('metric-avg-speed').textContent = '--';
        document.getElementById('metric-max-speed').textContent = '--';
        document.getElementById('metric-duration').textContent = '--';
        document.getElementById('metric-efficiency').textContent = '--';
        document.getElementById('metric-points').textContent = '--';
    }

    // ============================================================
    // BNO055 Log → IMU Chart
    // ============================================================
    function loadBNO055ToChart(headers, rows) {
        let iTime = headers.indexOf('time');
        let iHeading = headers.indexOf('heading');
        let iRoll = headers.indexOf('roll');
        let iPitch = headers.indexOf('pitch');
        if (iTime < 0) iTime = 0;
        if (iHeading < 0) iHeading = 1;
        if (iRoll < 0) iRoll = 2;
        if (iPitch < 0) iPitch = 3;

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
        const rawPts = parsePositionRows(headers, rows, { onlyEkf: true });
        const pts = trimLeadingOriginRows(rawPts);
        const speedProfile = getConfiguredSpeedProfile();

        if (pts.length < 2) {
            resetMetricsUI();
            clearPositionChart();
            clearVelocityChart();
            return null;
        }

        // Robust metrics: smooth trajectory, suppress jitter and implausible jumps.
        const stats = computeRobustPathStats(pts, {
            smoothWindow: 5,
            minStepMeters: 0.01,
            movingSpeedThreshold: speedProfile.movingThreshold,
            maxReasonableSpeed: speedProfile.maxReasonable,
            peakSpeedCap: speedProfile.peakCap,
            speedOutlierFactor: 1.25,
            speedPercentile: 0.98,
        });
        if (!stats) return null;

        const metrics = {
            totalDist: stats.totalDist.toFixed(3),
            avgSpeed: stats.avgSpeed.toFixed(4),
            maxSpeed: stats.maxSpeed.toFixed(4),
            duration: stats.duration.toFixed(1),
            efficiency: stats.efficiency.toFixed(1),
            points: stats.series.length
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
        const chartPts = stats.series;
        const step = Math.max(1, Math.floor(chartPts.length / 500));
        for (let i = 0; i < chartPts.length; i += step) {
            const p = chartPts[i];
            rtPosition.labels.push((p.t - chartPts[0].t).toFixed(1));
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
        for (let i = 0; i < chartPts.length; i += step) {
            const p = chartPts[i];
            const prev = i > 0 ? chartPts[i - 1] : chartPts[i];
            const dt = Math.max(1e-6, p.t - prev.t);
            const vxPos = i > 0 ? (p.x - prev.x) / dt : 0;
            const vyPos = i > 0 ? (p.y - prev.y) / dt : 0;
            let vx = Number.isFinite(p.vx) ? p.vx : vxPos;
            let vy = Number.isFinite(p.vy) ? p.vy : vyPos;
            // Fallback when logged velocity is zero but geometric movement is evident.
            if ((Math.abs(vx) + Math.abs(vy) < 1e-6) && Math.hypot(vxPos, vyPos) > 0.05) {
                vx = vxPos;
                vy = vyPos;
            }
            rtVelocity.labels.push((p.t - chartPts[0].t).toFixed(1));
            rtVelocity.vx.push(vx);
            rtVelocity.vy.push(vy);
            rtVelocity.speed.push(Math.sqrt(vx * vx + vy * vy));
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
        const sid = sel.value;
        if (!sid) return;
        if (compSessions.find(s => s.sid === sid)) return; // Already added

        // Load session into cache if not already loaded
        if (!sessionCache[sid]) {
            const sg = sessionGroups[sid];
            if (!sg || !sg.files.position) return;
            const posData = await fetchCSV(sg.files.position);
            if (!posData) return;
            const cache = { sid, posHeaders: posData.headers, posRows: posData.rows };
            if (sg.files.imu) {
                const imuData = await fetchCSV(sg.files.imu);
                if (imuData) { cache.imuHeaders = imuData.headers;
                    cache.imuRows = imuData.rows; }
            }
            sessionCache[sid] = cache;
        }

        const cache = sessionCache[sid];
        if (!cache.posHeaders) return;

        const data = parsePositionRows(cache.posHeaders, cache.posRows, { onlyEkf: true })
            .map(p => ({ t: p.t, x: p.x, y: p.y, vx: p.vx, vy: p.vy }));

        const trimmedData = trimLeadingOriginRows(data);
        const compData = trimmedData.map(p => ({ t: p.t, x: p.x, y: p.y, vx: p.vx, vy: p.vy }));

        if (compData.length === 0) return;

        const color = COMP_COLORS[compSessions.length % COMP_COLORS.length];
        const metrics = computeSessionMetrics(compData);
        const sg = sessionGroups[sid];
        compSessions.push({ sid, filename: (sg && sg.files.position) || sid, color, data: compData, metrics });
        renderComparisonUI();
        drawReplayFrame();
    }

    function computeSessionMetrics(data) {
        const speedProfile = getConfiguredSpeedProfile();
        const stats = computeRobustPathStats(data, {
            smoothWindow: 5,
            minStepMeters: 0.01,
            movingSpeedThreshold: speedProfile.movingThreshold,
            maxReasonableSpeed: speedProfile.maxReasonable,
            peakSpeedCap: speedProfile.peakCap,
            speedOutlierFactor: 1.25,
            speedPercentile: 0.98,
        });
        if (!stats) {
            return {
                totalDist: '0.000',
                avgSpeed: '0.0000',
                duration: '0.0',
                efficiency: '0.0',
                points: data.length,
            };
        }
        return {
            totalDist: stats.totalDist.toFixed(3),
            avgSpeed: stats.avgSpeed.toFixed(4),
            duration: stats.duration.toFixed(1),
            efficiency: stats.efficiency.toFixed(1),
            points: stats.series.length
        };
    }

    function renderComparisonUI() {
        const list = document.getElementById('comparison-list');
        const table = document.getElementById('comparison-table');

        // Badges
        list.innerHTML = compSessions.map((s, i) => `
            <span class="compare-badge">
                <span class="compare-dot" style="background:${s.color}"></span>
                ${formatSid(s.sid)}
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
            const label = formatSid(s.sid);
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
        switchSession,
        renderLoadedSessionsUI,
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