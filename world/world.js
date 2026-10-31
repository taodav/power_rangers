import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {makeRanger,makeCore,makeIsland,makePhysicsRig} from './robots.js';
import {applyAtmosphere,makeCity} from './city.js';
import {createConstruction} from './construction.js';
import {createCoreSmoother,createViews,updateCityUI} from './views.js';

const $=id=>document.getElementById(id), viewport=$('viewport');
let state=null, selected=-1, online=false, pending=false, lastEvent=-1, lastPhase='', follow=false;
const rangerModels=[],labels=[],cards=[];
const phaseCopy={
  roaming:['Independent patrol','Four robots exploring their own corners of the world.','FOUR INDEPENDENT RANGERS','Each robot owns its own durable planner.'],
  rendezvous:['Meet at the core','Assembly waits for all four persisted docking receipts.','RENDEZVOUS IN PROGRESS','Four waypoints. One shared assembly barrier.'],
  assembling:['Becoming something bigger','The original robot meshes fold and move into their mounts.','MAGNETIC RAILS ENGAGED','Ember + Cobalt → arms. Sol + Jade → legs.'],
  combined:['Megazord online','Four identities remain intact. Move together or split the team.','FOUR RANGERS. ONE MEGAZORD.','Shared torso and head · four independently owned limbs.'],
  separating:['Back to four','Unfolding the same robot modules into independent Rangers.','RELEASING THE TEAM','Same actors. Same memories. New individual goals.']
};
const formatTime=time=>`${String(Math.floor(time/60)).padStart(2,'0')}:${(time%60).toFixed(1).padStart(4,'0')}`;
function error(message){$('error').hidden=!message;$('error').textContent=message;}
function connection(ok){online=ok;$('connection').textContent=ok?'Four actors · local Terse':'World disconnected';$('connection-dot').classList.toggle('online',ok);}

const scene=new THREE.Scene();scene.background=new THREE.Color('#e4e9d9');scene.fog=new THREE.Fog('#e4e9d9',38,85);
const camera=new THREE.PerspectiveCamera(36,1,.1,160);camera.position.set(19,18,23);
let renderer;
try {renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});}
catch {error('WebGL is unavailable. Open this page in a browser with hardware acceleration to see the city.');throw new Error('WebGL unavailable');}
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.32;
viewport.prepend(renderer.domElement);renderer.domElement.setAttribute('aria-label','Four articulated Rangers in a city, followed by one camera each. They share one camera once combined.');
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,1,0);controls.enableDamping=true;controls.dampingFactor=.065;
controls.minDistance=7;controls.maxDistance=47;controls.minPolarAngle=.18;controls.maxPolarAngle=Math.PI*.46;
controls.addEventListener('start',()=>follow=false);
scene.add(new THREE.HemisphereLight('#fffce9','#9cac8c',2.6));
const sun=new THREE.DirectionalLight('#fff5d8',3.3);sun.position.set(-9,18,12);sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-15,right:15,top:15,bottom:-15,near:.5,far:55});sun.shadow.normalBias=.035;sun.shadow.bias=-.0001;scene.add(sun);
const fill=new THREE.DirectionalLight('#c2d7e6',1.15);fill.position.set(12,8,-8);scene.add(fill);
const backdrop=new THREE.Mesh(new THREE.PlaneGeometry(300,300),new THREE.MeshStandardMaterial({color:'#e0e5d4',roughness:1}));backdrop.rotation.x=-Math.PI/2;backdrop.position.y=-2.8;backdrop.receiveShadow=true;scene.add(backdrop);
const atmosphere=applyAtmosphere(scene,renderer,sun);makeCity(scene,renderer);const construction=createConstruction(scene),smoothCore=createCoreSmoother();let views=null,lastFrame=performance.now();
makeIsland(scene);const core=makeCore();scene.add(core.root);const physicsRig=makePhysicsRig(scene);
const railMaterial=new THREE.LineBasicMaterial({color:'#aec18e',transparent:true,opacity:.6});
const rails=[];
for(let i=0;i<4;i++){const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),railMaterial);line.visible=false;scene.add(line);rails.push(line);}
const mount=[[-1.32,2.08,0],[1.32,2.08,0],[-.52,0,0],[.52,0,0]];
const smooth=p=>p*p*(3-2*p);
function resize(){const {width,height}=viewport.getBoundingClientRect();renderer.setSize(width,height,false);camera.aspect=width/height;camera.fov=width<540?48:36;camera.updateProjectionMatrix();}
new ResizeObserver(resize).observe(viewport);resize();

