import * as THREE from 'three';

const materials = new Map();
function mat(color, metalness=.15, roughness=.52) {
  const key = `${color}/${metalness}/${roughness}`;
  if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({color, metalness, roughness}));
  return materials.get(key);
}
const IVORY='#edf0dc', DARK='#303e3b', METAL='#7f9085', GOLD='#d9b567';
function mesh(parent, geometry, color, x=0,y=0,z=0, metalness=.15) {
  const object=new THREE.Mesh(geometry,mat(color,metalness));
  object.position.set(x,y,z);object.castShadow=true;object.receiveShadow=true;parent.add(object);return object;
}
function armor(parent,w,h,d,color,x=0,y=0,z=0,c=.07) {
  c=Math.min(c,w/3,h/3);
  const shape=new THREE.Shape();
  shape.moveTo(-w/2+c,-h/2);shape.lineTo(w/2-c,-h/2);shape.lineTo(w/2,-h/2+c);
  shape.lineTo(w/2,h/2-c);shape.lineTo(w/2-c,h/2);shape.lineTo(-w/2+c,h/2);
  shape.lineTo(-w/2,h/2-c);shape.lineTo(-w/2,-h/2+c);shape.closePath();
  const geometry=new THREE.ExtrudeGeometry(shape,{depth:d,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:.018,bevelThickness:.018});
  geometry.translate(0,0,-d/2);
  return mesh(parent,geometry,color,x,y,z);
}
function ball(parent,r,color,x=0,y=0,z=0){return mesh(parent,new THREE.SphereGeometry(r,10,8),color,x,y,z,.45);}
function group(parent,x=0,y=0,z=0){const g=new THREE.Group();g.position.set(x,y,z);parent.add(g);return g;}
function emblem(parent,size,y,z,color=IVORY){const m=armor(parent,size,size,.025,color,0,y,z,.02);m.rotation.z=Math.PI/4;return m;}
function helmet(parent,color,scale=1) {
  const g=group(parent);g.scale.setScalar(scale);
  armor(g,.49,.46,.4,color,0,0,0,.12);
  armor(g,.43,.14,.06,DARK,0,.015,.22,.035);
  armor(g,.17,.11,.07,IVORY,0,-.16,.21,.035);
  armor(g,.075,.17,.035,IVORY,0,.165,.215,.01);
  armor(g,.085,.28,.28,IVORY,0,.12,-.015,.025);
  for(const side of [-1,1]){const ear=mesh(g,new THREE.CylinderGeometry(.075,.075,.055,10),METAL,side*.26,-.015,0,.7);ear.rotation.z=Math.PI/2;}
  return g;
}

