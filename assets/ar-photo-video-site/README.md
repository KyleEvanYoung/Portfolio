# Image → Video AR demo

A downloadable, static mobile website that recognizes one of three reference images and overlays its associated video on the detected image. It uses OpenCV.js ORB feature matching + RANSAC homography, then applies that projective transform to an HTML video element. This gives planar 3D/perspective tracking as the phone moves around the image.

## Included test pairs

- `assets/images/target-1.png` → `assets/videos/video-1.mp4`
- `assets/images/target-2.png` → `assets/videos/video-2.mp4`
- `assets/images/target-3.png` → `assets/videos/video-3.mp4`

The mapping is the `PAIRS` array at the top of `app.js`.

## Run it

Camera APIs require a secure browser context. `localhost` works for development; a phone opening another computer's plain `http://192.168...` address usually does **not** count as secure.

Desktop test:

```bash
cd image-video-ar
python3 -m http.server 8080
```

Open `http://localhost:8080` and allow the webcam. Show one of the target PNGs on another screen.

Phone test: deploy this folder to any HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages, Vercel, etc.), open that HTTPS URL on the phone, tap **Start camera**, and point at a printed target or a target displayed on another device.

## How it works

1. Loads the 3 reference images and computes ORB feature descriptors.
2. Samples camera frames and computes descriptors for the live view.
3. Compares the live descriptors against every image in `PAIRS`.
4. Uses RANSAC to reject bad matches and estimate a homography for the best target.
5. Projects the target's four corners into camera space.
6. Converts those corners to the phone screen's `object-fit: cover` coordinates.
7. Applies a CSS `matrix3d()` projective transform to the paired video.
8. Pauses/hides the video when the target is lost and resumes when reacquired.

## Add your own image/video

Copy a high-detail JPG/PNG into `assets/images/` and its MP4 into `assets/videos/`, then add another object to `PAIRS` in `app.js`:

```js
{ name: 'My target', image: 'assets/images/my-target.jpg', video: 'assets/videos/my-video.mp4' }
```

High-detail, non-repeating images work much better than logos, blank areas, gradients, or simple geometric art.

## Notes

- OpenCV.js is loaded from `https://docs.opencv.org/4.x/opencv.js`, so the first load needs internet access.
- The demo processes a reduced camera frame every few animation frames to keep phone CPU use reasonable.
- The videos begin muted because mobile browsers commonly block audible autoplay. Use **Sound off/on** after starting the camera.
- This is planar image tracking. It estimates the target plane's perspective in camera space; it is not general-purpose SLAM/world tracking after the image disappears.
