const camera = document.querySelector('#camera');
const arVideo = document.querySelector('#arVideo');
const startBtn = document.querySelector('#startBtn');
const startPanel = document.querySelector('#startPanel');
const statusEl = document.querySelector('#status');
const soundBtn = document.querySelector('#soundBtn');

// Add more pairs here later. A production version plugs an image-tracking
// library into the `onTargetFound` / `onTargetLost` functions below.
const targets = [
  { id: 'photo-1', image: 'photo.png', video: 'video.mp4' }
];

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    camera.srcObject = stream;
    await camera.play();
    startPanel.hidden = true;
    statusEl.textContent = 'Camera running — point it at photo.png';

    // Prototype demonstration: after the camera starts, show the stand-in
    // video. Replace this timer with a real image-tracker callback.
    setTimeout(() => onTargetFound(targets[0]), 1800);
  } catch (err) {
    statusEl.textContent = 'Camera permission was not granted.';
    console.error(err);
  }
}

function onTargetFound(target) {
  arVideo.src = target.video;
  arVideo.style.display = 'block';
  arVideo.play().catch(() => {});
  statusEl.textContent = `Recognised ${target.id}`;
}

function onTargetLost() {
  arVideo.pause();
  arVideo.style.display = 'none';
  statusEl.textContent = 'Looking for a registered picture…';
}

startBtn.addEventListener('click', startCamera);
soundBtn.addEventListener('click', () => {
  arVideo.muted = !arVideo.muted;
  soundBtn.textContent = `Sound: ${arVideo.muted ? 'off' : 'on'}`;
});
arVideo.muted = true;