/** Original articulated Ranger silhouettes. These exact meshes remain in the combined form. */
export function makeRanger(color,slot) {
  const root=new THREE.Group();root.userData.slot=slot;
  const body=group(root);
  const chest=group(body,0,1.82,0);
  armor(chest,.84,.66,.46,color,0,0,0,.15);
  armor(chest,.72,.17,.035,IVORY,0,.16,.255,.045);
  emblem(chest,.22,-.015,.27);emblem(chest,.075,-.015,.3,GOLD);
  armor(chest,.57,.14,.04,DARK,0,-.26,.255,.03);
  armor(chest,.45,.4,.17,METAL,0,0,-.31,.08);
  for(const x of [-.14,.14])armor(chest,.05,.25,.04,DARK,x,0,-.42,.01);
  armor(body,.57,.23,.38,DARK,0,1.37,0);
  armor(body,.69,.12,.43,IVORY,0,1.45,0,.03);
  armor(body,.18,.15,.07,GOLD,0,1.45,.255,.04);
  ball(body,.12,DARK,0,2.2,0);
  const headPivot=group(body,0,2.46,0);helmet(headPivot,color);
  const shoulders=[],elbows=[],hips=[],knees=[],feet=[];
  for(const side of [-1,1]) {
    const shoulder=group(body,side*.55,2.02,0);shoulders.push(shoulder);
    ball(shoulder,.15,DARK);
    armor(shoulder,.37,.29,.45,IVORY,side*.04,.02,0,.08);
    armor(shoulder,.31,.13,.045,color,side*.04,.1,.245,.025);
    armor(shoulder,.23,.37,.26,color,0,-.28,0,.05);
    const elbow=group(shoulder,0,-.49,0);elbows.push(elbow);ball(elbow,.115,METAL);
    armor(elbow,.28,.38,.31,IVORY,0,-.23,0,.06);
    armor(elbow,.23,.14,.035,color,0,-.18,.18,.03);
    armor(elbow,.22,.2,.24,DARK,0,-.49,.02,.04);
    const hip=group(body,side*.235,1.25,0);hips.push(hip);ball(hip,.14,METAL);
    armor(hip,.32,.43,.32,color,0,-.26,0,.07);
    const knee=group(hip,0,-.51,0);knees.push(knee);ball(knee,.13,DARK);
    armor(knee,.32,.22,.08,IVORY,0,-.015,.17,.05);
    armor(knee,.36,.49,.36,IVORY,0,-.28,0,.075);
    armor(knee,.22,.27,.045,color,0,-.25,.21,.05);
    const foot=group(knee,0,-.6,.09);feet.push(foot);
    armor(foot,.37,.22,.57,color,0,0,0,.065);
    armor(foot,.39,.07,.59,DARK,0,-.1,.01,.02);
    armor(foot,.29,.09,.05,IVORY,0,.02,.31,.02);
  }
  const gauntlet=group(body,0,.19,.08);
  if(slot<2) {
    armor(gauntlet,.7,.4,.58,color,0,0,0,.085);
    armor(gauntlet,.67,.12,.61,IVORY,0,.17,0,.035);
    for(let i=0;i<4;i++)armor(gauntlet,.12,.2,.08,METAL,(i-1.5)*.155,-.025,.33,.025);
  }
  const ring=mesh(root,new THREE.TorusGeometry(.9,.022,6,48),color,0,.035,0);ring.rotation.x=Math.PI/2;ring.castShadow=false;
  ring.material=mat(color).clone();ring.material.transparent=true;ring.material.opacity=.35;
  root.traverse(o=>o.userData.slot=slot);
  return {root,body,headPivot,shoulders,elbows,hips,knees,feet,ring,
    pose(distance,speed,fold,selected=false) {
      const gait=distance*5.1, moving=Math.min(1,speed), walk=1-fold;
      body.position.y=Math.abs(Math.sin(gait))*moving*.045*walk;
      body.rotation.z=Math.sin(gait)*moving*.025*walk;
      headPivot.position.y=2.46-fold*.6;headPivot.scale.setScalar(1-fold*.88);
      gauntlet.scale.setScalar(fold);gauntlet.visible=fold>.01;
      ring.visible=fold<.03;ring.material.opacity=selected?.85:.28;ring.scale.setScalar(selected?1.13:1);
      for(let i=0;i<2;i++) {
        const side=i===0?-1:1, cycle=gait+i*Math.PI;
        shoulders[i].position.x=side*(.55-fold*.11);
        shoulders[i].rotation.set(-Math.sin(cycle)*.5*moving*walk-fold*.16,0,side*(.08+fold*.1));
        elbows[i].rotation.x=-.12-fold*2.3-Math.max(0,Math.sin(cycle))*.18*moving*walk;
        hips[i].rotation.x=Math.sin(cycle)*.43*moving*walk+fold*.08;
        hips[i].position.x=side*(.235-fold*.09);
        knees[i].rotation.x=Math.max(0,-Math.sin(cycle))*.65*moving*walk-fold*.12;
        feet[i].rotation.x=fold*.04;
      }
    }};
}

