import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const activePlayers = new Set();
export class RobotPlayer {
  constructor(root) {
    this.root = root;
    this.generation = 0;
    this.scrubbing = false;
    this.inView = true;
    this.rate = 1;
    this.needsRender = true;
    this.presentedTime = 0;
    this.pendingSeek = null;
    this.seekInFlight = false;
    this.resumeWhenSettled = false;
    root.innerHTML = `<div class="sync-row">
      <div class="sync-panel media"><video muted playsinline preload="metadata"></video><span class="panel-tag">RGB</span><span class="panel-tag tactile-tag">Tactile</span></div>
      <div class="sync-panel sim"><span class="panel-tag">Robot 3D</span><span class="orbit-hint">Drag to rotate · Scroll to zoom</span><span class="model-status">Loading robot…</span></div>
    </div><div class="transport">
      <button class="play" aria-label="Play">▶</button>
      <div class="track"><input type="range" min="0" max="1" step="0.00001" value="0" aria-label="Playback position"></div>
      <span class="time">0.00 / 0.00 s</span>
      <div class="speeds" aria-label="Playback speed"><button data-rate="0.5" aria-pressed="false">0.5×</button><button data-rate="1" aria-pressed="true">1×</button><button data-rate="2" aria-pressed="false">2×</button></div>
    </div><p class="clip-note" aria-live="polite"></p>`;
    this.rgb = root.querySelector('video');
    this.rgb.muted = true;
    this.seek = root.querySelector('input');
    this.track = root.querySelector('.track');
    this.time = root.querySelector('.time');
    this.button = root.querySelector('.play');
    this.note = root.querySelector('.clip-note');
    this.sim = root.querySelector('.sim');
    this.status = root.querySelector('.model-status');
    this.button.onclick = () => this.setPlaying(this.rgb.paused);
    for (const video of [this.rgb]) {
      video.addEventListener('error', () => {
        if (video.error && video.getAttribute('src')) {
          this.setPlaying(false);
          this.note.textContent = 'This clip could not be loaded. Please reload the page.';
          this.note.classList.add('player-error');
        }
      });
    }
    this.rgb.addEventListener('play', () => this.updateButton());
    this.rgb.addEventListener('pause', () => this.updateButton());
    this.rgb.addEventListener('loadedmetadata', () => { this.updateTransport(); this.flushSeek(); });
    this.rgb.addEventListener('durationchange', () => this.updateTransport());
    this.rgb.addEventListener('seeked', () => {
      const generation = this.generation;
      if (!('requestVideoFrameCallback' in this.rgb)) this.poseAt(this.rgb.currentTime);
      // Let the decoded frame paint before starting the next queued seek.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (generation !== this.generation) return;
        this.seekInFlight = false;
        this.flushSeek();
      }));
    });
    this.rgb.addEventListener('ended', () => { this.setPlaying(false); this.updateTransport(); });
    this.seek.addEventListener('pointerdown', () => {
      this.scrubbing = true;
      this.resumeAfterSeek = !this.rgb.paused;
      this.resumeWhenSettled = false;
      this.setPlaying(false);
    });
    this.seek.addEventListener('input', () => this.seekTo(Number(this.seek.value) * this.duration));
    const finishSeek = () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      this.resumeWhenSettled = this.resumeAfterSeek;
      this.resumeAfterSeek = false;
      this.flushSeek();
    };
    window.addEventListener('pointerup', finishSeek);
    window.addEventListener('pointercancel', finishSeek);
    this.seek.addEventListener('change', finishSeek);
    root.querySelectorAll('[data-rate]').forEach(button => {
      button.onclick = () => {
        this.rate = Number(button.dataset.rate);
        this.rgb.playbackRate = this.rate;
        root.querySelectorAll('[data-rate]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      };
    });
    root.tabIndex = 0;
    root.addEventListener('keydown', event => {
      // Native range arrows remain functional; transport shortcuts apply to the player.
      if (event.target.matches('input,button')) return;
      if (event.code === 'Space') { event.preventDefault(); this.setPlaying(this.rgb.paused); }
      if (['ArrowLeft','ArrowRight'].includes(event.code)) {
        event.preventDefault(); this.setPlaying(false);
        this.seekTo(this.rgb.currentTime + (event.code === 'ArrowRight' ? 1 : -1) / (this.clip?.fps || 30));
      }
    });
    new IntersectionObserver(entries => {
      this.inView = entries[0].isIntersecting;
      if (!this.inView) this.setPlaying(false);
    }).observe(root);
    activePlayers.add(this);
    this.initScene();
    // RGB and touch map share one decoded frame; 3D follows presented media time.
    if ('requestVideoFrameCallback' in this.rgb) {
      const presented = (_now, metadata) => {
        this.presentedTime = metadata.mediaTime;
        this.poseAt(this.presentedTime);
        this.rgb.requestVideoFrameCallback(presented);
      };
      this.rgb.requestVideoFrameCallback(presented);
    }
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
  }
  get duration() {
    return Number.isFinite(this.rgb.duration) ? this.rgb.duration : (this.clip?.duration || 0);
  }
  updateButton() {
    this.button.textContent = this.rgb.paused ? '▶' : 'Ⅱ';
    this.button.setAttribute('aria-label', this.rgb.paused ? 'Play' : 'Pause');
  }
  async setPlaying(on) {
    if (!on) { this.rgb.pause(); this.resumeWhenSettled=false; return; }
    for (const player of activePlayers) if (player !== this) player.setPlaying(false);
    if (this.rgb.ended) this.seekTo(0);
    const token = this.generation;
    try { await this.rgb.play(); }
    catch (error) {
      if (token !== this.generation || error.name === 'AbortError') return;
      this.rgb.pause();
      this.note.textContent = 'Press play to start the clip.';
    }
  }
  seekTo(t) {
    const time = Math.max(0, Math.min(this.duration, t));
    this.pendingSeek = time;
    this.updateTransport(time);
    this.flushSeek();
  }
  flushSeek() {
    if (this.seekInFlight || this.rgb.seeking || this.rgb.readyState < 1) return;
    if (this.pendingSeek !== null) {
      const time = this.pendingSeek;
      this.pendingSeek = null;
      if (Math.abs(this.rgb.currentTime - time) > .0001) {
        this.seekInFlight = true;
        this.rgb.currentTime = time;
        return;
      }
    }
    if (this.resumeWhenSettled && !this.scrubbing) {
      this.resumeWhenSettled = false;
      this.setPlaying(true);
    }
  }
  updateTransport(t = this.rgb.currentTime) {
    const d = this.duration;
    const progress = d ? Math.max(0, Math.min(1, t / d)) : 0;
    // Normalized range never depends on whether loadedmetadata was observed.
    if (!this.scrubbing) this.seek.value = progress;
    this.track.style.setProperty('--p', `${progress * 100}%`);
    this.time.textContent = `${t.toFixed(2)} / ${d.toFixed(2)} s`;
    this.seek.setAttribute('aria-valuetext', `${t.toFixed(2)} of ${d.toFixed(2)} seconds`);
  }
  initScene() {
    try { this.renderer = new THREE.WebGLRenderer({antialias:true,alpha:true}); }
    catch { this.status.textContent = '3D preview requires WebGL.'; return; }
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
    this.sim.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff,0x8a8f99,1.7));
    const key = new THREE.DirectionalLight(0xffffff,1.5); key.position.set(2,4,-2); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff,.6); fill.position.set(-2,2,3); this.scene.add(fill);
    const grid = new THREE.GridHelper(3,30,0xa3a9b5,0xd3d7de);
    grid.material.transparent=true; grid.material.opacity=.42; this.scene.add(grid);
    this.camera = new THREE.PerspectiveCamera(36,1,.01,50);
    // Robot x=forward, y=left, z=up -> glTF x=forward, y=up, z=right.
    this.camera.position.set(-1.12,1.55,1.15);
    this.orbit = new OrbitControls(this.camera,this.renderer.domElement);
    this.orbit.target.set(.12,.87,.02);
    this.orbit.enableDamping=true;
    this.orbit.addEventListener('change', () => { this.needsRender=true; });
    this.orbit.minDistance=.45; this.orbit.maxDistance=5;
    this.orbit.update();
    new ResizeObserver(() => {
      const w=this.sim.clientWidth,h=this.sim.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w,h,false); this.camera.aspect=w/h; this.camera.updateProjectionMatrix();
      this.needsRender=true;
    }).observe(this.sim);
  }
  disposeModel(model) {
    model.traverse(node => {
      node.geometry?.dispose();
      if (Array.isArray(node.material)) node.material.forEach(m => m.dispose());
      else node.material?.dispose();
    });
  }
  async load(clip) {
    this.setPlaying(false);
    this.clip = clip;
    const generation=++this.generation;
    this.scrubbing=false; this.resumeAfterSeek=false;
    this.pendingSeek=null;this.seekInFlight=false;this.resumeWhenSettled=false;
    this.note.classList.remove('player-error');
    this.note.textContent=[clip.note, !clip.hasContact ? 'Recorded tactile values are zero throughout this clip.' : ''].filter(Boolean).join(' · ');
    this.rgb.poster=clip.path+'sync_poster.jpg';
    this.rgb.src=clip.path+'sync.mp4?v=seek-v2';
    this.rgb.load();
    this.rgb.playbackRate=this.rate;
    this.updateTransport(0);
    if (!this.renderer) return;
    this.status.hidden=false; this.status.textContent='Loading robot…';
    if (this.model) {
      this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model);
      this.scene.remove(this.model); this.disposeModel(this.model);
      this.model=null; this.mixer=null;
    }
    try {
      const gltf=await new GLTFLoader().loadAsync(clip.path+'robot.glb');
      if (generation!==this.generation) {this.disposeModel(gltf.scene);return;}
      this.model=gltf.scene;this.scene.add(this.model);
      this.mixer=new THREE.AnimationMixer(this.model);
      const animation=gltf.animations[0];this.clipDuration=animation.duration;
      const action=this.mixer.clipAction(animation);this.action=action;
      action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();
      this.poseAt(this.rgb.currentTime);this.status.hidden=true;
      this.needsRender=true;
    } catch {
      if (generation===this.generation) this.status.textContent='Could not load robot model.';
    }
  }
  poseAt(t) {
    if (this.mixer) {
      if (this.poseTime === t && this.poseMixer === this.mixer) return;
      this.poseTime=t;this.poseMixer=this.mixer;this.needsRender=true;
      // LoopOnce may pause an action at the last frame; allow backward seeks afterward.
      this.action.paused=false;
      this.action.enabled=true;
      this.mixer.setTime(Math.min(t,this.clipDuration));
    }
  }
  tick() {
    if (this.inView) {
      const t=this.rgb.currentTime;
      if (!this.scrubbing && !this.seekInFlight && this.pendingSeek === null) {
        this.updateTransport(t);
      }
      if (!('requestVideoFrameCallback' in this.rgb) && !this.rgb.seeking) this.poseAt(t);
      if (this.renderer) {
        this.orbit.update();
        if (this.needsRender) {this.renderer.render(this.scene,this.camera);this.needsRender=false;}
      }
    }
    requestAnimationFrame(this.tick);
  }
}

