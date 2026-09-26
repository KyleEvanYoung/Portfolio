# Fast Image → Video WebAR demo

This is a static, phone-first website that:

1. asks for rear-camera access,
2. recognizes one of 3 reference images,
3. looks up the paired video in `targets.js`,
4. tracks the flat image through camera perspective changes,
5. replaces the target image with the video in the same perspective.

## Folder layout

```text
webar-image-video/
  index.html
  styles.css
  app.js
  targets.js
  assets/
    targets/
      target-1.png
      target-2.png
      target-3.png
    videos/
      video-1.mp4
      video-2.mp4
      video-3.mp4
```

## Test it

Camera access on a phone requires a secure context. Use **HTTPS** when opening it on a phone.

Fastest simple deployment options are any static HTTPS host (GitHub Pages, Netlify, Cloudflare Pages, Vercel, etc.). Upload this folder as-is.

For desktop development, `localhost` is also treated as a secure context:

```bash
cd webar-image-video
python3 -m http.server 8080
```

Then open `http://localhost:8080` on that same computer.

To test recognition, open one of the PNGs in `assets/targets/` on another screen or print it, then point the phone camera at it.

## How it works

- OpenCV.js ORB descriptors recognize each reference image.
- RANSAC homography estimates the target's planar pose/perspective.
- Once recognized, pyramidal Lucas–Kanade optical flow tracks the matched points frame-to-frame for faster updates.
- The matched video is a normal HTML `<video>` element transformed with a CSS `matrix3d`, so the browser/GPU animates the video independently of the vision update rate.
- Recognition is refreshed periodically to reduce optical-flow drift.

## Change the image/video pairs

Edit `targets.js`:

```js
window.AR_TARGETS = [
  {
    id: 'my-target',
    name: 'My Target',
    image: 'assets/targets/my-image.jpg',
    video: 'assets/videos/my-video.mp4'
  }
];
```

Use high-detail, high-contrast target images. Photos, posters, textured artwork, and product packaging usually work better than flat logos or large blank areas.

For phone compatibility, use MP4/H.264 video with `yuv420p` pixel format. Videos are muted in this demo so they can play inline/autoplay once a target is recognized.

## Performance tuning

The main settings are at the top of `app.js` in `CONFIG`:

- `processLongSide: 480` — camera analysis resolution. 360 is faster; 640 can recognize smaller/farther targets but costs more CPU.
- `maxFeatures: 950` — ORB feature budget.
- `searchEveryMs: 115` — recognition frequency while searching.
- `refreshEveryMs: 700` — full recognition refresh while tracking.
- `minFrameGapMs: 16` — fastest requested tracking interval; actual speed adapts to device processing time.

The visible `fps` value is the computer-vision processing rate, not the video playback frame rate.

## Dependency

`index.html` loads the official OpenCV.js 4.13.0 build from `docs.opencv.org`. That keeps this ZIP small, but means the first page load needs internet access. If you want a fully offline deployment, download that OpenCV.js build into the folder and change the final `<script>` tag in `index.html` to point at the local file.
