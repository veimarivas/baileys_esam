import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }     from 'three/addons/postprocessing/OutputPass.js';

/* ================================================================
   0 · BASE
================================================================ */
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RM   = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FINE = matchMedia('(pointer: fine)').matches;
const MOBILE = () => innerWidth < 1024;

if (typeof gsap === 'undefined') { $('#loader').style.display='none'; throw new Error('GSAP no cargó'); }
if(!FINE) $('#hintTxt').textContent = 'Toca un módulo para girar el formulario';

let threeOK=false, logging=false, spinning=false, spinTl=null;
const flow={v:1}, intro={v:RM?1:0};
const cam={x:0,y:.4,z:RM?12:17,lx:-1.2,ly:.15};
const par={x:0,y:0};
const camHome={z:12,lx:-1.2,ly:.15};
const rot={y:0,x:0,ty:0,tx:0,auto:0};
let dragging=false, dragMoved=0, lastPX=0, lastPY=0, velY=0;

/* ================================================================
   1 · MÓDULOS DEL SEGUIMIENTO (Baileys)
================================================================ */
const NODES=[
 {id:'baileys', label:'Baileys · WebSocket', desc:'Conexión directa multidispositivo · sin costo por contacto.', css:'#00E5A0', ui:'#0A8F66', icon:'bolt', r:3.05, tilt:[ .42, .22], speed: .095, phase:0.3, dirs:[1,-1,1], size:1.2,
  ctx:['Baileys · WebSocket','Socket directo multidispositivo','Conexión directa','Sin costo por contacto']},
 {id:'session', label:'Sesión QR · Multidispositivo', desc:'Vinculación por QR y sesión persistente cifrada en el servidor.', css:'#19C2D8', ui:'#0E7C8C', icon:'qr', r:3.5, tilt:[-.48,-.42], speed:-.072, phase:2.2, dirs:[1,-1],
  ctx:['Sesión QR','Vincula y mantiene la sesión activa','1 dispositivo','Credenciales cifradas']},
 {id:'tracking', label:'Seguimiento de chats', desc:'Etapas del lead, etiquetas y bitácora de cada conversación.', css:'#F6C445', ui:'#A87B0A', icon:'target', r:2.8, tilt:[ .18, .78], speed: .115, phase:4.1, dirs:[1,-1,1], size:1.15,
  ctx:['Seguimiento de chats','Etapas, etiquetas y bitácora por lead','Etapas y etiquetas','Bitácora por lead']},
 {id:'messages', label:'Mensajes ✓✓', desc:'Enviado, entregado y leído en vivo desde la sesión de WhatsApp.', css:'#25D366', ui:'#128C4A', icon:'checks', r:3.35, tilt:[-.2,-.85], speed: .08, phase:5.4, dirs:[1,-1,1], verified:true,
  ctx:['Mensajes ✓✓','Estados de entrega y lectura en vivo','Sincronización en vivo','Estados de entrega']},
 {id:'reminders', label:'Recordatorios automáticos', desc:'Follow-ups programados que se envían solos desde tu sesión.', css:'#4DA3FF', ui:'#2B6CB0', icon:'clock', r:3.7, tilt:[ .72,-.28], speed:-.062, phase:1.1, dirs:[1],
  ctx:['Recordatorios','Follow-ups programados por lead','Programados','Automáticos']},
 {id:'alerts', label:'Reconexión & alertas', desc:'Vigila la sesión, reconecta sola y avisa si el QR expira.', css:'#FF6B5A', ui:'#C2412D', icon:'shield', r:3.9, tilt:[-.68, .34], speed: .068, phase:3.2, dirs:[1,-1],
  ctx:['Reconexión & alertas','Salud de la sesión bajo vigilancia','Auto-retry 1.8 s','Alertas al instante']},
];

/* ================================================================
   2 · TEXTURAS PROCEDURALES
================================================================ */
function makeCanvas(size,draw){ const c=document.createElement('canvas'); c.width=c.height=size; draw(c.getContext('2d')); return c; }
function tex(c){ const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; return t; }
const rr=(ctx,x,y,w,h,r)=>{ ctx.beginPath(); ctx.roundRect?ctx.roundRect(x,y,w,h,r):ctx.rect(x,y,w,h); };

const haloTex=tex(makeCanvas(128,ctx=>{
  const g=ctx.createRadialGradient(64,64,2,64,64,62);
  g.addColorStop(0,'rgba(255,255,255,.95)');g.addColorStop(.35,'rgba(255,255,255,.35)');g.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=g;ctx.fillRect(0,0,128,128);
}));
const ringTex=tex(makeCanvas(128,ctx=>{
  ctx.strokeStyle='rgba(255,255,255,.95)';ctx.lineWidth=7;
  ctx.beginPath();ctx.arc(64,64,48,0,Math.PI*2);ctx.stroke();
}));
const sweepTex=tex(makeCanvas(256,ctx=>{
  const g=ctx.createRadialGradient(128,128,4,128,128,126);
  g.addColorStop(0,'rgba(255,255,255,.55)');g.addColorStop(.6,'rgba(255,255,255,.16)');g.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=g;ctx.beginPath();ctx.moveTo(128,128);ctx.arc(128,128,126,-0.62,0);ctx.closePath();ctx.fill();
}));
const bgTex=tex(makeCanvas(512,ctx=>{
  const lg=ctx.createLinearGradient(0,0,512,512);
  lg.addColorStop(0,'#050F1E');lg.addColorStop(.5,'#0A2540');lg.addColorStop(1,'#0E3A5C');
  ctx.fillStyle=lg;ctx.fillRect(0,0,512,512);
  let g=ctx.createRadialGradient(175,235,10,175,235,300);
  g.addColorStop(0,'rgba(0,190,150,.28)');g.addColorStop(1,'rgba(0,190,150,0)');
  ctx.fillStyle=g;ctx.fillRect(0,0,512,512);
  g=ctx.createRadialGradient(430,80,10,430,80,220);
  g.addColorStop(0,'rgba(246,196,69,.10)');g.addColorStop(1,'rgba(246,196,69,0)');
  ctx.fillStyle=g;ctx.fillRect(0,0,512,512);
}));
/* Sello ✓✓ (mensajes leídos) */
const badgeTex=tex(makeCanvas(128,ctx=>{
  ctx.fillStyle='#25D366';ctx.beginPath();
  for(let i=0;i<24;i++){
    const a=i*Math.PI/12,r=i%2?46:55;
    const x=64+Math.cos(a)*r,y=64+Math.sin(a)*r;
    i?ctx.lineTo(x,y):ctx.moveTo(x,y);
  }
  ctx.closePath();ctx.fill();
  ctx.strokeStyle='#FFFFFF';ctx.lineWidth=9;ctx.lineCap='round';ctx.lineJoin='round';
  ctx.beginPath();ctx.moveTo(34,66);ctx.lineTo(46,78);ctx.lineTo(66,52);ctx.stroke();
  ctx.beginPath();ctx.moveTo(56,66);ctx.lineTo(68,78);ctx.lineTo(92,50);ctx.stroke();
}));

