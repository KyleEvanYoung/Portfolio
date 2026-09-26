# Image → Video AR demo

A mobile-browser prototype that recognizes one of three planar images, estimates its camera-space perspective with feature matching + homography, and overlays the paired video on top of it.

## Run
Camera access requires HTTPS or localhost. Do not double-click `index.html` on a phone.

From this folder, run one of these on your computer:

    python3 -m http.server 8080

Then use localhost on the same computer, or serve the folder with an HTTPS-capable host/tunnel for a phone.

## Test pairs
- `assets/images/target-1.png` → `assets/videos/video-1.mp4`
- `assets/images/target-2.png` → `assets/videos/video-2.mp4`
- `assets/images/target-3.png` → `assets/videos/video-3.mp4`

Print/show a target on another screen and point the phone camera at it.

## Tracking rate
`app.js` throttles recognition/pose updates to about 30 Hz (`33 ms`). Actual delivered FPS depends on phone CPU, camera resolution, browser, lighting, and target visibility.

## Important technical note
This is planar AR tracking: the target's four corners are estimated with a homography, which gives perspective-consistent placement for a flat image. It is not full world-scale SLAM/6DoF tracking after the image leaves view. For persistent world tracking, use WebXR + an image-tracking implementation/device that supports it, or a commercial WebAR SDK.

## Dependency
The page loads OpenCV.js 4.x from the official OpenCV documentation CDN, so first load requires internet access. The image/video assets themselves are local.
