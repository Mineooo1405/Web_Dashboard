// ============================================================
// Arm Simulator — IK/FK visualizer
// Mirrors workspace_visualizer.py in the browser canvas.
// ============================================================
const ArmViz = (() => {
    let cfg        = null;   // robot config from /api/arm/config
    let canvas     = null;
    let ctx        = null;
    let lastResult = null;
    let resizeObs  = null;

    // R-Z coordinate bounds (set once config is loaded)
    let rMin = -100, rMax = 530, zMin = -160, zMax = 530;

    // ────────────────────────────────────────────────────────
    // Bootstrap
    // ────────────────────────────────────────────────────────
    async function init() {
        canvas = document.getElementById('arm-canvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');

        // Fetch robot config
        try {
            const resp = await fetch('/api/arm/config');
            cfg = await resp.json();
            const maxExtent = cfg.a2 + cfg.a3 + cfg.d5 + 50;
            rMin = -100; rMax = maxExtent;
            zMin = -160; zMax = maxExtent;
        } catch (e) {
            console.error('ArmViz: failed to load config', e);
        }

        // ResizeObserver: entry.contentRect is always correct — no clientWidth race.
        resizeObs = new ResizeObserver(entries => {
            const w = Math.round(entries[0].contentRect.width);
            const h = Math.round(entries[0].contentRect.height);
            if (w < 10 || h < 10) return;
            canvas.width  = w;
            canvas.height = h;
            redraw();
        });
        resizeObs.observe(canvas);

        // If the tab was already visible when init() ran (e.g. first open),
        // the observer may fire with w=0. Force a draw after next paint.
        requestAnimationFrame(() => {
            const w = canvas.clientWidth, h = canvas.clientHeight;
            if (w >= 10 && h >= 10) { canvas.width = w; canvas.height = h; redraw(); }
        });
    }

    // Called by app.js when the Arm tab is clicked
    function onTabActivated() {
        if (!cfg) { init(); return; }   // init sets up the observer which fires on its own
        // Defer to rAF: the tab's display:block hasn't been painted yet when
        // this function is called synchronously inside the click handler.
        requestAnimationFrame(() => {
            const w = canvas.clientWidth, h = canvas.clientHeight;
            if (w >= 10 && h >= 10) { canvas.width = w; canvas.height = h; redraw(); }
        });
    }

    // ────────────────────────────────────────────────────────
    // Canvas coordinate helpers
    // ────────────────────────────────────────────────────────
    const PAD = 40;
    const drawW = () => canvas.width  - 2 * PAD;
    const drawH = () => canvas.height - 2 * PAD;

    const tx = r => PAD + (r - rMin) / (rMax - rMin) * drawW();
    const ty = z => canvas.height - PAD - (z - zMin) / (zMax - zMin) * drawH();

    function cssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    // ────────────────────────────────────────────────────────
    // Drawing primitives
    // ────────────────────────────────────────────────────────
    function clearCanvas() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = cssVar('--map-bg') || '#0e1117';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    function drawGrid() {
        const range = Math.max(rMax - rMin, zMax - zMin);
        const step  = range > 500 ? 100 : range > 200 ? 50 : 25;
        ctx.strokeStyle = cssVar('--map-grid') || '#1a1e2e';
        ctx.lineWidth   = 0.5;

        for (let r = Math.ceil(rMin / step) * step; r <= rMax; r += step) {
            ctx.beginPath(); ctx.moveTo(tx(r), ty(zMin)); ctx.lineTo(tx(r), ty(zMax)); ctx.stroke();
        }
        for (let z = Math.ceil(zMin / step) * step; z <= zMax; z += step) {
            ctx.beginPath(); ctx.moveTo(tx(rMin), ty(z)); ctx.lineTo(tx(rMax), ty(z)); ctx.stroke();
        }
    }

    function drawWorkspaceArcs() {
        if (!cfg) return;
        const arcParams = [
            { radius: cfg.max_reach, color: '#da3333', dash: [6, 3] },
            { radius: cfg.min_reach, color: '#f87c00', dash: [4, 2] },
        ];
        arcParams.forEach(({ radius, color, dash }) => {
            if (radius <= 0) return;
            ctx.beginPath(); ctx.setLineDash(dash);
            ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.45;
            let first = true;
            for (let theta = -Math.PI / 2; theta <= Math.PI + 0.02; theta += 0.025) {
                const r = 0 + radius * Math.cos(theta);
                const z = cfg.d1 + radius * Math.sin(theta);
                if (first) { ctx.moveTo(tx(r), ty(z)); first = false; }
                else ctx.lineTo(tx(r), ty(z));
            }
            ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        });
    }

    function drawGroundAndBase() {
        if (!cfg) return;
        // Ground Z=0
        ctx.strokeStyle = '#7a5230'; ctx.lineWidth = 2; ctx.globalAlpha = 0.8;
        ctx.beginPath(); ctx.moveTo(tx(rMin), ty(0)); ctx.lineTo(tx(rMax), ty(0)); ctx.stroke();
        ctx.globalAlpha = 1;
        // Base column
        ctx.strokeStyle = '#555'; ctx.lineWidth = 7; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(tx(0), ty(0)); ctx.lineTo(tx(0), ty(cfg.d1)); ctx.stroke();
        ctx.lineCap = 'butt';
    }

    function drawArm(pts, color, dash, lineW, dotR) {
        if (!pts || pts.length < 2) return;
        ctx.strokeStyle = color; ctx.lineWidth = lineW;
        ctx.setLineDash(dash || []);
        ctx.beginPath();
        pts.forEach((p, i) => {
            if (i === 0) ctx.moveTo(tx(p[0]), ty(p[1]));
            else         ctx.lineTo(tx(p[0]), ty(p[1]));
        });
        ctx.stroke(); ctx.setLineDash([]);
        if (dotR > 0) {
            pts.forEach(p => {
                ctx.fillStyle = color;
                ctx.beginPath(); ctx.arc(tx(p[0]), ty(p[1]), dotR, 0, Math.PI * 2); ctx.fill();
            });
        }
    }

    function drawStar(cx_, cy_, r, color) {
        ctx.fillStyle = color;
        ctx.save(); ctx.translate(cx_, cy_); ctx.beginPath();
        for (let i = 0; i < 5; i++) {
            const a1 = (i * 4 * Math.PI / 5) - Math.PI / 2;
            const a2 = a1 + (2 * Math.PI / 5);
            if (i === 0) ctx.moveTo(r * Math.cos(a1), r * Math.sin(a1));
            else         ctx.lineTo(r * Math.cos(a1), r * Math.sin(a1));
            ctx.lineTo((r * 0.4) * Math.cos(a2), (r * 0.4) * Math.sin(a2));
        }
        ctx.closePath(); ctx.fill(); ctx.restore();
    }

    function drawPoint(r, z, color, dotR) {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(tx(r), ty(z), dotR, 0, Math.PI * 2); ctx.fill();
    }

    function drawAxisLabels() {
        ctx.fillStyle = cssVar('--text-3') || '#5c5e6a';
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('R (mm)', canvas.width / 2, canvas.height - 4);
        ctx.save();
        ctx.translate(12, canvas.height / 2); ctx.rotate(-Math.PI / 2);
        ctx.fillText('Z (mm)', 0, 0); ctx.restore();

        // Tick marks
        const step = (rMax - rMin) > 500 ? 100 : 50;
        for (let v = Math.ceil(rMin / step) * step; v <= rMax; v += step) {
            ctx.textAlign = 'center';
            ctx.fillText(v, tx(v), canvas.height - PAD + 13);
        }
        for (let v = Math.ceil(zMin / step) * step; v <= zMax; v += step) {
            ctx.textAlign = 'right';
            ctx.fillText(v, PAD - 4, ty(v) + 3);
        }
    }

    function drawLegend(items) {
        const x0 = canvas.width - PAD;
        let   y0 = PAD + 8;
        items.forEach(({ color, dash, label }) => {
            ctx.strokeStyle = color; ctx.lineWidth = 1.5;
            ctx.setLineDash(dash || []); ctx.globalAlpha = 0.75;
            ctx.beginPath(); ctx.moveTo(x0 - 85, y0); ctx.lineTo(x0 - 58, y0); ctx.stroke();
            ctx.setLineDash([]); ctx.globalAlpha = 1;
            ctx.fillStyle = color; ctx.font = '9px Inter, sans-serif';
            ctx.textAlign = 'left'; ctx.fillText(label, x0 - 54, y0 + 3);
            y0 += 16;
        });
    }

    // ────────────────────────────────────────────────────────
    // High-level draw routines
    // ────────────────────────────────────────────────────────
    function drawEmpty() {
        if (!ctx) return;
        clearCanvas(); drawGrid(); drawWorkspaceArcs(); drawGroundAndBase(); drawAxisLabels();
        drawLegend([
            { color: '#da3333', dash: [6, 3], label: cfg ? `Max ${cfg.max_reach.toFixed(0)}mm` : 'Max reach' },
            { color: '#f87c00', dash: [4, 2], label: cfg ? `Min ${cfg.min_reach.toFixed(0)}mm` : 'Min reach' },
        ]);
        ctx.fillStyle = cssVar('--text-3') || '#5c5e6a';
        ctx.font = '12px Inter, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Enter values and click Solve IK or Solve FK', canvas.width / 2, canvas.height / 2);
    }

    function drawResult(result) {
        if (!ctx || !cfg) return;
        clearCanvas(); drawGrid(); drawWorkspaceArcs(); drawGroundAndBase();

        // Gravity arm (blue dashed, drawn first — behind)
        drawArm(result.points_rz_gravity, 'rgba(96,165,250,0.6)', [7, 3], 2, 0);
        // Main arm (green solid)
        drawArm(result.points_rz, '#22c55e', [], 3, 5);

        // Wrist
        if (result.wrist_rz) drawPoint(result.wrist_rz[0], result.wrist_rz[1], '#c084fc', 8);

        // IK → red star at target
        if (result.mode === 'IK' && result.target_rz)
            drawStar(tx(result.target_rz[0]), ty(result.target_rz[1]), 13, '#ef4444');

        // FK → red star at TCP
        if (result.mode === 'FK' && result.tcp_xyz)
            drawStar(tx(result.tcp_xyz.r), ty(result.tcp_xyz.z), 13, '#ef4444');

        drawAxisLabels();
        drawLegend([
            { color: '#da3333', dash: [6, 3], label: `Max ${cfg.max_reach.toFixed(0)}mm` },
            { color: '#f87c00', dash: [4, 2], label: `Min ${cfg.min_reach.toFixed(0)}mm` },
            { color: '#22c55e', dash: [],     label: 'Arm (IK/FK)' },
            { color: 'rgba(96,165,250,0.75)', dash: [4, 2], label: '+Gravity comp' },
            { color: '#c084fc', dash: [],     label: 'Wrist' },
            { color: '#ef4444', dash: [],     label: 'Target / TCP' },
        ]);
    }

    function redraw() {
        if (lastResult) drawResult(lastResult);
        else drawEmpty();
    }

    // ────────────────────────────────────────────────────────
    // Result panel
    // ────────────────────────────────────────────────────────
    function setStatus(msg, ok = null) {
        const el = document.getElementById('arm-sim-status');
        if (!el) return;
        el.textContent = msg;
        el.style.color = ok === true ? '#22c55e' : ok === false ? '#ef4444' : '';
    }

    function renderResult(result) {
        const resEl  = document.getElementById('arm-sim-result');
        const inclEl = document.getElementById('arm-incl-text');
        if (!resEl) return;

        const fmt = v => parseFloat(v).toFixed(1);

        if (!result.success) {
            resEl.innerHTML  = `<span style="color:#ef4444">⚠ ${result.fail_reason}</span>`;
            if (inclEl) inclEl.innerHTML = '';
            return;
        }

        const j = result.joints, g = result.gravity_comp;

        if (result.mode === 'IK') {
            const i = result.input, fk = result.tcp_xyz;
            resEl.innerHTML = [
                `<b>INPUT</b>   X=${fmt(i.x)}  Y=${fmt(i.y)}  Z=${fmt(i.z)}  Phi=${fmt(i.phi)}°  R=${fmt(i.r)} mm`,
                `<b>XAVIER</b>  J0=${fmt(j.j0)}°  J1=${fmt(j.j1)}°  J2=${fmt(j.j2)}°  J3=${fmt(j.j3)}°`,
                `<b>+GravComp</b>       J1=${fmt(g.j1)}°  J2=${fmt(g.j2)}°  J3=${fmt(g.j3)}°`,
                `<b>Wrist</b>   R=${fmt(result.wrist_rz[0])}  Z=${fmt(result.wrist_rz[1])} mm`,
                `<b>FK check</b>  X=${fmt(fk.x)}  Y=${fmt(fk.y)}  Z=${fmt(fk.z)}  Phi=${fmt(fk.phi)}°`,
            ].join('<br>');
        } else {
            const fk = result.tcp_xyz, fkg = result.tcp_xyz_gravity;
            resEl.innerHTML = [
                `<b>INPUT</b>  J0=${fmt(j.j0)}°  J1=${fmt(j.j1)}°  J2=${fmt(j.j2)}°  J3=${fmt(j.j3)}°`,
                `<b>+GravComp</b>       J1=${fmt(g.j1)}°  J2=${fmt(g.j2)}°  J3=${fmt(g.j3)}°`,
                `<b>TCP (Xavier)</b>   X=${fmt(fk.x)}  Y=${fmt(fk.y)}  Z=${fmt(fk.z)}  R=${fmt(fk.r)}  Phi=${fmt(fk.phi)}°`,
                `<b>TCP (+Gravity)</b> X=${fmt(fkg.x)}  Y=${fmt(fkg.y)}  Z=${fmt(fkg.z)}`,
            ].join('<br>');
        }

        if (inclEl && result.inclinometer) {
            const ix = result.inclinometer.xavier, ig = result.inclinometer.gravity;
            const fmtI = v => parseFloat(v).toFixed(1).padStart(6);
            inclEl.innerHTML = [
                `<b>INCLINOMETER</b>  (0=horiz  +90=up  −90=down)`,
                `<span style="color:#8b8d98">         Xavier   +Gravity</span>`,
                `Link 1   ${fmtI(ix.link1)}°  ${fmtI(ig.link1)}°`,
                `Link 2   ${fmtI(ix.link2)}°  ${fmtI(ig.link2)}°`,
                `Link 3   ${fmtI(ix.link3)}°  ${fmtI(ig.link3)}°`,
            ].join('<br>');
        }
    }

    // ────────────────────────────────────────────────────────
    // Public: Solve IK
    // ────────────────────────────────────────────────────────
    async function solveIK() {
        const x   = parseFloat(document.getElementById('arm-sim-x')?.value)   || 0;
        const y   = parseFloat(document.getElementById('arm-sim-y')?.value)   || 0;
        const z   = parseFloat(document.getElementById('arm-sim-z')?.value)   || 0;
        const phi = parseFloat(document.getElementById('arm-sim-phi')?.value ?? '-90');

        setStatus('Solving IK…');
        try {
            const resp = await fetch('/api/arm/ik', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x, y, z, phi }),
            });
            const result = await resp.json();
            lastResult = result;
            drawResult(result);
            renderResult(result);
            setStatus(result.success ? '✓ IK solved' : '⚠ ' + result.fail_reason, result.success);
        } catch (e) { setStatus('Error: ' + e.message, false); }
    }

    // ────────────────────────────────────────────────────────
    // Public: Solve FK
    // ────────────────────────────────────────────────────────
    async function solveFK() {
        const j0 = parseFloat(document.getElementById('arm-sim-j0')?.value ?? '90');
        const j1 = parseFloat(document.getElementById('arm-sim-j1')?.value ?? '90');
        const j2 = parseFloat(document.getElementById('arm-sim-j2')?.value ?? '90');
        const j3 = parseFloat(document.getElementById('arm-sim-j3')?.value ?? '90');

        setStatus('Solving FK…');
        try {
            const resp = await fetch('/api/arm/fk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ j0, j1, j2, j3 }),
            });
            const result = await resp.json();
            lastResult = result;
            drawResult(result);
            renderResult(result);
            setStatus('✓ FK solved', true);
        } catch (e) { setStatus('Error: ' + e.message, false); }
    }

    // ────────────────────────────────────────────────────────
    // Public: Presets (FK-based, identical to workspace_visualizer.py)
    // ────────────────────────────────────────────────────────
    const PRESETS = {
        home:    [90,  90,  90,  90],
        forward: [90,  45,  90, 135],
        up:      [90,   0,  90, 180],
        down:    [90, 120,  60,  60],
        stretch: [90,  90,   0,  90],
    };

    function setPreset(name) {
        const vals = PRESETS[name];
        if (!vals) return;
        ['j0', 'j1', 'j2', 'j3'].forEach((id, i) => {
            const el = document.getElementById('arm-sim-' + id);
            if (el) el.value = vals[i];
        });
        // Also fill FK inputs
        setMode('fk');
        solveFK();
    }

    // ────────────────────────────────────────────────────────
    // Mode toggle (shows/hides IK vs FK input rows)
    // ────────────────────────────────────────────────────────
    function setMode(mode) {
        const ikRow = document.getElementById('arm-sim-ik-row');
        const fkRow = document.getElementById('arm-sim-fk-row');
        const btnIK = document.getElementById('arm-sim-btn-ik');
        const btnFK = document.getElementById('arm-sim-btn-fk');
        if (!ikRow || !fkRow) return;
        if (mode === 'ik') {
            ikRow.style.display = ''; fkRow.style.display = 'none';
            btnIK?.classList.add('active'); btnFK?.classList.remove('active');
        } else {
            ikRow.style.display = 'none'; fkRow.style.display = '';
            btnFK?.classList.add('active'); btnIK?.classList.remove('active');
        }
    }

    return { init, onTabActivated, solveIK, solveFK, setPreset, setMode };
})();
