(() => {
  'use strict';

  const CONFIG = {
    maxReferenceWidth: 720,
    processLongSide: 480,
    maxFeatures: 950,
    minRecognitionInliers: 10,
    minTrackingInliers: 8,
    maxGoodMatches: 90,
    searchEveryMs: 115,
    refreshEveryMs: 700,
    lostAfterMs: 320,
    cornerSmoothing: 0.74,
    minFrameGapMs: 16
  };

  const els = {
    camera: document.getElementById('camera'),
    overlayLayer: document.getElementById('overlayLayer'),
    canvas: document.getElementById('processCanvas'),
    statusPill: document.getElementById('statusPill'),
    statusText: document.getElementById('statusText'),
    fps: document.getElementById('fpsPill'),
    startScreen: document.getElementById('startScreen'),
    startButton: document.getElementById('startButton'),
    startHint: document.getElementById('startHint'),
    targetsButton: document.getElementById('targetsButton'),
    stopButton: document.getElementById('stopButton'),
    targetsPanel: document.getElementById('targetsPanel'),
    closeTargets: document.getElementById('closeTargets'),
    targetsList: document.getElementById('targetsList'),
    toast: document.getElementById('toast')
  };

  const state = {
    cv: null,
    cvReady: false,
    referencesReady: false,
    stream: null,
    running: false,
    busy: false,
    orb: null,
    matcher: null,
    targets: [],
    activeIndex: null,
    activeCorners: null,
    prevGray: null,
    prevScenePts: null,
    trackObjectPoints: [],
    lastSearch: 0,
    lastRefresh: 0,
    lastSeen: 0,
    lastProcessed: 0,
    lostFrames: 0,
    processedFrames: 0,
    fpsWindowStart: performance.now(),
    avgProcessMs: 12,
    frameHandle: null,
    usingVideoFrameCallback: false
  };

  const ctx = els.canvas.getContext('2d', { willReadFrequently: true, alpha: false });

  buildTargetPanel();
  bindUI();

  // Emscripten callback used by the official OpenCV.js build.
  window.Module = window.Module || {};
  window.Module.onRuntimeInitialized = () => prepareOpenCv();
  window.onOpenCvScriptLoaded = () => prepareOpenCv();

  async function prepareOpenCv() {
    if (state.cvReady) return;
    try {
      let candidate = window.cv;
      if (!candidate) return;
      candidate = candidate instanceof Promise ? await candidate : candidate;
      if (!candidate || !candidate.Mat) return;
      state.cv = candidate;
      window.cv = candidate;
      state.cvReady = true;
      setStatus('Preparing image library…', 'live');
      await prepareReferences();
      els.startButton.disabled = false;
      els.startButton.textContent = 'Start AR camera';
      els.startHint.textContent = 'Tap Start, then allow camera access.';
      setStatus('Ready', 'live');
    } catch (error) {
      console.error(error);
      fatal('OpenCV could not start. Check your internet connection and reload.');
    }
  }

  function bindUI() {
    els.startButton.addEventListener('click', startCamera);
    els.stopButton.addEventListener('click', stopCamera);
    els.targetsButton.addEventListener('click', () => setTargetsPanel(true));
    els.closeTargets.addEventListener('click', () => setTargetsPanel(false));
    els.targetsPanel.addEventListener('click', e => {
      if (e.target === els.targetsPanel) setTargetsPanel(false);
    });
    window.addEventListener('resize', () => {
      if (state.activeCorners && state.activeIndex !== null) {
        updateOverlay(state.activeCorners, state.targets[state.activeIndex]);
      }
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.running) hideAllOverlays(false);
    });
  }

  function buildTargetPanel() {
    const defs = window.AR_TARGETS || [];
    els.targetsList.innerHTML = defs.map((target, i) => `
      <article class="target-card">
        <img src="${target.image}" alt="Target ${i + 1}: ${escapeHtml(target.name)}" loading="eager" />
        <div class="target-copy">
          <div class="target-name">${i + 1}. ${escapeHtml(target.name)}</div>
          <div class="target-path">${escapeHtml(target.image)} → ${escapeHtml(target.video)}</div>
        </div>
      </article>
    `).join('');
  }

  async function prepareReferences() {
    if (state.referencesReady) return;
    const cv = state.cv;
    const defs = window.AR_TARGETS || [];
    if (!defs.length) throw new Error('No AR_TARGETS configured.');

    state.orb = cv.ORB.create ? cv.ORB.create(CONFIG.maxFeatures) : new cv.ORB(CONFIG.maxFeatures);
    state.matcher = cv.BFMatcher.create ? cv.BFMatcher.create(cv.NORM_HAMMING, true) : new cv.BFMatcher(cv.NORM_HAMMING, true);

    for (let i = 0; i < defs.length; i++) {
      setStatus(`Indexing target ${i + 1}/${defs.length}…`, 'live');
      const img = await loadImage(defs[i].image);
      const src = cv.imread(img);
      const gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      const scale = Math.min(1, CONFIG.maxReferenceWidth / gray.cols);
      const work = new cv.Mat();
      if (scale < 1) {
        cv.resize(gray, work, new cv.Size(Math.max(1, Math.round(gray.cols * scale)), Math.max(1, Math.round(gray.rows * scale))), 0, 0, cv.INTER_AREA);
      } else {
        gray.copyTo(work);
      }

      const keypoints = new cv.KeyPointVector();
      const descriptors = new cv.Mat();
      const emptyMask = new cv.Mat();
      state.orb.detectAndCompute(work, emptyMask, keypoints, descriptors);
      emptyMask.delete();

      if (descriptors.empty() || keypoints.size() < 20) {
        src.delete(); gray.delete(); work.delete(); keypoints.delete(); descriptors.delete();
        throw new Error(`Target ${defs[i].image} does not contain enough visual features.`);
      }

      const video = document.createElement('video');
      video.className = 'ar-video';
      video.src = defs[i].video;
      video.loop = true;
      video.muted = true;
      video.autoplay = false;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.preload = 'auto';
      video.style.width = `${work.cols}px`;
      video.style.height = `${work.rows}px`;
      els.overlayLayer.appendChild(video);

      state.targets.push({
        ...defs[i],
        keypoints,
        descriptors,
        cvWidth: work.cols,
        cvHeight: work.rows,
        video
      });

      src.delete();
      gray.delete();
      work.delete();
    }

    state.referencesReady = true;
  }

  async function startCamera() {
    if (!state.cvReady || !state.referencesReady || state.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      fatal('This browser does not provide camera access. Use a current Safari, Chrome, Edge, or Firefox browser.');
      return;
    }

    els.startButton.disabled = true;
    els.startButton.textContent = 'Waiting for camera permission…';
    setStatus('Waiting for camera permission…', 'live');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60, max: 60 }
        }
      });
      state.stream = stream;
      els.camera.srcObject = stream;
      await els.camera.play();
      await waitForVideoDimensions(els.camera);
      configureProcessCanvas();

      state.running = true;
      state.lastSearch = 0;
      state.lastRefresh = 0;
      state.lastSeen = performance.now();
      state.lastProcessed = 0;
      state.fpsWindowStart = performance.now();
      state.processedFrames = 0;

      els.startScreen.classList.add('hidden');
      els.stopButton.disabled = false;
      els.startButton.textContent = 'Start AR camera';
      els.startButton.disabled = false;
      setStatus('Searching for a target image…', 'live');
      showToast('Camera active — point it at one of the 3 target images.');
      scheduleFrame();
    } catch (error) {
      console.error(error);
      els.startButton.disabled = false;
      els.startButton.textContent = 'Try camera again';
      if (error?.name === 'NotAllowedError') {
        setStatus('Camera permission denied', '');
        els.startHint.textContent = 'Camera access was blocked. Allow camera permission for this site, then try again.';
      } else {
        setStatus('Camera could not start', '');
        els.startHint.textContent = `${error?.message || 'Camera error'}`;
      }
    }
  }

  function stopCamera() {
    state.running = false;
    if (state.frameHandle && !state.usingVideoFrameCallback) cancelAnimationFrame(state.frameHandle);
    state.frameHandle = null;
    if (state.stream) state.stream.getTracks().forEach(track => track.stop());
    state.stream = null;
    els.camera.srcObject = null;
    resetTracking(true);
    hideAllOverlays(true);
    els.stopButton.disabled = true;
    els.startScreen.classList.remove('hidden');
    els.startButton.disabled = false;
    els.startButton.textContent = 'Start AR camera';
    setStatus('Ready', 'live');
    els.fps.textContent = '-- fps';
  }

  function configureProcessCanvas() {
    const w = els.camera.videoWidth;
    const h = els.camera.videoHeight;
    if (w >= h) {
      els.canvas.width = CONFIG.processLongSide;
      els.canvas.height = Math.max(1, Math.round(CONFIG.processLongSide * h / w));
    } else {
      els.canvas.height = CONFIG.processLongSide;
      els.canvas.width = Math.max(1, Math.round(CONFIG.processLongSide * w / h));
    }
  }

  function scheduleFrame() {
    if (!state.running) return;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      state.usingVideoFrameCallback = true;
      els.camera.requestVideoFrameCallback(frameTick);
    } else {
      state.usingVideoFrameCallback = false;
      state.frameHandle = requestAnimationFrame(frameTick);
    }
  }

  function frameTick(now) {
    if (!state.running) return;
    const gap = Math.max(CONFIG.minFrameGapMs, Math.min(45, state.avgProcessMs * 0.92));
    if (!state.busy && now - state.lastProcessed >= gap) {
      state.busy = true;
      const started = performance.now();
      try {
        processFrame(started);
      } catch (error) {
        console.error('Frame processing error:', error);
      } finally {
        const elapsed = performance.now() - started;
        state.avgProcessMs = state.avgProcessMs * 0.88 + elapsed * 0.12;
        state.lastProcessed = now;
        state.busy = false;
      }
    }
    scheduleFrame();
  }

  function processFrame(now) {
    const cv = state.cv;
    ctx.drawImage(els.camera, 0, 0, els.canvas.width, els.canvas.height);
    const rgba = cv.imread(els.canvas);
    const gray = new cv.Mat();
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    rgba.delete();

    let tracked = false;
    if (state.activeIndex !== null && state.prevGray && state.prevScenePts && state.trackObjectPoints.length >= CONFIG.minTrackingInliers) {
      tracked = trackWithOpticalFlow(state.prevGray, gray);
      if (tracked) {
        state.lastSeen = now;
        state.lostFrames = 0;
      } else {
        state.lostFrames += 1;
      }
    }

    if (state.activeIndex !== null && now - state.lastRefresh >= CONFIG.refreshEveryMs) {
      const refreshed = recognize(gray, [state.activeIndex]);
      state.lastRefresh = now;
      if (refreshed) {
        adoptRecognition(refreshed, false);
        tracked = true;
        state.lastSeen = now;
        state.lostFrames = 0;
      }
    }

    if (state.activeIndex === null && now - state.lastSearch >= CONFIG.searchEveryMs) {
      const recognized = recognize(gray, state.targets.map((_, i) => i));
      state.lastSearch = now;
      if (recognized) {
        adoptRecognition(recognized, true);
        state.lastRefresh = now;
        state.lastSeen = now;
        tracked = true;
      }
    }

    if (state.activeIndex !== null && !tracked && state.lostFrames >= 3 && now - state.lastSeen > CONFIG.lostAfterMs) {
      resetTracking(false);
      setStatus('Searching for a target image…', 'live');
    }

    replacePrevGray(gray);
    gray.delete();
    updateFps(now);
  }

  function recognize(gray, targetIndexes) {
    const cv = state.cv;
    const frameKeypoints = new cv.KeyPointVector();
    const frameDescriptors = new cv.Mat();
    const emptyMask = new cv.Mat();
    state.orb.detectAndCompute(gray, emptyMask, frameKeypoints, frameDescriptors);
    emptyMask.delete();

    if (frameDescriptors.empty() || frameKeypoints.size() < 12) {
      frameKeypoints.delete();
      frameDescriptors.delete();
      return null;
    }

    let best = null;

    for (const targetIndex of targetIndexes) {
      const target = state.targets[targetIndex];
      const matches = new cv.DMatchVector();
      state.matcher.match(target.descriptors, frameDescriptors, matches);

      const sorted = [];
      for (let i = 0; i < matches.size(); i++) {
        const m = matches.get(i);
        sorted.push({ queryIdx: m.queryIdx, trainIdx: m.trainIdx, distance: m.distance });
      }
      matches.delete();
      sorted.sort((a, b) => a.distance - b.distance);
      if (sorted.length < CONFIG.minRecognitionInliers) continue;

      const bestDistance = sorted[0].distance;
      const cutoff = Math.min(78, Math.max(38, bestDistance * 2.15));
      const good = sorted.filter(m => m.distance <= cutoff).slice(0, CONFIG.maxGoodMatches);
      if (good.length < CONFIG.minRecognitionInliers) continue;

      const srcData = [];
      const dstData = [];
      for (const m of good) {
        const a = target.keypoints.get(m.queryIdx).pt;
        const b = frameKeypoints.get(m.trainIdx).pt;
        srcData.push(a.x, a.y);
        dstData.push(b.x, b.y);
      }

      const srcPts = cv.matFromArray(good.length, 1, cv.CV_32FC2, srcData);
      const dstPts = cv.matFromArray(good.length, 1, cv.CV_32FC2, dstData);
      const H = cv.findHomography(srcPts, dstPts, cv.RANSAC, 3.2);

      if (H.empty()) {
        srcPts.delete(); dstPts.delete(); H.delete();
        continue;
      }

      // Compute our own reprojection inliers. This avoids depending on the
      // optional findHomography output-mask overload, which varies between
      // OpenCV.js builds.
      const projected = new cv.Mat();
      cv.perspectiveTransform(srcPts, projected, H);
      const projectedData = projected.data32F;
      let inliers = 0;
      const objectPoints = [];
      const scenePoints = [];
      for (let i = 0; i < good.length; i++) {
        const dx = projectedData[i * 2] - dstData[i * 2];
        const dy = projectedData[i * 2 + 1] - dstData[i * 2 + 1];
        if (dx * dx + dy * dy <= 4.2 * 4.2) {
          inliers++;
          objectPoints.push({ x: srcData[i * 2], y: srcData[i * 2 + 1] });
          scenePoints.push({ x: dstData[i * 2], y: dstData[i * 2 + 1] });
        }
      }
      projected.delete();
      const ratio = inliers / good.length;
      const corners = projectTargetCorners(H, target.cvWidth, target.cvHeight);
      const valid = inliers >= CONFIG.minRecognitionInliers && ratio >= 0.34 && validateQuad(corners, gray.cols, gray.rows);

      if (valid) {
        const medianDistance = good[Math.floor(good.length / 2)].distance;
        const score = inliers * 2.1 + ratio * 18 - medianDistance * 0.08;
        if (!best || score > best.score) {
          best = { targetIndex, corners, objectPoints, scenePoints, score, inliers };
        }
      }

      srcPts.delete(); dstPts.delete(); H.delete();
    }

    frameKeypoints.delete();
    frameDescriptors.delete();
    return best;
  }

  function trackWithOpticalFlow(prevGray, gray) {
    const cv = state.cv;
    const nextPts = new cv.Mat();
    const status = new cv.Mat();
    const err = new cv.Mat();

    cv.calcOpticalFlowPyrLK(prevGray, gray, state.prevScenePts, nextPts, status, err);

    const objectPoints = [];
    const scenePoints = [];
    const nextData = nextPts.data32F;
    for (let i = 0; i < state.trackObjectPoints.length; i++) {
      if (status.data[i]) {
        const x = nextData[i * 2];
        const y = nextData[i * 2 + 1];
        if (Number.isFinite(x) && Number.isFinite(y) && x >= -8 && y >= -8 && x <= gray.cols + 8 && y <= gray.rows + 8) {
          objectPoints.push(state.trackObjectPoints[i]);
          scenePoints.push({ x, y });
        }
      }
    }

    nextPts.delete(); status.delete(); err.delete();
    if (objectPoints.length < CONFIG.minTrackingInliers) return false;

    const srcData = objectPoints.flatMap(p => [p.x, p.y]);
    const dstData = scenePoints.flatMap(p => [p.x, p.y]);
    const srcPts = cv.matFromArray(objectPoints.length, 1, cv.CV_32FC2, srcData);
    const dstPts = cv.matFromArray(scenePoints.length, 1, cv.CV_32FC2, dstData);
    const H = cv.findHomography(srcPts, dstPts, cv.RANSAC, 3.5);

    if (H.empty()) {
      srcPts.delete(); dstPts.delete(); H.delete();
      return false;
    }

    const projected = new cv.Mat();
    cv.perspectiveTransform(srcPts, projected, H);
    const projectedData = projected.data32F;
    const filteredObject = [];
    const filteredScene = [];
    for (let i = 0; i < objectPoints.length; i++) {
      const dx = projectedData[i * 2] - dstData[i * 2];
      const dy = projectedData[i * 2 + 1] - dstData[i * 2 + 1];
      if (dx * dx + dy * dy <= 4.5 * 4.5) {
        filteredObject.push(objectPoints[i]);
        filteredScene.push(scenePoints[i]);
      }
    }
    projected.delete();

    const target = state.targets[state.activeIndex];
    const corners = projectTargetCorners(H, target.cvWidth, target.cvHeight);
    const valid = filteredObject.length >= CONFIG.minTrackingInliers && validateQuad(corners, gray.cols, gray.rows);

    if (valid) {
      setTrackingPoints(filteredObject, filteredScene);
      applyCorners(corners, target);
    }

    srcPts.delete(); dstPts.delete(); H.delete();
    return valid;
  }

  function projectTargetCorners(H, width, height) {
    const cv = state.cv;
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
    const dst = new cv.Mat();
    cv.perspectiveTransform(src, dst, H);
    const d = dst.data32F;
    const corners = [
      { x: d[0], y: d[1] },
      { x: d[2], y: d[3] },
      { x: d[4], y: d[5] },
      { x: d[6], y: d[7] }
    ];
    src.delete(); dst.delete();
    return corners;
  }

  function adoptRecognition(result, announce) {
    if (state.activeIndex !== result.targetIndex) {
      hideAllOverlays(false);
      state.activeIndex = result.targetIndex;
      state.activeCorners = null;
    }
    setTrackingPoints(result.objectPoints, result.scenePoints);
    applyCorners(result.corners, state.targets[result.targetIndex]);
    if (announce) {
      const name = state.targets[result.targetIndex].name;
      setStatus(`${name} recognized`, 'found');
      showToast(`${name} → playing its paired video`);
    }
  }

  function setTrackingPoints(objectPoints, scenePoints) {
    const cv = state.cv;
    state.trackObjectPoints = objectPoints.map(p => ({ x: p.x, y: p.y }));
    if (state.prevScenePts) state.prevScenePts.delete();
    const data = scenePoints.flatMap(p => [p.x, p.y]);
    state.prevScenePts = cv.matFromArray(scenePoints.length, 1, cv.CV_32FC2, data);
  }

  function applyCorners(corners, target) {
    if (!state.activeCorners) {
      state.activeCorners = corners.map(p => ({ ...p }));
    } else {
      const a = CONFIG.cornerSmoothing;
      state.activeCorners = corners.map((p, i) => ({
        x: state.activeCorners[i].x * (1 - a) + p.x * a,
        y: state.activeCorners[i].y * (1 - a) + p.y * a
      }));
    }
    updateOverlay(state.activeCorners, target);
    if (target.video.paused) target.video.play().catch(() => {});
    target.video.classList.add('visible');
  }

  function updateOverlay(processCorners, target) {
    const screenCorners = processCorners.map(processPointToScreen);
    const H = homographyFromFourPoints(
      [
        { x: 0, y: 0 },
        { x: target.cvWidth, y: 0 },
        { x: target.cvWidth, y: target.cvHeight },
        { x: 0, y: target.cvHeight }
      ],
      screenCorners
    );
    if (!H) return;
    const [h11,h12,h13,h21,h22,h23,h31,h32] = H;
    target.video.style.transform = `matrix3d(${h11},${h21},0,${h31},${h12},${h22},0,${h32},0,0,1,0,${h13},${h23},0,1)`;
  }

  function processPointToScreen(p) {
    const rawW = els.camera.videoWidth;
    const rawH = els.camera.videoHeight;
    const procW = els.canvas.width;
    const procH = els.canvas.height;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    const rawX = p.x * rawW / procW;
    const rawY = p.y * rawH / procH;
    const scale = Math.max(viewportW / rawW, viewportH / rawH);
    const offsetX = (viewportW - rawW * scale) / 2;
    const offsetY = (viewportH - rawH * scale) / 2;
    return { x: rawX * scale + offsetX, y: rawY * scale + offsetY };
  }

  function homographyFromFourPoints(src, dst) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i];
      const { x: u, y: v } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u*x, -u*y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v*x, -v*y]); b.push(v);
    }
    return solveLinearSystem(A, b);
  }

  function solveLinearSystem(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.slice().concat(b[i]));
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
      }
      if (Math.abs(M[pivot][col]) < 1e-9) return null;
      [M[col], M[pivot]] = [M[pivot], M[col]];
      const div = M[col][col];
      for (let j = col; j <= n; j++) M[col][j] /= div;
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = M[row][col];
        for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
      }
    }
    return M.map(row => row[n]);
  }

  function validateQuad(corners, frameW, frameH) {
    if (!corners || corners.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
    const area = polygonArea(corners);
    const frameArea = frameW * frameH;
    if (area < frameArea * 0.008 || area > frameArea * 1.18) return false;

    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i+1)%4], c = corners[(i+2)%4];
      const cross = (b.x-a.x)*(c.y-b.y) - (b.y-a.y)*(c.x-b.x);
      if (Math.abs(cross) < 1e-4) return false;
      const s = Math.sign(cross);
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  function polygonArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  }

  function replacePrevGray(gray) {
    if (state.prevGray) state.prevGray.delete();
    state.prevGray = gray.clone();
  }

  function resetTracking(full) {
    state.activeIndex = null;
    state.activeCorners = null;
    state.trackObjectPoints = [];
    state.lostFrames = 0;
    if (state.prevScenePts) { state.prevScenePts.delete(); state.prevScenePts = null; }
    if (full && state.prevGray) { state.prevGray.delete(); state.prevGray = null; }
    hideAllOverlays(false);
  }

  function hideAllOverlays(resetTime) {
    for (const target of state.targets) {
      target.video.classList.remove('visible');
      target.video.pause();
      if (resetTime) {
        try { target.video.currentTime = 0; } catch (_) {}
      }
    }
  }

  function updateFps(now) {
    state.processedFrames++;
    const elapsed = now - state.fpsWindowStart;
    if (elapsed >= 700) {
      const fps = Math.round(state.processedFrames * 1000 / elapsed);
      els.fps.textContent = `${fps} fps`;
      state.processedFrames = 0;
      state.fpsWindowStart = now;
    }
  }

  function setStatus(text, mode) {
    els.statusText.textContent = text;
    els.statusPill.classList.remove('live', 'found');
    if (mode) els.statusPill.classList.add(mode);
  }

  function setTargetsPanel(open) {
    els.targetsPanel.classList.toggle('open', open);
    els.targetsPanel.setAttribute('aria-hidden', String(!open));
  }

  let toastTimer = 0;
  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add('show');
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  function fatal(message) {
    setStatus('Setup error', '');
    els.startButton.disabled = true;
    els.startButton.textContent = 'Unable to start';
    els.startHint.textContent = message;
    showToast(message);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${src}`));
      img.src = src;
    });
  }

  function waitForVideoDimensions(video) {
    if (video.videoWidth && video.videoHeight) return Promise.resolve();
    return new Promise(resolve => {
      const handler = () => {
        if (video.videoWidth && video.videoHeight) {
          video.removeEventListener('loadedmetadata', handler);
          resolve();
        }
      };
      video.addEventListener('loadedmetadata', handler);
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));
  }
})();