function label(name,color) {
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=64;const ctx=canvas.getContext('2d');
  ctx.fillStyle='#f6f7eced';ctx.beginPath();ctx.roundRect(2,4,252,54,16);ctx.fill();
  ctx.fillStyle=color;ctx.beginPath();ctx.arc(28,31,6,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#435740';ctx.font='600 22px sans-serif';ctx.textAlign='center';ctx.fillText(name.toUpperCase(),143,39);
  const texture=new THREE.CanvasTexture(canvas),sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:false,transparent:true}));
  sprite.scale.set(1.8,.45,1);sprite.renderOrder=5;scene.add(sprite);return sprite;
}
function select(slot){selected=selected===slot?-1:slot;follow=selected>=0;cards.forEach((card,i)=>card.classList.toggle('selected',i===selected));}
function setupRangers(rangers) {
  rangers.forEach((r,slot)=>{
    const bot=makeRanger(r.color,slot);scene.add(bot.root);rangerModels.push(bot);labels.push(label(r.name,r.color));
    const card=document.createElement('button');card.className='ranger-card';card.style.setProperty('--ranger',r.color);
    card.innerHTML='<div class="card-top"><span class="avatar" aria-hidden="true"><span class="helmet"></span></span><div><div class="ranger-name"></div><div class="ranger-role"></div></div><span class="ranger-state"></span></div><div class="card-bottom"><span class="actor-id"></span><b class="card-decisions"></b></div>';
    card.querySelector('.ranger-name').textContent=r.name;card.querySelector('.ranger-role').textContent=`Ranger 0${slot+1} → ${r.role}`;
    card.addEventListener('click',()=>select(slot));card.setAttribute('aria-label',`Follow ${r.name}, ${r.role}`);$('ranger-cards').append(card);cards.push(card);
  });
}
function updateUI() {
  const copy=phaseCopy[state.phase]??phaseCopy.roaming;
  $('phase-title').textContent=state.paused?'World paused':copy[0];$('phase-description').textContent=copy[1];
  $('scene-state').textContent=copy[2];$('scene-detail').textContent=copy[3];$('sim-time').textContent=formatTime(state.time);
  if(state.physics){
    const p=state.physics;
    $('phase-title').textContent=state.paused?'Physics paused':p.walking?'Joint-driven MuJoCo walk':'MuJoCo hold';
    $('phase-description').textContent=`${p.steps} confirmed steps · ${p.forward.toFixed(2)} m forward · ${p.max_tilt_deg.toFixed(1)}° max tilt · contacts ${Number(p.contacts.left)+Number(p.contacts.right)}/2`;
    $('scene-state').textContent='MUJOCO · LIVE PHYSICAL RIG';
    $('scene-detail').textContent='Actual collision geometry and joint motion. Assembly remains kinematic.';
  }
  $('actor-count').textContent=`${state.bots.filter(b=>b.activation).length}/4`;
  $('decisions').textContent=state.bots.reduce((sum,b)=>sum+b.decisions+(b.physicsSequence??0),0);$('docked').textContent=`${state.bots.filter(b=>b.docked).length} / 4`;
  $('pause').textContent=state.paused?'▶ Resume':'Ⅱ Pause';$('pause').disabled=!online||pending||!!state.error;
  $('assemble').textContent=state.phase==='combined'?'Separate team ↗':state.phase==='roaming'?'Assemble team ↗':state.phase==='separating'?'Releasing…':'Assembling…';
  $('assemble').disabled=!online||pending||!!state.error||!['roaming','combined'].includes(state.phase);
  $('patrol').hidden=state.phase!=='combined';$('patrol').textContent=state.patrol?'Finish & hold':'Walk in MuJoCo';$('patrol').disabled=!online||pending||state.paused||!!state.error||!state.physicsAvailable;
  $('patrol').title=state.physicsAvailable?'Joint-driven native locomotion':'Restart the world server with its repo-local physics dependencies installed';
  const phases=['roaming','rendezvous','assembling','combined'],index=phases.indexOf(state.phase);
  document.querySelectorAll('[data-stage]').forEach((el,i)=>el.classList.toggle('active',i<=index));
  $('progress-fill').style.width=`${state.phase==='roaming'?0:state.phase==='rendezvous'?25+state.bots.filter(b=>b.docked).length*6.25:state.phase==='combined'?100:50+state.progress*50}%`;
  state.bots.forEach((b,i)=>{
    cards[i].querySelector('.ranger-state').textContent=state.paused?'paused':state.physics?.phase==='standing'?'holding':b.status;
    cards[i].querySelector('.actor-id').textContent=`ACTOR ${b.id.split('-')[1]}·${i+1}`;
    cards[i].querySelector('.card-decisions').textContent=`${b.decisions+(b.physicsSequence??0)} saved`;
    cards[i].title=`${b.id} · ${b.decisions} persisted decisions${b.docked?' · docking receipt saved':''}`;
    cards[i].setAttribute('aria-pressed',String(i===selected));
  });
  if(state.events.at(-1)?.id!==lastEvent) {
    lastEvent=state.events.at(-1)?.id;$('event-log').replaceChildren();
    for(const event of [...state.events].reverse()) {
      const row=document.createElement('div');row.className='event-row';const ranger=state.rangers[event.slot];if(ranger)row.style.setProperty('--ranger',ranger.color);
      for(const [className,text] of [['event-time',formatTime(event.time)],['event-source',ranger?.name.toUpperCase()??'SYSTEM'],['event-text',event.text]]){const span=document.createElement('span');span.className=className;span.textContent=text;row.append(span);}
      $('event-log').append(row);
    }
  }
  updateCityUI(state,!online||pending);
  if(state.error)error(state.error);
  if(state.phase!==lastPhase){if(state.phase==='assembling')frameCore();lastPhase=state.phase;}
}
async function poll() {
  try {
    const response=await fetch('/api/state',{cache:'no-store',signal:AbortSignal.timeout(2500)});if(!response.ok)throw new Error('State unavailable');
    const next=await response.json();if(typeof next.physics!=='object'||!next.physics?.geoms)next.physics=null;
    if(state&&next.run!==state.run){location.reload();return;}
    if(!state){setupRangers(next.rangers);views=createViews({renderer,scene,camera,controls,atmosphere,rangers:next.rangers});}state=next;connection(true);error(state.error);updateUI();$('loading').hidden=true;
  } catch {connection(false);error('The local world is disconnected. Controls are disabled; no movement is being invented. Start run_world.py to reconnect.');for(const id of ['pause','assemble','patrol'])$(id).disabled=true;}
  setTimeout(poll,online?120:1000);
}
async function command(name) {
  if(!online||pending)return;pending=true;updateUI();
  try{const response=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:name}),signal:AbortSignal.timeout(5000)});const body=await response.json();if(!response.ok)throw new Error(body.error??'Command failed');}
  catch(e){error(e.message);}finally{pending=false;updateUI();}
}
$('pause').addEventListener('click',()=>command('pause'));
$('assemble').addEventListener('click',()=>command(state.phase==='combined'?'separate':'assemble'));
$('patrol').addEventListener('click',()=>command('patrol'));
$('rebuild').addEventListener('click',()=>command('rebuild'));
let cameraGoal=null,targetGoal=null;
function frameTeam(){follow=false;selected=-1;cards.forEach(c=>c.classList.remove('selected'));cameraGoal=new THREE.Vector3(19,18,23);targetGoal=new THREE.Vector3(0,1,0);}
function frameCore(){follow=false;const c=state?.core??{x:0,z:0};cameraGoal=new THREE.Vector3(c.x+10,9,c.z+15);targetGoal=new THREE.Vector3(c.x,2.4,c.z);}
$('frame-team').addEventListener('click',frameTeam);$('frame-core').addEventListener('click',frameCore);
controls.addEventListener('start',()=>{cameraGoal=null;targetGoal=null;});
const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();let down=null;
renderer.domElement.addEventListener('pointerdown',e=>down=[e.clientX,e.clientY]);
renderer.domElement.addEventListener('pointerup',e=>{
  if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;
  const box=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-box.left)/box.width*2-1,-(e.clientY-box.top)/box.height*2+1);
  raycaster.setFromCamera(pointer,views?views.cameraAt(e.clientX,e.clientY,pointer):camera);const hit=raycaster.intersectObjects(rangerModels.map(b=>b.root),true).find(hit=>Number.isInteger(hit.object.userData.slot));if(hit)select(hit.object.userData.slot);
});