function drawIcon(ctx,type,color){
  ctx.beginPath();ctx.arc(64,64,55,0,Math.PI*2);
  ctx.fillStyle='#0A2036';ctx.fill();ctx.lineWidth=6;ctx.strokeStyle=color;ctx.stroke();
  ctx.lineCap='round';ctx.lineJoin='round';const W='#FFFFFF';
  if(type==='bolt'){
    ctx.fillStyle=color;ctx.beginPath();
    [[70,26],[44,70],[61,70],[55,102],[86,54],[67,54]].forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));
    ctx.closePath();ctx.fill();
  }else if(type==='qr'){
    ctx.strokeStyle=W;ctx.lineWidth=6;
    rr(ctx,34,34,24,24,5);ctx.stroke();
    rr(ctx,70,34,24,24,5);ctx.stroke();
    rr(ctx,34,70,24,24,5);ctx.stroke();
    ctx.fillStyle=color;
    [[72,72],[86,72],[72,86],[92,90],[86,86]].forEach(([x,y])=>{ctx.beginPath();ctx.arc(x,y,4.2,0,Math.PI*2);ctx.fill();});
  }else if(type==='target'){
    ctx.strokeStyle=W;ctx.lineWidth=5.5;
    ctx.beginPath();ctx.arc(64,64,28,0,Math.PI*2);ctx.stroke();
    ctx.beginPath();ctx.arc(64,64,16,0,Math.PI*2);ctx.stroke();
    ctx.fillStyle=color;ctx.beginPath();ctx.arc(64,64,6.5,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle=color;ctx.lineWidth=5;
    ctx.beginPath();ctx.moveTo(64,26);ctx.lineTo(64,36);ctx.stroke();
    ctx.beginPath();ctx.moveTo(102,64);ctx.lineTo(92,64);ctx.stroke();
  }else if(type==='checks'){
    ctx.strokeStyle=W;ctx.lineWidth=8;
    ctx.beginPath();ctx.moveTo(30,66);ctx.lineTo(44,80);ctx.lineTo(68,48);ctx.stroke();
    ctx.strokeStyle=color;
    ctx.beginPath();ctx.moveTo(56,66);ctx.lineTo(70,80);ctx.lineTo(98,44);ctx.stroke();
  }else if(type==='clock'){
    ctx.strokeStyle=W;ctx.lineWidth=6;
    ctx.beginPath();ctx.arc(64,66,27,0,Math.PI*2);ctx.stroke();
    ctx.lineWidth=5.5;
    ctx.beginPath();ctx.moveTo(64,66);ctx.lineTo(64,50);ctx.stroke();
    ctx.beginPath();ctx.moveTo(64,66);ctx.lineTo(77,72);ctx.stroke();
    ctx.strokeStyle=color;ctx.lineWidth=5;
    ctx.beginPath();ctx.moveTo(50,32);ctx.lineTo(58,38);ctx.stroke();
    ctx.beginPath();ctx.moveTo(78,32);ctx.lineTo(70,38);ctx.stroke();
    ctx.fillStyle=color;ctx.beginPath();ctx.arc(64,66,3.6,0,Math.PI*2);ctx.fill();
  }else if(type==='shield'){
    ctx.strokeStyle=W;ctx.lineWidth=6;
    ctx.beginPath();ctx.moveTo(64,30);ctx.lineTo(92,42);ctx.lineTo(92,66);
    ctx.quadraticCurveTo(92,88,64,98);ctx.quadraticCurveTo(36,88,36,66);
    ctx.lineTo(36,42);ctx.closePath();ctx.stroke();
    ctx.strokeStyle=color;ctx.lineWidth=5.5;
    ctx.beginPath();ctx.arc(64,64,13,Math.PI*.35,Math.PI*1.75);ctx.stroke();
    ctx.fillStyle=color;ctx.beginPath();
    ctx.moveTo(74,50);ctx.lineTo(80,60);ctx.lineTo(68,60);ctx.closePath();ctx.fill();
  }
}
const iconDataURL={};
function iconTex(type,color){
  const c=makeCanvas(128,ctx=>drawIcon(ctx,type,color));
  iconDataURL[type]=c.toDataURL();
  return tex(c);
}
NODES.forEach(n=>{ if(!iconDataURL[n.icon]){ const c=makeCanvas(128,ctx=>drawIcon(ctx,n.icon,n.css)); iconDataURL[n.icon]=c.toDataURL(); } });

/* ================================================================
   3 · ESCENA — núcleo = radar de seguimiento con ✓✓
================================================================ */
let renderer,scene,camera,composer,bloom,world;
let rim,core,coreMat,sweep,blip,coreLight,curLight,glowSprite,particles,pUniforms,badge;
let chainCurve,chainGeo,chainMat; const CHAIN_SEG=40;
const checkpoints=[];
const hitMeshes=[],ringMats=[],decorMats=[],lineMats=[],packets=[],conns=[],nodeGroups=[];
const clock=new THREE.Clock();
const raycaster=new THREE.Raycaster();
const ndc=new THREE.Vector2(-2,-2);
const tmpV=new THREE.Vector3(),tmpV2=new THREE.Vector3(),lightTarget=new THREE.Vector3(-4,2,3);
let hovered=null,overUI=false,chipActive=false,tipNode=null;

