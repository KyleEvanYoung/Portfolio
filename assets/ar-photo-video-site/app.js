import { TARGETS, SETTINGS } from './config.js';

const $ = (s) => document.querySelector(s);
const camera = $('#camera');
const overlay = $('#overlay');
const processCanvas = $('#process');
const statusEl = $('#status');
const permission = $('#permission');
const startBtn = $('#startBtn');
const flipBtn = $('#flipBtn');
const targetsBtn = $('#targetsBtn');
const closeTargets = $('#closeTargets');
const targetsDialog = $('#targetsDialog');
const targetGrid = $('#targetGrid');
const targetNameEl = $('#targetName');
const fpsEl = $('#fps');
const confidenceBar = $('#confidenceBar');
const flash = $('#flash');

let cvReady = false;
let cameraReady = false;
let running = false;
let stream = null;
let facingMode = 'environment';
let cvx = null;
let targetData = [];
let frameIndex = 0;
let processing = false;
let lock = null;
let prevGray = null;
let lastFrameTs = performance.now();
let fpsEMA = 0;
let lastRecognitionScore = 0;
let glRenderer = null;

function setStatus(text, kind = 'loading') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

async function waitForOpenCV() {
  if (window.cv) {
    cvx = window.cv instanceof Promise ? await window.cv : window.cv;
    if (cvx?.Mat) return;
  }
  await new Promise(resolve => {
    const handler = async () => {
      window.removeEventListener('opencv-runtime-ready', handler);
      cvx = window.cv instanceof Promise ? await window.cv : window.cv;
      resolve();
    };
    window.addEventListener('opencv-runtime-ready', handler, { once: true });
  });
}

function buildTargetGrid() {
  targetGrid.innerHTML = TARGETS.map(t => `
    <figure class="target-card">
      <a href="${t.image}" target="_blank" rel="noopener"><img src="${t.image}" alt="${t.name} target"></a>
      <figcaption><strong>${t.name}</strong><br><span>${t.image.split('/').pop()} → ${t.video.split('/').pop()}</span></figcaption>
    </figure>
  `).join('');
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function loadTargets() {
  setStatus('Learning 3 target images…');
  const orb = new cvx.ORB();
  if (typeof orb.setMaxFeatures === 'function') orb.setMaxFeatures(SETTINGS.orbFeatures);

  for (const spec of TARGETS) {
    const img = await loadImage(spec.image);
    const rgba = cvx.imread(img);
    const gray = new cvx.Mat();
    cvx.cvtColor(rgba, gray, cvx.COLOR_RGBA2GRAY);
    const keypoints = new cvx.KeyPointVector();
    const descriptors = new cvx.Mat();
    const mask = new cvx.Mat();
    orb.detectAndCompute(gray, mask, keypoints, descriptors);

    const video = document.createElement('video');
    video.src = spec.video;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.load();

    targetData.push({
      ...spec,
      width: gray.cols,
      height: gray.rows,
      img,
      gray,
      keypoints,
      descriptors,
      video,
    });

    rgba.delete();
    mask.delete();
  }

  orb.delete();
  cvReady = true;
  setStatus('Vision ready — allow camera', 'ok');
  startBtn.disabled = false;
  startBtn.textContent = 'Allow camera & start';
}

function getCoverCrop(video, outAspect) {
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const srcAspect = vw / vh;
  if (srcAspect > outAspect) {
    const sw = vh * outAspect;
    return { sx: (vw - sw) / 2, sy: 0, sw, sh: vh };
  }
  const sh = vw / outAspect;
  return { sx: 0, sy: (vh - sh) / 2, sw: vw, sh };
}

function resetTrackingFrames() {
  if (prevGray) prevGray.delete();
  prevGray = null;
}

function sizeCanvases() {
  const oldW = processCanvas.width;
  const oldH = processCanvas.height;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const cssW = innerWidth;
  const cssH = innerHeight;

  overlay.width = Math.round(cssW * dpr);
  overlay.height = Math.round(cssH * dpr);
  overlay.style.width = `${cssW}px`;
  overlay.style.height = `${cssH}px`;
  glRenderer?.resize(overlay.width, overlay.height);

  const pw = Math.min(SETTINGS.processWidth, Math.round(cssW * dpr));
  const ph = Math.max(240, Math.round(pw * cssH / cssW));
  processCanvas.width = pw;
  processCanvas.height = ph;

  if (oldW && oldH && (oldW !== pw || oldH !== ph) && lock) {
    loseLock();
    resetTrackingFrames();
  }
}

async function startCamera() {
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    throw new Error('Camera access needs HTTPS (or localhost).');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API unavailable. Use a modern mobile browser over HTTPS.');
  }

  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60, min: 24 },
    },
  });

  camera.srcObject = stream;
  await camera.play();
  cameraReady = true;
  sizeCanvases();
  resetTrackingFrames();
  permission.classList.add('hidden');
  setStatus('Scanning for a target…', 'ok');
}

