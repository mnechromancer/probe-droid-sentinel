/* ============================================================================
   sentinel_live.js — client-side port of sentinel_driver.py's run_patrol().

   Runs entirely in the visitor's browser. Owns the whole agent loop (the tool-
   use turns) and calls callProxy() once per Messages API turn — the proxy
   (portfolio's /api/demo-relay) is a thin relay that knows nothing about these
   tool schemas; it just forwards one turn and returns the finished message
   ({content, usage, stop_reason}), the same shape stream.get_final_message()
   gives the Python driver. Mirrors run_patrol(emit) frame-for-frame so live and
   replay stay in lockstep (see starwars-viz-kit/README.md's frame contract).

   Tool execution here is entirely local (no external calls) — flag_anomaly and
   log_observation just format a frame and push to the threat board, exactly
   like sentinel_driver.py's _execute_tool.
   ========================================================================== */
(function () {
  'use strict';

  var MAX_TOKENS = 3000;
  var MAX_TURNS = 10; // defensive ceiling — real runs finish in 1-2 turns

  var SYSTEM_PROMPT =
    'You are the Imperial Probe-Droid Sentinel, an always-watching sensor and ' +
    'intel-fusion agent monitoring the Kuat sector. You will be given a contact ' +
    'log for one patrol cycle. For EACH contact, briefly reason about whether its ' +
    'sensor readings (mass, thermal signature) match its filed manifest.\n\n' +
    'Call log_observation for traffic that checks out — sensor readings consistent ' +
    'with the declared cargo, even if the vessel is doing something merely unusual ' +
    '(off its normal route, outside its patrol box). Call flag_anomaly ONLY when ' +
    'the sensor data itself contradicts the manifest — a mass or thermal reading ' +
    "that doesn't match what was declared. Don't flag a contact just because it's " +
    "surprising; flag it because the numbers don't add up.\n\n" +
    'After triaging every contact, write a brief PATROL SUMMARY: what was ' +
    'routine, what you flagged (if anything) and why, and your recommendation.';

  var INTEL_FEED =
    'CONTACT LOG — Kuat sector, patrol cycle 7-G\n\n' +
    '1. Freighter "Dawn Treader" — filed route Kuat -> Corellia. Manifest: agricultural\n' +
    '   equipment, 40 metric tons. Sensor mass reading: 42 tons. Thermal signature: cold,\n' +
    '   consistent with inert cargo.\n\n' +
    '2. Bulk hauler "Ithorian Pride" — filed route Kuat -> Bestine. Manifest: raw\n' +
    '   durasteel, 120 tons. Sensor mass reading: 118 tons. Thermal signature: cold.\n\n' +
    '3. Patrol cruiser 88-G — squawking a valid Imperial IFF transponder. Operating in\n' +
    '   a contested lane outside its normal patrol box. Military vessel, no manifest.\n\n' +
    '4. Passenger liner "Corvette Runner" — filed route Kuat -> Coruscant. 220\n' +
    '   passengers manifested, boarding logs match. No cargo hold activity detected.\n\n' +
    '5. Convoy "KSE-4471" — filed route Kuat -> Byss. Manifest: agricultural parts, 30\n' +
    '   metric tons. Sensor mass reading: 71 tons. Thermal signature: elevated core\n' +
    '   heat, consistent with active reactor shielding, not inert parts.\n\n' +
    '6. Shuttle "Whisper-9" — filed route Kuat -> Kuat orbital yards, short hop.\n' +
    '   Manifest: maintenance crew transfer. Sensor readings nominal for a light\n' +
    '   shuttle.\n';

  var TOOLS = [
    {
      name: 'flag_anomaly',
      description:
        'Raise an anomaly flag for a contact whose sensor readings contradict its ' +
        'filed manifest — e.g. a mass or thermal signature mismatch. Call this ' +
        'only for a genuine data contradiction, not for traffic that\'s merely ' +
        'unusual or off-route.',
      input_schema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'The contact/vessel/convoy name' },
          reason: {
            type: 'string',
            description: 'The specific sensor-vs-manifest mismatch that makes this anomalous',
          },
          severity: {
            type: 'string',
            enum: ['LOW', 'MEDIUM', 'HIGH'],
            description: 'How severe the anomaly is',
          },
        },
        required: ['target', 'reason', 'severity'],
      },
    },
    {
      name: 'log_observation',
      description:
        'Log a routine contact whose sensor readings are consistent with its ' +
        'filed manifest — no anomaly, no further action needed.',
      input_schema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'The contact/vessel name' },
          note: { type: 'string', description: 'Brief note on why it\'s routine' },
        },
        required: ['target', 'note'],
      },
    },
  ];

  function executeTool(name, input, emit, threatBoard) {
    var target = input.target || '?';
    if (name === 'flag_anomaly') {
      var reason = input.reason || '';
      var severity = (input.severity || 'MEDIUM').toUpperCase();
      emit({ type: 'flag', text: target + ' — ' + reason, label: severity + ' THREAT FLAGGED' });
      threatBoard.push({ name: '⚑ ' + target, accent: 'hostile', body: reason + ' Severity ' + severity + '.' });
      return 'flag raised · severity ' + severity;
    }
    if (name === 'log_observation') {
      var note = input.note || '';
      emit({ type: 'observation', text: target + ' — ' + note });
      threatBoard.push({ name: target, body: note });
      return 'logged · routine';
    }
    return 'unknown tool: ' + name;
  }

  async function runPatrolLive(ctx) {
    var emit = ctx.emit, callProxy = ctx.callProxy;

    emit({ type: 'status', text: 'PROBE-DROID SENTINEL online — booting sensors' });
    emit({ type: 'prompt', title: 'patrol', text: '[system]\n' + SYSTEM_PROMPT + '\n\n[contact log]\n' + INTEL_FEED });

    var messages = [{ role: 'user', content: INTEL_FEED }];
    var threatBoard = [];
    var turn = 0;

    while (turn < MAX_TURNS) {
      turn++;
      emit({ type: 'status', text: '◇ querying Claude… (turn ' + turn + ')' });

      var response = await callProxy({
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        max_tokens: MAX_TOKENS,
        messages: messages,
      });

      var toolResults = [];
      for (var i = 0; i < response.content.length; i++) {
        var block = response.content[i];
        if (block.type === 'thinking') {
          if (block.thinking) emit({ type: 'think', text: block.thinking });
        } else if (block.type === 'text') {
          if (block.text) emit({ type: 'answer', text: block.text });
        } else if (block.type === 'tool_use') {
          var body = block.name === 'flag_anomaly' ? (block.input.reason || '') : (block.input.note || '');
          var accent = block.name === 'flag_anomaly' ? 'hostile' : 'tool';
          emit({ type: 'tool', name: block.name, target: block.input.target || '', body: body, accent: accent });
          var resultText = executeTool(block.name, block.input, emit, threatBoard);
          emit({ type: 'tool_result', text: resultText });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultText });
        }
      }

      var usage = response.usage || {};
      emit({
        type: 'usage',
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cache_write: usage.cache_creation_input_tokens || 0,
        cache_read: usage.cache_read_input_tokens || 0,
      });

      if (response.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    emit({ type: 'snapshot', title: 'THREAT BOARD', items: threatBoard });
    emit({ type: 'status', text: 'patrol complete — resuming passive watch' });
    emit({ type: 'done' });
  }

  window.runPatrolLive = runPatrolLive;
})();