/** Passive torso/head. Unfolds from the visible hub, never impersonates a fifth actor. */
export function makeCore() {
  const root=new THREE.Group(), body=group(root), torso=group(body);
  armor(torso,1.9,1.34,.85,IVORY,0,0,0,.23);
  armor(torso,1.72,.44,.08,DARK,0,.3,.49,.08);
  const left=armor(torso,.7,.32,.09,'#ed6655',-.43,.29,.55,.045);left.rotation.z=-.15;
  const right=armor(torso,.7,.32,.09,'#679df2',.43,.29,.55,.045);right.rotation.z=.15;
  emblem(torso,.45,-.04,.55,GOLD);emblem(torso,.19,-.04,.6,DARK);
  armor(torso,1.18,.32,.16,METAL,0,-.53,.4,.08);
  for(const x of [-.4,-.2,0,.2,.4])armor(torso,.07,.18,.03,DARK,x,-.51,.5,.01);
  armor(torso,1.5,.75,.4,DARK,0,0,-.56,.15);
  const shoulderBar=armor(body,2.95,.32,.62,IVORY,0,0,0,.09);
  for(const x of [-1.24,1.24]){
    ball(shoulderBar,.27,METAL,x,-.06,0);
    armor(shoulderBar,.46,.42,.65,DARK,x,-.2,0,.07);
    armor(shoulderBar,.48,.13,.68,IVORY,x,-.16,0,.025);
  }
  const waist=group(body);armor(waist,1.3,.46,.72,DARK,0,0,0,.12);armor(waist,1.45,.14,.78,GOLD,0,.13,.03,.035);
  for(const side of [-1,1]){
    ball(waist,.24,METAL,side*.52,-.31,0);
    armor(waist,.52,.38,.58,DARK,side*.52,-.39,0,.08);
    armor(waist,.55,.12,.62,IVORY,side*.52,-.39,0,.025);
  }
  for(const side of [-1,1]){const plate=armor(waist,.58,.45,.08,side<0?'#e8bb56':'#6cb99a',side*.38,-.1,.44,.06);plate.rotation.z=-side*.16;}
  const neck=mesh(body,new THREE.CylinderGeometry(.23,.3,.55,10),DARK);
  const head=group(body);helmet(head,IVORY,1.65);
  for(const side of [-1,1]){const horn=armor(head,.13,.51,.2,GOLD,side*.4,.29,0,.03);horn.rotation.z=-side*.35;}
  armor(head,.13,.28,.08,'#ed6655',0,.29,.38,.025);
  const beacon=mesh(root,new THREE.CylinderGeometry(.4,.64,.2,6),GOLD,0,.14,0,.45);
  return {root,body,pose(p,time) {
    torso.position.y=.82+p*2.88;torso.scale.set(1, .68+p*.32,1);
    shoulderBar.position.y=.88+p*3.35;shoulderBar.scale.x=.4+p*.6;
    waist.position.y=.35+p*2.19;waist.scale.setScalar(.6+p*.4);
    head.position.y=1.15+p*3.76;head.scale.setScalar(.35+p*.65);
    neck.position.y=1.05+p*3.44;neck.scale.setScalar(.3+p*.7);
    body.rotation.y=(1-p)*Math.sin(time*.25)*.05;
    beacon.visible=p<.92;
  }};
}

