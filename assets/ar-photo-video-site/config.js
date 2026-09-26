export const TARGETS = [
  { id: 'target-1', name: 'Neon City', image: 'assets/images/target-1.png', video: 'assets/videos/video-1.mp4' },
  { id: 'target-2', name: 'Orbit Lab', image: 'assets/images/target-2.png', video: 'assets/videos/video-2.mp4' },
  { id: 'target-3', name: 'Signal Garden', image: 'assets/images/target-3.png', video: 'assets/videos/video-3.mp4' },
];

export const SETTINGS = {
  processWidth: 480,
  orbFeatures: 700,
  ratioTest: 0.74,
  minGoodMatches: 16,
  minInliers: 11,
  ransacThreshold: 4.0,
  recognitionEveryFrames: 2,
  refreshLockEveryFrames: 20,
  maxTrackPoints: 70,
  minTrackPoints: 9,
  smoothing: 0.32,
  lostFrameLimit: 8,
};