function render() {
  requestAnimationFrame(render);
  const frameAt=performance.now(),dt=Math.min(.1,(frameAt-lastFrame)/1000);lastFrame=frameAt;
  if(state) {
    const transforming=['assembling','combined','separating'].includes(state.phase),p=smooth(state.progress),c=smoothCore(state.core,frameAt/1000,state.paused);
    const cx=c.x*(state.phase==='separating'?p:1),cz=c.z*(state.phase==='separating'?p:1),cyaw=c.yaw*(state.phase==='separating'?p:1);
    core.root.visible=!state.physics;physicsRig.update(state.physics);
    core.root.position.set(cx,0,cz);core.root.rotation.y=cyaw;core.pose(p,state.time);
    rangerModels.forEach((model,i)=>{
      const bot=state.bots[i],dock=state.rangers[i].dock,m=mount[i],scale=i<2?.9:1;
      model.root.visible=!state.physics;
      let x=bot.x,y=0,z=bot.z,yaw=bot.yaw;
      if(transforming) {
        const mx=cx+m[0]*Math.cos(cyaw)+m[2]*Math.sin(cyaw),mz=cz-m[0]*Math.sin(cyaw)+m[2]*Math.cos(cyaw);
        x=THREE.MathUtils.lerp(dock[0],mx,p);z=THREE.MathUtils.lerp(dock[1],mz,p);y=m[1]*p+Math.sin(p*Math.PI)*(i<2?1.1:.35);
        const shortest=Math.atan2(Math.sin(cyaw-bot.yaw),Math.cos(cyaw-bot.yaw));yaw=bot.yaw+shortest*p;
      }
      const destination=new THREE.Vector3(x,y,z);
      if(state.paused||!online||!model.root.userData.placed||state.phase==='combined')model.root.position.copy(destination);else model.root.position.lerp(destination,.23);
      model.root.userData.placed=true;model.root.rotation.set(0,yaw,0);model.root.scale.setScalar(THREE.MathUtils.lerp(1,scale,p));
      model.pose(bot.distance,bot.speed,transforming?p:0,selected===i);
      labels[i].position.copy(model.root.position).add(new THREE.Vector3(0,3.12,0));labels[i].visible=!transforming;
      rails[i].visible=['rendezvous','assembling','separating'].includes(state.phase);
      if(rails[i].visible){rails[i].geometry.setFromPoints([new THREE.Vector3(dock[0],.18,dock[1]),new THREE.Vector3(cx+m[0],p*m[1]+.2,cz)]);}
    });
    construction.update(state,rangerModels,p);
    views?.update(state,rangerModels,{x:cx,z:cz,yaw:cyaw},p,dt);
    if(follow&&selected>=0){const target=rangerModels[selected].root.position.clone();target.y+=1.5;const delta=target.clone().sub(controls.target).multiplyScalar(.035);camera.position.add(delta);controls.target.add(delta);}
  }
  if(cameraGoal){camera.position.lerp(cameraGoal,.045);controls.target.lerp(targetGoal,.045);if(camera.position.distanceTo(cameraGoal)<.02){cameraGoal=null;targetGoal=null;}}
  if(views)views.render();else{controls.update();renderer.render(scene,camera);}
}
render();poll();