async function init() {
  const container=document.getElementById('robot-list');
  if (!container) return;
  const response=await fetch(new URL('../robot/manifest.json',import.meta.url));
  if (!response.ok) throw new Error('Could not load clip manifest');
  const clips=await response.json();
  const tasks=[{id:'Paper',title:'Paper manipulation',description:'Observe the contact pattern as the hand handles a sheet of paper.'},
    {id:'Cup',title:'Cup nesting',description:'Follow the grasp, transfer, and placement of a paper cup.'},
    {id:'Bag',title:'Bag manipulation',description:'Explore fingertip contact during deformable-object manipulation.'}];
  const methods=[['Baseline','Baseline'],['TWLA','T-WLA'],['TWLA_Editor','T-WLA + Editor']];
  tasks.forEach((task,index) => {
    const card=document.createElement('article');card.className='robot-case';card.id='task-'+task.id.toLowerCase();
    card.innerHTML=`<div class="case-head"><div class="case-heading"><span class="case-index">0${index+1}</span><div><h3>${task.title}</h3><p>${task.description}</p></div></div><div class="method-tabs" role="group" aria-label="${task.title} method">${methods.map(([id,label])=>`<button data-method="${id}" aria-pressed="${id==='TWLA_Editor'}">${label}</button>`).join('')}</div></div><div class="robot-player" aria-label="${task.title} synchronized player"></div>`;
    container.append(card);
    let player=null,method='TWLA_Editor';
    const activate=() => {
      if (!player) player=new RobotPlayer(card.querySelector('.robot-player'));
      const clip=clips.find(c=>c.task===task.id && c.method===method);
      if (clip) player.load(clip);
    };
    const observer=new IntersectionObserver(entries=>{
      if (entries[0].isIntersecting) {activate();observer.disconnect();}
    },{rootMargin:'200px'});observer.observe(card);
    card.querySelectorAll('[data-method]').forEach(button=>button.onclick=()=>{
      method=button.dataset.method;
      card.querySelectorAll('[data-method]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
      activate();
    });
    // Read-only diagnostics used by local browser verification.
    card.getPlayer=()=>player;
  });
}
init().catch(error=>{
  const container=document.getElementById('robot-list');
  if (container) container.textContent='The robot clips could not be loaded. Please reload the page.';
  console.error(error);
});
