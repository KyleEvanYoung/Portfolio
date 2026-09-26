'use strict';

const TARGETS = [
  { id: 'orbit', name: 'ORBIT', image: 'assets/images/target-1.png', video: 'assets/videos/video-1.mp4' },
  { id: 'pulse', name: 'PULSE', image: 'assets/images/target-2.png', video: 'assets/videos/video-2.mp4' },
  { id: 'grid',  name: 'GRID',  image: 'assets/images/target-3.png', video: 'assets/videos/video-3.mp4' },
];

const PROCESSING_MAX_WIDTH = 640;
const TARGET_FPS = 30;
const FRAME_INTERVAL = 1000 / TARGET_FPS;
const RATIO_TEST = 0.74;
const MIN_GOOD_MATCHES = 16;
const MIN_INLIERS = 12;
const MIN_INLIER_RATIO = 0.45;
const MAX_REPROJECTION_ERROR = 6.0;
const LOST_FRAME_LIMIT = 10;

const cameraVideo = document.getElementById('cameraVideo');
const outputCanvas = document.getElementById('outputCanvas');
const outputCtx = outputCanvas.getContext('2d', { alpha: false, desynchronized: true });
const warpCanvas = document.getElementById('warpCanvas');
const overlaySourceCanvas = document.getElementById('overlaySourceCanvas');
const overlaySourceCtx = overlaySourceCanvas.getContext('2d', { alpha: true, desynchronized: true });
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusText = document.getElementById('statusText');
const fpsValue = document.getElementById('fpsValue');
const matchValue = document.getElementById('matchValue');
const posePanel = document.getElementById('posePanel');
const yawValue = document.getElementById('yawValue');
const pitchValue = document.getElementById('pitchValue');
const rollValue = document.getElementById('rollValue');
const depthValue = document.getElementById('depthValue');
const targetList = document.getElementById('targetList');

let cvReady = false;
let modelsReady = false;
let running = false;
let mediaStream = null;
let orb = null;
let matcher = null;
let activeTarget = null;
let lostFrames = 0;
let lastFrameAt = 0;
let fpsWindowStart = performance.now();
let fpsFrames = 0;
let animationHandle = null;

function setStatus(message) {
  statusText.textContent = message;
}

function safeDelete(obj) {
  if (obj && typeof obj.delete === 'function') {
    try { obj.delete(); } catch (_) { /* no-op */ }
  }
}

function renderTargetList() {
  targetList.innerHTML = TARGETS.map(t => `
    <article class="target-card" data-target-id="${t.id}">
      <img src="${t.image}" alt="${t.name} test target" />
      <div>
        <h2>${t.name}</h2>
        <p>${t.image.split('/').pop()}</p>
        <div class="mapping">→ ${t.video.split('/').pop()}</div>
      </div>
    </article>
  `).join('');
}