export function makeIsland(scene) {
  const island=new THREE.Group();scene.add(island);
  const soil=mesh(island,new THREE.CylinderGeometry(11.7,10.8,1.1,64),'#b2bda1',0,-.62,0);
  mesh(island,new THREE.CylinderGeometry(11.75,11.75,.15,64),'#d5ddc3',0,-.07,0);
  mesh(island,new THREE.CylinderGeometry(4.75,4.75,.06,64),'#bdcbb1',0,.035,0);
  mesh(island,new THREE.CylinderGeometry(3.05,3.05,.08,12),'#dae0cc',0,.09,0);
  const rim=mesh(island,new THREE.TorusGeometry(3.08,.025,6,96),'#8da080',0,.15,0);rim.rotation.x=Math.PI/2;
  const outer=mesh(island,new THREE.TorusGeometry(4.8,.018,6,96),'#a6b798',0,.055,0);outer.rotation.x=Math.PI/2;
  for(let i=-9;i<=9;i+=1.5) {
    const extent=Math.sqrt(11.1**2-i*i);
    for(const axis of [0,1]){const line=mesh(island,new THREE.BoxGeometry(axis?.012:extent*2,.008,axis?extent*2:.012),'#c5d0b5',axis?i:0,.012,axis?0:i);line.castShadow=false;}
  }
  for(let i=0;i<12;i++){const a=i/12*Math.PI*2,marker=mesh(island,new THREE.BoxGeometry(.045,.02,.22),'#819b76',Math.sin(a)*3.5,.14,Math.cos(a)*3.5);marker.rotation.y=a;}
  for(const [slot,color] of ['#ed6655','#679df2','#e8bb56','#6cb99a'].entries()) {
    const positions=[[-3.7,-1.5],[3.7,-1.5],[-1.55,3.7],[1.55,3.7]], [x,z]=positions[slot];
    const disc=mesh(island,new THREE.CylinderGeometry(.7,.7,.03,6),'#dfe5d2',x,.14,z);disc.rotation.y=Math.PI/6;
    const ring=mesh(island,new THREE.TorusGeometry(.69,.03,6,6),color,x,.17,z);ring.rotation.x=Math.PI/2;
    mesh(island,new THREE.BoxGeometry(.1,.025,.42),color,x,.17,z);
    mesh(island,new THREE.BoxGeometry(.42,.025,.1),color,x,.17,z);
  }
  // Decorative terrain is outside the actors' bounded patrol rectangles.
  for(let i=0;i<16;i++) {
    const a=i/16*Math.PI*2, radius=10.4+(i%3)*.2, x=Math.sin(a)*radius,z=Math.cos(a)*radius;
    if(i%4===0) {
      armor(island,.46,.7,.46,'#9cae8b',x,.3,z,.09);
      const lamp=mesh(island,new THREE.BoxGeometry(.38,.08,.38),'#eff3d7',x,.71,z);lamp.material=mat('#eff3d7').clone();lamp.material.emissive.set('#b9d294');lamp.material.emissiveIntensity=.25;
    } else {
      const rock=mesh(island,new THREE.DodecahedronGeometry(.34+(i%3)*.11,0),i%2?'#b7c4a6':'#9fb293',x,.16,z);rock.scale.set(1.2,.75,1);rock.rotation.set(.3,i,.4);
      for(let j=0;j<3;j++){const grass=mesh(island,new THREE.ConeGeometry(.13,.6+j*.12,4),'#8da877',x+.28+j*.13,.2,z+.17);grass.rotation.z=(j-1)*.2;}
    }
  }
  for(const side of [-1,1]) {
    const tower=group(island,side*5.5,0,-8.6);armor(tower,.8,2.1,.75,'#abbc99',0,1,0,.16);armor(tower,.72,.42,.82,IVORY,0,2.03,0,.08);
    armor(tower,.38,.11,.05,'#e6d39b',0,2.04,.45,.025);armor(tower,.14,1,.06,'#6f8965',0,1.06,.42,.02);
  }
  // Floating stratum, not a physical collision mesh.
  soil.castShadow=true;
  return island;
}


/** Authoritative collision-geometry view, not an animation of an invented path. */
export function makePhysicsRig(scene) {
  const group=new THREE.Group();group.scale.setScalar(2.4);group.position.y=.15;group.visible=false;scene.add(group);
  const meshes=new Map(), basis=new THREE.Matrix4().set(0,1,0,0, 0,0,1,0, 1,0,0,0, 0,0,0,1);
  return {group,update(state){
    group.visible=!!state;if(!state)return;
    for(const geom of state.geoms){
      let mesh=meshes.get(geom.name);
      if(!mesh){
        const [x,y,z]=geom.size;let geometry;
        if(geom.type===6)geometry=new THREE.BoxGeometry(2*x,2*y,2*z);
        else if(geom.type===2)geometry=new THREE.SphereGeometry(x,16,12);
        else if(geom.type===5){geometry=new THREE.CylinderGeometry(x,x,2*y,16);geometry.rotateX(Math.PI/2);}
        else continue;
        const material=new THREE.MeshStandardMaterial({color:new THREE.Color(...geom.rgba.slice(0,3)),roughness:.48,metalness:.2});
        mesh=new THREE.Mesh(geometry,material);mesh.matrixAutoUpdate=false;mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);meshes.set(geom.name,mesh);
        const edges=new THREE.LineSegments(new THREE.EdgesGeometry(geometry,30),new THREE.LineBasicMaterial({color:'#354938',transparent:true,opacity:.1}));mesh.add(edges);
      }
      const r=geom.mat,p=geom.pos;
      mesh.matrix.set(r[0],r[1],r[2],p[0], r[3],r[4],r[5],p[1], r[6],r[7],r[8],p[2], 0,0,0,1).premultiply(basis);
      mesh.matrixWorldNeedsUpdate=true;
    }
  }};
}
