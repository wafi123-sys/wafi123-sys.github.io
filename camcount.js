// =====================================================================
// GudangPro - Camera Counter (AI)
// Counts bags carried by workers (1 bag per trip on the shoulder) using the
// phone camera. Pipeline:
//   1. COCO-SSD (TensorFlow.js, runs 100% offline on the device) detects people.
//   2. A multi-object tracker gives every worker a stable ID across frames,
//      so several workers walking at the same time are counted separately.
//   3. A virtual line with a direction arrow is drawn on the picture. A worker
//      is counted once each time he crosses the line in the ARROW direction
//      (walking with a bag). Walking back empty (opposite direction) is ignored.
// =====================================================================
(function () {
    const LS_KEY = 'gp_camcount_v1';
    const VENDOR = 'vendor/';
    const MAX_THUMBS = 40;

    const CC = {
        running: false, stream: null, fileUrl: null, model: null, loading: null,
        facing: 'environment', tracks: [], nextId: 1,
        count: 0, events: [], thumbs: [],
        line: { x1: 0.5, y1: 0.08, x2: 0.5, y2: 0.92 }, // normalized 0..1
        flip: false, // false: count when moving to the side the arrow points to
        busy: false, raf: 0, wake: null, drag: null,
        fps: 0, lastDet: 0, people: 0, audio: null
    };
    window.CC = CC;
    CC._updateTracks = (...a) => updateTracks(...a); // exposed for automated tests

    const el = id => document.getElementById(id);

    // ------------------------------------------------------------ persistence
    function save() {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify({
                count: CC.count, line: CC.line, flip: CC.flip, events: CC.events.slice(-500),
                mode: el('cc-mode').value, wh: el('cc-wh').value, item: el('cc-item').value,
                per: el('cc-per').value, sens: el('cc-sens').value, minh: el('cc-minh').value
            }));
        } catch (e) { /* storage full - ignore */ }
    }
    function restore() {
        try {
            const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
            if (!s) return;
            CC.count = s.count || 0; CC.events = s.events || [];
            if (s.line) CC.line = s.line;
            CC.flip = !!s.flip;
            if (s.mode) el('cc-mode').value = s.mode;
            if (s.per) el('cc-per').value = s.per;
            if (s.sens) el('cc-sens').value = s.sens;
            if (s.minh) el('cc-minh').value = s.minh;
            if (s.wh && [...el('cc-wh').options].some(o => o.value === s.wh)) el('cc-wh').value = s.wh;
            if (s.item && [...el('cc-item').options].some(o => o.value === s.item)) el('cc-item').value = s.item;
        } catch (e) { /* corrupted - ignore */ }
    }

    // ------------------------------------------------------------ AI model (lazy)
    function loadScript(src) {
        return new Promise((res, rej) => {
            if (document.querySelector(`script[data-cc="${src}"]`)) return res();
            const s = document.createElement('script');
            s.src = src; s.async = true; s.dataset.cc = src;
            s.onload = () => res(); s.onerror = () => rej(new Error('Failed to load ' + src));
            document.head.appendChild(s);
        });
    }
    async function ensureModel() {
        if (CC.model) return CC.model;
        if (CC.loading) return CC.loading;
        CC.loading = (async () => {
            status('Memuat mesin AI... (pertama kali butuh beberapa detik)');
            try {
                await loadScript(VENDOR + 'tf.min.js');
                await loadScript(VENDOR + 'coco-ssd.min.js');
            } catch (err) {
                await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
                await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
            }
            try { await tf.setBackend('webgl'); } catch (e) { /* fallback below */ }
            if (tf.getBackend() !== 'webgl') { try { await tf.setBackend('cpu'); } catch (e) { } }
            await tf.ready();
            let modelSource = VENDOR + 'coco/model.json';
            if (location.protocol === 'file:' && window.AndroidBridge && typeof window.AndroidBridge.readAssetBase64 === 'function') {
                const mJsonB64 = window.AndroidBridge.readAssetBase64('vendor/coco/model.json');
                if (mJsonB64) {
                    const mJson = JSON.parse(atob(mJsonB64));
                    const weightSpecs = [];
                    const chunks = [];
                    let totalBytes = 0;
                    for (const group of (mJson.weightsManifest || [])) {
                        for (const spec of (group.weights || [])) weightSpecs.push(spec);
                        for (const p of (group.paths || [])) {
                            const b64 = window.AndroidBridge.readAssetBase64('vendor/coco/' + p);
                            const bin = atob(b64);
                            const u8 = new Uint8Array(bin.length);
                            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                            chunks.push(u8);
                            totalBytes += u8.byteLength;
                        }
                    }
                    const merged = new Uint8Array(totalBytes);
                    let off = 0;
                    for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
                    modelSource = {
                        load: async () => ({
                            modelTopology: mJson.modelTopology,
                            format: mJson.format,
                            generatedBy: mJson.generatedBy,
                            convertedBy: mJson.convertedBy,
                            signature: mJson.signature,
                            userDefinedMetadata: mJson.userDefinedMetadata,
                            modelInitializer: mJson.modelInitializer,
                            weightSpecs: weightSpecs,
                            weightData: merged.buffer
                        })
                    };
                } else {
                    modelSource = 'indexeddb://gp-coco-ssd-v1';
                }
            }
            try {
                CC.model = await cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: modelSource });
            } catch (err) {
                // First time on standalone APK without bundled weights: fetch once from CDN and save to IndexedDB for 100% offline use next time
                const base = 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2';
                const m = await tf.loadGraphModel(base + '/model.json');
                try { await m.save('indexeddb://gp-coco-ssd-v1'); } catch (e) {}
                CC.model = await cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: base + '/model.json' });
            }
            status('AI siap (' + tf.getBackend() + ')');
            return CC.model;
        })();
        try { return await CC.loading; } catch (e) { CC.loading = null; throw e; }
    }

    // ------------------------------------------------------------ geometry
    function linePx(w, h) {
        return { x1: CC.line.x1 * w, y1: CC.line.y1 * h, x2: CC.line.x2 * w, y2: CC.line.y2 * h };
    }
    // signed distance to the line (+ = side the normal points to) and projection t along segment
    function sideInfo(px, py, L) {
        const dx = L.x2 - L.x1, dy = L.y2 - L.y1, len = Math.hypot(dx, dy) || 1;
        const d = (dx * (py - L.y1) - dy * (px - L.x1)) / len;
        const t = ((px - L.x1) * dx + (py - L.y1) * dy) / (len * len);
        return { d, t };
    }
    function iou(a, b) {
        const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
        const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
        const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const u = a[2] * a[3] + b[2] * b[3] - inter;
        return u > 0 ? inter / u : 0;
    }
    const center = b => [b[0] + b[2] / 2, b[1] + b[3] / 2];

    // ------------------------------------------------------------ tracker
    const TRACK_TTL = 1500;     // ms a track survives without detection
    const COOLDOWN = 1200;      // ms before the same worker can be counted again
    function updateTracks(dets, now, W, H) {
        const L = linePx(W, H);
        const margin = Math.max(10, 0.035 * Math.min(W, H)); // hysteresis band around the line
        // predict positions
        for (const t of CC.tracks) {
            const dt = now - t.seen;
            t.pred = [t.box[0] + t.vx * dt, t.box[1] + t.vy * dt, t.box[2], t.box[3]];
        }
        // candidate pairs (IoU first, then centroid distance)
        const pairs = [];
        CC.tracks.forEach((t, ti) => dets.forEach((d, di) => {
            const ov = iou(t.pred, d.bbox);
            const [ax, ay] = center(t.pred), [bx, by] = center(d.bbox);
            const dist = Math.hypot(ax - bx, ay - by);
            const lim = 0.75 * Math.max(t.box[2], t.box[3]);
            if (ov > 0.15 || dist < lim) pairs.push({ ti, di, s: ov > 0.15 ? 1 + ov : 1 - dist / lim });
        }));
        pairs.sort((a, b) => b.s - a.s);
        const usedT = new Set(), usedD = new Set();
        for (const p of pairs) {
            if (usedT.has(p.ti) || usedD.has(p.di)) continue;
            usedT.add(p.ti); usedD.add(p.di);
            const t = CC.tracks[p.ti], b = dets[p.di].bbox, dt = Math.max(1, now - t.seen);
            const [ox, oy] = center(t.box), [nx, ny] = center(b);
            t.vx = 0.6 * t.vx + 0.4 * ((nx - ox) / dt);
            t.vy = 0.6 * t.vy + 0.4 * ((ny - oy) / dt);
            t.box = b; t.seen = now; t.hits++; t.score = dets[p.di].score;
        }
        dets.forEach((d, di) => {
            if (usedD.has(di)) return;
            CC.tracks.push({ id: CC.nextId++, box: d.bbox, seen: now, born: now, vx: 0, vy: 0, hits: 1, side: 0, lastCount: 0, flash: 0, score: d.score });
        });
        CC.tracks = CC.tracks.filter(t => now - t.seen < TRACK_TTL);

        // line crossing
        const want = CC.flip ? -1 : 1; // side the worker must END on to be counted
        for (const t of CC.tracks) {
            if (t.seen !== now) continue; // only update with fresh detections
            const [cx, cy] = center(t.box);
            const { d, t: proj } = sideInfo(cx, cy, L);
            if (Math.abs(d) < margin) continue;
            const s = d > 0 ? 1 : -1;
            if (t.side !== 0 && s !== t.side) {
                const insideSegment = proj > -0.1 && proj < 1.1;
                if (s === want && insideSegment && t.hits >= 2 && now - t.lastCount > COOLDOWN) {
                    t.lastCount = now; t.flash = now;
                    addCount(1, 'AI', t);
                }
            }
            t.side = s;
        }
    }

    // ------------------------------------------------------------ counting
    function addCount(n, src, track) {
        CC.count = Math.max(0, CC.count + n);
        const ev = { t: new Date().toISOString(), n, src, id: track ? track.id : null };
        CC.events.push(ev);
        if (n > 0 && src === 'AI') { snapshot(track, ev); beep(); if (navigator.vibrate) navigator.vibrate(60); }
        renderCount(); save();
    }
    function snapshot(track, ev) {
        const v = el('cc-video');
        if (!v.videoWidth) return;
        const w = 200, h = Math.round(w * v.videoHeight / v.videoWidth);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.drawImage(v, 0, 0, w, h);
        if (track) {
            const k = w / v.videoWidth, b = track.box;
            g.strokeStyle = '#40c057'; g.lineWidth = 2; g.strokeRect(b[0] * k, b[1] * k, b[2] * k, b[3] * k);
        }
        CC.thumbs.unshift({ img: c.toDataURL('image/jpeg', 0.6), no: CC.count, t: ev.t });
        if (CC.thumbs.length > MAX_THUMBS) CC.thumbs.pop();
        renderThumbs();
    }
    function beep() {
        try {
            CC.audio = CC.audio || new (window.AudioContext || window.webkitAudioContext)();
            const o = CC.audio.createOscillator(), g = CC.audio.createGain();
            o.frequency.value = 1200; g.gain.value = 0.15;
            o.connect(g); g.connect(CC.audio.destination);
            o.start(); o.stop(CC.audio.currentTime + 0.09);
        } catch (e) { }
    }
    function total() { return CC.count * (parseFloat(el('cc-per').value) || 1); }
    function renderCount() {
        el('cc-count').innerText = CC.count;
        el('cc-total').innerText = total();
        el('cc-fcount').innerText = CC.count;
    }
    function renderThumbs() {
        el('cc-thumbs').innerHTML = CC.thumbs.length
            ? CC.thumbs.map(x => `<figure class="cc-thumb"><img src="${x.img}"><figcaption>#${x.no} ${x.t.slice(11, 19)}</figcaption></figure>`).join('')
            : '<span class="cell-muted">Foto bukti setiap kuli yang terhitung (+1) akan otomatis muncul di sini.</span>';
    }
    function status(msg) { el('cc-status').innerText = msg; }

    // ------------------------------------------------------------ drawing
    function draw() {
        const v = el('cc-video'), c = el('cc-canvas');
        const W = v.videoWidth || 640, H = v.videoHeight || 480;
        if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
        const g = c.getContext('2d');
        g.clearRect(0, 0, W, H);
        const S = Math.max(1, Math.min(W, H) / 360); // scale for strokes / fonts
        const L = linePx(W, H);
        // line
        g.lineWidth = 4 * S; g.strokeStyle = '#ffd43b'; g.setLineDash([14 * S, 8 * S]);
        g.beginPath(); g.moveTo(L.x1, L.y1); g.lineTo(L.x2, L.y2); g.stroke(); g.setLineDash([]);
        // handles
        for (const [x, y] of [[L.x1, L.y1], [L.x2, L.y2]]) {
            g.fillStyle = '#ffd43b'; g.beginPath(); g.arc(x, y, 9 * S, 0, Math.PI * 2); g.fill();
            g.strokeStyle = '#000'; g.lineWidth = 2 * S; g.stroke();
        }
        // direction arrow (from midpoint along the normal)
        const dx = L.x2 - L.x1, dy = L.y2 - L.y1, len = Math.hypot(dx, dy) || 1;
        let nx = -dy / len, ny = dx / len;
        if (CC.flip) { nx = -nx; ny = -ny; }
        const mx = (L.x1 + L.x2) / 2, my = (L.y1 + L.y2) / 2, al = 60 * S;
        const ax = mx + nx * al, ay = my + ny * al;
        g.strokeStyle = '#40c057'; g.fillStyle = '#40c057'; g.lineWidth = 6 * S;
        g.beginPath(); g.moveTo(mx - nx * al * 0.4, my - ny * al * 0.4); g.lineTo(ax, ay); g.stroke();
        g.beginPath();
        g.moveTo(ax + nx * 14 * S, ay + ny * 14 * S);
        g.lineTo(ax - ny * 12 * S, ay + nx * 12 * S);
        g.lineTo(ax + ny * 12 * S, ay - nx * 12 * S);
        g.closePath(); g.fill();
        label(g, 'BAWA KARUNG (+1)', ax + nx * 18 * S - 55 * S, ay + ny * 18 * S + 4 * S, '#40c057', S);

        // tracks
        const now = performance.now();
        for (const t of CC.tracks) {
            const b = t.box, hot = now - t.flash < 900;
            g.lineWidth = (hot ? 5 : 3) * S;
            g.strokeStyle = hot ? '#40c057' : (now - t.seen > 300 ? 'rgba(77,171,247,.45)' : '#4dabf7');
            g.strokeRect(b[0], b[1], b[2], b[3]);
            const [cx, cy] = center(b);
            g.fillStyle = g.strokeStyle; g.beginPath(); g.arc(cx, cy, 5 * S, 0, Math.PI * 2); g.fill();
            label(g, `Kuli #${t.id}${hot ? '  +1' : ''}`, b[0], b[1] - 4 * S, g.strokeStyle, S);
        }
        // HUD
        g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 0, 250 * S, 54 * S);
        g.fillStyle = '#fff'; g.font = `bold ${30 * S}px system-ui, sans-serif`;
        g.fillText(`${CC.count}`, 10 * S, 36 * S);
        g.font = `${11 * S}px system-ui, sans-serif`;
        g.fillText(`jalan | orang: ${CC.people} | ${CC.fps.toFixed(0)} fps`, 70 * S, 22 * S);
        g.fillText(el('cc-mode').value === 'IN' ? 'BONGKAR (MASUK)' : 'MUAT (KELUAR)', 70 * S, 40 * S);
    }
    function label(g, txt, x, y, color, S) {
        g.font = `bold ${13 * S}px system-ui, sans-serif`;
        const w = g.measureText(txt).width + 8 * S;
        g.fillStyle = color; g.fillRect(x, y - 16 * S, w, 18 * S);
        g.fillStyle = '#000'; g.fillText(txt, x + 4 * S, y - 3 * S);
    }

    // ------------------------------------------------------------ main loop
    async function detectOnce() {
        const v = el('cc-video');
        if (!CC.model || v.readyState < 2 || !v.videoWidth) return;
        CC.busy = true;
        const t0 = performance.now();
        try {
            const minScore = parseFloat(el('cc-sens').value) || 0.45;
            const minH = (parseFloat(el('cc-minh').value) || 0) / 100 * v.videoHeight;
            const preds = await CC.model.detect(v, 25, minScore);
            const people = preds.filter(p => p.class === 'person' && p.bbox[3] >= minH);
            CC.people = people.length;
            updateTracks(people, performance.now(), v.videoWidth, v.videoHeight);
        } catch (e) { console.warn('[CC] detect', e); }
        const dt = performance.now() - t0;
        CC.fps = CC.fps ? CC.fps * 0.85 + (1000 / Math.max(dt, 1)) * 0.15 : 1000 / Math.max(dt, 1);
        CC.busy = false;
    }
    function loop() {
        if (!CC.running) return;
        if (!CC.busy) detectOnce();
        draw();
        CC.raf = requestAnimationFrame(loop);
    }

    // ------------------------------------------------------------ start / stop
    async function start(fromFile) {
        if (CC.running) return;
        const v = el('cc-video');
        try {
            if (fromFile) {
                if (CC.fileUrl) URL.revokeObjectURL(CC.fileUrl);
                CC.fileUrl = URL.createObjectURL(fromFile);
                v.srcObject = null; v.src = CC.fileUrl; v.loop = false; v.muted = true;
            } else {
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
                    throw new Error('Camera not available here. Open GudangPro via HTTPS (Chrome / installed app) and allow camera permission.');
                CC.stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { facingMode: { ideal: CC.facing }, width: { ideal: 640 }, height: { ideal: 480 } }
                });
                v.removeAttribute('src'); v.srcObject = CC.stream;
            }
            await v.play();
            el('cc-placeholder').style.display = 'none';
            await ensureModel();
            CC.tracks = []; CC.running = true;
            try { if (navigator.wakeLock) CC.wake = await navigator.wakeLock.request('screen'); } catch (e) { }
            setButtons(); status('Menghitung otomatis... tahan HP agar tetap stabil.');
            loop();
        } catch (e) {
            stop();
            const msg = e && e.name === 'NotAllowedError' ? 'Izin kamera ditolak. Izinkan akses kamera untuk Chrome / GudangPro di pengaturan HP.' : (e.message || String(e));
            status(msg); if (window.toast) toast(msg, true);
        }
    }
    function stop() {
        CC.running = false;
        cancelAnimationFrame(CC.raf);
        if (CC.stream) { CC.stream.getTracks().forEach(t => t.stop()); CC.stream = null; }
        const v = el('cc-video');
        if (v) { v.pause(); v.srcObject = null; }
        if (CC.wake) { CC.wake.release().catch(() => { }); CC.wake = null; }
        CC.tracks = []; CC.people = 0;
        if (el('cc-start')) { setButtons(); status(CC.model ? 'Kamera dihentikan.' : 'Tekan Mulai Kamera.'); }
    }
    function setButtons() {
        el('cc-start').style.display = CC.running ? 'none' : '';
        el('cc-stop').style.display = CC.running ? '' : 'none';
    }

    // ------------------------------------------------------------ line editing (drag on the picture)
    function evtPos(e) {
        const r = el('cc-canvas').getBoundingClientRect();
        return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), r };
    }
    function bindLineEditing() {
        const c = el('cc-canvas');
        c.addEventListener('pointerdown', e => {
            const p = evtPos(e), L = CC.line;
            const px = (x, y) => Math.hypot((x - p.x) * p.r.width, (y - p.y) * p.r.height);
            const d1 = px(L.x1, L.y1), d2 = px(L.x2, L.y2);
            const mid = px((L.x1 + L.x2) / 2, (L.y1 + L.y2) / 2);
            if (Math.min(d1, d2) < 36) CC.drag = { type: d1 < d2 ? 'p1' : 'p2' };
            else if (mid < 48) CC.drag = { type: 'move', sx: p.x, sy: p.y, L: { ...L } };
            else return;
            c.setPointerCapture(e.pointerId); e.preventDefault();
        });
        c.addEventListener('pointermove', e => {
            if (!CC.drag) return;
            const p = evtPos(e), L = CC.line;
            if (CC.drag.type === 'p1') { L.x1 = p.x; L.y1 = p.y; }
            else if (CC.drag.type === 'p2') { L.x2 = p.x; L.y2 = p.y; }
            else {
                const o = CC.drag.L, dx = p.x - CC.drag.sx, dy = p.y - CC.drag.sy;
                L.x1 = o.x1 + dx; L.y1 = o.y1 + dy; L.x2 = o.x2 + dx; L.y2 = o.y2 + dy;
            }
            CC.tracks.forEach(t => t.side = 0); // re-arm after moving the line
            if (!CC.running) draw();
        });
        const end = () => { if (CC.drag) { CC.drag = null; save(); } };
        c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    }

    // ------------------------------------------------------------ public actions
    window.camStart = () => start();
    window.camStop = stop;
    window.camFile = input => { const f = input.files && input.files[0]; input.value = ''; if (!f) return; stop(); start(f); };
    window.camSwitch = async () => { CC.facing = CC.facing === 'environment' ? 'user' : 'environment'; if (CC.running && CC.stream) { stop(); await start(); } };
    window.camFlip = () => { CC.flip = !CC.flip; CC.tracks.forEach(t => t.side = 0); save(); if (!CC.running) draw(); };
    window.camPreset = kind => {
        CC.line = kind === 'h' ? { x1: 0.06, y1: 0.5, x2: 0.94, y2: 0.5 } : { x1: 0.5, y1: 0.08, x2: 0.5, y2: 0.92 };
        CC.tracks.forEach(t => t.side = 0); save(); if (!CC.running) draw();
    };
    window.camAdd = n => addCount(n, 'MANUAL');
    window.camReset = () => {
        if (CC.count && !confirm(`Reset hitungan (${CC.count} jalan) kembali ke 0?`)) return;
        CC.count = 0; CC.events = []; CC.thumbs = []; renderThumbs(); renderCount(); save();
    };
    window.camFullscreen = () => {
        const w = el('cc-stage');
        if (document.fullscreenElement) document.exitFullscreen();
        else if (w.requestFullscreen) w.requestFullscreen().catch(() => { });
    };
    window.camOnChange = () => { renderCount(); save(); if (!CC.running) draw(); };
    window.camApply = () => {
        const qty = total(), mode = el('cc-mode').value, wh = el('cc-wh').value, item = el('cc-item').value;
        if (!qty) return toast('Hitungan masih 0 - belum ada barang untuk dimasukkan.', true);
        if (!item) return toast('Pilih barang (pupuk) terlebih dahulu.', true);
        stop();
        if (mode === 'IN') {
            switchTab('receiving');
            el('in-wh').value = wh; el('in-item').value = item; el('in-qty').value = qty; onInItem();
            el('in-form').scrollIntoView({ behavior: 'smooth' });
        } else {
            switchTab('issuing');
            el('out-wh').value = wh; el('out-item').value = item; el('out-qty').value = qty; onOutItem();
            el('out-form').scrollIntoView({ behavior: 'smooth' });
        }
        toast(`Jumlah ${qty} karung otomatis terisi dari kamera. Lengkapi form lalu klik Save.`);
    };
    window.initCamCount = () => {
        if (!initCamCount.done) { restore(); bindLineEditing(); initCamCount.done = true; }
        renderCount(); renderThumbs(); setButtons(); draw();
        if (!CC.running) status(CC.model ? 'AI siap. Tekan Mulai Kamera.' : 'Tekan Mulai Kamera. (AI dimuat saat pertama kali mulai)');
    };
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && CC.running && !CC.wake && navigator.wakeLock) {
            try { CC.wake = await navigator.wakeLock.request('screen'); } catch (e) { }
        }
    });
})();
