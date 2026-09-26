/* Planar image-target AR demo using OpenCV.js.
   Recognition/tracking is intentionally capped at ~30 Hz. */
const TARGETS = [
  {name:'Target 1', image:'assets/images/target-1.png', video:'v1'},
  {name:'Target 2', image:'assets/images/target-2.png', video:'v2'},
  {name:'Target 3', image:'assets/images/target-3.png', video:'v3'}
];
const camera=document.querySelector('#camera'), canvas=document.querySelector('#overlay'), ctx=canvas.getContext('2d');
const startBtn=document.querySelector('#start'), statusEl=document.querySelector('#status'), matchEl=document.querySelector('#match'), fpsEl=document.querySelector('#fps');
let ready=false, running=false, targetData=[], cap, frame, gray, detector, matcher;
let lastTick=0, fpsT=performance.now(), fpsN=0, activeVideo=null;

function waitForCV(){
  const timer=setInterval(()=>{
    if(window.cv && cv.Mat){clearInterval(timer); cv.onRuntimeInitialized=()=>initCV(); if(cv.getBuildInformation) initCV();}
  },100);
}
async function initCV(){
  if(ready) return;
  detector = new cv.ORB(1200); matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  for(const t of TARGETS){
    const img=await loadImage(t.image); const m=cv.imread(img), g=new cv.Mat(), kp=new cv.KeyPointVector(), desc=new cv.Mat();
    cv.cvtColor(m,g,cv.COLOR_RGBA2GRAY); detector.detectAndCompute(g,new cv.Mat(),kp,desc);
    targetData.push({...t,w:m.cols,h:m.rows,kp,desc}); m.delete(); g.delete();
  }
  ready=true; statusEl.textContent='Ready';
}
function loadImage(src){return new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=src})}

startBtn.addEventListener('click', async()=>{
  if(!ready){statusEl.textContent='Still loading…';return}
  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:960},height:{ideal:1280}},audio:false});
    camera.srcObject=stream; await camera.play();
    canvas.width=camera.videoWidth; canvas.height=camera.videoHeight;
    cap=new cv.VideoCapture(camera); frame=new cv.Mat(camera.videoHeight,camera.videoWidth,cv.CV_8UC4); gray=new cv.Mat();
    startBtn.hidden=true; running=true; statusEl.textContent='Camera live'; requestAnimationFrame(loop);
  }catch(e){statusEl.textContent='Camera permission failed'; console.error(e)}
});

function loop(now){
  if(!running) return;
  requestAnimationFrame(loop);
  if(now-lastTick<33) return; // <= ~30 recognition/tracking updates/sec
  lastTick=now; fpsN++; if(now-fpsT>=1000){fpsEl.textContent=`${fpsN} FPS`;fpsN=0;fpsT=now}
  cap.read(frame); cv.cvtColor(frame,gray,cv.COLOR_RGBA2GRAY);
  const kp=new cv.KeyPointVector(), desc=new cv.Mat(); detector.detectAndCompute(gray,new cv.Mat(),kp,desc);
  let best=null;
  if(!desc.empty()) for(const t of targetData){
    const knn=new cv.DMatchVectorVector(); matcher.knnMatch(t.desc,desc,knn,2);
    const good=[];
    for(let i=0;i<knn.size();i++){const pair=knn.get(i);if(pair.size()>=2){const a=pair.get(0),b=pair.get(1);if(a.distance<0.72*b.distance)good.push({q:a.queryIdx,tr:a.trainIdx});} pair.delete();}
    knn.delete();
    if(good.length>=12 && (!best || good.length>best.good.length)) best={t,good};
  }
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(best) renderTarget(best,kp); else {matchEl.textContent='No target'; stopActive();}
  kp.delete(); desc.delete();
}