function buildScene(){
  renderer=new THREE.WebGLRenderer({canvas:$('#scene'),antialias:true,alpha:false,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.setSize(innerWidth,innerHeight);
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.1;

  scene=new THREE.Scene();
  scene.background=bgTex;
  scene.fog=new THREE.FogExp2(0x0A2540,.028);
  camera=new THREE.PerspectiveCamera(42,innerWidth/innerHeight,.1,100);

  scene.add(new THREE.AmbientLight(0x5f7f9f,.9));
  const dir=new THREE.DirectionalLight(0xffffff,1.1);dir.position.set(6,10,8);scene.add(dir);
  const goldL=new THREE.PointLight(0xF6C445,14,22,2);goldL.position.set(-5,4,6);scene.add(goldL);
  const mintL=new THREE.PointLight(0x00E5A0,10,20,2);mintL.position.set(4,-3,5);scene.add(mintL);
  curLight=new THREE.PointLight(0xF6C445,0,11,2);scene.add(curLight);

  world=new THREE.Group();scene.add(world);

  /* Aro radar dorado (abierto) + blip */
  const goldMat=new THREE.MeshStandardMaterial({color:0xF6C445,metalness:.85,roughness:.28,emissive:0xF6C445,emissiveIntensity:.35});
  rim=new THREE.Group();
  const ARC=Math.PI*1.6;
  rim.add(new THREE.Mesh(new THREE.TorusGeometry(1.0,.07,18,110,ARC),goldMat));
  blip=new THREE.Mesh(new THREE.SphereGeometry(.1,16,16),new THREE.MeshStandardMaterial({color:0xF6C445,emissive:0xF6C445,emissiveIntensity:2.4}));
  blip.position.set(Math.cos(ARC)*1.0,Math.sin(ARC)*1.0,0);
  rim.add(blip);
  world.add(rim);

  /* Interior: anillos, barrido radar y doble check */
  coreMat=new THREE.MeshStandardMaterial({color:0x0FB5BA,emissive:0x17C8DE,emissiveIntensity:1.7,metalness:.15,roughness:.25});
  core=new THREE.Group();
  [[.62,.5],[.32,.34]].forEach(([r,o])=>{
    core.add(new THREE.Mesh(new THREE.TorusGeometry(r,.018,10,80),
      new THREE.MeshBasicMaterial({color:0x2FD4DE,transparent:true,opacity:o,blending:THREE.AdditiveBlending,depthWrite:false})));
  });
  sweep=new THREE.Group();
  const sweepMesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),
    new THREE.MeshBasicMaterial({map:sweepTex,color:0x00E5A0,transparent:true,opacity:.55,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide}));
  sweep.add(sweepMesh);
  const edge=new THREE.Mesh(new THREE.BoxGeometry(.98,.016,.016),
    new THREE.MeshBasicMaterial({color:0x9BFFE0,transparent:true,opacity:.85,blending:THREE.AdditiveBlending,depthWrite:false}));
  edge.position.x=.49;sweep.add(edge);
  core.add(sweep);

  const mkCheck=(dx)=>{
    const g=new THREE.Group();
    const a=new THREE.Mesh(new THREE.BoxGeometry(.3,.075,.09),coreMat);
    a.position.set(-.09,-.06,0);a.rotation.z=-Math.PI/4;
    const b=new THREE.Mesh(new THREE.BoxGeometry(.62,.075,.09),coreMat);
    b.position.set(.16,.09,0);b.rotation.z=Math.PI/4.4;
    g.add(a,b);g.position.x=dx;g.scale.setScalar(.85);
    return g;
  };
  core.add(mkCheck(-.2),mkCheck(.16));
  world.add(core);

  /* Checkpoints de seguimiento orbitando el núcleo */
  [[.62,1.5,0],[.32,-2.1,2.1],[.62,1.1,4.2]].forEach(([r,sp,ph])=>{
    const m=new THREE.Mesh(new THREE.SphereGeometry(.05,12,12),
      new THREE.MeshStandardMaterial({color:0xF6C445,emissive:0xF6C445,emissiveIntensity:2.6}));
    core.add(m);checkpoints.push({mesh:m,r,sp,ph});
  });

  coreLight=new THREE.PointLight(0x19C2D8,RM?30:0,18,2);world.add(coreLight);
  glowSprite=new THREE.Sprite(new THREE.SpriteMaterial({map:haloTex,color:0x12C79E,transparent:true,opacity:RM?.5:0,blending:THREE.AdditiveBlending,depthWrite:false}));
  glowSprite.scale.setScalar(4.6);world.add(glowSprite);

  [[2.2,0xF6C445,.22,[1.2,.4]],[2.55,0x00E5A0,.2,[-.9,-.5]]].forEach(([r,c,o,t])=>{
    const m=new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:RM?o:0,blending:THREE.AdditiveBlending,depthWrite:false});
    m.userData={target:o};
    const ringD=new THREE.Mesh(new THREE.TorusGeometry(r,.008,8,140),m);
    ringD.quaternion.setFromEuler(new THREE.Euler(t[0],0,t[1]));
    ringD.userData.spin=.05+Math.random()*.05;ringD.userData.decor=true;
    decorMats.push(m);world.add(ringD);
  });

  NODES.forEach((cfg,idx)=>{
    const color=new THREE.Color(cfg.css);
    const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(cfg.tilt[0],0,cfg.tilt[1]));
    const normal=new THREE.Vector3(0,0,1).applyQuaternion(q);
    const size=cfg.size||1;

    const ringMat=new THREE.MeshBasicMaterial({color:0x2E6B96,transparent:true,opacity:RM?.16:0,blending:THREE.AdditiveBlending,depthWrite:false});
    const orbit=new THREE.Mesh(new THREE.TorusGeometry(cfg.r,.006,8,140),ringMat);
    orbit.quaternion.copy(q);world.add(orbit);ringMats.push(ringMat);

    const group=new THREE.Group();
    const orb=new THREE.Mesh(new THREE.SphereGeometry(.15*size,24,24),new THREE.MeshStandardMaterial({color:color.clone().multiplyScalar(.5),emissive:color,emissiveIntensity:2.2,roughness:.3}));
    const halo=new THREE.Sprite(new THREE.SpriteMaterial({map:haloTex,color,transparent:true,opacity:.8,blending:THREE.AdditiveBlending,depthWrite:false}));
    halo.scale.setScalar(1.05*size);
    const icon=new THREE.Sprite(new THREE.SpriteMaterial({map:iconTex(cfg.icon,cfg.css),transparent:true,depthTest:false}));
    icon.scale.setScalar(.52*size);icon.renderOrder=10;
    const hit=new THREE.Mesh(new THREE.SphereGeometry(.42*size,8,8),new THREE.MeshBasicMaterial({visible:false}));
    group.add(orb,halo,icon,hit);world.add(group);
    if(!RM)group.scale.setScalar(.001);
    nodeGroups.push(group);

    if(cfg.verified){
      badge=new THREE.Sprite(new THREE.SpriteMaterial({map:badgeTex,transparent:true,depthTest:false}));
      badge.scale.setScalar(.32);badge.position.set(.36,.36,0);badge.renderOrder=11;
      group.add(badge);
    }

    const curve=new THREE.QuadraticBezierCurve3(new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3());
    const SEG=40;
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array((SEG+1)*3),3));
    const lineMat=new THREE.LineBasicMaterial({color,transparent:true,opacity:RM?.32:0,blending:THREE.AdditiveBlending,depthWrite:false});
    const line=new THREE.Line(geo,lineMat);line.frustumCulled=false;world.add(line);lineMats.push(lineMat);

    const node={...cfg,idx,color,q,normal,group,halo,curve,geo,SEG,angle:cfg.phase,sign:idx%2?1:-1};
    hit.userData.node=node;hitMeshes.push(hit);conns.push(node);

    cfg.dirs.forEach((dir,k)=>{
      const p=new THREE.Mesh(new THREE.SphereGeometry(.045,10,10),new THREE.MeshBasicMaterial({color:k===0?0xFFFFFF:color,transparent:true,opacity:.95,blending:THREE.AdditiveBlending,depthWrite:false}));
      p.frustumCulled=false;world.add(p);
      if(!RM)p.scale.setScalar(.001);
      packets.push({mesh:p,node,dir,t:Math.random(),speed:.14+Math.random()*.1});
    });
  });

  /* Cadena de seguimiento: Baileys ↔ Mensajes */
  chainCurve=new THREE.QuadraticBezierCurve3(new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3());
  chainGeo=new THREE.BufferGeometry();
  chainGeo.setAttribute('position',new THREE.BufferAttribute(new Float32Array((CHAIN_SEG+1)*3),3));
  chainMat=new THREE.LineBasicMaterial({color:0x9BFFE0,transparent:true,opacity:RM?.22:0,blending:THREE.AdditiveBlending,depthWrite:false});
  const chainLine=new THREE.Line(chainGeo,chainMat);chainLine.frustumCulled=false;world.add(chainLine);
  [0,1].forEach(k=>{
    const p=new THREE.Mesh(new THREE.SphereGeometry(.04,10,10),new THREE.MeshBasicMaterial({color:0xFFFFFF,transparent:true,opacity:.9,blending:THREE.AdditiveBlending,depthWrite:false}));
    p.frustumCulled=false;world.add(p);
    if(!RM)p.scale.setScalar(.001);
    packets.push({mesh:p,node:{curve:chainCurve},dir:k?-1:1,t:k*.5,speed:.12});
  });

  /* Partículas */
  const N=MOBILE()?220:420;
  const pos=new Float32Array(N*3),sz=new Float32Array(N),ph=new Float32Array(N),col=new Float32Array(N*3);
  const palette=[new THREE.Color('#00E5A0'),new THREE.Color('#F6C445'),new THREE.Color('#19C2D8'),new THREE.Color('#25D366'),new THREE.Color('#FFFFFF')];
  for(let i=0;i<N;i++){
    pos[i*3]=(Math.random()-.5)*26;pos[i*3+1]=(Math.random()-.5)*14;pos[i*3+2]=(Math.random()-.5)*14-2;
    sz[i]=.2+Math.random()*.3;ph[i]=Math.random()*Math.PI*2;
    const c=palette[(Math.random()*palette.length)|0];
    col[i*3]=c.r;col[i*3+1]=c.g;col[i*3+2]=c.b;
  }
  const pGeo=new THREE.BufferGeometry();
  pGeo.setAttribute('position',new THREE.BufferAttribute(pos,3));
  pGeo.setAttribute('aSize',new THREE.BufferAttribute(sz,1));
  pGeo.setAttribute('aPhase',new THREE.BufferAttribute(ph,1));
  pGeo.setAttribute('aColor',new THREE.BufferAttribute(col,3));
  pUniforms={uTime:{value:0},uPR:{value:renderer.getPixelRatio()}};
  particles=new THREE.Points(pGeo,new THREE.ShaderMaterial({
    uniforms:pUniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
    vertexShader:`
      attribute float aSize;attribute float aPhase;attribute vec3 aColor;
      uniform float uTime,uPR;varying float vA;varying vec3 vC;
      void main(){
        vec3 p=position;
        p.y+=sin(uTime*.25+aPhase)*.4;
        p.x+=cos(uTime*.18+aPhase*1.7)*.3;
        vec4 mv=modelViewMatrix*vec4(p,1.);
        gl_PointSize=aSize*uPR*(160./-mv.z);
        vA=.45+.55*sin(uTime*1.4+aPhase*6.28);
        vC=aColor;
        gl_Position=projectionMatrix*mv;
      }`,
    fragmentShader:`
      varying float vA;varying vec3 vC;
      void main(){
        float d=length(gl_PointCoord-.5);
        gl_FragColor=vec4(vC,smoothstep(.5,.05,d)*vA);
      }`
  }));
  particles.frustumCulled=false;scene.add(particles);

  composer=new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(devicePixelRatio,2));
  composer.addPass(new RenderPass(scene,camera));
  bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),.85,.55,.62);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  layoutScene();
  if(!RM){
    gsap.to(coreMat,{emissiveIntensity:2.2,duration:2.2,yoyo:true,repeat:-1,ease:'sine.inOut'});
    gsap.fromTo(rim.rotation,{y:-.36},{y:.36,duration:6,yoyo:true,repeat:-1,ease:'sine.inOut'});
    gsap.fromTo(rim.rotation,{z:-.06},{z:.06,duration:4.5,yoyo:true,repeat:-1,ease:'sine.inOut'});
    gsap.to(blip.scale,{x:1.35,y:1.35,z:1.35,duration:1.3,yoyo:true,repeat:-1,ease:'sine.inOut'});
    gsap.to(badge.scale,{x:.36,y:.36,duration:1.6,yoyo:true,repeat:-1,ease:'sine.inOut'});
  }
  threeOK=true;
}

