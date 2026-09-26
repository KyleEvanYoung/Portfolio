export const TARGETS = [
  { id: 'target-1', name: 'Neon City', image: 'assets/images/target-1.png', video: 'assets/videos/video-1.mp4' },
  { id: 'target-2', name: 'Orbit Lab', image: 'assets/images/target-2.png', video: 'assets/videos/video-2.mp4' },
  { id: 'target-3', name: 'Signal Garden', image: 'assets/images/target-3.png', video: 'assets/videos/video-3.mp4' },
];

export const SETTINGS = {
  // Camera analysis resolution. Higher = more accurate, lower = faster.
  processWidth: 540,

  // Initial / periodic recognition.
  orbFeatures: 1000,
  ratioTest: 0.72,
  minGoodMatches: 18,
  minInliers: 12,
  ransacThreshold: 3.2,
  recognitionEveryFrames: 2,
  refreshLockEveryFrames: 10,

  // Per-frame optical-flow tracking.
  maxTrackPoints: 120,
  minTrackPoints: 10,
  minTrackInlierRatio: 0.52,
  lkWindowSize: 31,
  lkMaxLevel: 4,
  lkForwardBackwardMaxError: 1.8,
  lkMaxError: 38,

  // Adaptive One-Euro smoothing: steady when the phone is still,
  // responsive when the target is moving quickly.
  oneEuroMinCutoff: 2.0,
  oneEuroBeta: 0.012,
  oneEuroDerivativeCutoff: 1.0,

  // Reject implausible one-frame jumps instead of letting one bad point
  // throw the entire video across the screen.
  maxFrameCenterJumpRatio: 0.34,
  minFrameAreaRatio: 0.46,
  maxFrameAreaRatio: 2.15,
  lostFrameLimit: 4,
};
