/* ============================================================================
   starwars-viz-kit — viz.js
   The reusable VizKit engine for the Anthropic demo harnesses. Build-step-free
   (plain global, no bundler) so it runs on GitHub Pages as-is.

   A demo page does only:
       <link rel="stylesheet" href="viz.css">
       <div id="app"></div>
       <script src="viz.js"></script>
       <script> VizKit.mount(document.getElementById('app'), {...config}); </script>

   The kit owns the whole UI; the demo supplies a config (title, run buttons,
   replay URLs, a snapshot renderer, and handlers for any demo-specific frame
   types). Live and replay share ONE render path — handleFrame(f) — so a frame
   looks identical whether it streamed from a server or played from committed
   JSON. New frame types are added in config.frames (client) and the emitter
   (server) — never fork the render path.

   Base frame contract (handled here):
     {type:"status", text}            {type:"prompt", text, title}
     {type:"think", text}             {type:"answer", text}          // accumulates
     {type:"tool", name, target, body, accent?}
     {type:"tool_result", text}       {type:"usage", input, output, cache_write, cache_read}
     {type:"snapshot", title?, items:[{name, body, accent?}]}
     {type:"heartbeat"}  {type:"done"}  {type:"error", text}
   Demo-specific frames (e.g. flag/observation/route/specialist/synthesis) are
   dispatched to config.frames[type](frame, vk).

   Opt-in council mode (config.council = {enabled: true}) adds an N-column
   layout for parallel-specialist demos. The kit owns the DOM construction
   (vk.buildCouncil({question, specialists}), vk.appendSpecialist(id, text))
   since config.frames handlers have no way to add columns to the grid on
   their own; the frame dispatch itself still goes through config.frames
   (e.g. frames.route calling vk.buildCouncil, frames.specialist calling
   vk.appendSpecialist) — the render path stays single and generic.
   ========================================================================== */