function layoutScene(){
  if(!world)return;
  const m=MOBILE()&&innerHeight>500;
  world.userData.basePos=m?new THREE.Vector3(0,1.35,0):new THREE.Vector3(-2.5,.1,0);
  world.userData.baseScale=m?.62:(innerHeight<=500?.8:1);
  camHome.z=12;camHome.lx=world.userData.basePos.x*.5;camHome.ly=m?.6:.15;
  if(RM){cam.z=camHome.z;cam.lx=camHome.lx;cam.ly=camHome.ly;}
}

/* ================================================================
   4 · LOOP
================================================================ */
function tick(){
  const dt=Math.min(clock.getDelta(),.05),t=clock.elapsedTime;
  const base=world.userData.basePos,bs=world.userData.baseScale;

  world.position.lerp(base,.06);
  world.scale.setScalar(bs*Math.max(intro.v,.001));
  rot.auto+=dt*(RM?.01:.045);
  rot.y+=(rot.ty-rot.y)*.08;
  rot.x+=(rot.tx-rot.x)*.08;
  world.rotation.y=rot.auto+rot.y;
  world.rotation.x=rot.x;

  sweep.rotation.z-=dt*(RM?.25:1.15);
  checkpoints.forEach(c=>{
    const a=t*c.sp+c.ph;
    c.mesh.position.set(Math.cos(a)*c.r,Math.sin(a)*c.r,.02);
  });
  world.children.forEach(o=>{if(o.userData.decor)o.rotation.z+=dt*o.userData.spin;});

  conns.forEach(n=>{
    n.angle+=dt*n.speed*(RM?.4:1);
    tmpV.set(Math.cos(n.angle)*n.r,Math.sin(n.angle)*n.r,0).applyQuaternion(n.q);
    tmpV.y+=Math.sin(t*.9+n.idx*1.7)*.06;
    n.group.position.copy(tmpV);
    n.curve.v2.copy(tmpV);
    n.curve.v1.copy(tmpV).multiplyScalar(.5).addScaledVector(n.normal,.55*n.sign);
    const arr=n.geo.attributes.position.array;
    for(let i=0;i<=n.SEG;i++){
      n.curve.getPoint(i/n.SEG,tmpV2);
      arr[i*3]=tmpV2.x;arr[i*3+1]=tmpV2.y;arr[i*3+2]=tmpV2.z;
    }
    n.geo.attributes.position.needsUpdate=true;
  });

  const bay=conns.find(n=>n.id==='baileys'),msg=conns.find(n=>n.id==='messages');
  chainCurve.v0.copy(bay.group.position);
  chainCurve.v2.copy(msg.group.position);
  chainCurve.v1.copy(bay.group.position).add(msg.group.position).multiplyScalar(.5);
  chainCurve.v1.z+=.55;
  const ca=chainGeo.attributes.position.array;
  for(let i=0;i<=CHAIN_SEG;i++){
    chainCurve.getPoint(i/CHAIN_SEG,tmpV2);
    ca[i*3]=tmpV2.x;ca[i*3+1]=tmpV2.y;ca[i*3+2]=tmpV2.z;
  }
  chainGeo.attributes.position.needsUpdate=true;

  packets.forEach(p=>{
    p.t=(p.t+dt*p.speed*flow.v*(RM?.4:1))%1;
    p.node.curve.getPoint(p.dir>0?p.t:1-p.t,tmpV2);
    p.mesh.position.copy(tmpV2);
    p.mesh.material.opacity=Math.min(1,Math.min(p.t,1-p.t)*8)*.95;
  });

  pUniforms.uTime.value=t*(RM?.3:1);
  particles.rotation.y=t*.008;

  camera.position.set(cam.x+par.x,cam.y+par.y,cam.z);
  camera.lookAt(cam.lx,cam.ly,0);

  if(FINE&&ndc.x>-1.5){
    raycaster.setFromCamera(ndc,camera);
    lightTarget.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction,10.2);
    curLight.position.lerp(lightTarget,.18);
    curLight.intensity+=((overUI?8:26)+Math.sin(t*7)*2-curLight.intensity)*.1;
  }

  if(FINE&&!overUI&&!chipActive&&!dragging){
    raycaster.setFromCamera(ndc,camera);
    const hit=raycaster.intersectObjects(hitMeshes,false)[0];
    const n=hit?hit.object.userData.node:null;
    if(n!==hovered){hovered&&highlight(hovered,false);hovered=n;hovered&&highlight(hovered,true);}
  }
  if(tipNode){
    tipNode.group.getWorldPosition(tmpV2).project(camera);
    if(tmpV2.z<1){
      const x=Math.min(Math.max((tmpV2.x*.5+.5)*innerWidth,110),innerWidth-110);
      const y=Math.min(Math.max((-tmpV2.y*.5+.5)*innerHeight-14,80),innerHeight-16);
      $('#tip').style.left=x+'px';$('#tip').style.top=y+'px';
    }
  }
  composer.render();
}

