const PAIRS = [
  { name: 'City Signal', image: 'assets/images/target-1.png', video: 'assets/videos/video-1.mp4' },
  { name: 'Ocean Grid', image: 'assets/images/target-2.png', video: 'assets/videos/video-2.mp4' },
  { name: 'Forest Code', image: 'assets/images/target-3.png', video: 'assets/videos/video-3.mp4' }
];

const $ = s => document.querySelector(s);
const intro=$('#intro'), ar=$('#ar'), camera=$('#camera'), canvas=$('#workCanvas'), overlay=$('#videoOverlay'), arVideo=$('#arVideo');
const statusEl=$('#status'), detailEl=$('#detail'), dot=$('#dot');
let stream=null, running=false, templates=[], lastSeen=0, active=-1, processing=false, cvReady=false;
let frameNo=0;

$('#targets').innerHTML = `<div class="target-grid">${PAIRS.map((p,i)=>`<div class="card"><img src="${p.image}" alt="Test target ${i+1}"><div><b>${p.name}</b><span>target-${i+1}.png → video-${i+1}.mp4</span></div></div>`).join('')}</div>`;

function setStatus(title, detail, ok=false){ statusEl.textContent=title; detailEl.textContent=detail; dot.style.background=ok?'#8fffc1':'#ffcc65'; }
function waitForCV(){
  return new Promise(resolve=>{
    const check=()=>{
      if(window.cv && cv.Mat){
        if(cv.onRuntimeInitialized && !cv.getBuildInformation){ cv.onRuntimeInitialized=()=>{cvReady=true;resolve()}; }
        else { cvReady=true; resolve(); }
      } else setTimeout(check,100);
    }; check();
  });
}
function loadImage(src){return new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src=src;});}

async function buildTemplates(){
  setStatus('Loading targets…','Preparing 3 reference images');
  templates=[];
  for(const p of PAIRS){
    const img=await loadImage(p.image); const rgba=cv.imread(img), gray=new cv.Mat();
    cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY); rgba.delete();
    const kp=new cv.KeyPointVector(), desc=new cv.Mat(), mask=new cv.Mat();
    const orb=new cv.ORB(1200); orb.detectAndCompute(gray,mask,kp,desc); orb.delete(); mask.delete(); gray.delete();
    templates.push({kp,desc,w:img.naturalWidth,h:img.naturalHeight});
  }
}

async function start(){
  intro.hidden=true; ar.hidden=false; setStatus('Starting camera…','Allow camera access when asked');
  try{
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
    camera.srcObject=stream; await camera.play();
    await waitForCV(); await buildTemplates();
    running=true; setStatus('Scanning…','Point at one of the 3 test images'); requestAnimationFrame(loop);
  }catch(e){ console.error(e); setStatus('Could not start', e.message || 'Camera or CV failed'); }
}
function stop(){ running=false; if(stream)stream.getTracks().forEach(t=>t.stop()); stream=null; hideOverlay(); ar.hidden=true; intro.hidden=false; }
$('#startBtn').onclick=start; $('#stopBtn').onclick=stop;
$('#soundBtn').onclick=()=>{arVideo.muted=!arVideo.muted; $('#soundBtn').textContent=arVideo.muted?'Sound off':'Sound on'; if(!arVideo.paused) arVideo.play().catch(()=>{});};

function videoToScreen(x,y){
  const vw=camera.videoWidth,vh=camera.videoHeight, sw=innerWidth,sh=innerHeight;
  const scale=Math.max(sw/vw,sh/vh), dw=vw*scale,dh=vh*scale;
  return [(x*scale)+(sw-dw)/2,(y*scale)+(sh-dh)/2];
}

