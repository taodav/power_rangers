const $ = id => document.getElementById(id);
const LEGS = ['FR', 'FL', 'RR', 'RL'];
const names = {FR: 'Front right', FL: 'Front left', RR: 'Rear right', RL: 'Rear left'};
const colors = {FR: '#dc5373', FL: '#408fbe', RR: '#c59929', RL: '#31a184'};
const roundNames = ['Draft', 'Peer review', 'Refine', 'Repair'];
const DT = .02, PERIOD = .48, START = .6;
let state = null, busy = false, message = '', connected = false;
let selectedLeg = 'FR', selectedRound = null, episode = null, revision = null;
const text = (id, value) => {
  const node = $(id);
  // Avoid repeating identical aria-live announcements on every poll.
  if (node.textContent !== String(value)) node.textContent = value;
};
const fixed = (value, digits = 2) => Number(value || 0).toFixed(digits);
const signed = value => `${value > 0 ? '+' : ''}${Number(value.toFixed(2))}`;
const badge = (id, value, kind = '') => { text(id, value); $(id).className = `badge ${kind}`; };
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function selectLeg(leg) { selectedLeg = leg; draw(); }
for (const leg of LEGS) {
  const node = element('button', 'actor-node');
  node.id = `node-${leg}`; node.style.setProperty('--color', colors[leg]);
  node.append(element('strong', '', `${leg} Ranger`), element('small', '', 'Owns one leg'));
  node.onclick = () => selectLeg(leg); node.title = `Inspect ${names[leg].toLowerCase()} Ranger`;
  $('actorNodes').append(node);
  const card = element('button', 'ranger-card');
  card.id = `card-${leg}`; card.style.setProperty('--color', colors[leg]);
  // This template contains only application-owned labels. Model text uses textContent.
  card.innerHTML = `<div class="ranger-head"><strong>${leg} Ranger</strong><span></span></div><span class="ranger-position">${names[leg]} leg</span><div class="plan-values"><div><span>Phase lead</span><b class="offset">—</b></div><div><span>Swing</span><b class="duration">—</b></div><div><span>Forward bias</span><b class="bias">—</b></div></div><span class="plan-change"></span>`;
  card.onclick = () => selectLeg(leg); $('rangers').append(card);
}
async function command(name) {
  busy = true; message = ''; draw();
  try {
    const response = await fetch('/api/command', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({command: name})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Command failed');
    await poll();
  } catch (error) { message = error.message; }
  finally { busy = false; draw(); }
}
$('start').onclick = () => command('start');
$('pause').onclick = () => command(state?.running ? 'pause' : 'play');
$('stop').onclick = () => command('stop');
$('restart').onclick = () => command('restart_actors');
$('resume').onclick = () => command('resume_saved');
$('followLive').onclick = () => { selectedRound = null; draw(); };

function draw() {
  if (!state) {
    if (!connected) text('connection', 'Connecting to local demo…');
    return;
  }
  const a = state.actors, team = state.team, p = a?.planning || {};
  if (episode !== a?.episode) { episode = a?.episode; selectedRound = null; revision = null; }
  const active = Boolean(a && !a.stopped && !a.error && ['ready', 'running'].includes(team.status));
  const planning = active && !a.agreement;
  const moving = active && !!a.agreement && state.running && connected;
  const stage = a?.error ? 'error' : p.stage || 'ready';
  $('start').disabled = busy || active || !connected; text('start', a ? 'Run new demo ↗' : 'Run demo ↗');
  $('stop').hidden = !active; $('stop').disabled = busy || !connected;
  $('pause').hidden = !active || !a?.agreement; $('pause').disabled = busy || !connected;
  text('pause', state.running ? 'Pause' : 'Continue');
  $('restart').disabled = busy || !a?.agreement || !!a?.error || !connected;
  $('resume').disabled = busy || active || !connected;
  text('connection', connected ? 'Local demo connected' : 'Connection interrupted');
  document.querySelector('.status-dot').style.background = connected ? 'var(--green)' : '#cf4261';
  text('error', message || a?.error || (connected ? '' : 'Connection lost. Reconnecting to the local demo…'));
  text('clock', `${fixed(state.sim_time)} s`);
  text('distance', `${fixed(team.distance_m)} m`);
  text('speed', `${fixed((team.distance_m || 0) / Math.max(DT, state.sim_time))} m/s`);
  text('tilt', `${fixed(state.body_tilt_deg, 1)}°`);
  const swinging = Object.values(state.legs).filter(leg => leg.swinging).length;
  text('concurrent', `${active ? swinging : team.max_concurrent || 0} / 4`);
  text('overlapLabel', active ? 'Legs swinging' : 'Peak overlap');
  const executionLabel = planning ? 'Planning · clock paused' : active ? (state.running ? 'Executing' : 'Paused') :
    ({completed: 'Run complete', failed: 'Lost balance'}[team.status] || (a?.stopped ? 'Stopped' : 'Waiting for a plan'));
  badge('executionBadge', executionLabel, moving ? 'active' : team.status === 'completed' ? 'good' : '');
  text('sceneLabel', planning ? 'Simulation waits for the accepted plan' : 'Unassisted MuJoCo physics');
  text('runNote', planning ? 'Models use wall-clock time' : `${fixed(state.sim_time, 1)} / ${fixed(team.duration_s, 0)} simulation seconds`);
  $('executionPath').classList.toggle('running', moving);
  drawPlanner(a, p, planning, stage);
  drawHistory(a, p, planning);
  drawTimeline(a, team, active);
  const saved = (a?.committed_tick || 0) * DT;
  text('savedTime', `${fixed(saved)} s`); text('liveTime', `${fixed(state.sim_time)} s`);
  $('checkpointProgress').style.width = `${a ? (state.sim_time ? Math.min(100, saved / state.sim_time * 100) : 100) : 0}%`;
  text('durableTitle', a ? `Body ${a.episode.slice(0, 8)} · revision ${a.revision}` : 'The plan and motion state are durable');
  text('durableCopy', a?.recovery?.checkpoint_equal ? 'Restart verified: identical checkpoint, four reactivated Rangers, all decisions preserved.' :
    planning ? 'Each response is saved in its Ranger. The Body publishes a round when all four are ready.' :
    a ? `${team.completed || 0} confirmed touchdowns · ${team.missed || 0} missed deadlines. Controller and contact history are checkpointed together.` :
    'Restarting actors preserves their decisions and the exact execution checkpoint.');
  if (revision !== null && revision !== a?.revision) {
    $('bodyNode').classList.remove('committed'); void $('bodyNode').offsetWidth; $('bodyNode').classList.add('committed');
  }
  revision = a?.revision ?? null;
}

function drawPlanner(a, p, planning, stage) {
  const rounds = a?.rounds || [], accepted = !!a?.agreement;
  const round = p.round || 0, thinking = planning && ['proposing', 'negotiating'].includes(stage);
  $('planningMap').className = `planning-map ${accepted ? 'accepted' : connected && planning ? stage : ''} ${round >= 2 ? 'refining' : ''}`;
  badge('plannerBadge', accepted ? 'Plan accepted' : planning ? `Round ${round + 1} · ${roundNames[round]}` : a?.stopped ? 'Stopped' : stage === 'error' ? 'Needs attention' : 'Ready', accepted ? 'good' : planning ? 'active' : '');
  text('sharedLabel', round >= 2 && planning ? 'Read peers + measured feedback ↔' : round >= 1 && planning ? 'Read peers ↔ publish own revision' : 'Own-leg proposals → shared state');
  text('bodyMemory', rounds.length ? `${rounds.length} shared ${rounds.length === 1 ? 'round' : 'rounds'} · ${rounds.reduce((n, r) => n + r.decisions.length, 0)} proposals` : 'Proposals · feedback · accepted plan');
  text('trialNodeText', stage === 'checking' && planning ? `${p.trial?.completed || 0} / 2 trials complete` : a?.validations?.length ? `${a.validations.reduce((n, v) => n + v.results.length, 0)} measured trials saved` : 'Measure speed + stability');
  $('trialNode').classList.toggle('active', planning && stage === 'checking');
  $('acceptedNode').classList.toggle('accepted', accepted);
  text('acceptedNodeText', accepted ? `Round ${a.agreement.round + 1} · four leg policies` : 'Four independent leg policies');
  const savedIds = new Set(rounds.flatMap(r => r.decisions.map(d => d.request_id)));
  for (const work of Object.values(p.legs || {})) if (work.decision) savedIds.add(work.decision.request_id);
  text('savedDecisions', `${savedIds.size} saved model decisions`);
  for (const leg of LEGS) {
    const node = $(`node-${leg}`), work = p.legs?.[leg];
    node.classList.toggle('selected', leg === selectedLeg); node.setAttribute('aria-pressed', String(leg === selectedLeg));
    node.classList.toggle('thinking', connected && thinking && work?.status === 'thinking');
    node.querySelector('small').textContent = accepted ? 'Policy saved' : thinking ? (work?.decision ? 'Response saved' : 'Model thinking…') : planning && stage === 'checking' ? 'Trial in progress' : 'Owns one leg';
  }
  const title = accepted ? 'Accepted policies → numerical execution' : ({proposing: 'Four Rangers propose in parallel', negotiating: round >= 2 ? 'Refine from measured trial feedback' : 'Read peers and revise together', checking: 'Test all four policies together', stopped: 'Planning stopped', error: 'Planning needs attention'}[stage] || 'Ready to plan');
  const copy = accepted ? 'The agreed policies repeat on independent leg clocks. The controller handles balance and joints; models are finished for this run.' :
    stage === 'proposing' ? 'Four separate model requests. Each Ranger can change only its own leg; responses are saved as they arrive.' :
    stage === 'negotiating' ? (round >= 2 ? 'Each model reads saved peer proposals and measured trial results, then adjusts its own leg policy.' : 'All four models read the previous shared round. They revise concurrently; the Body publishes their joint draft.') :
    stage === 'checking' ? 'Two six-second MuJoCo trials measure speed and stability. Their feedback returns to shared memory before the next pass.' :
    stage === 'error' ? a.error : 'Each actor owns its leg’s timing and placement. The Body stores their agreement.';
  text('stageNumber', accepted ? '✓' : planning ? String(round + 1).padStart(2, '0') : '—');
  text('stageTitle', title); text('stageCopy', copy);
  text('planningClock', planning && p.stage_started_at_ms && connected ? `${fixed(Math.max(0, Date.now() - p.stage_started_at_ms) / 1000, 1)} s wall time in this stage` : accepted ? 'Planning complete · simulation owns the clock' : 'Planning uses wall-clock time');
}

function decisionFor(a, p, round, leg) {
  const saved = a?.rounds?.find(r => r.round === round)?.decisions.find(d => d.leg === leg);
  return saved || (p.round === round ? p.legs?.[leg]?.decision : null);
}
function changes(plan, previous) {
  if (!previous) return 'Initial own-leg proposal';
  const fields = [['offset', 'phase', 480, 'ms'], ['swing_s', 'swing', 1000, 'ms'], ['forward_bias', 'forward', 1000, 'mm'],
    ['clearance', 'clearance', 1000, 'mm'], ['lateral_bias', 'lateral', 1000, 'mm'], ['placement_gain', 'gain', 1, '']];
  const changed = fields.filter(([key]) => Math.abs(plan[key] - previous[key]) > 1e-8)
    .map(([key, label, scale, unit]) => `${label} ${signed((plan[key] - previous[key]) * scale)} ${unit}`.trim());
  return changed.length ? changed.join(' · ') : 'All parameters retained';
}
function drawHistory(a, p, planning) {
  const available = new Set((a?.rounds || []).map(r => r.round));
  if (planning) available.add(p.round || 0);
  const rounds = [...available].sort((x, y) => x - y), latest = rounds.at(-1);
  const round = selectedRound ?? latest, saved = a?.rounds?.find(r => r.round === round);
  const tabs = $('roundTabs');
  // Preserve button identity and keyboard focus while telemetry refreshes.
  for (const button of [...tabs.children]) if (!available.has(Number(button.dataset.round))) button.remove();
  for (const n of rounds) {
    let button = tabs.querySelector(`[data-round="${n}"]`);
    if (!button) {
      button = element('button', 'round-tab'); button.dataset.round = n; button.setAttribute('role', 'tab');
      button.onclick = () => { selectedRound = n; draw(); }; tabs.append(button);
    }
    button.textContent = `${n + 1} / ${roundNames[n]}${a?.agreement?.round === n ? ' ✓' : ''}`;
    button.setAttribute('aria-selected', String(n === round));
  }
  $('followLive').hidden = selectedRound === null;
  const descriptions = ['Independent proposals from the measured starting policy. No peer discussion has happened yet.',
    'Each Ranger reads all four draft proposals and revises its own leg. The combined policy is tested next.',
    'Measured trial feedback and peer proposals inform one more own-leg refinement. Both seeds are tested again.',
    'A final repair pass responds to failed validation. The combined policy must pass both trials before execution.'];
  text('roundDescription', descriptions[round] || 'Start a demo to see real proposals, peer reviews and feedback-driven revisions.');
  const decisions = LEGS.map(leg => decisionFor(a, p, round, leg)).filter(Boolean);
  badge('roundSaved', saved ? 'Shared round saved' : decisions.length ? `${decisions.length} / 4 responses saved` : planning ? 'Models thinking' : 'No proposals yet', saved ? 'good' : '');
  for (const leg of LEGS) {
    const card = $(`card-${leg}`), decision = decisionFor(a, p, round, leg), plan = decision?.plan;
    const previous = decisionFor(a, p, round - 1, leg)?.plan;
    card.classList.toggle('selected', leg === selectedLeg); card.setAttribute('aria-pressed', String(leg === selectedLeg));
    card.querySelector('.ranger-head span').textContent = decision ? 'Saved' : planning && round === p.round ? 'Thinking…' : 'Waiting';
    card.querySelector('.offset').textContent = plan ? `${Math.round(plan.offset * 480)} ms` : '—';
    card.querySelector('.duration').textContent = plan ? `${Math.round(plan.swing_s * 1000)} ms` : '—';
    card.querySelector('.bias').textContent = plan ? `${signed(plan.forward_bias * 1000)} mm` : '—';
    const delta = card.querySelector('.plan-change'); delta.textContent = plan ? changes(plan, previous) : 'Awaiting own-leg proposal';
    delta.classList.toggle('changed', !!previous && delta.textContent !== 'All parameters retained');
  }
  const decision = decisionFor(a, p, round, selectedLeg), plan = decision?.plan;
  text('decisionTitle', `${selectedLeg} Ranger · ${round !== undefined ? `round ${round + 1} proposal` : 'proposal'}`);
  $('detailDot').style.background = colors[selectedLeg];
  text('decisionLatency', decision?.model_wall_ms !== undefined ? `Model call ${fixed(decision.model_wall_ms / 1000, 1)} s` : decision ? 'Call time not recorded' : '');
  text('decisionReason', plan?.reason || (planning ? 'This Ranger’s model response will appear here once it is saved.' : 'Choose a Ranger to inspect its decision. Explanations are shown as written before trial validation.'));
  const params = $('decisionParams'); params.replaceChildren();
  if (plan) {
    for (const [label, value] of [['Clearance', `${fixed(plan.clearance * 1000, 0)} mm`], ['Lateral bias', `${signed(plan.lateral_bias * 1000)} mm`], ['Placement gain', fixed(plan.placement_gain, 3)]]) {
      const item = element('span', '', `${label} `); item.append(element('b', '', value)); params.append(item);
    }
  }
  const validation = a?.validations?.find(v => v.round === round);
  const inTrial = planning && p.stage === 'checking' && p.round === round && !validation;
  const results = validation?.results || (inTrial ? p.trial?.results || [] : []);
  badge('trialBadge', validation ? (validation.accepted ? '2 / 2 passed' : 'Revision needed') : inTrial ? `${results.length} / 2 complete` : 'No trial yet', validation ? (validation.accepted ? 'good' : 'warn') : inTrial ? 'active' : '');
  const box = $('trialResults'); box.replaceChildren();
  for (const result of results) {
    const row = element('div', 'trial-result'); row.append(element('span', '', `Seed ${result.seed}`));
    const bar = element('div', 'trial-bar'), fill = element('i', result.healthy && result.speed_m_s > .08 ? '' : 'failed');
    fill.style.width = `${Math.max(0, Math.min(100, result.speed_m_s / .2 * 100))}%`;
    bar.title = `Speed relative to the 0.20 m/s goal. Maximum tilt ${fixed(result.max_tilt_deg, 1)}°.`;
    bar.append(fill); row.append(bar, element('b', '', `${fixed(result.speed_m_s, 3)} m/s`)); box.append(row);
    if (result.failure) box.append(element('p', 'trial-caption', String(result.failure)));
  }
  const caption = results.length ? `Six-second trials · goal 0.20 m/s · peak tilt ${fixed(Math.max(...results.map(r => r.max_tilt_deg)), 1)}°. ${validation ? (a?.agreement?.round === round ? 'This joint policy was accepted for execution.' : 'Saved feedback informs the next round.') : 'Trial progress; feedback is saved after both finish.'}` :
    round === 0 ? 'The first proposals go to peer review before simulator trials. Model explanations are proposals, not measured results.' :
    inTrial ? 'Running real simulator trials. The live robot waits at simulation time zero.' : 'Shared trials test all four leg policies together. Feedback informs the next planning pass.';
  box.append(element('p', results.length ? 'trial-caption' : 'muted', caption));
}

function svgNode(tag, attrs = {}, content) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (content !== undefined) node.textContent = content;
  return node;
}
// A sample records the command applied over the preceding control interval and
// the contact measurement at its end. Never infer contact from planned swings.
function intervals(samples, key, legIndex) {
  const spans = [];
  for (const sample of samples) {
    if (!sample[key][legIndex]) continue;
    const start = (sample.tick - 1) * DT, end = sample.tick * DT, last = spans.at(-1);
    if (last && Math.abs(last[1] - start) < 1e-7) last[1] = end;
    else spans.push([start, end]);
  }
  return spans;
}
function plannedSpans(plan, start, end) {
  const spans = [], duty = 1 - plan.swing_s / PERIOD;
  for (let cycle = Math.floor((start - START) / PERIOD) - 1; cycle <= Math.ceil((end - START) / PERIOD) + 1; cycle++) {
    const a = Math.max(START, START + (cycle + duty - plan.offset) * PERIOD);
    const b = START + (cycle + 1 - plan.offset) * PERIOD;
    if (b > a && b > start && a < end) spans.push([Math.max(start, a), Math.min(end, b)]);
  }
  return spans;
}
function drawTimeline(a, team, active) {
  const svg = $('motionTimeline'), fragment = document.createDocumentFragment();
  const now = state.sim_time, trace = team.trace || [], accepted = !!a?.agreement;
  const end = Math.max(2.4, now + (active && accepted ? PERIOD : 0)), start = end - 2.4;
  const left = 116, right = 1090, x = time => left + (time - start) / (end - start) * (right - left);
  const add = (tag, attrs, content) => { const node = svgNode(tag, attrs, content); fragment.append(node); return node; };
  const label = (xx, yy, value, attrs = {}) => add('text', {x: xx, y: yy, fill: '#738795', 'font-size': 10, ...attrs}, value);
  for (let time = Math.ceil((start - 1e-7) / PERIOD) * PERIOD; time <= end + 1e-7; time += PERIOD) {
    add('line', {x1: x(time), x2: x(time), y1: 27, y2: 191, stroke: '#e4ecf1'});
    label(x(time), 211, `${fixed(time)} s`, {'text-anchor': 'middle'});
  }
  if (active && accepted && now < end) add('rect', {x: Math.max(left, x(now)), y: 27, width: right - Math.max(left, x(now)), height: 164, fill: '#f6f9fc'});
  for (const [i, leg] of LEGS.entries()) {
    const y = 44 + i * 42, color = colors[leg], plan = team.policy?.[leg];
    if (selectedLeg === leg) add('rect', {x: 3, y: y - 15, width: 1095, height: 39, rx: 5, fill: color, opacity: .045});
    label(13, y, `${leg} Ranger`, {fill: color, 'font-weight': 650, 'font-size': 11});
    label(13, y + 13, accepted ? (active ? state.legs[leg].swinging ? 'Swinging' : state.legs[leg].contact ? 'Contact' : 'Airborne' : 'Saved history') : 'Awaiting plan', {'font-size': 9});
    add('line', {x1: left, x2: right, y1: y, y2: y, stroke: '#edf1f5', 'stroke-width': 9});
    add('line', {x1: left, x2: right, y1: y + 12, y2: y + 12, stroke: '#edf1f5', 'stroke-width': 3});
    const bar = (span, yy, height, fill, opacity = 1) => {
      const lo = Math.max(start, span[0]), hi = Math.min(end, span[1]);
      if (hi <= lo) return;
      add('rect', {x: x(lo), y: yy, width: Math.max(.5, x(hi) - x(lo)), height, rx: 2, fill, opacity});
    };
    if (accepted && plan) {
      if (trace.length) for (const span of intervals(trace, 'swing', i)) bar(span, y - 4, 8, color);
      else for (const span of plannedSpans(plan, start, Math.min(now, end))) bar(span, y - 4, 8, color, .75);
      if (active) for (const span of plannedSpans(plan, Math.max(start, now), end)) bar(span, y - 4, 8, color, .25);
      for (const span of intervals(trace, 'contact', i)) bar(span, y + 10, 3, '#7c8f9e');
      for (const event of team.events || []) {
        const time = event.end_tick * DT;
        if (event.leg !== leg || time < start || time > end) continue;
        const xx = x(time);
        if (event.status === 'landed') add('path', {d: `M${xx} ${y + 7}l4 4-4 4-4-4Z`, fill: color});
        else label(xx, y + 16, '×', {fill: '#c83e5c', 'font-size': 18, 'text-anchor': 'middle'});
      }
    }
  }
  if (accepted) {
    const saved = (a.committed_tick || 0) * DT, same = Math.abs(saved - now) < .001;
    if (saved >= start && saved <= end && !same) {
      add('line', {x1: x(saved), x2: x(saved), y1: 27, y2: 191, stroke: '#245bd8', 'stroke-dasharray': '3 3'});
      label(x(saved) - 4, 22, 'SAVED', {fill: '#245bd8', 'font-size': 8, 'text-anchor': 'end'});
    }
    if (now >= start && now <= end) {
      add('line', {x1: x(now), x2: x(now), y1: 27, y2: 191, stroke: '#253d50', 'stroke-width': 1.5});
      label(x(now), 13, same ? 'NOW · SAVED' : 'NOW', {fill: '#253d50', 'font-size': 9, 'text-anchor': now > end - .15 ? 'end' : 'middle', 'font-weight': 650});
    }
  }
  svg.replaceChildren(fragment);
  text('timelineEmpty', accepted ? trace.length ? '' : 'This older saved run has no contact trace. Bars show its policy; markers show saved touchdown events.' : 'The timeline fills when the accepted plan starts executing.');
  text('timelineClock', `${fixed(now)} s · 20 ms samples`);
  text('executionNote', accepted ? `${team.completed || 0} confirmed touchdowns · ${team.missed || 0} missed deadlines. A late landing does not shift the other leg clocks.` : 'Each leg follows its own clock. A late touchdown does not delay the other legs.');
}
async function poll() {
  try {
    const response = await fetch('/api/state', {signal: AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error('Disconnected');
    state = await response.json(); connected = true;
  } catch { connected = false; }
  draw();
}
async function loop() { await poll(); setTimeout(loop, 180); }
loop();
const frame = $('frame');
frame.onload = () => setTimeout(() => { frame.src = `/frame.jpg?t=${Date.now()}`; }, 100);
frame.onerror = () => setTimeout(() => { frame.src = `/frame.jpg?t=${Date.now()}`; }, 1000);
// The initial image may have loaded before this module was evaluated.
if (frame.complete) frame.onload();