/* ================================================================
   5 · MORPH + GIRO 360° + INTERACCIÓN
================================================================ */
const card=$('#card'),faceFront=$('#faceFront'),faceBack=$('#faceBack'),tip=$('#tip');
let activeNode=null,morphTl=null,revertCall=null;
const SHADOW_BASE='0 34px 90px -22px rgba(2,12,27,.7)';

function morphTo(node){
  if(spinning)return;
  if(node===activeNode)return;
  revertCall&&revertCall.kill();revertCall=null;
  if(!node){revertCall=gsap.delayedCall(.14,()=>{if(!spinning)applyMorph(null);});return;}
  applyMorph(node);
}
function resetToBase(){
  revertCall&&revertCall.kill();revertCall=null;
  if(spinning)cancelSpin();
  applyMorph(null);
}
function applyMorph(node){
  activeNode=node;morphTl&&morphTl.kill();
  const acc=node?node.css:'#0FB5BA',accText=node?node.ui:'#0E7C8C';
  const shadow=node
    ?`${SHADOW_BASE},0 0 0 1.5px ${node.css}55,0 0 46px -10px ${node.css}66`
    :`${SHADOW_BASE},0 0 0 0px rgba(15,181,186,0),0 0 0px 0px rgba(15,181,186,0)`;
  morphTl=gsap.timeline({defaults:{ease:'power3.out'}});
  morphTl.to(card,{'--acc':acc,'--accText':accText,'--btn2':accText,boxShadow:shadow,duration:.55,ease:'power2.out'},0);

  const pill=$('#pill');
  morphTl.to(pill,{autoAlpha:0,y:-5,duration:.16,ease:'power2.in'},0)
    .add(()=>{
      $('#pillTxt').textContent=node?node.ctx[0].split('·')[0].trim():'Acceso seguro';
      $('#pillDot').style.background=node?node.css:'#22C55E';
      pill.style.color=node?node.ui:'#15803D';
      pill.style.background=node?node.css+'1c':'rgba(34,197,94,.12)';
      pill.style.borderColor=node?node.css+'44':'rgba(34,197,94,.25)';
    })
    .to(pill,{autoAlpha:1,y:0,duration:.3},.18);

  if(node){
    $('#ctxIco').src=iconDataURL[node.icon]||'';
    $('#ctxName').textContent=node.ctx[0];
    $('#ctxDesc').textContent=node.ctx[1];
    $('#ctxS1').textContent=node.ctx[2];
    $('#ctxS2').textContent=node.ctx[3];
    morphTl.to('#ctxDefault',{y:-14,autoAlpha:0,duration:.25,ease:'power2.in'},0)
      .fromTo('#ctxModule',{y:18,autoAlpha:0},{y:0,autoAlpha:1,duration:.45,ease:'back.out(1.6)'},.14)
      .fromTo('#ctxIco',{scale:.4,rotation:-14},{scale:1,rotation:0,duration:.55,ease:'elastic.out(1,.55)'},.16)
      .fromTo('.ctx-stats span',{y:8,autoAlpha:0},{y:0,autoAlpha:1,duration:.3,stagger:.07},.28);
  }else{
    morphTl.to('#ctxModule',{y:14,autoAlpha:0,duration:.22,ease:'power2.in'},0)
      .fromTo('#ctxDefault',{y:-12,autoAlpha:0},{y:0,autoAlpha:1,duration:.4},.16);
  }
  $$('.chip').forEach(c=>c.classList.toggle('on',!!node&&c.dataset.node===node.id));
}

