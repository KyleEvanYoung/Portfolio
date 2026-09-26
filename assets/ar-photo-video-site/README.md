# Image → Video AR Tracker demo

A browser-only demo that:

1. Uses the phone camera.
2. Recognizes one of three target images with ORB feature matching.
3. Looks up the video associated with that target.
4. Estimates a planar homography every tracking frame.
5. Perspective-warps the paired video over the target image.
6. Shows an approximate planar 3D pose (yaw, pitch, roll, and a depth proxy).
7. Aims for a 30 FPS update loop (`requestAnimationFrame` throttled to ~33.3 ms).

## Included test mappings

- `assets/images/target-1.png` → `assets/videos/video-1.mp4` (ORBIT)
- `assets/images/target-2.png` → `assets/videos/video-2.mp4` (PULSE)
- `assets/images/target-3.png` → `assets/videos/video-3.mp4` (GRID)

All three MP4s are encoded at 30 FPS.

## Run it

Camera access requires a secure browser context.

### Desktop test

From this folder:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

### Phone test

The easiest option is to upload this folder to any HTTPS static host (for example GitHub Pages, Netlify, Vercel, Cloudflare Pages, or your own HTTPS server) and open the HTTPS URL on your phone.

Plain `http://<your-lan-ip>:8000` may be blocked from using the camera on mobile because it is not a secure origin.

## How to test recognition

Open or print one target PNG. Point the phone camera at it and keep the whole outer border visible. The status will change to the target name, its paired video will start, and the video will be perspective-warped over the image.

For easiest testing, show the target on a second device rather than showing it on the same phone that is running the camera.

## Important implementation notes

- This is planar image tracking, so it works best on flat images/posters/cards.
- The overlay follows the projective pose of the target using a homography. That is enough for a convincing "replace this image with this video" effect.
- The displayed 3D pose is approximate because the demo guesses the phone camera intrinsics. For metric 3D position, calibrate the camera and provide the real target width.
- Actual FPS depends on phone speed, camera resolution, browser, lighting, and the number of target features. The loop targets 30 FPS but cannot guarantee 30 FPS on every device.
- The page currently loads OpenCV.js 4.13.0 from the official OpenCV documentation CDN. To make the site fully offline, download that `opencv.js` file into `vendor/opencv.js` and change the script tag in `index.html` to `vendor/opencv.js`.

## Customize your own image/video list

Edit the `TARGETS` array near the top of `app.js`:

```js
const TARGETS = [
  { id: 'my-target', name: 'MY TARGET', image: 'assets/images/my-target.png', video: 'assets/videos/my-video.mp4' },
];
```

Use target images with lots of unique corners, texture, text, and asymmetry. Avoid blank gradients, repeating patterns, or nearly featureless artwork.

## Tuning

At the top of `app.js` you can adjust:

- `PROCESSING_MAX_WIDTH` — lower this if a phone is too slow.
- `RATIO_TEST` — lower = stricter feature matches.
- `MIN_GOOD_MATCHES` / `MIN_INLIERS` — lower = easier recognition but more false positives.
- `MAX_REPROJECTION_ERROR` — lower = stricter geometric verification.
- `LOST_FRAME_LIMIT` — number of weak frames before returning to scan mode.
