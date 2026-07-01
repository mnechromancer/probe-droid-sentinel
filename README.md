# probe-droid-sentinel

**Demo D** of the Anthropic Basecamp demo set — an always-watching Imperial
sensor agent, built on the [starwars-viz-kit](https://github.com/) shared
harness. Showcases the **Messages API**: streaming, tool use, and adaptive
extended thinking.

Each patrol cycle, the agent ingests a synthetic Kuat-sector contact log and,
for each contact, reasons about whether its sensor readings (mass, thermal
signature) match its filed manifest. It calls `log_observation` for routine
traffic and `flag_anomaly` only when the sensor data itself contradicts the
manifest — then writes a patrol summary.

## Try it

The committed replay needs no key and no backend — it's a real captured run,
not a scripted one:

```bash
python -m http.server 8080   # then open http://localhost:8080/viz.html
```

Press **▶ Begin patrol**.

## Run it live

```bash
pip install -r requirements.txt
echo ANTHROPIC_API_KEY=sk-ant-... > .env    # git-ignored
python sentinel_server.py capture           # one live run -> outputs/patrol.json
# review it, then:
cp outputs/patrol.json replays/patrol.json  # promote to the committed replay
```

`python sentinel_server.py serve` starts a local dev server (`http://localhost:8766`)
that can also drive a **live** SSE run (`/run`) for local testing — useful groundwork
for the BYOK live proxy planned for a later pass. It is not what GitHub Pages serves;
Pages only ever plays the committed `replays/patrol.json`.

## Files

- `viz.css` / `viz.js` — the shared kit, copied in verbatim (no dependencies).
- `viz.html` — this demo's config: title, the `observation`/`flag` frame
  handlers, the threat-board snapshot, idle chatter.
- `sentinel_driver.py` — the agent itself: system prompt, synthetic intel
  feed, the two tools, and the tool-use loop. Framework-agnostic — it just
  calls `emit(frame)` for each frame in the shared contract.
- `sentinel_server.py` — wraps the driver for a live SSE server and a
  one-shot local capture CLI (mirrors the HOLOCRON-9 `viz_server.py` pattern
  from `institutional-memory`).
- `replays/patrol.json` — the committed replay. **This is a real captured
  run**, not hand-authored — Claude Sonnet 5 actually triaged all six
  contacts and correctly flagged only the genuine anomaly (a mass/thermal
  mismatch on convoy KSE-4471), while correctly *not* flagging the
  off-route patrol cruiser, which is unusual but not contradictory.

## Frame contract

Base frames are handled by the kit (see `starwars-viz-kit/README.md`). This
demo adds two:

```
{type:"observation", text}                  // routine contact, non-dramatic
{type:"flag", text, label}                  // anomaly, raises the headline flag
```

Both are emitted by `sentinel_driver.py` right after the corresponding
`tool` + `tool_result` frames — see `_execute_tool()`.

## Model & cost

`claude-sonnet-5`, adaptive thinking (`display: "summarized"`), `effort:
"medium"` — chosen to keep a BYOK-visitor-triggered run cheap (per the
project handoff) while still getting real tool-use + thinking behavior. A
captured patrol run costs a few thousand tokens.

## Notes / invariants

- Same invariants as the kit: no backend needed for replay, never store a
  visitor's key once BYOK is wired, Windows/Python file I/O must pass
  `encoding="utf-8"`.
- Every new frame type must be handled in **both** `sentinel_driver.py`
  (emitter) and `viz.html`'s `config.frames` (client) — see the kit's
  README for why.

---
Part of Handoff C for [jamisonducey.com](https://jamisonducey.com); shared
harness is [starwars-viz-kit](../starwars-viz-kit); reference template is
the live HOLOCRON-9 demo (`institutional-memory`).