/* Giro 360° izquierda → derecha con reverso de marca */
function spinTo(node){
  if(!node)return;
  if(spinning)cancelSpin();
  spinning=true;
  revertCall&&revertCall.kill();
  gsap.killTweensOf(card,'rotationX,rotationY,scale');
  $('#backIco').src=iconDataURL[node.icon]||'';
  $('#backName').textContent=node.ctx[0];
  $('#backDesc').textContent=node.ctx[1];
  faceBack.style.setProperty('--bc',node.css);
  gsap.set(card,{transformPerspective:1200,rotationX:0});
  spinTl=gsap.timeline({onComplete:()=>{
    spinning=false;gsap.set(card,{rotationY:0,rotationX:0,scale:1});
    gsap.set(faceFront,{opacity:1});
  }});
  spinTl.to(card,{rotationY:-360,duration:RM?.01:1.15,ease:'power2.inOut'},0)
    .to(card,{scale:.94,duration:.5,ease:'power2.in'},0)
    .to(card,{scale:1,duration:.62,ease:'back.out(1.6)'},.53)
    .to(faceFront,{opacity:0,duration:.1},.44)
    .add(()=>applyMorph(node),.5)
    .fromTo('.back-ico',{scale:.55,rotation:-18},{scale:1,rotation:0,duration:.6,ease:'back.out(2)'},.34)
    .fromTo(['#backName','#backDesc','.back-tag'],{y:10,autoAlpha:0},{y:0,autoAlpha:1,duration:.35,stagger:.05},.42)
    .to(faceFront,{opacity:1,duration:.12},.66)
    .add(()=>burst(node),.5);
}
function cancelSpin(){
  spinTl&&spinTl.kill();spinTl=null;spinning=false;
  gsap.set(card,{rotationY:0,rotationX:0,scale:1});
  gsap.set(faceFront,{opacity:1});
}

function highlight(node,on){
  if(threeOK){
    gsap.to(node.group.scale,{x:on?1.3:1,y:on?1.3:1,z:on?1.3:1,duration:.5,ease:'back.out(2)',overwrite:'auto'});
    gsap.to(node.halo.material,{opacity:on?1:.8,duration:.4,overwrite:'auto'});
  }
  if(on){
    morphTo(node);
    if(threeOK){
      tipNode=node;
      $('#tipDot').style.background=node.css;
      $('#tipDot').style.boxShadow=`0 0 10px ${node.css}`;
      $('#tipTitle').textContent=node.label;
      $('#tipDesc').textContent=node.desc;
      gsap.to(tip,{autoAlpha:1,duration:.3,overwrite:'auto'});
    }
  }else{
    if(activeNode===node)morphTo(null);
    if(tipNode===node){tipNode=null;gsap.to(tip,{autoAlpha:0,duration:.25,overwrite:'auto'});}
  }
}
function burst(node){
  if(!threeOK)return;
  const mat=new THREE.SpriteMaterial({map:ringTex,color:node.color,transparent:true,opacity:.9,blending:THREE.AdditiveBlending,depthWrite:false});
  const s=new THREE.Sprite(mat);
  s.position.copy(node.group.position);s.scale.setScalar(.4);world.add(s);
  gsap.to(s.scale,{x:2.4,y:2.4,duration:.8,ease:'power2.out'});
  gsap.to(mat,{opacity:0,duration:.8,ease:'power2.out',onComplete:()=>{world.remove(s);mat.dispose();}});
  gsap.fromTo(flow,{v:2.6},{v:1,duration:1.6,ease:'power2.out',overwrite:'auto'});
  showToast('⚡ '+node.label+' · sincronizado');
}