function updateActiveCard() {
  document.querySelectorAll('.target-card').forEach(card => {
    card.classList.toggle('active', activeTarget && card.dataset.targetId === activeTarget.id);
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${url}`));
    img.src = url;
  });
}

function makeVideo(url) {
  const video = document.createElement('video');
  video.src = url;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  return video;
}

async function waitForOpenCV(timeoutMs = 30000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (window.cv) {
      if (typeof window.cv.then === 'function') {
        try { window.cv = await window.cv; } catch (_) { /* keep polling */ }
      }
      if (window.cv && window.cv.Mat && window.cv.ORB) return window.cv;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('OpenCV.js did not finish loading. Check your internet connection or self-host opencv.js.');
}

async function buildTargetModels() {
  setStatus('Preparing target image descriptors…');
  orb = new cv.ORB();
  if (typeof orb.setMaxFeatures === 'function') orb.setMaxFeatures(900);
  matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);

  for (const target of TARGETS) {
    const img = await loadImage(target.image);
    target.width = img.naturalWidth;
    target.height = img.naturalHeight;
    target.videoEl = makeVideo(target.video);

    const rgba = cv.imread(img);
    const gray = new cv.Mat();
    const mask = new cv.Mat();
    const keypoints = new cv.KeyPointVector();
    const descriptors = new cv.Mat();
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    orb.detectAndCompute(gray, mask, keypoints, descriptors);

    target.keypoints = keypoints;
    target.descriptors = descriptors;

    safeDelete(rgba);
    safeDelete(gray);
    safeDelete(mask);
  }
  modelsReady = true;
  setStatus('Ready — start the camera');
  startButton.disabled = false;
}

async function startCamera() {
  if (!cvReady || !modelsReady || running) return;
  try {
    setStatus('Requesting camera permission…');
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
    cameraVideo.srcObject = mediaStream;
    await cameraVideo.play();

    const srcW = cameraVideo.videoWidth;
    const srcH = cameraVideo.videoHeight;
    const scale = Math.min(1, PROCESSING_MAX_WIDTH / srcW);
    outputCanvas.width = Math.max(1, Math.round(srcW * scale));
    outputCanvas.height = Math.max(1, Math.round(srcH * scale));
    warpCanvas.width = outputCanvas.width;
    warpCanvas.height = outputCanvas.height;

    running = true;
    startButton.disabled = true;
    stopButton.disabled = false;
    setStatus('Scanning for ORBIT, PULSE, or GRID…');
    lastFrameAt = performance.now() - FRAME_INTERVAL;
    fpsWindowStart = performance.now();
    fpsFrames = 0;
    animationHandle = requestAnimationFrame(processLoop);
  } catch (err) {
    console.error(err);
    setStatus(`Camera error: ${err.message}`);
  }
}

function stopCamera() {
  running = false;
  if (animationHandle) cancelAnimationFrame(animationHandle);
  animationHandle = null;
  if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
  mediaStream = null;
  cameraVideo.srcObject = null;
  deactivateTarget();
  outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
  setStatus('Stopped');
  startButton.disabled = !modelsReady;
  stopButton.disabled = true;
  fpsValue.textContent = '0';
  matchValue.textContent = '0';
}

async function activateTarget(target) {
  if (activeTarget === target) return;
  if (activeTarget?.videoEl) activeTarget.videoEl.pause();
  activeTarget = target;
  lostFrames = 0;
  updateActiveCard();
  posePanel.hidden = false;
  setStatus(`${target.name} recognized — playing ${target.video.split('/').pop()}`);
  try {
    target.videoEl.currentTime = 0;
    await target.videoEl.play();
  } catch (err) {
    console.warn('Replacement video play was blocked:', err);
  }
}

function deactivateTarget() {
  if (activeTarget?.videoEl) activeTarget.videoEl.pause();
  activeTarget = null;
  lostFrames = 0;
  updateActiveCard();
  posePanel.hidden = true;
}

function getKeypointXY(vector, index) {
  const kp = vector.get(index);
  const point = kp.pt;
  const xy = [point.x, point.y];
  safeDelete(kp);
  return xy;
}

function hValues(H) {
  if (H.data64F && H.data64F.length >= 9) return Array.from(H.data64F.slice(0, 9));
  if (H.data32F && H.data32F.length >= 9) return Array.from(H.data32F.slice(0, 9));
  return null;
}

function project(H, x, y) {
  const z = H[6] * x + H[7] * y + H[8];
  if (!Number.isFinite(z) || Math.abs(z) < 1e-8) return null;
  return [
    (H[0] * x + H[1] * y + H[2]) / z,
    (H[3] * x + H[4] * y + H[5]) / z
  ];
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) * 0.5;
}

function validateHomography(H, target, srcPoints, dstPoints, frameW, frameH) {
  const vals = hValues(H);
  if (!vals || vals.some(v => !Number.isFinite(v))) return null;

  let inliers = 0;
  let errorSum = 0;
  for (let i = 0; i < srcPoints.length; i++) {
    const p = project(vals, srcPoints[i][0], srcPoints[i][1]);
    if (!p) continue;
    const dx = p[0] - dstPoints[i][0];
    const dy = p[1] - dstPoints[i][1];
    const error = Math.hypot(dx, dy);
    if (error <= MAX_REPROJECTION_ERROR) {
      inliers++;
      errorSum += error;
    }
  }
  if (inliers < MIN_INLIERS || inliers / srcPoints.length < MIN_INLIER_RATIO) return null;

  const corners = [
    project(vals, 0, 0),
    project(vals, target.width, 0),
    project(vals, target.width, target.height),
    project(vals, 0, target.height)
  ];
  if (corners.some(p => !p || p.some(v => !Number.isFinite(v)))) return null;

  const area = polygonArea(corners);
  const frameArea = frameW * frameH;
  if (area < frameArea * 0.018 || area > frameArea * 1.35) return null;

  const marginX = frameW * 0.35;
  const marginY = frameH * 0.35;
  if (corners.some(([x, y]) => x < -marginX || x > frameW + marginX || y < -marginY || y > frameH + marginY)) return null;

  return {
    values: vals,
    corners,
    inliers,
    avgError: inliers ? errorSum / inliers : Infinity
  };
}

function matchTarget(target, frameKeypoints, frameDescriptors, frameW, frameH) {
  if (!target.descriptors || target.descriptors.rows < 2 || frameDescriptors.rows < 2) return null;

  const matches = new cv.DMatchVectorVector();
  let srcMat = null;
  let dstMat = null;
  let H = null;
  try {
    matcher.knnMatch(target.descriptors, frameDescriptors, matches, 2);
    const good = [];

    for (let i = 0; i < matches.size(); i++) {
      const pair = matches.get(i);
      try {
        if (pair.size() < 2) continue;
        const m = pair.get(0);
        const n = pair.get(1);
        try {
          if (m.distance < RATIO_TEST * n.distance) {
            good.push({ queryIdx: m.queryIdx, trainIdx: m.trainIdx, distance: m.distance });
          }
        } finally {
          safeDelete(m);
          safeDelete(n);
        }
      } finally {
        safeDelete(pair);
      }
    }

    if (good.length < MIN_GOOD_MATCHES) return { target, goodMatches: good.length, valid: false };

    const srcPoints = [];
    const dstPoints = [];
    const srcData = [];
    const dstData = [];
    for (const m of good) {
      const src = getKeypointXY(target.keypoints, m.queryIdx);
      const dst = getKeypointXY(frameKeypoints, m.trainIdx);
      srcPoints.push(src);
      dstPoints.push(dst);
      srcData.push(src[0], src[1]);
      dstData.push(dst[0], dst[1]);
    }

    srcMat = cv.matFromArray(good.length, 1, cv.CV_32FC2, srcData);
    dstMat = cv.matFromArray(good.length, 1, cv.CV_32FC2, dstData);
    H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 4.0);
    if (!H || H.empty()) return { target, goodMatches: good.length, valid: false };

    const validation = validateHomography(H, target, srcPoints, dstPoints, frameW, frameH);
    if (!validation) return { target, goodMatches: good.length, valid: false };

    return {
      target,
      goodMatches: good.length,
      valid: true,
      inliers: validation.inliers,
      avgError: validation.avgError,
      homography: H.clone(),
      homographyValues: validation.values,
      corners: validation.corners,
      score: validation.inliers * 4 + good.length - validation.avgError
    };
  } catch (err) {
    console.warn('matchTarget failed for', target.id, err);
    return { target, goodMatches: 0, valid: false };
  } finally {
    safeDelete(matches);
    safeDelete(srcMat);
    safeDelete(dstMat);
    safeDelete(H);
  }
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}

function estimatePose(H, target, frameW, frameH) {
  // Approximate intrinsic matrix. For metric pose, calibrate the phone camera and use a real target width.
  const fx = frameW * 0.92;
  const fy = fx;
  const cx = frameW / 2;
  const cy = frameH / 2;

  // Re-express homography so the plane origin is at target center and one world unit ~= target width.
  const s = target.width;
  const c1 = [H[0] * s, H[3] * s, H[6] * s];
  const c2 = [H[1] * s, H[4] * s, H[7] * s];
  const c3 = [
    H[0]*(target.width/2) + H[1]*(target.height/2) + H[2],
    H[3]*(target.width/2) + H[4]*(target.height/2) + H[5],
    H[6]*(target.width/2) + H[7]*(target.height/2) + H[8]
  ];

  const invK = v => [(v[0] - cx*v[2])/fx, (v[1] - cy*v[2])/fy, v[2]];
  const b1 = invK(c1), b2 = invK(c2), b3 = invK(c3);
  const lambda = 2 / ((Math.hypot(...b1) || 1) + (Math.hypot(...b2) || 1));

  let r1 = normalize(b1);
  let r2raw = normalize(b2);
  let r2 = normalize([r2raw[0]-dot(r2raw,r1)*r1[0], r2raw[1]-dot(r2raw,r1)*r1[1], r2raw[2]-dot(r2raw,r1)*r1[2]]);
  let r3 = normalize(cross(r1, r2));
  if (r3[2] < 0) { r1 = r1.map(v => -v); r2 = r2.map(v => -v); r3 = r3.map(v => -v); }

  const R = [
    [r1[0], r2[0], r3[0]],
    [r1[1], r2[1], r3[1]],
    [r1[2], r2[2], r3[2]],
  ];
  const sy = Math.hypot(R[0][0], R[1][0]);
  const singular = sy < 1e-6;
  let pitch, yaw, roll;
  if (!singular) {
    pitch = Math.atan2(R[2][1], R[2][2]);
    yaw = Math.atan2(-R[2][0], sy);
    roll = Math.atan2(R[1][0], R[0][0]);
  } else {
    pitch = Math.atan2(-R[1][2], R[1][1]);
    yaw = Math.atan2(-R[2][0], sy);
    roll = 0;
  }

  const t = b3.map(v => v * lambda);
  const deg = r => r * 180 / Math.PI;
  return { yaw: deg(yaw), pitch: deg(pitch), roll: deg(roll), depth: Math.abs(t[2]) };
}

function updatePose(homographyValues, target) {
  const pose = estimatePose(homographyValues, target, outputCanvas.width, outputCanvas.height);
  yawValue.textContent = `${pose.yaw.toFixed(1)}°`;
  pitchValue.textContent = `${pose.pitch.toFixed(1)}°`;
  rollValue.textContent = `${pose.roll.toFixed(1)}°`;
  depthValue.textContent = `${pose.depth.toFixed(2)}× target width`;
}

function renderReplacement(target, H) {
  const video = target.videoEl;
  if (!video || video.readyState < 2 || video.paused) return;

  if (overlaySourceCanvas.width !== target.width || overlaySourceCanvas.height !== target.height) {
    overlaySourceCanvas.width = target.width;
    overlaySourceCanvas.height = target.height;
  }
  overlaySourceCtx.clearRect(0, 0, target.width, target.height);
  overlaySourceCtx.drawImage(video, 0, 0, target.width, target.height);

  const src = cv.imread(overlaySourceCanvas);
  const warped = new cv.Mat();
  try {
    cv.warpPerspective(
      src,
      warped,
      H,
      new cv.Size(outputCanvas.width, outputCanvas.height),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(0, 0, 0, 0)
    );
    cv.imshow(warpCanvas, warped);
    outputCtx.drawImage(warpCanvas, 0, 0);
  } finally {
    safeDelete(src);
    safeDelete(warped);
  }
}

function drawTrackingOutline(corners) {
  if (!corners) return;
  outputCtx.save();
  outputCtx.strokeStyle = 'rgba(114,230,177,.95)';
  outputCtx.lineWidth = 3;
  outputCtx.beginPath();
  outputCtx.moveTo(corners[0][0], corners[0][1]);
  for (let i = 1; i < corners.length; i++) outputCtx.lineTo(corners[i][0], corners[i][1]);
  outputCtx.closePath();
  outputCtx.stroke();
  outputCtx.restore();
}

function processFrame() {
  outputCtx.drawImage(cameraVideo, 0, 0, outputCanvas.width, outputCanvas.height);

  const rgba = cv.imread(outputCanvas);
  const gray = new cv.Mat();
  const frameKeypoints = new cv.KeyPointVector();
  const frameDescriptors = new cv.Mat();
  const mask = new cv.Mat();
  let result = null;

  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    orb.detectAndCompute(gray, mask, frameKeypoints, frameDescriptors);

    if (frameDescriptors.rows >= 2) {
      if (activeTarget) {
        result = matchTarget(activeTarget, frameKeypoints, frameDescriptors, outputCanvas.width, outputCanvas.height);
        if (!result?.valid) {
          lostFrames++;
          matchValue.textContent = String(result?.goodMatches || 0);
          if (lostFrames >= LOST_FRAME_LIMIT) {
            deactivateTarget();
            setStatus('Target lost — scanning again…');
          }
        } else {
          lostFrames = 0;
        }
      }

      if (!activeTarget) {
        let best = null;
        for (const target of TARGETS) {
          const candidate = matchTarget(target, frameKeypoints, frameDescriptors, outputCanvas.width, outputCanvas.height);
          if (candidate?.valid && (!best || candidate.score > best.score)) {
            safeDelete(best?.homography);
            best = candidate;
          } else {
            safeDelete(candidate?.homography);
          }
        }
        if (best) {
          result = best;
          activateTarget(best.target);
        }
      }
    }

    if (result?.valid && activeTarget === result.target) {
      matchValue.textContent = String(result.inliers);
      updatePose(result.homographyValues, result.target);
      renderReplacement(result.target, result.homography);
      drawTrackingOutline(result.corners);
    }
  } finally {
    safeDelete(result?.homography);
    safeDelete(rgba);
    safeDelete(gray);
    safeDelete(frameKeypoints);
    safeDelete(frameDescriptors);
    safeDelete(mask);
  }
}

function processLoop(now) {
  if (!running) return;
  animationHandle = requestAnimationFrame(processLoop);
  if (cameraVideo.readyState < 2) return;
  if (now - lastFrameAt < FRAME_INTERVAL) return;
  lastFrameAt = now;

  try {
    processFrame();
  } catch (err) {
    console.error(err);
    setStatus(`Tracking error: ${err.message}`);
  }

  fpsFrames++;
  const elapsed = now - fpsWindowStart;
  if (elapsed >= 750) {
    fpsValue.textContent = String(Math.round((fpsFrames * 1000) / elapsed));
    fpsFrames = 0;
    fpsWindowStart = now;
  }
}

startButton.addEventListener('click', startCamera);
stopButton.addEventListener('click', stopCamera);
window.addEventListener('pagehide', stopCamera);

renderTargetList();

(async function init() {
  try {
    await waitForOpenCV();
    cvReady = true;
    await buildTargetModels();
  } catch (err) {
    console.error(err);
    setStatus(err.message);
  }
})();