function frameToGray() {
  const ctx = processCanvas.getContext('2d', { willReadFrequently: true });
  const aspect = processCanvas.width / processCanvas.height;
  const { sx, sy, sw, sh } = getCoverCrop(camera, aspect);
  ctx.drawImage(camera, sx, sy, sw, sh, 0, 0, processCanvas.width, processCanvas.height);
  const rgba = cvx.imread(processCanvas);
  const gray = new cvx.Mat();
  cvx.cvtColor(rgba, gray, cvx.COLOR_RGBA2GRAY);
  rgba.delete();
  return gray;
}

function quadArea(q) {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) * 0.5;
}

function quadCenter(q) {
  return {
    x: (q[0].x + q[1].x + q[2].x + q[3].x) * 0.25,
    y: (q[0].y + q[1].y + q[2].y + q[3].y) * 0.25,
  };
}

function edgeLength(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isConvexQuad(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-3) return false;
    const s = Math.sign(cross);
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function isSaneQuad(q) {
  if (!q || q.length !== 4) return false;
  if (q.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  if (!isConvexQuad(q)) return false;

  const area = quadArea(q);
  const full = processCanvas.width * processCanvas.height;
  if (area < full * 0.012 || area > full * 1.7) return false;

  const edges = [0,1,2,3].map(i => edgeLength(q[i], q[(i + 1) % 4]));
  const minEdge = Math.min(...edges);
  const maxEdge = Math.max(...edges);
  if (minEdge < 10 || maxEdge / Math.max(1, minEdge) > 14) return false;

  const padX = processCanvas.width * 0.40;
  const padY = processCanvas.height * 0.40;
  return q.every(p =>
    p.x > -padX && p.y > -padY &&
    p.x < processCanvas.width + padX && p.y < processCanvas.height + padY
  );
}

function isPlausibleFrameMove(next, prev) {
  if (!prev || !next) return true;
  const a0 = quadArea(prev);
  const a1 = quadArea(next);
  if (a0 <= 0 || a1 <= 0) return false;
  const areaRatio = a1 / a0;
  if (areaRatio < SETTINGS.minFrameAreaRatio || areaRatio > SETTINGS.maxFrameAreaRatio) return false;

  const c0 = quadCenter(prev);
  const c1 = quadCenter(next);
  const diag = Math.hypot(processCanvas.width, processCanvas.height);
  const centerJump = Math.hypot(c1.x - c0.x, c1.y - c0.y) / Math.max(1, diag);
  if (centerJump > SETTINGS.maxFrameCenterJumpRatio) return false;

  return true;
}

function homographyToQuad(H, tw, th) {
  const src = cvx.matFromArray(4, 1, cvx.CV_32FC2, [0,0, tw,0, tw,th, 0,th]);
  const dst = new cvx.Mat();
  cvx.perspectiveTransform(src, dst, H);
  const d = dst.data32F;
  const q = [0,1,2,3].map(i => ({ x: d[i*2], y: d[i*2+1] }));
  src.delete();
  dst.delete();
  return q;
}

function keypointPt(vec, i) {
  const kp = vec.get(i);
  return { x: kp.pt.x, y: kp.pt.y };
}

function selectDistributedPairs(targetPts, scenePts, maxPoints, tw, th) {
  const cols = 4;
  const rows = 3;
  const buckets = Array.from({ length: cols * rows }, () => []);
  const n = targetPts.length / 2;

  for (let i = 0; i < n; i++) {
    const x = targetPts[i * 2];
    const y = targetPts[i * 2 + 1];
    const bx = Math.max(0, Math.min(cols - 1, Math.floor((x / Math.max(1, tw)) * cols)));
    const by = Math.max(0, Math.min(rows - 1, Math.floor((y / Math.max(1, th)) * rows)));
    buckets[by * cols + bx].push(i);
  }

  const chosen = [];
  let round = 0;
  while (chosen.length < Math.min(maxPoints, n)) {
    let added = false;
    for (const bucket of buckets) {
      if (bucket[round] !== undefined) {
        chosen.push(bucket[round]);
        added = true;
        if (chosen.length >= Math.min(maxPoints, n)) break;
      }
    }
    if (!added) break;
    round++;
  }

  const outTarget = [];
  const outScene = [];
  for (const i of chosen) {
    outTarget.push(targetPts[i*2], targetPts[i*2+1]);
    outScene.push(scenePts[i*2], scenePts[i*2+1]);
  }
  return { targetPts: outTarget, scenePts: outScene };
}

function matchTarget(frameKeypoints, frameDescriptors, target) {
  if (frameDescriptors.empty() || target.descriptors.empty()) return null;

  const matcher = new cvx.BFMatcher(cvx.NORM_HAMMING, false);
  const knn = new cvx.DMatchVectorVector();

  try {
    matcher.knnMatch(frameDescriptors, target.descriptors, knn, 2);
    const scenePts = [];
    const targetPts = [];

    for (let i = 0; i < knn.size(); i++) {
      const pair = knn.get(i);
      if (pair.size() < 2) {
        pair.delete();
        continue;
      }

      const m0 = pair.get(0);
      const m1 = pair.get(1);
      if (m0.distance < SETTINGS.ratioTest * m1.distance) {
        const sp = keypointPt(frameKeypoints, m0.queryIdx);
        const tp = keypointPt(target.keypoints, m0.trainIdx);
        scenePts.push(sp.x, sp.y);
        targetPts.push(tp.x, tp.y);
      }
      pair.delete();
    }

    const goodCount = scenePts.length / 2;
    if (goodCount < SETTINGS.minGoodMatches) return null;

    const src = cvx.matFromArray(goodCount, 1, cvx.CV_32FC2, targetPts);
    const dst = cvx.matFromArray(goodCount, 1, cvx.CV_32FC2, scenePts);
    const mask = new cvx.Mat();
    const H = cvx.findHomography(src, dst, cvx.RANSAC, SETTINGS.ransacThreshold, mask);

    if (H.empty()) {
      src.delete(); dst.delete(); mask.delete(); H.delete();
      return null;
    }

    const keptTarget = [];
    const keptScene = [];
    let inliers = 0;
    for (let i = 0; i < mask.rows; i++) {
      if (mask.data[i]) {
        inliers++;
        keptTarget.push(targetPts[i*2], targetPts[i*2+1]);
        keptScene.push(scenePts[i*2], scenePts[i*2+1]);
      }
    }

    const quad = homographyToQuad(H, target.width, target.height);
    src.delete(); dst.delete(); mask.delete(); H.delete();

    if (inliers < SETTINGS.minInliers || !isSaneQuad(quad)) return null;

    const distributed = selectDistributedPairs(
      keptTarget,
      keptScene,
      SETTINGS.maxTrackPoints,
      target.width,
      target.height,
    );

    return {
      target,
      inliers,
      goodCount,
      score: inliers / Math.max(1, goodCount),
      quad,
      targetPts: distributed.targetPts,
      scenePts: distributed.scenePts,
    };
  } finally {
    knn.delete();
    matcher.delete();
  }
}

function detectFeatures(gray) {
  const orb = new cvx.ORB();
  if (typeof orb.setMaxFeatures === 'function') orb.setMaxFeatures(SETTINGS.orbFeatures);
  const kp = new cvx.KeyPointVector();
  const desc = new cvx.Mat();
  const mask = new cvx.Mat();
  orb.detectAndCompute(gray, mask, kp, desc);
  mask.delete();
  orb.delete();
  return { kp, desc };
}

function recognise(gray, onlyTarget = null) {
  const { kp, desc } = detectFeatures(gray);
  let best = null;
  const candidates = onlyTarget ? [onlyTarget] : targetData;

  for (const target of candidates) {
    const result = matchTarget(kp, desc, target);
    if (result && (!best || result.inliers > best.inliers)) best = result;
  }

  kp.delete();
  desc.delete();
  return best;
}

function matPoints(flat) {
  return cvx.matFromArray(flat.length / 2, 1, cvx.CV_32FC2, flat);
}

function trackOpticalFlow(gray) {
  if (!lock || !prevGray || lock.scenePts.length / 2 < SETTINGS.minTrackPoints) return false;
  if (prevGray.cols !== gray.cols || prevGray.rows !== gray.rows) return false;

  const oldPts = matPoints(lock.scenePts);
  const nextPts = new cvx.Mat();
  const fwdStatus = new cvx.Mat();
  const fwdErr = new cvx.Mat();
  const backPts = new cvx.Mat();
  const backStatus = new cvx.Mat();
  const backErr = new cvx.Mat();
  const win = new cvx.Size(SETTINGS.lkWindowSize, SETTINGS.lkWindowSize);
  const criteria = new cvx.TermCriteria(
    cvx.TermCriteria_COUNT | cvx.TermCriteria_EPS,
    24,
    0.01,
  );

  try {
    cvx.calcOpticalFlowPyrLK(
      prevGray, gray, oldPts, nextPts, fwdStatus, fwdErr,
      win, SETTINGS.lkMaxLevel, criteria,
    );
    cvx.calcOpticalFlowPyrLK(
      gray, prevGray, nextPts, backPts, backStatus, backErr,
      win, SETTINGS.lkMaxLevel, criteria,
    );

    const scene = [];
    const target = [];
    const old = oldPts.data32F;
    const next = nextPts.data32F;
    const back = backPts.data32F;

    for (let i = 0; i < fwdStatus.rows; i++) {
      if (!fwdStatus.data[i] || !backStatus.data[i]) continue;
      if (fwdErr.data32F?.length && fwdErr.data32F[i] > SETTINGS.lkMaxError) continue;

      const ox = old[i*2];
      const oy = old[i*2+1];
      const x = next[i*2];
      const y = next[i*2+1];
      const bx = back[i*2];
      const by = back[i*2+1];
      const fb = Math.hypot(bx - ox, by - oy);

      if (fb > SETTINGS.lkForwardBackwardMaxError) continue;
      if (x < -10 || y < -10 || x > processCanvas.width + 10 || y > processCanvas.height + 10) continue;

      scene.push(x, y);
      target.push(lock.targetPts[i*2], lock.targetPts[i*2+1]);
    }

    if (scene.length / 2 < SETTINGS.minTrackPoints) return false;

    const src = matPoints(target);
    const dst = matPoints(scene);
    const mask = new cvx.Mat();
    const H = cvx.findHomography(src, dst, cvx.RANSAC, SETTINGS.ransacThreshold, mask);

    if (H.empty()) {
      src.delete(); dst.delete(); mask.delete(); H.delete();
      return false;
    }

    const inlierScene = [];
    const inlierTarget = [];
    let inliers = 0;
    for (let i = 0; i < mask.rows; i++) {
      if (mask.data[i]) {
        inliers++;
        inlierScene.push(scene[i*2], scene[i*2+1]);
        inlierTarget.push(target[i*2], target[i*2+1]);
      }
    }

    const quad = homographyToQuad(H, lock.target.width, lock.target.height);
    src.delete(); dst.delete(); mask.delete(); H.delete();

    const inlierRatio = inliers / Math.max(1, scene.length / 2);
    if (
      inliers < SETTINGS.minTrackPoints ||
      inlierRatio < SETTINGS.minTrackInlierRatio ||
      !isSaneQuad(quad) ||
      !isPlausibleFrameMove(quad, lock.rawQuad)
    ) {
      return false;
    }

    lock.scenePts = inlierScene;
    lock.targetPts = inlierTarget;
    lock.rawQuad = quad;
    lock.lostFrames = 0;
    lastRecognitionScore = Math.max(0.15, Math.min(1, 0.55 * inlierRatio + 0.45 * Math.min(1, inliers / 36)));
    return true;
  } finally {
    oldPts.delete();
    nextPts.delete();
    fwdStatus.delete();
    fwdErr.delete();
    backPts.delete();
    backStatus.delete();
    backErr.delete();
  }
}

function alphaForCutoff(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * Math.max(0.001, cutoff));
  return 1 / (1 + tau / Math.max(1e-4, dt));
}

function newOneEuroState(value, ts) {
  return { raw: value, filtered: value, derivative: 0, ts };
}

function oneEuro(value, state, ts) {
  const dt = Math.min(0.1, Math.max(1/120, (ts - state.ts) / 1000 || 1/60));
  const derivative = (value - state.raw) / dt;
  const da = alphaForCutoff(SETTINGS.oneEuroDerivativeCutoff, dt);
  state.derivative += da * (derivative - state.derivative);

  const cutoff = SETTINGS.oneEuroMinCutoff + SETTINGS.oneEuroBeta * Math.abs(state.derivative);
  const a = alphaForCutoff(cutoff, dt);
  state.filtered += a * (value - state.filtered);
  state.raw = value;
  state.ts = ts;
  return state.filtered;
}

function createQuadFilters(q, ts) {
  return q.map(p => ({
    x: newOneEuroState(p.x, ts),
    y: newOneEuroState(p.y, ts),
  }));
}

function smoothQuad(raw, ts = performance.now()) {
  if (!lock.quadFilters) lock.quadFilters = createQuadFilters(raw, ts);
  const filtered = raw.map((p, i) => ({
    x: oneEuro(p.x, lock.quadFilters[i].x, ts),
    y: oneEuro(p.y, lock.quadFilters[i].y, ts),
  }));

  // A filter should never turn a valid perspective quad inside out.
  // If it somehow does, use the raw pose for this frame and re-seed.
  if (!isSaneQuad(filtered)) {
    lock.quadFilters = createQuadFilters(raw, ts);
    lock.smoothedQuad = raw.map(p => ({ ...p }));
  } else {
    lock.smoothedQuad = filtered;
  }
}

function setConfidenceFromRecognition(result) {
  const inlierStrength = Math.min(1, result.inliers / 34);
  const ratioStrength = Math.min(1, result.score / 0.72);
  lastRecognitionScore = Math.max(0.15, Math.min(1, 0.55 * inlierStrength + 0.45 * ratioStrength));
}

async function setLock(result, ts = performance.now()) {
  const changed = !lock || lock.target.id !== result.target.id;
  if (changed && lock?.target?.video) lock.target.video.pause();

  lock = {
    target: result.target,
    targetPts: result.targetPts,
    scenePts: result.scenePts,
    rawQuad: result.quad,
    smoothedQuad: result.quad.map(p => ({ ...p })),
    quadFilters: createQuadFilters(result.quad, ts),
    lostFrames: 0,
    age: 0,
  };

  setConfidenceFromRecognition(result);

  if (changed) {
    try { await result.target.video.play(); } catch (_) {}
    flash.classList.add('on');
    setTimeout(() => flash.classList.remove('on'), 150);
  }

  targetNameEl.textContent = `${result.target.name} • ${result.inliers} inliers`;
  setStatus(`Tracking ${result.target.name}`, 'ok');
}

function refreshLock(result, ts = performance.now()) {
  if (!lock || lock.target.id !== result.target.id) return false;
  if (!isPlausibleFrameMove(result.quad, lock.rawQuad)) return false;

  lock.targetPts = result.targetPts;
  lock.scenePts = result.scenePts;
  lock.rawQuad = result.quad;
  lock.lostFrames = 0;
  setConfidenceFromRecognition(result);
  smoothQuad(result.quad, ts);
  targetNameEl.textContent = `${result.target.name} • ${result.inliers} inliers`;
  return true;
}

function loseLock() {
  if (lock?.target?.video) lock.target.video.pause();
  lock = null;
  lastRecognitionScore = 0;
  targetNameEl.textContent = 'Searching for a target…';
  setStatus('Scanning for a target…', 'ok');
  glRenderer?.clear();
}

function replacePrevGray(gray) {
  if (prevGray) prevGray.delete();
  prevGray = gray.clone();
}

async function processFrame() {
  if (!running || processing || !cameraReady || !cvReady || camera.readyState < 2) return;
  processing = true;
  let gray = null;

  try {
    gray = frameToGray();
    frameIndex++;
    const now = performance.now();
    let currentFrameOwnsTrackPoints = false;

    if (lock) {
      lock.age++;
      let tracked = trackOpticalFlow(gray);

      if (tracked) {
        smoothQuad(lock.rawQuad, now);
        currentFrameOwnsTrackPoints = true;
      } else {
        // Do an immediate same-target recovery. This is much better than
        // advancing the LK reference frame while its points still belong
        // to an older frame (a major source of runaway drift).
        const recovered = recognise(gray, lock.target);
        if (recovered && refreshLock(recovered, now)) {
          tracked = true;
          currentFrameOwnsTrackPoints = true;
        } else {
          lock.lostFrames++;
        }
      }

      if (
        lock &&
        tracked &&
        lock.age % SETTINGS.refreshLockEveryFrames === 0
      ) {
        const refreshed = recognise(gray, lock.target);
        if (refreshed) refreshLock(refreshed, now);
      }

      if (lock && lock.lostFrames > SETTINGS.lostFrameLimit) loseLock();
    }

    if (!lock && frameIndex % SETTINGS.recognitionEveryFrames === 0) {
      const result = recognise(gray);
      if (result) {
        await setLock(result, now);
        currentFrameOwnsTrackPoints = true;
      }
    }

    // prevGray must correspond to lock.scenePts. If LK failed and recovery
    // also failed, keep the older reference frame instead of mismatching
    // points and pixels on the next iteration.
    if (!lock || currentFrameOwnsTrackPoints) replacePrevGray(gray);
  } catch (err) {
    console.error(err);
    setStatus(`Tracking error: ${err.message || err}`, 'bad');
  } finally {
    gray?.delete();
    processing = false;
  }
}

function toOverlayQuad(q) {
  if (!q) return null;
  const sx = overlay.width / processCanvas.width;
  const sy = overlay.height / processCanvas.height;
  return q.map(p => ({ x: p.x * sx, y: p.y * sy }));
}

function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];

    const div = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= div;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
    }
  }

  return M.map(row => row[n]);
}