/* ---------- Cursor: luz en el fondo, manito dorada en el formulario ---------- */
let curX,curY,glowX,glowY,ringS,curMode=null;
function setCurMode(ui){
  if(curMode===ui)return;curMode=ui;
  gsap.to('#cur',{autoAlpha:ui?0:1,duration:.2,overwrite:'auto'});
}
if(FINE&&!RM){
  document.documentElement.classList.add('has-cursor');
  curX=gsap.quickTo('#cur','x',{duration:.12,ease:'power3.out'});
  curY=gsap.quickTo('#cur','y',{duration:.12,ease:'power3.out'});
  glowX=gsap.quickTo('#curGlow','x',{duration:.5,ease:'power3.out'});
  glowY=gsap.quickTo('#curGlow','y',{duration:.5,ease:'power3.out'});
  ringS=gsap.quickTo('#curRing','scale',{duration:.3,ease:'back.out(2)'});
  document.addEventListener('pointerleave',()=>gsap.to(['#cur','#curGlow'],{autoAlpha:0,duration:.25}));
  document.addEventListener('pointerenter',()=>{gsap.to('#curGlow',{autoAlpha:1,duration:.25});gsap.to('#cur',{autoAlpha:curMode?0:1,duration:.25});});
  addEventListener('pointerdown',()=>gsap.to('#curDot',{scale:.65,duration:.15}));
  addEventListener('pointerup',()=>gsap.to('#curDot',{scale:1,duration:.3,ease:'back.out(3)'}));
}

/* ---------- Puntero ---------- */
addEventListener('pointermove',e=>{
  ndc.set((e.clientX/innerWidth)*2-1,-(e.clientY/innerHeight)*2+1);
  overUI=!!e.target.closest('input,button,a,label,.chip,#card,.ticker');
  if(FINE&&!RM){
    curX(e.clientX);curY(e.clientY);glowX(e.clientX);glowY(e.clientY);
    setCurMode(overUI);
    ringS(hovered&&!overUI?1:0);
  }
  if(overUI&&hovered&&!chipActive){highlight(hovered,false);hovered=null;}
  if(dragging){
    const dx=e.clientX-lastPX,dy=e.clientY-lastPY;
    dragMoved+=Math.abs(dx)+Math.abs(dy);
    rot.ty+=dx*.005;velY=dx*.005;
    rot.tx=Math.min(.45,Math.max(-.45,rot.tx+dy*.003));
    lastPX=e.clientX;lastPY=e.clientY;
  }else if(FINE&&!RM&&threeOK){
    parX((e.clientX/innerWidth-.5)*1.1);parY(-(e.clientY/innerHeight-.5)*.7);
  }
});
addEventListener('pointerdown',e=>{
  if(overUI||logging||RM)return;
  dragging=true;dragMoved=0;lastPX=e.clientX;lastPY=e.clientY;velY=0;
});
addEventListener('pointerup',()=>{
  if(dragging){
    dragging=false;rot.ty+=velY*6;
    if(dragMoved<5&&hovered&&!overUI)spinTo(hovered);
    if(dragMoved<5&&!hovered&&!overUI&&!FINE)resetToBase();
  }
});
addEventListener('wheel',e=>{
  if(overUI||logging||!threeOK||RM)return;
  e.preventDefault();
  const z=Math.min(16,Math.max(8.5,cam.z+e.deltaY*.004));
  gsap.to(cam,{z,duration:.6,ease:'power2.out',overwrite:'auto'});
},{passive:false});
const parX=gsap.quickTo(par,'x',{duration:1,ease:'power3.out'});
const parY=gsap.quickTo(par,'y',{duration:1,ease:'power3.out'});

/* Clic en cualquier parte del formulario → estado base inmediato */
card.addEventListener('pointerdown',resetToBase,true);
card.addEventListener('focusin',resetToBase);

$$('.chip').forEach(chip=>{
  const node=()=>conns.find(n=>n.id===chip.dataset.node)||NODES.find(n=>n.id===chip.dataset.node);
  const on=()=>{const n=node();if(n){chipActive=true;highlight(n,true);}};
  const off=()=>{const n=node();if(n){chipActive=false;highlight(n,false);}};
  chip.addEventListener('mouseenter',on);chip.addEventListener('mouseleave',off);
  chip.addEventListener('focus',on);chip.addEventListener('blur',off);
  chip.addEventListener('click',()=>{const n=node();if(n)spinTo(n);});
});

/* ================================================================
   6 · UI
================================================================ */
let toastTl;
function showToast(msg){
  const el=$('#toast');el.textContent=msg;toastTl&&toastTl.kill();
  toastTl=gsap.timeline()
    .fromTo(el,{autoAlpha:0,y:16},{autoAlpha:1,y:0,duration:.4,ease:'back.out(1.6)'})
    .to(el,{autoAlpha:0,y:10,duration:.35,ease:'power2.in'},'+=2.4');
}
const TICKS=[
  ['#00E5A0','Baileys: conexión directa por WebSocket'],
  ['#19C2D8','Sesión multidispositivo vinculada por QR'],
  ['#25D366','Mensajes con estado de entrega y lectura'],
  ['#4DA3FF','Recordatorios y follow-ups programados'],
  ['#FF6B5A','Reconexión automática y alertas'],
  ['#F6C445','Etiquetas y seguimiento por lead'],
];
let tickIdx=0;
function cycleTicker(){
  const [c,t]=TICKS[tickIdx%TICKS.length];tickIdx++;
  $('#tickerDot').style.background=c;$('#tickerDot').style.color=c;
  $('#tickerText').textContent=t;
  gsap.timeline({onComplete:()=>gsap.delayedCall(2.4,cycleTicker)})
    .fromTo('#tickerText',{y:10,autoAlpha:0},{y:0,autoAlpha:1,duration:.5,ease:'power3.out'})
    .set({},{},'+=2')
    .to('#tickerText',{y:-10,autoAlpha:0,duration:.4,ease:'power2.in'});
}

