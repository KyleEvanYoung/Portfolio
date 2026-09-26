# Photo → Video WebAR prototype

## Files
- `index.html` – mobile camera interface
- `style.css` – styling
- `app.js` – camera + target/video mapping
- `photo.png` – stand-in target image
- `video.mp4` – stand-in video

## Run it
Camera access normally works only on HTTPS or localhost.

For a quick local test:

    python3 -m http.server 8000

Then visit `http://localhost:8000`.

## Important
This ZIP contains the complete camera/video prototype and the structure for multiple image/video pairs. The current stand-in target is demonstrated after the camera starts. For true recognition of arbitrary printed images, connect an image-tracking engine (for example MindAR) so its target-found/target-lost events call `onTargetFound()` and `onTargetLost()` in `app.js`.

## Add more pairs
Put additional image/video files in the folder and extend `targets` in `app.js`, for example:

    { id: 'photo-2', image: 'photo2.png', video: 'video2.mp4' }