function homographyFrom4(src, dst) {
  const A = [];
  const b = [];

  for (let i = 0; i < 4; i++) {
    const x = src[i].x;
    const y = src[i].y;
    const u = dst[i].x;
    const v = dst[i].y;

    A.push([x, y, 1, 0, 0, 0, -u*x, -u*y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v*x, -v*y]);
    b.push(v);
  }

  const h = solveLinearSystem(A, b);
  if (!h) return null;
  return [
    h[0], h[1], h[2],
    h[3], h[4], h[5],
    h[6], h[7], 1,
  ];
}

function makeGLRenderer(canvas) {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL is required for the video overlay.');

  const vs = `
    attribute vec2 a_pos;
    void main(){
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // True projective texture mapping. Every output pixel is mapped back
  // through the inverse homography into the source video rectangle.
  // This avoids the diagonal/shearing error caused by two affine triangles.
  const fs = `
    precision highp float;
    uniform sampler2D u_tex;
    uniform mat3 u_screenToUV;
    void main(){
      vec3 p = u_screenToUV * vec3(gl_FragCoord.xy, 1.0);
      if (abs(p.z) < 0.000001) discard;
      vec2 uv = p.xy / p.z;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
      gl_FragColor = texture2D(u_tex, uv);
    }
  `;

  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s));
    }
    return s;
  }

  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  gl.useProgram(program);

  const posLoc = gl.getAttribLocation(program, 'a_pos');
  const homographyLoc = gl.getUniformLocation(program, 'u_screenToUV');
  const texLoc = gl.getUniformLocation(program, 'u_tex');

  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1,-1,  1,-1,  1, 1,
    -1,-1,  1, 1, -1, 1,
  ]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.uniform1i(texLoc, 0);
  gl.clearColor(0,0,0,0);

  let lastVideo = null;
  let lastVideoTime = -1;

  return {
    resize(w, h) {
      gl.viewport(0,0,w,h);
    },

    clear() {
      gl.clear(gl.COLOR_BUFFER_BIT);
    },

    draw(video, q) {
      if (!q || q.length !== 4) return this.clear();

      const H = canvas.height;
      // gl_FragCoord is bottom-up. Tracking coordinates are top-down.
      const screen = q.map(p => ({ x: p.x, y: H - p.y }));
      const uv = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ];
      const m = homographyFrom4(screen, uv);
      if (!m) return this.clear();

      // WebGL expects column-major matrix memory.
      const columnMajor = new Float32Array([
        m[0], m[3], m[6],
        m[1], m[4], m[7],
        m[2], m[5], m[8],
      ]);

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix3fv(homographyLoc, false, columnMajor);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);

      // Avoid re-uploading the same decoded video frame at 60/120 Hz.
      if (video !== lastVideo || Math.abs(video.currentTime - lastVideoTime) > 0.0005) {
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          lastVideo = video;
          lastVideoTime = video.currentTime;
        } catch (_) {
          return;
        }
      }

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
  };
}

function render() {
  const now = performance.now();
  const inst = 1000 / Math.max(1, now - lastFrameTs);
  fpsEMA = fpsEMA ? fpsEMA * 0.9 + inst * 0.1 : inst;
  lastFrameTs = now;
  fpsEl.textContent = `${Math.round(fpsEMA)} fps`;
  confidenceBar.style.width = `${Math.round(lastRecognitionScore * 100)}%`;

  if (lock?.smoothedQuad && lock.target.video.readyState >= 2) {
    glRenderer.draw(lock.target.video, toOverlayQuad(lock.smoothedQuad));
  } else {
    glRenderer.clear();
  }

  requestAnimationFrame(render);
}

async function boot() {
  buildTargetGrid();
  try {
    glRenderer = makeGLRenderer(overlay);
    sizeCanvases();
    await waitForOpenCV();
    await loadTargets();
  } catch (err) {
    console.error(err);
    setStatus(`Could not start: ${err.message || err}`, 'bad');
    startBtn.textContent = 'Reload page';
    startBtn.disabled = false;
    startBtn.onclick = () => location.reload();
  }
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.textContent = 'Requesting camera…';
  try {
    await startCamera();
    running = true;
    render();

    const loop = async () => {
      if (!running) return;
      await processFrame();
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype && camera.requestVideoFrameCallback) {
        camera.requestVideoFrameCallback(() => loop());
      } else {
        requestAnimationFrame(loop);
      }
    };
    loop();
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    startBtn.textContent = 'Try camera again';
    setStatus(`Camera unavailable: ${err.message || err}`, 'bad');
  }
});

flipBtn.addEventListener('click', async () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  loseLock();
  resetTrackingFrames();
  try {
    await startCamera();
  } catch (err) {
    setStatus(`Could not flip camera: ${err.message || err}`, 'bad');
  }
});

targetsBtn.addEventListener('click', () => targetsDialog.showModal());
closeTargets.addEventListener('click', () => targetsDialog.close());
addEventListener('resize', sizeCanvases);
addEventListener('pagehide', () => stream?.getTracks().forEach(t => t.stop()));

boot();