$('#eyeBtn').addEventListener('click',()=>{
  const inp=$('#pass'),show=inp.type==='password';
  inp.type=show?'text':'password';
  $('#eyeOn').classList.toggle('hidden',show);
  $('#eyeOff').classList.toggle('hidden',!show);
  $('#eyeBtn').setAttribute('aria-pressed',show);
  inp.focus();
});
['keydown','keyup'].forEach(ev=>$('#pass').addEventListener(ev,e=>{
  $('#capsHint').classList.toggle('show',!!(e.getModifierState&&e.getModifierState('CapsLock')));
}));
['email','pass'].forEach(id=>$('#'+id).addEventListener('input',()=>$('#'+id+'Field').classList.remove('invalid')));

function shake(el){gsap.fromTo(el,{x:0},{keyframes:[{x:-7},{x:7},{x:-4},{x:4},{x:0}],duration:.4,ease:'power2.out'});}

$('#loginForm').addEventListener('submit',e=>{
  if(logging){e.preventDefault();return;}
  resetToBase();
  const user=$('#email').value.trim(),pass=$('#pass').value;
  let ok=true;
  if(!user){$('#emailField').classList.add('invalid');shake($('#emailField'));ok=false;}
  if(!pass){$('#passField').classList.add('invalid');shake($('#passField'));ok=false;}
  if(!ok){e.preventDefault();return;}
  logging=true;
  const btn=$('#submitBtn');
  btn.classList.add('loading');
  btn.disabled=true;
  $('#btnLabel').textContent='Ingresando…';
});

/* Tilt sutil (se pausa durante el giro 360°) */
if(FINE&&!RM){
  gsap.set(card,{transformPerspective:1200});
  const rx=gsap.quickTo(card,'rotationX',{duration:.6,ease:'power3.out'});
  const ry=gsap.quickTo(card,'rotationY',{duration:.6,ease:'power3.out'});
  card.addEventListener('pointermove',e=>{
    if(spinning)return;
    const r=card.getBoundingClientRect();
    ry(((e.clientX-r.left)/r.width-.5)*3.5);
    rx(-((e.clientY-r.top)/r.height-.5)*3.5);
  });
  card.addEventListener('pointerleave',()=>{if(!spinning){rx(0);ry(0);}});
}

/* ================================================================
   7 · ARRANQUE
================================================================ */
try{buildScene();}catch(err){console.warn('WebGL no disponible:',err);threeOK=false;}
window.__booted=true;

if(threeOK){
  renderer.setAnimationLoop(tick);
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)renderer.setAnimationLoop(null);
    else{clock.getDelta();renderer.setAnimationLoop(tick);}
  });
  addEventListener('resize',()=>{
    camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
    renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight);
    pUniforms.uPR.value=renderer.getPixelRatio();
    layoutScene();
    if(!logging)gsap.to(cam,{lx:camHome.lx,ly:camHome.ly,duration:.8});
  });
}

gsap.set('.rv-left',{autoAlpha:0,y:26});
gsap.set(card,{autoAlpha:0,y:44});
gsap.set('.card-in',{autoAlpha:0,y:18});
gsap.set('.rv-foot',{autoAlpha:0});

function reveal(){
  if(RM){
    gsap.set(['.rv-left',card,'.card-in','.rv-foot'],{autoAlpha:1,y:0});
    gsap.to('#loader',{autoAlpha:0,duration:.3,onComplete:()=>$('#loader').remove()});
    cycleTicker();return;
  }
  const tl=gsap.timeline({defaults:{ease:'power3.out'}});
  tl.to('#loader',{autoAlpha:0,duration:.7,ease:'power2.inOut',onComplete:()=>$('#loader').remove()});
  if(threeOK){
    tl.to(cam,{z:12,duration:1.9,ease:'expo.out'},.15)
      .to(intro,{v:1,duration:1.4,ease:'back.out(1.3)'},.2)
      .to(rim.scale,{x:1,y:1,z:1,duration:1.15,ease:'elastic.out(1,.55)'},.35)
      .to(core.scale,{x:1,y:1,z:1,duration:.9,ease:'back.out(2)'},.5)
      .to(coreLight,{intensity:30,duration:1.2},.5)
      .to(glowSprite.material,{opacity:.5,duration:1.2},.6)
      .to(nodeGroups.map(g=>g.scale),{x:1,y:1,z:1,duration:.7,ease:'back.out(2.2)',stagger:{each:.09,from:'random'}},.65)
      .to(ringMats,{opacity:.16,duration:.6,stagger:.05},.75)
      .to(decorMats,{opacity:(i,m)=>m.userData.target,duration:.6,stagger:.1},.8)
      .to(lineMats,{opacity:.32,duration:.6,stagger:.07},.85)
      .to(chainMat,{opacity:.22,duration:.7},1)
      .to(packets.map(p=>p.mesh.scale),{x:1,y:1,z:1,duration:.4,stagger:.03},1.05);
  }
  tl.to('.rv-left',{autoAlpha:1,y:0,duration:.9,stagger:.1},.55)
    .to(card,{autoAlpha:1,y:0,duration:1,ease:'expo.out'},.7)
    .to('.card-in',{autoAlpha:1,y:0,duration:.7,stagger:.06},.95)
    .to('.rv-foot',{autoAlpha:1,duration:.8},1.35)
    .add(()=>cycleTicker(),1.6);
}

const prog={v:0};
gsap.to(prog,{v:100,duration:1.6,ease:'power2.inOut',
  onUpdate:()=>{$('#loadBar').style.width=prog.v+'%';$('#loadPct').textContent=Math.round(prog.v)+'%';},
  onComplete:async()=>{await (document.fonts?.ready||Promise.resolve());reveal();}
});