(function () {
  'use strict';

  // small DOM helper
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  const CHARS_PER_TOKEN = 4; // rough token estimate when the stream has no usage

  function mount(rootEl, config) {
    config = config || {};
    const replayUrl = config.replayUrl || ((id) => `replays/${id}.json`);
    const live = Object.assign({ enabled: false }, config.live || {});
    const showHud = config.hud !== false;
    const pricing = config.pricing || null; // {in,out,cacheWrite,cacheRead} per 1M; omit to hide cost
    const frames = config.frames || {};
    const idleCfg = Object.assign({ enabled: true, chatter: DEFAULT_CHATTER.slice() }, config.idle || {});
    const DEAD_MS = idleCfg.deadMs || 1100;
    const councilCfg = Object.assign({ enabled: false }, config.council || {});

    // ── build the UI ─────────────────────────────────────────────────────────
    rootEl.classList.add('vk-root');
    rootEl.innerHTML = `
      <div class="vk-idle"><canvas></canvas><div class="vk-sweep"></div><div class="vk-chatter"></div></div>
      <div class="vk-header"><h1></h1><button class="vk-help-btn" title="What is this?" style="display:none">?</button></div>
      <div class="vk-sub"></div>
      <div class="vk-runs"></div>
      <div class="vk-bar">
        <div class="vk-track"><div class="vk-pill"></div><span class="vk-opt vk-replay active">REPLAY</span><span class="vk-opt vk-live">LIVE</span></div>
        <input type="password" class="vk-key" placeholder="your Anthropic API key — sent per-request, never stored" autocomplete="off" spellcheck="false" style="display:none">
        <button class="vk-clear">clear</button>
      </div>
      <div class="vk-hud"></div>
      <div class="vk-status">idle — press a run button</div>
      <details class="vk-promptwrap" open><summary>▸ what the agent was asked</summary><pre class="vk-prompt"></pre></details>
      <div class="vk-council" style="display:none"><div class="vk-council-q"></div><div class="vk-council-cols"></div></div>
      <div class="vk-grid">
        <div class="vk-col"><h2>${config.streamLabel || 'Agent activity'}</h2><div class="vk-stream"></div></div>
        <div class="vk-col"><h2>${config.answerLabel || 'Output'} <span class="vk-flag-holder"></span></h2><div class="vk-answer" data-placeholder="${config.answerPlaceholder || 'the response streams here…'}"></div></div>
      </div>
      <div class="vk-snap" style="display:none"><h2></h2><div class="vk-snap-body"></div></div>
      <div class="vk-modal"><div class="vk-modal-box"><button class="vk-modal-close">✕</button><div class="vk-modal-content"></div></div></div>
    `;

    const els = {
      root: rootEl,
      idle: rootEl.querySelector('.vk-idle'),
      canvas: rootEl.querySelector('.vk-idle canvas'),
      chatter: rootEl.querySelector('.vk-chatter'),
      h1: rootEl.querySelector('.vk-header h1'),
      helpBtn: rootEl.querySelector('.vk-help-btn'),
      sub: rootEl.querySelector('.vk-sub'),
      runs: rootEl.querySelector('.vk-runs'),
      track: rootEl.querySelector('.vk-track'),
      pill: rootEl.querySelector('.vk-pill'),
      optReplay: rootEl.querySelector('.vk-replay'),
      optLive: rootEl.querySelector('.vk-live'),
      key: rootEl.querySelector('.vk-key'),
      clear: rootEl.querySelector('.vk-clear'),
      hud: rootEl.querySelector('.vk-hud'),
      status: rootEl.querySelector('.vk-status'),
      prompt: rootEl.querySelector('.vk-prompt'),
      council: rootEl.querySelector('.vk-council'),
      councilQ: rootEl.querySelector('.vk-council-q'),
      councilCols: rootEl.querySelector('.vk-council-cols'),
      stream: rootEl.querySelector('.vk-stream'),
      answer: rootEl.querySelector('.vk-answer'),
      flag: rootEl.querySelector('.vk-flag-holder'),
      snap: rootEl.querySelector('.vk-snap'),
      snapTitle: rootEl.querySelector('.vk-snap h2'),
      snapBody: rootEl.querySelector('.vk-snap-body'),
      modal: rootEl.querySelector('.vk-modal'),
      modalContent: rootEl.querySelector('.vk-modal-content'),
    };

    els.h1.textContent = config.title || 'AGENT HARNESS';
    els.sub.textContent = config.subtitle || '';
    if (config.help) {
      els.helpBtn.style.display = '';
      els.modalContent.innerHTML = config.help;
      els.helpBtn.onclick = () => els.modal.classList.add('open');
    }
    rootEl.querySelector('.vk-modal-close').onclick = () => els.modal.classList.remove('open');
    els.modal.onclick = (e) => { if (e.target === els.modal) els.modal.classList.remove('open'); };

    // ── state ─────────────────────────────────────────────────────────────────
    let es = null;             // EventSource for legacy URL-based live
    let liveAbort = null;      // AbortController for a driver-based live run
    let replayGen = 0;         // bumped per run to cancel in-flight replays
    let activeRun = null;
    let liveMode = false;
    let pulseTick = null, pulseT0 = 0, steps = 0;
    let typer = null, briefShown = false;
    let hudTimer = null, hudT0 = 0;
    const hud = { tools: 0, inChars: 0, outChars: 0, real: null };
    let councilBodies = {}, councilTypers = {};

    // ── HUD ─────────────────────────────────────────────────────────────────
    const HUD_FIELDS = ['Elapsed', 'Steps', 'Tokens'].concat(pricing ? ['Credits'] : []);
    if (showHud) {
      HUD_FIELDS.forEach((k) => {
        const s = el('div', 'vk-stat');
        s.innerHTML = `<span class="k">${k}${(k === 'Tokens' || k === 'Credits') ? '<span class="vk-est" style="display:none">EST</span>' : ''}</span><span class="v" data-k="${k}">—</span>`;
        els.hud.appendChild(s);
      });
    }
    const hv = (k) => els.hud.querySelector(`.v[data-k="${k}"]`);
    function setEst(on) {
      els.hud.querySelectorAll('.vk-est').forEach((t) => (t.style.display = on ? 'inline' : 'none'));
    }
    function computeCost(inTok, outTok, cw, cr) {
      if (!pricing) return 0;
      return inTok / 1e6 * (pricing.in || 0) + outTok / 1e6 * (pricing.out || 0)
        + (cw || 0) / 1e6 * (pricing.cacheWrite || 0) + (cr || 0) / 1e6 * (pricing.cacheRead || 0);
    }
    function renderHud() {
      if (!showHud) return;
      if (hv('Steps')) hv('Steps').textContent = steps > 0 ? steps : '—';
      let inTok, outTok, cw = 0, cr = 0, est = true;
      if (hud.real) { inTok = hud.real.inTok; outTok = hud.real.outTok; cw = hud.real.cw || 0; cr = hud.real.cr || 0; est = false; }
      else if (hud.inChars === 0 && hud.outChars === 0) {
        if (hv('Tokens')) hv('Tokens').textContent = '—';
        if (hv('Credits')) hv('Credits').textContent = '—';
        setEst(false); return;
      } else {
        inTok = Math.round(hud.inChars / CHARS_PER_TOKEN);
        outTok = Math.round(hud.outChars / CHARS_PER_TOKEN);
      }
      if (hv('Tokens')) hv('Tokens').textContent = (inTok + outTok + cw + cr).toLocaleString();
      if (hv('Credits')) hv('Credits').textContent = '$' + computeCost(inTok, outTok, cw, cr).toFixed(4);
      setEst(est);
    }
    function startHudTimer() {
      hudT0 = Date.now(); clearInterval(hudTimer);
      hudTimer = setInterval(() => { if (hv('Elapsed')) hv('Elapsed').textContent = ((Date.now() - hudT0) / 1000).toFixed(1) + 's'; }, 100);
    }
    function stopHudTimer() { clearInterval(hudTimer); hudTimer = null; }
    function resetHud() {
      stopHudTimer();
      hud.tools = 0; hud.inChars = 0; hud.outChars = 0; hud.real = null;
      if (showHud) { HUD_FIELDS.forEach((k) => { if (hv(k)) hv(k).textContent = '—'; }); setEst(false); }
    }

    // ── stream helpers ────────────────────────────────────────────────────────
    function startPulse() {
      pulseT0 = Date.now(); steps = 0;
      const live = el('div', 'vk-step stat'); live.dataset.pulse = '1';
      els.stream.appendChild(live); clearInterval(pulseTick);
      pulseTick = setInterval(() => {
        const s = ((Date.now() - pulseT0) / 1000).toFixed(0);
        const dots = '.'.repeat(1 + (Math.floor(Date.now() / 400) % 3));
        const p = els.stream.querySelector('[data-pulse]');
        if (p) p.textContent = `◐ working${dots}  ${s}s · ${steps} actions`;
      }, 250);
    }
    function stopPulse() {
      clearInterval(pulseTick); pulseTick = null;
      const p = els.stream.querySelector('[data-pulse]'); if (p) p.remove();
    }
    function step(cls, text) {
      const d = el('div', 'vk-step ' + cls); d.textContent = text;
      els.stream.appendChild(d); els.stream.scrollTop = els.stream.scrollHeight;
      return d;
    }
    function body(text) {
      const c = el('div', 'vk-body'); c.textContent = text;
      const last = els.stream.lastChild;
      if (last) last.after(c); else els.stream.appendChild(c);
      els.stream.scrollTop = els.stream.scrollHeight;
      return c;
    }
    function appendAnswer(text) {
      const a = els.answer; a.classList.remove('thinking');
      if (!briefShown) { a.textContent = ''; briefShown = true; step('stat', '✍ writing…'); }
      const base = (briefShown && a.textContent) ? a.textContent + '\n\n' : '';
      if (config.flagTest) {
        const html = config.flagTest(text);
        if (html && !els.flag.innerHTML) setFlag(html);
      }
      let i = 0; const stepN = 22;
      clearInterval(typer);
      typer = setInterval(() => {
        a.textContent = base + text.slice(0, i); a.scrollTop = a.scrollHeight; i += stepN;
        if (i >= text.length) { a.textContent = base + text; clearInterval(typer); typer = null; }
      }, 14);
      setTimeout(() => { if (a.textContent.length < (base + text).length) a.textContent = base + text; }, 60000);
    }
    function setFlag(html) { els.flag.innerHTML = `<span class="vk-flag">${html}</span>`; }

    // ── council mode (opt-in N-column layout for parallel-specialist demos) ───
    function resetCouncil() {
      Object.keys(councilTypers).forEach((k) => clearInterval(councilTypers[k]));
      councilTypers = {}; councilBodies = {};
      els.council.style.display = 'none';
      els.councilQ.textContent = '';
      els.councilCols.innerHTML = '';
    }
    function buildCouncil(payload) {
      if (!councilCfg.enabled) return;
      resetCouncil();
      const specialists = (payload && payload.specialists) || [];
      els.council.style.display = '';
      els.councilQ.textContent = (payload && payload.question) || '';
      specialists.forEach((s) => {
        const col = el('div', 'vk-council-col' + (s.accent ? ' ' + s.accent : ''));
        col.innerHTML = `<h3>${escapeHtml(s.label || s.id || '')}</h3>` +
          `<div class="vk-council-body" data-placeholder="deliberating…"></div>`;
        els.councilCols.appendChild(col);
        councilBodies[s.id] = col.querySelector('.vk-council-body');
      });
      steps++; step('stat', '⚖ council convened — ' + specialists.length + ' specialists');
    }
    function appendSpecialist(id, text) {
      const target = councilBodies[id];
      if (!target) return;
      text = text || '';
      clearInterval(councilTypers[id]);
      let i = 0; const stepN = 22;
      councilTypers[id] = setInterval(() => {
        target.textContent = text.slice(0, i); target.scrollTop = target.scrollHeight; i += stepN;
        if (i >= text.length) { target.textContent = text; clearInterval(councilTypers[id]); delete councilTypers[id]; }
      }, 14);
      hud.outChars += text.length; renderHud();
    }

    // ── snapshot panel (generic; demos may override config.snapshot.render) ────
    function renderSnapshot(payload) {
      const title = payload.title || (config.snapshot && config.snapshot.title) || 'Snapshot';
      const items = payload.items || [];
      els.snap.style.display = '';
      els.snapTitle.textContent = title;
      if (config.snapshot && typeof config.snapshot.render === 'function') {
        els.snapBody.innerHTML = '';
        config.snapshot.render(items, els.snapBody, vk);
        return;
      }
      els.snapBody.innerHTML = '';
      if (!items.length) { els.snapBody.appendChild(el('div', 'vk-snap-item', '(empty)')); return; }
      items.forEach((it, idx) => {
        const d = el('div', 'vk-snap-item' + (it.accent ? ' ' + it.accent : ''));
        d.innerHTML = `<div class="name">${escapeHtml(it.name || '')}</div>`;
        els.snapBody.appendChild(d);
        if (it.body) setTimeout(() => {
          const pre = el('pre'); d.appendChild(pre);
          typeInto(pre, String(it.body).slice(0, 1400));
        }, idx * 220);
      });
    }
    function typeInto(pre, text) {
      let i = 0; const t = setInterval(() => {
        pre.textContent = text.slice(0, i); pre.scrollTop = pre.scrollHeight;
        i += 24; if (i >= text.length) { pre.textContent = text; clearInterval(t); }
      }, 12);
    }

    // ── THE shared render path ────────────────────────────────────────────────
    function handleFrame(f) {
      noteActivity();
      if (!f || !f.type) return;
      if (f.type === 'heartbeat') return;
      switch (f.type) {
        case 'prompt':
          els.prompt.textContent = f.text || ''; hud.inChars += (f.text || '').length; renderHud(); break;
        case 'status': steps++; step('stat', f.text || ''); break;
        case 'think': {
          steps++;
          const tail = f.text ? ': ' + f.text.slice(0, 90) : '';
          step('stat', '🧠 reasoning…' + tail);
          hud.outChars += (f.text || '').length; renderHud(); break;
        }
        case 'tool': {
          steps++;
          const where = f.target ? '  ' + String(f.target).slice(0, 80) : '';
          step(f.accent || 'tool', '⚙ ' + (f.name || 'tool') + where);
          if (f.body) body(String(f.body).slice(0, 400));
          hud.tools++; hud.outChars += ((f.body || '').length + (f.name || '').length + (f.target || '').length);
          renderHud(); break;
        }
        case 'tool_result':
          if (f.text) body('↳ ' + String(f.text).slice(0, 400));
          hud.inChars += (f.text || '').length; renderHud(); break;
        case 'answer': stopPulse(); appendAnswer(f.text || ''); hud.outChars += (f.text || '').length; renderHud(); break;
        case 'usage':
          hud.real = hud.real || { inTok: 0, outTok: 0, cw: 0, cr: 0 };
          hud.real.inTok += f.input || 0; hud.real.outTok += f.output || 0;
          hud.real.cw += f.cache_write || 0; hud.real.cr += f.cache_read || 0;
          renderHud(); break;
        case 'snapshot': renderSnapshot(f); break;
        case 'error': stopPulse(); step('err', '✖ ' + (f.text || 'error')); finish('error'); break;
        case 'done': finish('done'); break;
        default:
          if (frames[f.type]) frames[f.type](f, vk);
          // unknown & unhandled frame types are ignored (forward-compatible)
      }
    }

    // ── live proxy transport (BYOK) ─────────────────────────────────────────────
    // fetch (not EventSource) so a visitor's key can ride a header — EventSource
    // is GET-only and can't carry one. The proxy answers one Messages API turn
    // per call with the finished message ({content, usage, stop_reason}); the
    // demo's own live.driver owns the agent loop (tool-use, fan-out) and calls
    // this once per turn, same shape sentinel_driver.py/council_driver.py use
    // server-side via stream.get_final_message().
    async function callProxy(payload, key, signal) {
      const res = await fetch(live.proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Anthropic-Key': key },
        body: JSON.stringify(payload),
        signal,
      });
      if (!res.ok) {
        let msg = 'relay error ' + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* non-JSON error body */ }
        throw new Error(msg);
      }
      return res.json();
    }

    // ── static replay (Pages-native: plays committed JSON, no backend) ─────────
    async function replayStatic(runId, gen) {
      let data;
      try {
        const res = await fetch(replayUrl(runId), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
      } catch (e) {
        if (replayGen !== gen) return;
        stopPulse(); step('err', '✖ no saved replay for "' + runId + '"'); finish('error'); return;
      }
      for (const f of data) {
        if (replayGen !== gen) return; // a newer run started — bail silently
        handleFrame(f);
        await new Promise((r) => setTimeout(r, f.type === 'answer' ? 20 : (f.delay || 400)));
      }
      if (replayGen === gen && !data.some((f) => f.type === 'done')) finish('replay');
    }

    // ── run / reset ────────────────────────────────────────────────────────────
    function run(runId) {
      if (es) { es.onerror = null; es.close(); es = null; }
      if (liveAbort) { liveAbort.abort(); liveAbort = null; }
      replayGen++; const gen = replayGen;
      stopPulse(); stopHudTimer(); clearInterval(typer); typer = null; briefShown = false;
      els.stream.innerHTML = ''; els.answer.textContent = ''; els.answer.className = 'vk-answer';
      els.flag.innerHTML = ''; els.prompt.textContent = '';
      resetHud(); resetCouncil();
      if (liveMode && live.enabled && typeof live.driver === 'function') {
        const key = (els.key.value || '').trim();
        if (!key) {
          step('err', '✖ enter your Anthropic API key to run live');
          els.status.textContent = 'idle — key required for a live run';
          els.status.className = 'vk-status';
          return;
        }
        activeRun = runId;
        els.status.textContent = 'running live — ' + runId + '…';
        els.status.className = 'vk-status live';
        setBusy(true); startPulse(); startHudTimer();
        liveAbort = new AbortController();
        const signal = liveAbort.signal;
        Promise.resolve(live.driver({
          runId, emit: handleFrame, apiKey: key, signal,
          callProxy: (payload) => callProxy(payload, key, signal),
        })).catch((err) => {
          if (replayGen !== gen || signal.aborted) return;
          handleFrame({ type: 'error', text: String((err && err.message) || err) });
        });
        return;
      }
      activeRun = runId;
      els.status.textContent = (liveMode ? 'running live' : 'replaying') + ' — ' + runId + '…';
      els.status.className = 'vk-status live';
      setBusy(true); startPulse(); startHudTimer();
      if (liveMode && live.enabled && live.url) {
        es = new EventSource(live.url(runId));
        es.onmessage = (ev) => { let f; try { f = JSON.parse(ev.data); } catch (e) { return; } handleFrame(f); };
        es.onerror = () => { stopPulse(); finish('stream closed'); };
      } else {
        replayStatic(runId, gen);
      }
    }
    function reset() {
      if (es) { es.onerror = null; es.close(); es = null; }
      if (liveAbort) { liveAbort.abort(); liveAbort = null; }
      replayGen++;
      stopPulse(); stopHudTimer(); clearInterval(typer); typer = null; briefShown = false;
      els.stream.innerHTML = ''; els.answer.textContent = ''; els.answer.className = 'vk-answer';
      els.prompt.textContent = ''; els.flag.innerHTML = '';
      els.snap.style.display = 'none'; els.snapBody.innerHTML = '';
      els.status.textContent = 'idle — press a run button'; els.status.className = 'vk-status';
      setBusy(false); resetHud(); resetCouncil(); activeRun = null;
      els.key.value = '';
    }
    function finish(why) {
      if (es) { es.close(); es = null; }
      if (liveAbort) { liveAbort = null; }
      stopPulse(); stopHudTimer(); setBusy(false);
      els.status.className = 'vk-status';
      els.status.textContent = 'finished (' + why + ')';
      activeRun = null;
    }
    function setBusy(b) { els.runs.querySelectorAll('button').forEach((btn) => (btn.disabled = b)); }

    // ── run buttons + mode toggle ──────────────────────────────────────────────
    (config.runs || [{ id: 'run', label: '▶ Run' }]).forEach((r) => {
      const b = el('button', 'vk-run-btn' + (r.accent ? ' ' + r.accent : ''));
      b.textContent = r.label || ('▶ ' + r.id);
      b.onclick = () => run(r.id);
      els.runs.appendChild(b);
    });
    function syncPill() {
      els.pill.style.width = els.optReplay.offsetWidth + 'px';
      if (liveMode) els.pill.style.left = (3 + els.optReplay.offsetWidth) + 'px';
      else els.pill.style.left = '3px';
    }
    function setMode(m) {
      if (m === 'live' && !live.enabled) return; // live disabled this pass
      liveMode = (m === 'live');
      els.optReplay.classList.toggle('active', !liveMode);
      els.optLive.classList.toggle('active', liveMode);
      els.key.style.display = (liveMode && live.enabled) ? '' : 'none';
      syncPill();
    }
    els.optReplay.onclick = () => setMode('replay');
    els.optLive.onclick = () => setMode('live');
    if (!live.enabled) { els.optLive.classList.add('disabled'); els.optLive.title = 'live BYOK runs not enabled for this demo'; }
    els.clear.onclick = reset;
    window.addEventListener('pagehide', () => { els.key.value = ''; });
    if (window.requestAnimationFrame) requestAnimationFrame(syncPill); else setTimeout(syncPill, 0);
    window.addEventListener('resize', syncPill);

    // ── idle animation (Star Wars "no dead air") ───────────────────────────────
    let lastActivity = Date.now();
    function noteActivity() { lastActivity = Date.now(); els.idle.classList.remove('scanning'); }
    const stars = new Starfield(els.canvas, idleCfg.starColor || '#5ab0ff');
    let chatterIdx = 0, chatterAt = 0;
    function idleTick() {
      const idleNow = (Date.now() - lastActivity) > DEAD_MS;
      els.idle.classList.toggle('scanning', idleCfg.enabled && idleNow);
      if (idleCfg.enabled && idleNow && Date.now() - chatterAt > 2600) {
        chatterAt = Date.now();
        const list = idleCfg.chatter && idleCfg.chatter.length ? idleCfg.chatter : DEFAULT_CHATTER;
        els.chatter.textContent = list[chatterIdx % list.length];
        chatterIdx++;
      }
    }
    const idleInterval = setInterval(idleTick, 500);
    // run the starfield always so the screen is never fully static
    if (idleCfg.enabled) stars.start();

    // ── public controller ──────────────────────────────────────────────────────
    const vk = {
      els, config, run, reset, setMode, handleFrame,
      step, body, appendAnswer, setFlag, renderSnapshot,
      buildCouncil, appendSpecialist,
      get hud() { return hud; }, renderHud,
      bumpSteps() { steps++; }, stopPulse, startPulse,
      destroy() {
        clearInterval(idleInterval); resetCouncil(); stars.stop();
        if (es) es.close();
        if (liveAbort) liveAbort.abort();
        els.key.value = '';
        window.removeEventListener('resize', syncPill);
      },
    };
    return vk;
  }

  // simple, cheap drifting starfield so the canvas is never static
  function Starfield(canvas, color) {
    const ctx = canvas.getContext('2d');
    let raf = 0, w = 0, h = 0, stars = [], running = false;
    function size() {
      const r = canvas.getBoundingClientRect();
      w = canvas.width = Math.max(1, Math.floor(r.width));
      h = canvas.height = Math.max(1, Math.floor(r.height));
      const n = Math.min(140, Math.floor((w * h) / 9000));
      stars = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        z: 0.3 + Math.random() * 0.7, ph: Math.random() * Math.PI * 2,
      }));
    }
    function frame() {
      ctx.clearRect(0, 0, w, h);
      const t = Date.now() / 1000;
      for (const s of stars) {
        s.x -= s.z * 0.22; s.y += s.z * 0.08;
        if (s.x < 0) s.x += w; if (s.y > h) s.y -= h;
        const tw = 0.5 + 0.5 * Math.sin(t * (0.6 + s.z) + s.ph);
        ctx.globalAlpha = (0.15 + 0.55 * s.z) * tw;
        ctx.fillStyle = color;
        const r = s.z * 1.4;
        ctx.fillRect(s.x, s.y, r, r);
      }
      ctx.globalAlpha = 1;
      if (running) raf = requestAnimationFrame(frame);
    }
    return {
      start() { if (running) return; running = true; size(); window.addEventListener('resize', size); raf = requestAnimationFrame(frame); },
      stop() { running = false; cancelAnimationFrame(raf); window.removeEventListener('resize', size); },
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const DEFAULT_CHATTER = [
    'scanning sector — no contacts',
    'sensors nominal · standing by',
    'monitoring sub-space channels',
    'awaiting telemetry',
    'idle — holding position',
  ];

  window.VizKit = { mount };
})();
