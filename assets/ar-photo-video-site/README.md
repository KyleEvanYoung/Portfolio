# Image → Video AR (mobile web demo)

This folder contains a phone-friendly web demo that:

- asks for the rear camera,
- recognises one of 3 included flat target images,
- finds the video paired with that target,
- tracks the target from frame to frame,
- draws the video over the target with perspective and smoothing.

## Run it

Camera access normally requires **HTTPS** or **localhost**. Do not double-click `index.html` and expect camera permissions to work on every phone.

### Easy local test on a computer

From this folder:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080` in the browser.

### Test on a phone

For a phone, host this folder on any HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages, Vercel, etc.). Then open the HTTPS URL on the phone and allow camera access.

The page currently loads OpenCV.js 4.13 from the official OpenCV CDN. The test images/videos are local in this folder.

## Test targets

Open or print these on another screen/device:

- `assets/images/target-1.png` → `assets/videos/video-1.mp4`
- `assets/images/target-2.png` → `assets/videos/video-2.mp4`
- `assets/images/target-3.png` → `assets/videos/video-3.mp4`

## Add your own images/videos

1. Put each image in `assets/images/`.
2. Put its video in `assets/videos/`.
3. Add a row to `TARGETS` in `config.js`.
4. Reload the site.

Example:

```js
{ id: 'poster', name: 'My Poster', image: 'assets/images/poster.jpg', video: 'assets/videos/poster.mp4' }
```

No pre-compilation step is needed; target features are learned in the browser when the page loads.

## Tracking design

Recognition uses ORB feature matching + RANSAC homography. Once a target is found, Lucas–Kanade optical flow carries matched points forward between camera frames, and a fresh homography updates the four target corners. An exponential filter smooths the corner positions. The video is rendered as a WebGL textured quad.

This is planar image tracking: the target should be a reasonably flat image/poster/card. Highly detailed, non-repeating images work much better than blank images, simple logos, glossy reflections, or repeated geometric patterns.

## Speed tuning

Settings are in `config.js`:

- `processWidth`: lower = faster, higher = more recognition detail.
- `orbFeatures`: lower = faster feature detection.
- `recognitionEveryFrames`: higher = less CPU while searching.
- `refreshLockEveryFrames`: higher = less CPU while already tracking.
- `smoothing`: lower = steadier but more lag; higher = more responsive but shakier.

The camera requests up to 60 fps, but actual rate depends on the phone/browser. Processing runs on a downscaled frame while the video overlay is WebGL-rendered at screen resolution.

## Important limitation

A browser cannot guarantee recognition of literally *any* image. Feature tracking needs visible texture/corners. For production-grade markerless AR, consider a commercial WebAR SDK or a dedicated image-tracking engine, especially if you need severe angles, occlusion, low light, or many hundreds of targets.