// Solve the 8-parameter projective transform mapping source rectangle to four screen points.
function homography(src,dst){
  const A=[],b=[];
  for(let i=0;i<4;i++){
    const [x,y]=src[i],[u,v]=dst[i];
    A.push([x,y,1,0,0,0,-u*x,-u*y]); b.push(u);
    A.push([0,0,0,x,y,1,-v*x,-v*y]); b.push(v);
  }
  for(let i=0;i<8;i++){
    let m=i; for(let r=i+1;r<8;r++) if(Math.abs(A[r][i])>Math.abs(A[m][i]))m=r;
    [A[i],A[m]]=[A[m],A[i]]; [b[i],b[m]]=[b[m],b[i]];
    const d=A[i][i]; if(Math.abs(d)<1e-9)return null;
    for(let c=i;c<8;c++)A[i][c]/=d; b[i]/=d;
    for(let r=0;r<8;r++)if(r!==i){const f=A[r][i];for(let c=i;c<8;c++)A[r][c]-=f*A[i][c];b[r]-=f*b[i];}
  }
  return [...b,1];
}
function cssMatrix(h){
  return `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,${h[8]})`;
}
function showOverlay(idx,corners){
  const t=templates[idx], screen=corners.map(p=>videoToScreen(p[0],p[1]));
  const H=homography([[0,0],[t.w,0],[t.w,t.h],[0,t.h]],screen); if(!H)return;
  overlay.style.width=t.w+'px'; overlay.style.height=t.h+'px'; overlay.style.transform=cssMatrix(H); overlay.style.display='block';
  lastSeen=performance.now();
  if(active!==idx){ active=idx; arVideo.src=PAIRS[idx].video; arVideo.load(); arVideo.play().catch(()=>{}); }
  else if(arVideo.paused) arVideo.play().catch(()=>{});
  setStatus(`Tracking: ${PAIRS[idx].name}`,'Video locked to target',true);
}
function hideOverlay(){ overlay.style.display='none'; arVideo.pause(); active=-1; setStatus('Scanning…','Point at one of the 3 test images'); }

function detect(){
  if(!running||processing||!cvReady||camera.readyState<2)return; processing=true;
  let src=null,small=null,gray=null,kp=null,desc=null,mask=null,orb=null;
  try{
    const maxW=640, scale=Math.min(1,maxW/camera.videoWidth), w=Math.round(camera.videoWidth*scale),h=Math.round(camera.videoHeight*scale);
    canvas.width=camera.videoWidth; canvas.height=camera.videoHeight; canvas.getContext('2d').drawImage(camera,0,0);
    src=cv.imread(canvas); small=new cv.Mat(); cv.resize(src,small,new cv.Size(w,h),0,0,cv.INTER_AREA); gray=new cv.Mat(); cv.cvtColor(small,gray,cv.COLOR_RGBA2GRAY);
    kp=new cv.KeyPointVector(); desc=new cv.Mat(); mask=new cv.Mat(); orb=new cv.ORB(1200); orb.detectAndCompute(gray,mask,kp,desc);
    let best=null;
    if(desc.rows>12){
      for(let ti=0;ti<templates.length;ti++){
        const matcher=new cv.BFMatcher(cv.NORM_HAMMING,true), matches=new cv.DMatchVector(); matcher.match(templates[ti].desc,desc,matches);
        const arr=[]; for(let j=0;j<matches.size();j++){const m=matches.get(j); if(m.distance<58)arr.push(m);} arr.sort((a,b)=>a.distance-b.distance);
        const good=arr.slice(0,Math.min(80,arr.length));
        if(good.length>=12){
          const s=[],d=[]; for(const m of good){const a=templates[ti].kp.get(m.queryIdx).pt, q=kp.get(m.trainIdx).pt; s.push(a.x,a.y); d.push(q.x,q.y);}
          const sm=cv.matFromArray(good.length,1,cv.CV_32FC2,s), dm=cv.matFromArray(good.length,1,cv.CV_32FC2,d), inliers=new cv.Mat();
          const H=cv.findHomography(sm,dm,cv.RANSAC,4,inliers); let count=0; for(let k=0;k<inliers.rows;k++)count+=inliers.data[k]?1:0;
          if(H.rows===3 && count>=9 && (!best||count>best.count)){
            const c=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,templates[ti].w,0,templates[ti].w,templates[ti].h,0,templates[ti].h]), out=new cv.Mat(); cv.perspectiveTransform(c,out,H);
            const pts=[]; for(let k=0;k<4;k++)pts.push([out.data32F[k*2]/scale,out.data32F[k*2+1]/scale]);
            best={idx:ti,count,corners:pts}; c.delete(); out.delete();
          }
          sm.delete();dm.delete();inliers.delete();H.delete();
        }
        matches.delete();matcher.delete();
      }
    }
    if(best)showOverlay(best.idx,best.corners); else if(performance.now()-lastSeen>450 && active>=0)hideOverlay();
  }catch(e){console.warn('Detection frame failed',e);}
  finally{[src,small,gray,kp,desc,mask,orb].forEach(x=>{try{x&&x.delete()}catch{}});processing=false;}
}
function loop(){ if(!running)return; frameNo++; if(frameNo%3===0)detect(); requestAnimationFrame(loop); }
