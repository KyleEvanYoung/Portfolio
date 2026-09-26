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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
      ...spec, width: gray.cols, height: gray.rows,
      img, gray, keypoints, descriptors, video
    });
    rgba.delete(); mask.delete();
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

function sizeCanvases() {
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
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60, min: 24 }
    }
  });
  camera.srcObject = stream;
  await camera.play();
  cameraReady = true;
  sizeCanvases();
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
    const a = q[i], b = q[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) * 0.5;
}

function isSaneQuad(q) {
  if (!q || q.length !== 4) return false;
  if (q.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  const area = quadArea(q);
  const full = processCanvas.width * processCanvas.height;
  if (area < full * 0.012 || area > full * 1.7) return false;
  const padX = processCanvas.width * 0.35, padY = processCanvas.height * 0.35;
  return q.every(p => p.x > -padX && p.y > -padY && p.x < processCanvas.width + padX && p.y < processCanvas.height + padY);
}

function homographyToQuad(H, tw, th) {
  const src = cvx.matFromArray(4, 1, cvx.CV_32FC2, [0,0, tw,0, tw,th, 0,th]);
  const dst = new cvx.Mat();
  cvx.perspectiveTransform(src, dst, H);
  const d = dst.data32F;
  const q = [0,1,2,3].map(i => ({ x: d[i*2], y: d[i*2+1] }));
  src.delete(); dst.delete();
  return q;
}

function keypointPt(vec, i) {
  const kp = vec.get(i);
  return { x: kp.pt.x, y: kp.pt.y };
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
      if (pair.size() < 2) { pair.delete(); continue; }
      const m0 = pair.get(0), m1 = pair.get(1);
      if (m0.distance < SETTINGS.ratioTest * m1.distance) {
        const sp = keypointPt(frameKeypoints, m0.queryIdx);
        const tp = keypointPt(target.keypoints, m0.trainIdx);
        scenePts.push(sp.x, sp.y);
        targetPts.push(tp.x, tp.y);
      }
      pair.delete();
    }
    if (scenePts.length / 2 < SETTINGS.minGoodMatches) return null;

    const src = cvx.matFromArray(targetPts.length / 2, 1, cvx.CV_32FC2, targetPts);
    const dst = cvx.matFromArray(scenePts.length / 2, 1, cvx.CV_32FC2, scenePts);
    const mask = new cvx.Mat();
    const H = cvx.findHomography(src, dst, cvx.RANSAC, SETTINGS.ransacThreshold, mask);
    if (H.empty()) { src.delete(); dst.delete(); mask.delete(); H.delete(); return null; }

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
    const score = inliers / Math.max(SETTINGS.minInliers, targetPts.length / 2);
    src.delete(); dst.delete(); mask.delete(); H.delete();
    if (inliers < SETTINGS.minInliers || !isSaneQuad(quad)) return null;

    const n = Math.min(keptScene.length / 2, SETTINGS.maxTrackPoints);
    return {
      target,
      inliers,
      score,
      quad,
      targetPts: keptTarget.slice(0, n * 2),
      scenePts: keptScene.slice(0, n * 2)
    };
  } finally {
    knn.delete(); matcher.delete();
  }
}

function detectFeatures(gray) {
  const orb = new cvx.ORB();
  if (typeof orb.setMaxFeatures === 'function') orb.setMaxFeatures(SETTINGS.orbFeatures);
  const kp = new cvx.KeyPointVector();
  const desc = new cvx.Mat();
  const mask = new cvx.Mat();
  orb.detectAndCompute(gray, mask, kp, desc);
  mask.delete(); orb.delete();
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
  kp.delete(); desc.delete();
  return best;
}

function matPoints(flat) { return cvx.matFromArray(flat.length / 2, 1, cvx.CV_32FC2, flat); }

function trackOpticalFlow(gray) {
  if (!lock || !prevGray || lock.scenePts.length / 2 < SETTINGS.minTrackPoints) return false;
  const oldPts = matPoints(lock.scenePts);
  const nextPts = new cvx.Mat();
  const status = new cvx.Mat();
  const err = new cvx.Mat();
  const win = new cvx.Size(21, 21);
  const criteria = new cvx.TermCriteria(cvx.TermCriteria_COUNT | cvx.TermCriteria_EPS, 20, 0.03);
  cvx.calcOpticalFlowPyrLK(prevGray, gray, oldPts, nextPts, status, err, win, 3, criteria);

  const scene = [], target = [];
  const nd = nextPts.data32F;
  for (let i = 0; i < status.rows; i++) {
    if (status.data[i]) {
      const x = nd[i*2], y = nd[i*2+1];
      if (x >= -10 && y >= -10 && x <= processCanvas.width + 10 && y <= processCanvas.height + 10) {
        scene.push(x, y);
        target.push(lock.targetPts[i*2], lock.targetPts[i*2+1]);
      }
    }
  }
  oldPts.delete(); nextPts.delete(); status.delete(); err.delete();
  if (scene.length / 2 < SETTINGS.minTrackPoints) return false;

  const src = matPoints(target);
  const dst = matPoints(scene);
  const mask = new cvx.Mat();
  const H = cvx.findHomography(src, dst, cvx.RANSAC, SETTINGS.ransacThreshold, mask);
  if (H.empty()) { src.delete(); dst.delete(); mask.delete(); H.delete(); return false; }
  const quad = homographyToQuad(H, lock.target.width, lock.target.height);
  src.delete(); dst.delete(); mask.delete(); H.delete();
  if (!isSaneQuad(quad)) return false;
  lock.scenePts = scene;
  lock.targetPts = target;
  lock.rawQuad = quad;
  lock.lostFrames = 0;
  return true;
}