function renderTarget(best, frameKP){
  const n=best.good.length, src=cv.matFromArray(n,1,cv.CV_32FC2, best.good.flatMap(m=>{const p=best.t.kp.get(m.q).pt;return[p.x,p.y]}));
  const dst=cv.matFromArray(n,1,cv.CV_32FC2, best.good.flatMap(m=>{const p=frameKP.get(m.tr).pt;return[p.x,p.y]}));
  const mask=new cv.Mat(), H=cv.findHomography(src,dst,cv.RANSAC,3,mask);
  let inliers=0; for(let i=0;i<mask.rows;i++) inliers+=mask.ucharPtr(i)[0];
  if(!H.empty() && inliers>=9){
    const corners=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,best.t.w,0,best.t.w,best.t.h,0,best.t.h]), out=new cv.Mat();
    cv.perspectiveTransform(corners,out,H); const p=[]; for(let i=0;i<4;i++){const q=out.data32F;p.push({x:q[i*2],y:q[i*2+1]})}
    matchEl.textContent=`${best.t.name} • ${inliers} inliers`; playActive(best.t.video); drawVideoQuad(activeVideo,p);
    corners.delete();out.delete();
  } else {matchEl.textContent='No stable target';stopActive()}
  src.delete();dst.delete();mask.delete();H.delete();
}

// Canvas has no native 4-corner video transform, so split each frame into triangles
// and affine-warp many small cells. This approximates the homography well enough for a demo.
function drawVideoQuad(video,p){
  if(!video || video.readyState<2) return;
  const cols=10, rows=8, sw=video.videoWidth/cols, sh=video.videoHeight/rows;
  for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
    const u0=x/cols,v0=y/rows,u1=(x+1)/cols,v1=(y+1)/rows;
    const a=project(p,u0,v0),b=project(p,u1,v0),c=project(p,u1,v1),d=project(p,u0,v1);
    tri(video,x*sw,y*sh,(x+1)*sw,y*sh,(x+1)*sw,(y+1)*sh,a,b,c);
    tri(video,x*sw,y*sh,(x+1)*sw,(y+1)*sh,x*sw,(y+1)*sh,a,c,d);
  }
}
function project(p,u,v){ // bilinear cell placement; dense mesh approximates perspective
  return {x:(1-u)*(1-v)*p[0].x+u*(1-v)*p[1].x+u*v*p[2].x+(1-u)*v*p[3].x,
          y:(1-u)*(1-v)*p[0].y+u*(1-v)*p[1].y+u*v*p[2].y+(1-u)*v*p[3].y};
}
function tri(img,sx0,sy0,sx1,sy1,sx2,sy2,d0,d1,d2){
  const den=sx0*(sy1-sy2)+sx1*(sy2-sy0)+sx2*(sy0-sy1); if(Math.abs(den)<.01)return;
  const a=(d0.x*(sy1-sy2)+d1.x*(sy2-sy0)+d2.x*(sy0-sy1))/den;
  const c=(d0.x*(sx2-sx1)+d1.x*(sx0-sx2)+d2.x*(sx1-sx0))/den;
  const e=(d0.x*(sx1*sy2-sx2*sy1)+d1.x*(sx2*sy0-sx0*sy2)+d2.x*(sx0*sy1-sx1*sy0))/den;
  const b=(d0.y*(sy1-sy2)+d1.y*(sy2-sy0)+d2.y*(sy0-sy1))/den;
  const d=(d0.y*(sx2-sx1)+d1.y*(sx0-sx2)+d2.y*(sx1-sx0))/den;
  const f=(d0.y*(sx1*sy2-sx2*sy1)+d1.y*(sx2*sy0-sx0*sy2)+d2.y*(sx0*sy1-sx1*sy0))/den;
  ctx.save();ctx.beginPath();ctx.moveTo(d0.x,d0.y);ctx.lineTo(d1.x,d1.y);ctx.lineTo(d2.x,d2.y);ctx.closePath();ctx.clip();ctx.setTransform(a,b,c,d,e,f);ctx.drawImage(img,0,0);ctx.restore();
}
function playActive(id){const v=document.getElementById(id);if(activeVideo===v)return;stopActive();activeVideo=v;v.play().catch(()=>{});}
function stopActive(){if(activeVideo){activeVideo.pause();activeVideo.currentTime=0;activeVideo=null}}
waitForCV();
