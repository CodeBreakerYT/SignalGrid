// F. Missions: campaign + challenge mode. The player's controller and the Fixed Timer run the SAME seeded
// scenario side by side; stars, score and XP come from the measured results, nothing else.
import { h, $, fmt, toast, modal, CTRL_COLORS } from '../util.js';
import { SimView, SimRunner } from '../render.js';
import { Sim, PHASES } from '../../core/sim.js';
import { buildScenario, SCENARIOS, SCENARIO_ORDER } from '../../core/scenarios.js';
import { CONTROLLER_LABELS } from '../../core/controllers.js';
import { factoryFor } from '../world.js';
import { MISSIONS, missionState, missionUnlocked, isUnlocked, evaluateMission, recordResult, compareRuns, scoreOf, demoUnlockAll, totalStars } from '../progress.js';
import { store, levelInfo } from '../store.js';
import { award, ACHIEVEMENTS } from '../achievements.js';
import { METRICS } from '../../core/bench.js';

const stars = (n) => `<span class="stars">${[0, 1, 2].map((i) => `<span class="${i < n ? 'on' : ''}">★</span>`).join('')}</span>`;

export function createMissions(ctx) {
  const root = h('section', { class: 'view', id: 'view-missions' });
  let tab = 'campaign', selected = 0, run = null;
  let challenge = { scenario: 'rush', seed: 4242, a: 'fixed', b: 'evolved' };

  const api = {
    id: 'missions', title: 'Missions', root,
    show() { this.render(); }, hide() { if (run) run.runnerA.paused = run.runnerB.paused = true; },
    refresh() { if (!run) this.render(); },
    tick(dt) {
      if (!run) return;
      const fa = run.runnerA.advance(dt), fb = run.runnerB.advance(dt);
      run.viewA.draw(fa); run.viewB.draw(fb);
      run.acc += dt;
      if (run.acc > 0.3) { run.acc = 0; this.runPanels(); }
      if (run.runnerA.done && run.runnerB.done && !run.finished) this.finish();
    },

    render() {
      run = null;
      const st = store.get(), li = levelInfo(st.xp);
      root.innerHTML = `
        <div class="row" style="margin-bottom:12px">
          <div class="tabs" style="margin:0;border:0"><button data-t="campaign" class="${tab === 'campaign' ? 'on' : ''}">Campaign</button><button data-t="challenge" class="${tab === 'challenge' ? 'on' : ''}">Challenge mode</button></div>
          <div class="spacer"></div>
          <span class="chip">Level ${li.level}</span><span class="chip">${st.xp} XP</span><span class="chip">${totalStars()} / ${MISSIONS.length * 3} stars</span>
          <button class="btn sm ${demoUnlockAll() ? 'primary' : ''}" id="m-unlock" title="Unlock every mission, scenario and controller (for reviewers)">${demoUnlockAll() ? 'Demo unlock: ON' : 'Unlock all (demo)'}</button>
          <button class="btn sm danger" id="m-reset">Reset progress</button>
        </div>
        <div id="m-body"></div>`;
      root.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => { tab = b.dataset.t; this.render(); }; });
      $('#m-unlock', root).onclick = () => { st.seen.unlockAll = !st.seen.unlockAll; store.save(); this.render(); ctx.refresh(); };
      $('#m-reset', root).onclick = () => { if (confirm('Reset all XP, stars and unlocks?')) { store.reset(); this.render(); ctx.refresh(); ctx.updateXp(); } };
      tab === 'campaign' ? this.renderCampaign() : this.renderChallenge();
    },

    renderCampaign() {
      const body = $('#m-body', root);
      body.innerHTML = `<div class="split"><div class="stack" id="m-list"></div><div class="stack"><div class="card" id="m-detail"></div></div></div>`;
      const list = $('#m-list', body);
      MISSIONS.forEach((m, idx) => {
        const ms = missionState(m.id), ok = missionUnlocked(idx), sc = SCENARIOS[m.scenario];
        const el = h('div', { class: 'mission' + (ok ? '' : ' locked') + (idx === selected ? ' sel' : ''), onclick: () => { if (!ok) return toast('Earn at least one star on the previous mission.', 'err'); selected = idx; this.render(); } },
          h('div', { class: 'num' }, ok ? String(idx + 1) : '\u{1F512}'),
          h('div', {}, h('h3', {}, m.title), h('p', {}, `${sc.nx}x${sc.ny} grid · ${sc.blurb}`)),
          h('div', { style: 'text-align:right' }, h('div', { html: stars(ms.stars) }), h('div', { class: 'xs muted mono' }, ms.runs ? `best ${ms.bestScore}` : `${m.xp} XP`)));
        list.append(el);
      });
      const got = store.get().seen.ach || {};
      list.insertAdjacentHTML('beforeend', `<div class="card"><div class="card-h"><h2>Achievements</h2><span class="sub">${Object.keys(got).length} / ${ACHIEVEMENTS.length}</span></div><div class="grid cols-3" style="gap:8px">${ACHIEVEMENTS.map((a) => `<div title="${a.desc}" style="padding:8px;border:1px solid var(--line);border-radius:10px;text-align:center;opacity:${got[a.id] ? 1 : 0.35};background:${got[a.id] ? 'rgba(0,243,255,.08)' : 'transparent'}"><div style="font-size:22px">${a.icon}</div><div class="xs">${a.name}</div></div>`).join('')}</div></div>`);
      const m = MISSIONS[selected], ms = missionState(m.id), sc = SCENARIOS[m.scenario];
      $('#m-detail', body).innerHTML = `
        <div class="card-h"><h2>Mission ${selected + 1}</h2><span class="badge">difficulty ${'◆'.repeat(sc.difficulty)}${'◇'.repeat(5 - sc.difficulty)}</span></div>
        <h3 style="font-size:18px;margin:2px 0 6px">${m.title}</h3>
        <p class="muted" style="margin:0 0 10px">${m.brief}</p>
        <div class="xs muted" style="letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px">Star objectives (measured vs Fixed Timer, same traffic)</div>
        ${m.objectives.map((o, i) => `<div class="obj ${ms.stars > i ? 'ok' : ''}"><span class="tick">${ms.stars > i ? '✓' : ''}</span><span>${o.label}</span></div>`).join('')}
        <div class="callout" style="margin:10px 0">Safety limits (min green, amber, all-red, pedestrian clearance) apply to every controller, including you. ${m.unlocks ? `Clearing this unlocks <b>${m.unlocks}</b>.` : ''}</div>
        <label class="fld">Your controller</label>
        <div class="seg" id="m-ctrl" style="margin-bottom:12px"></div>
        <button class="btn primary" id="m-start" style="width:100%;justify-content:center">Start mission</button>`;
      let kind = body.dataset.kind || (isUnlocked('controller', 'evolved') ? 'evolved' : 'adaptive');
      const seg = $('#m-ctrl', body);
      for (const k of ['adaptive', 'evolved', 'manual']) {
        const locked = !isUnlocked('controller', k);
        seg.append(h('button', { class: k === kind ? 'on' : '', disabled: locked, title: locked ? 'Earn a star on Rush Hour to unlock' : '', onclick: () => { kind = k; body.dataset.kind = k; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === seg.querySelector(`[data-k=${k}]`))); } }, (locked ? '\u{1F512} ' : '') + CONTROLLER_LABELS[k]));
        seg.lastChild.dataset.k = k;
      }
      if (!isUnlocked('controller', kind)) kind = 'adaptive';
      $('#m-start', body).onclick = () => this.startRun({ mode: 'campaign', mission: m, scenario: m.scenario, seed: m.seed, a: 'fixed', b: kind });
    },

    renderChallenge() {
      const body = $('#m-body', root);
      body.innerHTML = `<div class="card"><div class="card-h"><h2>Challenge mode</h2><span class="sub">Any scenario, any two controllers, identical traffic. No XP, pure comparison.</span></div>
        <div class="grid cols-4">
          <label class="fld">Scenario<select id="ch-scn"></select></label>
          <label class="fld">Seed<div class="row tight"><input type="number" id="ch-seed" style="width:100%"><button class="btn sm" id="ch-rnd" title="Random seed">↻</button></div></label>
          <label class="fld">Left<select id="ch-a"></select></label>
          <label class="fld">Right<select id="ch-b"></select></label>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="ch-go">Run challenge</button><span class="xs muted">Left and right panes run the same seeded traffic. Pick Manual on either side to drive it yourself.</span></div></div>
        <div class="card" style="margin-top:14px"><h2>Best challenge scores</h2><div id="ch-board" class="sm" style="margin-top:8px"></div></div>`;
      const scn = $('#ch-scn', body);
      SCENARIO_ORDER.forEach((id) => scn.append(h('option', { value: id, disabled: !isUnlocked('scenario', id) }, (isUnlocked('scenario', id) ? '' : '\u{1F512} ') + SCENARIOS[id].name)));
      scn.value = challenge.scenario; $('#ch-seed', body).value = challenge.seed;
      for (const id of ['ch-a', 'ch-b']) {
        const sel = $('#' + id, body);
        ['fixed', 'adaptive', 'evolved', 'manual'].forEach((k) => sel.append(h('option', { value: k, disabled: !isUnlocked('controller', k) }, CONTROLLER_LABELS[k])));
      }
      $('#ch-a', body).value = challenge.a; $('#ch-b', body).value = challenge.b;
      $('#ch-rnd', body).onclick = () => { $('#ch-seed', body).value = Math.floor(Math.random() * 90000) + 1000; };
      $('#ch-go', body).onclick = () => {
        challenge = { scenario: scn.value, seed: +$('#ch-seed', body).value || 1, a: $('#ch-a', body).value, b: $('#ch-b', body).value };
        this.startRun({ mode: 'challenge', scenario: challenge.scenario, seed: challenge.seed, a: challenge.a, b: challenge.b });
      };
      const board = store.get().seen.board || [];
      $('#ch-board', body).innerHTML = board.length ? `<table class="t"><thead><tr><th>Scenario</th><th>Matchup</th><th>Seed</th><th>Wait gain</th><th>Score</th></tr></thead><tbody>${board.slice().sort((a, b) => b.score - a.score).slice(0, 8).map((r) => `<tr><td>${r.scn}</td><td>${r.a} vs ${r.b}</td><td>${r.seed}</td><td class="${r.gain >= 0 ? 'good' : 'bad'}">${r.gain.toFixed(0)}%</td><td>${r.score}</td></tr>`).join('')}</tbody></table>` : '<span class="muted">No challenges run yet.</span>';
    },

    startRun(cfg) {
      const simA = new Sim(buildScenario(cfg.scenario, cfg.seed), factoryFor(cfg.a, { assist: true }));
      const simB = new Sim(buildScenario(cfg.scenario, cfg.seed), factoryFor(cfg.b, { assist: true }));
      const sc = SCENARIOS[cfg.scenario];
      root.innerHTML = `
        <div class="card"><div class="row"><h2>${cfg.mission ? 'Mission: ' + cfg.mission.title : 'Challenge: ' + sc.name}</h2><span class="badge sim">simulated</span><div class="spacer"></div>
          <div class="seg" id="r-speed"></div><button class="btn" id="r-pause">Pause</button><button class="btn" id="r-ff">Skip to results</button><button class="btn danger" id="r-quit">Abort</button></div>
          <div class="pbar" style="margin-top:10px"><i id="r-prog" style="width:0%"></i></div></div>
        <div class="grid cols-2" style="margin-top:14px">
          ${['A', 'B'].map((s) => `<div class="card"><div class="card-h"><h2 id="r-t${s}"></h2><span class="chip" id="r-c${s}"></span></div>
            <div class="stage stage-md"><canvas id="r-cv${s}"></canvas></div><div id="r-m${s}" style="margin-top:8px"></div>${s === 'B' && cfg.b === 'manual' ? '<div id="r-man" style="margin-top:8px"></div>' : ''}${s === 'A' && cfg.a === 'manual' ? '<div id="r-manA" style="margin-top:8px"></div>' : ''}</div>`).join('')}
        </div>`;
      const viewA = new SimView($('#r-cvA', root)), viewB = new SimView($('#r-cvB', root));
      viewA.setSim(simA); viewB.setSim(simB);
      run = { cfg, simA, simB, viewA, viewB, runnerA: new SimRunner(simA), runnerB: new SimRunner(simB), acc: 0, finished: false };
      run.runnerA.speed = run.runnerB.speed = 8;
      $('#r-tA', root).textContent = CONTROLLER_LABELS[cfg.a]; $('#r-tB', root).textContent = CONTROLLER_LABELS[cfg.b];
      $('#r-cA', root).textContent = 'baseline'; $('#r-cB', root).textContent = cfg.mission ? 'your run' : 'challenger';
      $('#r-cA', root).style.color = CTRL_COLORS[cfg.a]; $('#r-cB', root).style.color = CTRL_COLORS[cfg.b];
      const sp = $('#r-speed', root);
      for (const s of [1, 4, 8, 16, 32]) sp.append(h('button', { class: s === 8 ? 'on' : '', onclick: (e) => { run.runnerA.speed = run.runnerB.speed = s; sp.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, s + 'x'));
      $('#r-pause', root).onclick = (e) => { run.runnerA.paused = run.runnerB.paused = !run.runnerA.paused; e.currentTarget.textContent = run.runnerA.paused ? 'Resume' : 'Pause'; };
      $('#r-quit', root).onclick = () => this.render();
      $('#r-ff', root).onclick = () => { run.simA.runToEnd(); run.simB.runToEnd(); };
      if (cfg.b === 'manual') this.manualPanel(simB, viewB, '#r-man');
      if (cfg.a === 'manual') this.manualPanel(simA, viewA, '#r-manA');
      this.runPanels();
    },

    manualPanel(sim, view, sel) {
      const el = $(sel, root);
      el.innerHTML = `<div class="xs muted">Junction <b id="${sel.slice(1)}-j"></b>. Click a junction in the map to select it, then request a phase. Other junctions are driven by the Adaptive agent until you touch them.</div><div class="phase-row" style="margin-top:6px"></div><button class="btn sm" style="margin-top:6px">Hand junction back to AI</button>`;
      const row = $('.phase-row', el);
      PHASES.forEach((p) => row.append(h('button', { class: 'phase-btn', 'data-p': p.id, onclick: () => { const n = sim.nodes[view.selected] || sim.nodes[0]; n.ctrl.requested = p.id; } }, h('b', {}, p.short), p.name)));
      $('button.btn', el).onclick = () => { const n = sim.nodes[view.selected] || sim.nodes[0]; n.ctrl.requested = -1; };
      el._sim = sim; el._view = view;
    },

    runPanels() {
      if (!run) return;
      const { simA, simB } = run;
      const dur = simA.sc.duration, t = simA.t;
      $('#r-prog', root).style.width = Math.min(100, (t / dur) * 100) + '%';
      for (const [s, sim] of [['A', simA], ['B', simB]]) {
        const m = sim.summary();
        $('#r-m' + s, root).innerHTML = `<table class="t"><tbody>
          <tr><td>Avg waiting</td><td>${fmt(m.avgWait)} s</td><td>Queue (avg)</td><td>${fmt(m.avgQueue)}</td></tr>
          <tr><td>Processed</td><td>${m.throughput}</td><td>Ped. wait</td><td>${fmt(m.pedWait)} s</td></tr></tbody></table>`;
      }
      for (const sel of ['#r-man', '#r-manA']) {
        const el = root.querySelector(sel); if (!el || !el._sim) continue;
        const n = el._sim.nodes[el._view.selected] || el._sim.nodes[0];
        $(sel + '-j', root).textContent = 'J' + (n.id + 1);
        el.querySelectorAll('.phase-btn').forEach((b) => { const p = +b.dataset.p; b.classList.toggle('cur', n.sig.phase === p); b.classList.toggle('pend', n.sig.pending === p); });
      }
    },

    finish() {
      run.finished = true;
      const a = run.simA.summary(), b = run.simB.summary(), cfg = run.cfg;
      const i = compareRuns(a, b), score = scoreOf(i, b);
      let body = '';
      if (cfg.mission) {
        const ev = evaluateMission(cfg.mission, a, b);
        const rec = recordResult(cfg.mission, ev, cfg.b);
        if (ev.stars === 3) award('stars');
        if (MISSIONS.every((m) => missionState(m.id).stars >= 1)) award('all');
        ctx.updateXp(); ctx.refresh();
        body = `<div class="row"><h2>Mission ${ev.stars ? 'complete' : 'failed'}</h2><div class="spacer"></div><div>${stars(ev.stars)}</div></div>
          <div class="sm muted">Score <b class="mono" style="color:var(--text)">${ev.score}</b> / 1000 (500 = same as Fixed Timer) &middot; +${rec.gain} XP${rec.levelUp ? ' &middot; <b class="good">LEVEL UP</b>' : ''}</div>
          <div style="margin:10px 0">${cfg.mission.objectives.map((o, k) => `<div class="obj ${ev.results[k] ? 'ok' : ''}"><span class="tick">${ev.results[k] ? '✓' : ''}</span><span>${o.label}</span></div>`).join('')}</div>`;
        if (ev.stars && cfg.mission.unlocks) body += `<div class="callout good">Unlocked: <b>${cfg.mission.unlocks}</b></div>`;
      } else {
        const board = store.get().seen.board || (store.get().seen.board = []);
        board.push({ scn: SCENARIOS[cfg.scenario].name, a: CONTROLLER_LABELS[cfg.a], b: CONTROLLER_LABELS[cfg.b], seed: cfg.seed, gain: i.avgWait, score }); if (board.length > 40) board.shift(); store.save();
        body = `<div class="row"><h2>Challenge result</h2><div class="spacer"></div><span class="chip">score ${score} / 1000</span></div>`;
      }
      const rows = METRICS.filter((m) => ['avgWait', 'avgDelay', 'maxQueue', 'avgQueue', 'throughput', 'pedWait', 'emergDelay'].includes(m.key));
      body += `<table class="t" style="margin-top:6px"><thead><tr><th>Metric</th><th>${CONTROLLER_LABELS[cfg.a]}</th><th>${CONTROLLER_LABELS[cfg.b]}</th><th>Change</th></tr></thead><tbody>${rows.map((m) => {
        const va = a[m.key], vb = b[m.key];
        if (m.key === 'emergDelay' && !a.emergCount) return '';
        const better = m.lower ? vb < va : vb > va, d = va ? ((vb - va) / Math.abs(va)) * 100 : 0;
        return `<tr><td>${m.label}</td><td>${fmt(va, m.fmt)} ${m.unit}</td><td class="${better ? 'best' : ''}">${fmt(vb, m.fmt)} ${m.unit}</td><td class="${better ? 'good' : Math.abs(d) < 0.5 ? '' : 'bad'}">${d >= 0 ? '+' : ''}${d.toFixed(1)}%</td></tr>`;
      }).join('')}</tbody></table>
      <div class="xs muted" style="margin-top:8px">Simulated results from the SignalGrid engine, seed ${cfg.seed}. Both runs saw byte-identical traffic.</div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="res-again">Play again</button><button class="btn" id="res-back">Back to missions</button></div>`;
      const el = h('div', { html: body });
      const close = modal(el, { onClose: () => {} });
      $('#res-back', el).onclick = () => { close(); this.render(); };
      $('#res-again', el).onclick = () => { close(); this.startRun(cfg); };
    },
  };

  return api;
}