function smoothQuad(raw) {
  if (!lock.smoothedQuad) {
    lock.smoothedQuad = raw.map(p => ({ ...p }));
    return;
  }
  const a = SETTINGS.smoothing;
  for (let i = 0; i < 4; i++) {
    lock.smoothedQuad[i].x += (raw[i].x - lock.smoothedQuad[i].x) * a;
    lock.smoothedQuad[i].y += (raw[i].y - lock.smoothedQuad[i].y) * a;
  }
}

async function setLock(result) {
  const changed = !lock || lock.target.id !== result.target.id;
  if (changed && lock?.target?.video) lock.target.video.pause();
  lock = {
    target: result.target,
    targetPts: result.targetPts,
    scenePts: result.scenePts,
    rawQuad: result.quad,
    smoothedQuad: result.quad.map(p => ({ ...p })),
    lostFrames: 0,
    age: 0,
  };
  lastRecognitionScore = Math.min(1, result.inliers / 28);
  if (changed) {
    try { await result.target.video.play(); } catch (_) {}
    flash.classList.add('on');
    setTimeout(() => flash.classList.remove('on'), 180);
  }
  targetNameEl.textContent = `${result.target.name} • ${result.inliers} inliers`;
  setStatus(`Tracking ${result.target.name}`, 'ok');
}

function loseLock() {
  if (lock?.target?.video) lock.target.video.pause();
  lock = null;
  lastRecognitionScore = 0;
  targetNameEl.textContent = 'Searching for a target…';
  setStatus('Scanning for a target…', 'ok');
}

async function processFrame() {
  if (!running || processing || !cameraReady || !cvReady || camera.readyState < 2) return;
  processing = true;
  let gray = null;
  try {
    gray = frameToGray();
    frameIndex++;
    let tracked = false;

    if (lock) {
      tracked = trackOpticalFlow(gray);
      lock.age++;
      if (!tracked) lock.lostFrames++;
      if (tracked) smoothQuad(lock.rawQuad);

      if (lock.age % SETTINGS.refreshLockEveryFrames === 0) {
        const refreshed = recognise(gray, lock.target);
        if (refreshed) await setLock(refreshed);
      }
      if (lock && lock.lostFrames > SETTINGS.lostFrameLimit) loseLock();
    }

    if (!lock && frameIndex % SETTINGS.recognitionEveryFrames === 0) {
      const result = recognise(gray);
      if (result) await setLock(result);
    }

    if (prevGray) prevGray.delete();
    prevGray = gray.clone();
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

function makeGLRenderer(canvas) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) throw new Error('WebGL is required for the video overlay.');
  const vs = `
    attribute vec2 a_pos;
    attribute vec2 a_uv;
    varying vec2 v_uv;
    void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); v_uv = a_uv; }
  `;
  const fs = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_tex;
    void main(){ gl_FragColor = texture2D(u_tex, v_uv); }
  `;
  function shader(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  gl.useProgram(program);
  const posLoc = gl.getAttribLocation(program, 'a_pos');
  const uvLoc = gl.getAttribLocation(program, 'a_uv');
  const posBuf = gl.createBuffer();
  const uvBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 1,1, 0,0, 1,1, 0,1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(uvLoc);
  gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.clearColor(0,0,0,0);

  return {
    resize(w, h) { gl.viewport(0,0,w,h); },
    clear() { gl.clear(gl.COLOR_BUFFER_BIT); },
    draw(video, q) {
      if (!q || q.length !== 4) return this.clear();
      const W = canvas.width, H = canvas.height;
      const clip = q.map(p => [p.x / W * 2 - 1, 1 - p.y / H * 2]);
      // TL,TR,BR + TL,BR,BL
      const v = new Float32Array([
        ...clip[0], ...clip[1], ...clip[2],
        ...clip[0], ...clip[2], ...clip[3]
      ]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); } catch (_) { return; }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  };
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
  try { await startCamera(); } catch (err) { setStatus(`Could not flip camera: ${err.message || err}`, 'bad'); }
});

targetsBtn.addEventListener('click', () => targetsDialog.showModal());
closeTargets.addEventListener('click', () => targetsDialog.close());
addEventListener('resize', sizeCanvases);
addEventListener('pagehide', () => stream?.getTracks().forEach(t => t.stop()));

boot();
