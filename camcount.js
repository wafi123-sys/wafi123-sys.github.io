// =====================================================================
// GudangPro - Camera Counter (AI Engine v2.0)
// Smart Hybrid Sack-Carrier Detector & Multi-Angle Tracker:
//   1. COCO-SSD (TensorFlow.js, 100% offline) detects workers even when
//      their head/shoulders are partially occluded by a large fertilizer sack.
//   2. Adaptive Background Subtraction + Frame-Diff Crown/Shoulder Analyzer
//      (144x256 real-time buffer) distinguishes workers actually carrying a
//      sack [BAWA KARUNG] vs bystanders/workers walking empty [LEWAT / KOSONG],
//      while ignoring static background stacks and white warehouse walls.
//   3. Dual Counting Engine: counts both sensor line crossings AND angled
//      aisle/truck-to-stack unload deliveries (sudut lorong / oper karung).
// =====================================================================
(function () {
    const LS_KEY = 'gp_camcount_v2';
    const VENDOR = 'vendor/';
    const MAX_THUMBS = 40;
    const BW = 144, BH = 256;

    const CC = {
        running: false, stream: null, fileUrl: null, model: null, loading: null,
        facing: 'environment', tracks: [], nextId: 1,
        count: 0, events: [], thumbs: [],
        line: { x1: 0.5, y1: 0.08, x2: 0.5, y2: 0.92 }, // normalized 0..1
        flip: false, // false: count when moving to the side the arrow points to
        busy: false, raf: 0, wake: null, drag: null,
        fps: 0, lastDet: 0, people: 0, carriers: 0, audio: null,
        bgCanvas: null, bgCtx: null, bgLum: null, bgSat: null, prevLum: null
    };
    window.CC = CC;
    CC._updateTracks = (...a) => updateTracks(...a); // exposed for automated tests
    CC._resetBg = resetBg;

    const el = id => document.getElementById(id);

    function resetBg() {
        if (!CC.bgCanvas) {
            CC.bgCanvas = document.createElement('canvas');
            CC.bgCanvas.width = BW;
            CC.bgCanvas.height = BH;
            CC.bgCtx = CC.bgCanvas.getContext('2d', { willReadFrequently: true });
        }
        CC.bgLum = new Float32Array(BW * BH);
        CC.bgSat = new Float32Array(BW * BH);
        CC.prevLum = null;
    }

    // ------------------------------------------------------------ persistence
    function save() {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify({
                count: CC.count, line: CC.line, flip: CC.flip, events: CC.events.slice(-500),
                mode: el('cc-mode') && el('cc-mode').value,
                wh: el('cc-wh') && el('cc-wh').value,
                item: el('cc-item') && el('cc-item').value,
                per: el('cc-per') && el('cc-per').value,
                sens: el('cc-sens') && el('cc-sens').value,
                minh: el('cc-minh') && el('cc-minh').value,
                bagfilter: el('cc-bagfilter') && el('cc-bagfilter').value
            }));
        } catch (e) { /* storage full - ignore */ }
    }
    function restore() {
        try {
            const s = JSON.parse(localStorage.getItem(LS_KEY) || localStorage.getItem('gp_camcount_v1') || 'null');
            if (!s) return;
            CC.count = s.count || 0; CC.events = s.events || [];
            if (s.line) CC.line = s.line;
            CC.flip = !!s.flip;
            if (s.mode && el('cc-mode')) el('cc-mode').value = s.mode;
            if (s.per && el('cc-per')) el('cc-per').value = s.per;
            if (s.sens && el('cc-sens') && [...el('cc-sens').options].some(o => o.value === s.sens)) el('cc-sens').value = s.sens;
            if (s.minh && el('cc-minh') && [...el('cc-minh').options].some(o => o.value === s.minh)) el('cc-minh').value = s.minh;
            if (s.bagfilter && el('cc-bagfilter') && [...el('cc-bagfilter').options].some(o => o.value === s.bagfilter)) el('cc-bagfilter').value = s.bagfilter;
            if (s.wh && el('cc-wh') && [...el('cc-wh').options].some(o => o.value === s.wh)) el('cc-wh').value = s.wh;
            if (s.item && el('cc-item') && [...el('cc-item').options].some(o => o.value === s.item)) el('cc-item').value = s.item;
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
            status('Memuat mesin AI v2.0... (pertama kali butuh beberapa detik)');
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
                const base = 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2';
                const m = await tf.loadGraphModel(base + '/model.json');
                try { await m.save('indexeddb://gp-coco-ssd-v1'); } catch (e) {}
                CC.model = await cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: base + '/model.json' });
            }
            status('AI v2.0 siap (' + tf.getBackend() + ')');
            return CC.model;
        })();
        try { return await CC.loading; } catch (e) { CC.loading = null; throw e; }
    }

    // ------------------------------------------------------------ geometry
    function linePx(w, h) {
        return { x1: CC.line.x1 * w, y1: CC.line.y1 * h, x2: CC.line.x2 * w, y2: CC.line.y2 * h };
    }
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

    // ------------------------------------------------------------ Crown / Shoulder Sack Analyzer
    function updateBgAndAnalyze(v, W, H) {
        if (!CC.bgCanvas || !CC.bgLum) resetBg();
        CC.bgCtx.drawImage(v, 0, 0, BW, BH);
        const data = CC.bgCtx.getImageData(0, 0, BW, BH).data;
        const curLum = new Float32Array(BW * BH);
        const bgLum = CC.bgLum, bgSat = CC.bgSat, prevLum = CC.prevLum;
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const lum = (r + g + b) * 0.3333;
            const sat = Math.max(r, g, b) - Math.min(r, g, b);
            curLum[p] = lum;
            if (!prevLum) {
                bgLum[p] = lum;
                bgSat[p] = sat;
            } else {
                const df = Math.abs(lum - prevLum[p]);
                // Adapt background quickly when static (df <= 7) so uncovered white walls/stacks become background immediately
                const alpha = df > 7 ? 0.025 : 0.18;
                bgLum[p] += (lum - bgLum[p]) * alpha;
                bgSat[p] += (sat - bgSat[p]) * alpha;
            }
        }
        return { data, curLum, prevLum, bgLum };
    }

    function analyzeCarry(frameData, bx, by, bw, bh, W, H) {
        if (!frameData) return { isCarrying: true, crownFgWhite: 0.5, maxRowFgWhite: 0.5 };
        const { data, curLum, prevLum, bgLum } = frameData;
        // Crown / Shoulder cap zone: from slightly above head (capped at 6% of screen height so foreground people don't touch ceiling)
        // down to upper shoulder (by + 0.24*bh)
        const upPad = Math.min(bh * 0.26, H * 0.06);
        const dnPad = bh * 0.24;
        const xPad = bw * 0.12;
        const ix0 = Math.max(0, Math.floor((bx - xPad) / W * BW));
        const ix1 = Math.min(BW - 1, Math.ceil((bx + bw + xPad) / W * BW));
        const iy0 = Math.max(0, Math.floor((by - upPad) / H * BH));
        const iy1 = Math.min(BH - 1, Math.ceil((by + dnPad) / H * BH));

        const spanW = Math.max(1, ix1 - ix0 + 1);
        const cx0 = Math.max(0, Math.floor((bx + bw * 0.20) / W * BW));
        const cx1 = Math.min(BW - 1, Math.ceil((bx + bw * 0.80) / W * BW));
        let maxRowWhite = 0, maxRowFgWhite = 0;
        let tot = 0, whiteCnt = 0, fgWhiteCnt = 0;
        let cTot = 0, cWhite = 0, cDark = 0;

        for (let y = iy0; y <= iy1; y++) {
            let rowW = 0, rowFgW = 0;
            for (let x = ix0; x <= ix1; x++) {
                const p = y * BW + x, i = p * 4;
                const r = data[i], g = data[i + 1], b = data[i + 2];
                const lum = curLum[p];
                const sat = Math.max(r, g, b) - Math.min(r, g, b);
                const blueTint = b - r; // reject blue/cyan shirts
                const df = prevLum ? Math.abs(lum - prevLum[p]) : 0;
                const db = lum - bgLum[p];
                const isSackColor = (lum > 142 && sat < 52 && blueTint < 16) || (lum > 175 && sat < 68 && blueTint < 20);
                if (isSackColor) {
                    whiteCnt++; rowW++;
                    if (db > 12 || df > 6) { fgWhiteCnt++; rowFgW++; }
                }
                tot++;
                if (x >= cx0 && x <= cx1) {
                    cTot++;
                    if (isSackColor) cWhite++;
                    if (lum < 90) cDark++;
                }
            }
            if (rowW / spanW > maxRowWhite) maxRowWhite = rowW / spanW;
            if (rowFgW / spanW > maxRowFgWhite) maxRowFgWhite = rowFgW / spanW;
        }

        // Check outer wall brightness to the left & right of the crown so uncovering a white wall isn't mistaken for carrying a sack
        const lx0 = Math.max(0, Math.floor((bx - bw * 0.40) / W * BW));
        const lx1 = Math.max(0, Math.floor((bx - bw * 0.12) / W * BW));
        const rx0 = Math.min(BW - 1, Math.ceil((bx + bw * 1.12) / W * BW));
        const rx1 = Math.min(BW - 1, Math.ceil((bx + bw * 1.40) / W * BW));
        let wTot = 0, wWhite = 0;
        for (let y = iy0; y <= iy1; y++) {
            for (let x = lx0; x <= lx1; x++) { wTot++; if (bgLum[y * BW + x] > 150) wWhite++; }
            for (let x = rx0; x <= rx1; x++) { wTot++; if (bgLum[y * BW + x] > 150) wWhite++; }
        }
        const wallWhite = wTot ? wWhite / wTot : 0;
        const centerWhite = cTot ? cWhite / cTot : 0;
        const centerDark = cTot ? cDark / cTot : 0;
        const crownFgWhite = tot ? fgWhiteCnt / tot : 0;

        let isCarrying = false;
        if (wallWhite >= 0.65) {
            // Standing in front of a bright white wall/stack: require center of crown to be covered by a moving sack (not bare dark hair)
            isCarrying = centerWhite >= 0.55 && centerDark <= 0.14 && crownFgWhite >= 0.22;
        } else {
            // Normal/dark background around head: foreground bright sack patch on crown/shoulder
            isCarrying = (maxRowFgWhite >= 0.30 && crownFgWhite >= 0.10) || (crownFgWhite >= 0.18 && maxRowWhite >= 0.45);
        }
        return { isCarrying, crownFgWhite: +crownFgWhite.toFixed(2), maxRowFgWhite: +maxRowFgWhite.toFixed(2) };
    }

    function captureThumbDataUrl(box) {
        const v = el('cc-video');
        if (!v || !v.videoWidth) return null;
        const w = 200, h = Math.round(w * v.videoHeight / v.videoWidth);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.drawImage(v, 0, 0, w, h);
        if (box) {
            const k = w / v.videoWidth;
            g.strokeStyle = '#40c057'; g.lineWidth = 2.5;
            g.strokeRect(box[0] * k, box[1] * k, box[2] * k, box[3] * k);
        }
        return c.toDataURL('image/jpeg', 0.65);
    }

    // ------------------------------------------------------------ tracker
    const TRACK_TTL = 1900;     // ms a track survives without detection
    const COOLDOWN = 2200;      // ms before the same worker can be counted again

    function updateTracks(dets, now, W, H) {
        const L = linePx(W, H);
        const DIAG = Math.hypot(W, H) || 1;
        const margin = Math.max(8, 0.025 * Math.min(W, H));
        const filterMode = (el('cc-bagfilter') && el('cc-bagfilter').value) || 'smart';

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
            const lim = 0.85 * Math.max(t.box[2], t.box[3], d.bbox[2], d.bbox[3]);
            if (ov > 0.10 || dist < lim) pairs.push({ ti, di, s: ov > 0.10 ? 1 + ov : 1 - dist / lim });
        }));
        pairs.sort((a, b) => b.s - a.s);
        const usedT = new Set(), usedD = new Set();
        for (const p of pairs) {
            if (usedT.has(p.ti) || usedD.has(p.di)) continue;
            usedT.add(p.ti); usedD.add(p.di);
            const t = CC.tracks[p.ti], d = dets[p.di], b = d.bbox, dt = Math.max(1, now - t.seen);
            const [ox, oy] = center(t.box), [nx, ny] = center(b);
            t.vx = 0.6 * t.vx + 0.4 * ((nx - ox) / dt);
            t.vy = 0.6 * t.vy + 0.4 * ((ny - oy) / dt);
            t.box = b; t.seen = now; t.hits++; t.score = d.score;

            const carrying = d.isCarrying !== undefined ? !!d.isCarrying : true;
            t.bagScore = 0.68 * (t.bagScore || 0) + 0.32 * (carrying ? 1 : 0);
            if (carrying) {
                t.bagFrames = (t.bagFrames || 0) + 1;
                t.emptyStreak = 0;
                if (!t.carryStart && t.bagFrames >= 2) {
                    t.carryStart = [nx, ny];
                    t.carryBorn = now;
                }
                if (t.carryStart) {
                    const disp = Math.hypot(nx - t.carryStart[0], ny - t.carryStart[1]) / DIAG;
                    if (disp > (t.maxCarryDisp || 0)) {
                        t.maxCarryDisp = disp;
                        if (t.bagFrames === 4 || t.bagFrames === 10 || disp > 0.09) {
                            t.bestSnap = captureThumbDataUrl(b) || t.bestSnap;
                        }
                    }
                }
            } else {
                t.emptyStreak = (t.emptyStreak || 0) + 1;
                if (t.emptyStreak >= 6) {
                    t.bagFrames = 0;
                    t.bagScore = 0;
                    t.carryStart = null;
                    t.maxCarryDisp = 0;
                    t.countedTrip = false;
                }
            }
            t.hasBag = filterMode === 'line_all'
                ? true
                : ((t.bagScore >= 0.34 && t.bagFrames >= 2) || (t.bagFrames >= 4 && t.emptyStreak <= 4));
        }
        dets.forEach((d, di) => {
            if (usedD.has(di)) return;
            const [nx, ny] = center(d.bbox);
            const carrying = d.isCarrying !== undefined ? !!d.isCarrying : true;
            CC.tracks.push({
                id: CC.nextId++, box: d.bbox, seen: now, born: now, vx: 0, vy: 0, hits: 1,
                side: 0, lastCount: -9999, flash: 0, score: d.score,
                bagScore: carrying ? 0.6 : 0,
                bagFrames: carrying ? 1 : 0,
                emptyStreak: carrying ? 0 : 1,
                hasBag: filterMode === 'line_all' ? true : carrying,
                carryStart: carrying ? [nx, ny] : null,
                carryBorn: now,
                maxCarryDisp: 0,
                countedTrip: false,
                bestSnap: carrying ? captureThumbDataUrl(d.bbox) : null
            });
        });
        CC.tracks = CC.tracks.filter(t => now - t.seen < TRACK_TTL);
        CC.carriers = CC.tracks.filter(t => t.hasBag).length;

        // Counting logic
        const want = CC.flip ? -1 : 1;
        for (const t of CC.tracks) {
            if (t.seen !== now) continue;
            const [cx, cy] = center(t.box);
            const { d, t: proj } = sideInfo(cx, cy, L);

            // 1. Sensor Line Crossing
            if (Math.abs(d) >= margin) {
                const s = d > 0 ? 1 : -1;
                if (t.side !== 0 && s !== t.side) {
                    const insideSegment = proj > -0.1 && proj < 1.1;
                    const dirOk = filterMode === 'smart' ? true : (s === want);
                    const bagOk = filterMode === 'line_all' ? true : (t.hasBag || t.bagFrames >= 3);
                    if (insideSegment && dirOk && bagOk && t.hits >= 2 && !t.countedTrip && now - t.lastCount > COOLDOWN) {
                        t.countedTrip = true;
                        t.lastCount = now;
                        t.flash = now;
                        addCount(1, 'AI', t);
                    }
                }
                t.side = s;
            }

            // 2. Smart Angled / Aisle Carrier Delivery Detection (for difficult camera angles where worker unloads onto stack)
            if (filterMode === 'smart' && !t.countedTrip && now - t.lastCount > COOLDOWN && (t.bagFrames || 0) >= 6) {
                const disp = t.maxCarryDisp || 0;
                const longCarry = t.hasBag && disp >= 0.16 && t.bagFrames >= 8;
                const unloadedAfterCarry = t.emptyStreak >= 2 && t.emptyStreak <= 5 && disp >= 0.095;
                if (longCarry || unloadedAfterCarry) {
                    t.countedTrip = true;
                    t.lastCount = now;
                    t.flash = now;
                    addCount(1, 'AI', t);
                }
            }
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
        const imgUrl = (track && track.bestSnap) || captureThumbDataUrl(track ? track.box : null);
        if (!imgUrl) return;
        CC.thumbs.unshift({ img: imgUrl, no: CC.count, t: ev.t });
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
    function status(msg) { if (el('cc-status')) el('cc-status').innerText = msg; }

    // ------------------------------------------------------------ drawing
    function draw() {
        const v = el('cc-video'), c = el('cc-canvas');
        if (!v || !c) return;
        const W = v.videoWidth || 640, H = v.videoHeight || 480;
        if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
        const g = c.getContext('2d');
        g.clearRect(0, 0, W, H);
        const S = Math.max(1, Math.min(W, H) / 360);
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
            const b = t.box, hot = now - t.flash < 1200;
            const carrying = !!t.hasBag;
            g.lineWidth = (hot ? 5 : (carrying ? 3.5 : 2)) * S;
            if (!carrying && !hot) g.setLineDash([6 * S, 4 * S]);
            const color = hot
                ? '#ffd43b'
                : (carrying ? '#40c057' : 'rgba(173,181,189,0.78)');
            g.strokeStyle = color;
            g.strokeRect(b[0], b[1], b[2], b[3]);
            g.setLineDash([]);
            const [cx, cy] = center(b);
            g.fillStyle = color; g.beginPath(); g.arc(cx, cy, 4.5 * S, 0, Math.PI * 2); g.fill();
            const tag = hot
                ? `Kuli #${t.id} [TERHITUNG +1]`
                : (carrying ? `Kuli #${t.id} [BAWA KARUNG]` : `Orang #${t.id} [KOSONG]`);
            label(g, tag, b[0], Math.max(18 * S, b[1] - 4 * S), color, S);
        }
        // HUD
        g.fillStyle = 'rgba(0,0,0,.62)'; g.fillRect(0, 0, 295 * S, 56 * S);
        g.fillStyle = '#40c057'; g.font = `bold ${30 * S}px system-ui, sans-serif`;
        g.fillText(`${CC.count}`, 10 * S, 37 * S);
        g.fillStyle = '#fff'; g.font = `${11 * S}px system-ui, sans-serif`;
        g.fillText(`karung: ${CC.carriers} aktif | orang: ${CC.people} | ${CC.fps.toFixed(0)} fps`, 68 * S, 22 * S);
        g.fillText(el('cc-mode').value === 'IN' ? 'BONGKAR (MASUK) - AI FILTER AKTIF' : 'MUAT (KELUAR) - AI FILTER AKTIF', 68 * S, 40 * S);
    }
    function label(g, txt, x, y, color, S) {
        g.font = `bold ${12 * S}px system-ui, sans-serif`;
        const w = g.measureText(txt).width + 8 * S;
        const lx = Math.max(2 * S, Math.min(x, (g.canvas ? g.canvas.width : 9999) - w - 2 * S));
        g.fillStyle = color; g.fillRect(lx, y - 16 * S, w, 18 * S);
        g.fillStyle = '#000'; g.fillText(txt, lx + 4 * S, y - 3 * S);
    }

    // ------------------------------------------------------------ main loop
    async function detectOnce() {
        const v = el('cc-video');
        if (!CC.model || v.readyState < 2 || !v.videoWidth) return;
        CC.busy = true;
        const t0 = performance.now();
        try {
            const W = v.videoWidth, H = v.videoHeight;
            const userMinScore = parseFloat(el('cc-sens').value) || 0.35;
            const minHFrac = (parseFloat(el('cc-minh').value) || 12) / 100;
            const frameData = updateBgAndAnalyze(v, W, H);
            // Detect down to 0.20 so workers whose heads are occluded by sacks are still caught
            const rawPreds = await CC.model.detect(v, 30, 0.20);
            const dets = [];
            for (const p of rawPreds) {
                if (p.class !== 'person') continue;
                const [bx, by, bw, bh] = p.bbox;
                const hFrac = bh / H;
                const areaFrac = (bw * bh) / (W * H);
                const matchesActive = CC.tracks.some(tr => {
                    const [ax, ay] = center(tr.box), [cx, cy] = center(p.bbox);
                    return iou(tr.box, p.bbox) > 0.12 || Math.hypot(ax - cx, ay - cy) < 0.65 * Math.max(tr.box[2], tr.box[3]);
                });
                if (!matchesActive && (hFrac < Math.max(0.11, minHFrac) || areaFrac < 0.016)) continue;
                if (hFrac < 0.085) continue;
                const carry = analyzeCarry(frameData, bx, by, bw, bh, W, H);
                if (!carry.isCarrying && !matchesActive && p.score < userMinScore) continue;
                dets.push({ bbox: p.bbox, score: p.score, isCarrying: carry.isCarrying });
            }
            CC.prevLum = frameData.curLum;
            CC.people = dets.length;
            updateTracks(dets, performance.now(), W, H);
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
            resetBg();
            if (fromFile) {
                if (CC.fileUrl) URL.revokeObjectURL(CC.fileUrl);
                CC.fileUrl = URL.createObjectURL(fromFile);
                v.srcObject = null; v.src = CC.fileUrl; v.loop = false; v.muted = true;
            } else {
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
                    throw new Error('Kamera tidak tersedia di sini. Buka GudangPro melalui aplikasi APK atau HTTPS dan izinkan akses kamera.');
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
            setButtons(); status('AI v2.0 aktif: otomatis membedakan kuli [BAWA KARUNG] vs orang [KOSONG].');
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
        CC.tracks = []; CC.people = 0; CC.carriers = 0;
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
            CC.tracks.forEach(t => t.side = 0);
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
        if (kind === 'h') CC.line = { x1: 0.06, y1: 0.5, x2: 0.94, y2: 0.5 };
        else if (kind === 'd') { CC.line = { x1: 0.62, y1: 0.22, x2: 0.44, y2: 0.82 }; CC.flip = true; }
        else CC.line = { x1: 0.5, y1: 0.08, x2: 0.5, y2: 0.92 };
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
        window._ccPendingPhoto = (CC.thumbs && CC.thumbs.length && CC.thumbs[0].url) ? CC.thumbs[0].url : null;
        const stamp = 'CAM-' + new Date().toTimeString().slice(0, 8).replace(/:/g, '');
        if (mode === 'IN') {
            switchTab('receiving');
            el('in-wh').value = wh; el('in-item').value = item; el('in-qty').value = qty;
            const sjInp = document.querySelector('#in-form input[name="surat_jalan"]');
            if (sjInp && !sjInp.value) sjInp.value = stamp;
            onInItem();
            el('in-form').scrollIntoView({ behavior: 'smooth' });
        } else {
            switchTab('issuing');
            el('out-wh').value = wh; el('out-item').value = item; el('out-qty').value = qty;
            const reqInp = document.querySelector('#out-form input[name="requisition_no"]');
            if (reqInp && !reqInp.value) reqInp.value = stamp;
            onOutItem();
            el('out-form').scrollIntoView({ behavior: 'smooth' });
        }
        toast(`Jumlah ${qty} karung otomatis terisi dari kamera. Klik Save untuk menyimpan.`);
    };
    window.camQuickSave = async () => {
        const qty = total(), mode = el('cc-mode').value, wh = el('cc-wh').value, item = el('cc-item').value;
        if (!qty) return toast('Hitungan masih 0 - belum ada karung terhitung.', true);
        if (!item) return toast('Pilih nama barang (pupuk) terlebih dahulu.', true);
        stop();
        const photoUrl = (CC.thumbs && CC.thumbs.length && CC.thumbs[0].url) ? CC.thumbs[0].url : null;
        const stamp = 'CAM-' + new Date().toTimeString().slice(0, 8).replace(/:/g, '');
        const userPic = localStorage.getItem('auth') || 'checker';
        const dStr = typeof today === 'function' ? today() : new Date().toISOString().slice(0, 10);
        try {
            if (mode === 'IN') {
                await api('/api/inbound', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tanggal_masuk: dStr,
                        gudang: wh,
                        kode_barang: item,
                        qty_masuk: qty,
                        supplier: 'Kamera AI Counter',
                        surat_jalan: stamp,
                        lokasi: '',
                        pic: userPic,
                        foto_bukti: photoUrl
                    })
                });
            } else {
                await api('/api/outbound', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tanggal_keluar: dStr,
                        gudang: wh,
                        kode_barang: item,
                        qty_keluar: qty,
                        requisition_no: stamp,
                        alasan_keluar: 'Hitung Otomatis Kamera AI',
                        pic: userPic,
                        foto_bukti: photoUrl
                    })
                });
            }
            if (typeof refreshBase === 'function') await refreshBase();
            const itObj = typeof itemOf === 'function' ? itemOf(item) : null;
            const itName = itObj ? itObj.nama_barang : item;
            CC.count = 0; CC.events = []; CC.thumbs = []; renderThumbs(); renderCount(); save();
            toast(`Tersimpan langsung: ${mode === 'IN' ? '+' : '-'}${qty} karung ${itName} (${wh})!`);
        } catch (err) {
            toast(err.message || String(err), true);
        }
    };
    window.initCamCount = () => {
        if (!initCamCount.done) { restore(); bindLineEditing(); initCamCount.done = true; }
        const sel = el('cc-item');
        if (sel && !sel.value && sel.options.length > 1) {
            const fertOpt = [...sel.options].find(o => o.value.startsWith('PUPUK-')) || sel.options[1];
            if (fertOpt) sel.value = fertOpt.value;
        }
        renderCount(); renderThumbs(); setButtons(); draw();
        if (!CC.running) status(CC.model ? 'AI v2.0 siap. Tekan Mulai Kamera.' : 'Tekan Mulai Kamera. (AI v2.0 dimuat saat pertama kali mulai)');
    };
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && CC.running && !CC.wake && navigator.wakeLock) {
            try { CC.wake = await navigator.wakeLock.request('screen'); } catch (e) { }
        }
    });
})();
