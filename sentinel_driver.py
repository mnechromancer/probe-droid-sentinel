"""
Probe-Droid Sentinel — the agent driver.

A synthetic Kuat-sector contact log is handed to Claude (Messages API, adaptive
extended thinking, streaming). The agent reasons about whether each contact's
sensor readings match its filed manifest, then calls one of two tools:

    log_observation(target, note)              — routine traffic
    flag_anomaly(target, reason, severity)      — a genuine data mismatch

run_patrol(emit) drives the tool-use loop and calls emit(frame) for every
frame in the shared viz-kit contract (see starwars-viz-kit/README.md). It has
no knowledge of HTTP/SSE — sentinel_server.py wraps it for both a live SSE
run and a one-shot local capture.

Frame contract reminder — base frames plus this demo's two additions:
    {type:"flag", text, label}         {type:"observation", text}
Every new frame type must be handled in both this emitter and the kit's
config.frames (see viz.html) so live and replay stay in lockstep.
"""

import anthropic

MODEL = "claude-sonnet-5"
MAX_TOKENS = 3000

SYSTEM_PROMPT = (
    "You are the Imperial Probe-Droid Sentinel, an always-watching sensor and "
    "intel-fusion agent monitoring the Kuat sector. You will be given a contact "
    "log for one patrol cycle. For EACH contact, briefly reason about whether its "
    "sensor readings (mass, thermal signature) match its filed manifest.\n\n"
    "Call log_observation for traffic that checks out — sensor readings consistent "
    "with the declared cargo, even if the vessel is doing something merely unusual "
    "(off its normal route, outside its patrol box). Call flag_anomaly ONLY when "
    "the sensor data itself contradicts the manifest — a mass or thermal reading "
    "that doesn't match what was declared. Don't flag a contact just because it's "
    "surprising; flag it because the numbers don't add up.\n\n"
    "After triaging every contact, write a brief PATROL SUMMARY: what was "
    "routine, what you flagged (if anything) and why, and your recommendation."
)

INTEL_FEED = """CONTACT LOG — Kuat sector, patrol cycle 7-G

1. Freighter "Dawn Treader" — filed route Kuat -> Corellia. Manifest: agricultural
   equipment, 40 metric tons. Sensor mass reading: 42 tons. Thermal signature: cold,
   consistent with inert cargo.

2. Bulk hauler "Ithorian Pride" — filed route Kuat -> Bestine. Manifest: raw
   durasteel, 120 tons. Sensor mass reading: 118 tons. Thermal signature: cold.

3. Patrol cruiser 88-G — squawking a valid Imperial IFF transponder. Operating in
   a contested lane outside its normal patrol box. Military vessel, no manifest.

4. Passenger liner "Corvette Runner" — filed route Kuat -> Coruscant. 220
   passengers manifested, boarding logs match. No cargo hold activity detected.

5. Convoy "KSE-4471" — filed route Kuat -> Byss. Manifest: agricultural parts, 30
   metric tons. Sensor mass reading: 71 tons. Thermal signature: elevated core
   heat, consistent with active reactor shielding, not inert parts.

6. Shuttle "Whisper-9" — filed route Kuat -> Kuat orbital yards, short hop.
   Manifest: maintenance crew transfer. Sensor readings nominal for a light
   shuttle.
"""

FLAG_ANOMALY_TOOL = {
    "name": "flag_anomaly",
    "description": (
        "Raise an anomaly flag for a contact whose sensor readings contradict its "
        "filed manifest — e.g. a mass or thermal signature mismatch. Call this "
        "only for a genuine data contradiction, not for traffic that's merely "
        "unusual or off-route."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "target": {"type": "string", "description": "The contact/vessel/convoy name"},
            "reason": {
                "type": "string",
                "description": "The specific sensor-vs-manifest mismatch that makes this anomalous",
            },
            "severity": {
                "type": "string",
                "enum": ["LOW", "MEDIUM", "HIGH"],
                "description": "How severe the anomaly is",
            },
        },
        "required": ["target", "reason", "severity"],
    },
}

LOG_OBSERVATION_TOOL = {
    "name": "log_observation",
    "description": (
        "Log a routine contact whose sensor readings are consistent with its "
        "filed manifest — no anomaly, no further action needed."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "target": {"type": "string", "description": "The contact/vessel name"},
            "note": {"type": "string", "description": "Brief note on why it's routine"},
        },
        "required": ["target", "note"],
    },
}

TOOLS = [FLAG_ANOMALY_TOOL, LOG_OBSERVATION_TOOL]


def _execute_tool(name, tool_input, emit, threat_board):
    target = tool_input.get("target", "?")
    if name == "flag_anomaly":
        reason = tool_input.get("reason", "")
        severity = (tool_input.get("severity") or "MEDIUM").upper()
        emit({"type": "flag", "text": f"{target} — {reason}", "label": f"{severity} THREAT FLAGGED"})
        threat_board.append({
            "name": f"⚑ {target}",
            "accent": "hostile",
            "body": f"{reason} Severity {severity}.",
        })
        return f"flag raised · severity {severity}"
    if name == "log_observation":
        note = tool_input.get("note", "")
        emit({"type": "observation", "text": f"{target} — {note}"})
        threat_board.append({"name": target, "body": note})
        return "logged · routine"
    return f"unknown tool: {name}"


def run_patrol(emit):
    """Drive one patrol cycle. Calls emit(frame) for every frame; returns
    nothing — the caller (server or capture script) owns recording/streaming."""
    client = anthropic.Anthropic()

    emit({"type": "status", "text": "PROBE-DROID SENTINEL online — booting sensors"})

    prompt_text = INTEL_FEED
    emit({
        "type": "prompt",
        "title": "patrol",
        "text": f"[system]\n{SYSTEM_PROMPT}\n\n[contact log]\n{prompt_text}",
    })

    messages = [{"role": "user", "content": prompt_text}]
    threat_board = []
    turn = 0

    while True:
        turn += 1
        emit({"type": "status", "text": f"◇ querying Claude… (turn {turn})"})

        with client.messages.stream(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": "medium"},
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        ) as stream:
            response = stream.get_final_message()

        tool_results = []
        for block in response.content:
            if block.type == "thinking":
                if block.thinking:
                    emit({"type": "think", "text": block.thinking})
            elif block.type == "text":
                if block.text:
                    emit({"type": "answer", "text": block.text})
            elif block.type == "tool_use":
                if block.name == "flag_anomaly":
                    body = block.input.get("reason", "")
                    accent = "hostile"
                else:
                    body = block.input.get("note", "")
                    accent = "tool"
                emit({
                    "type": "tool",
                    "name": block.name,
                    "target": block.input.get("target", ""),
                    "body": body,
                    "accent": accent,
                })
                result_text = _execute_tool(block.name, block.input, emit, threat_board)
                emit({"type": "tool_result", "text": result_text})
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result_text,
                })

        usage = response.usage
        emit({
            "type": "usage",
            "input": usage.input_tokens,
            "output": usage.output_tokens,
            "cache_write": getattr(usage, "cache_creation_input_tokens", 0) or 0,
            "cache_read": getattr(usage, "cache_read_input_tokens", 0) or 0,
        })

        if response.stop_reason != "tool_use":
            break

        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user", "content": tool_results})

    emit({"type": "snapshot", "title": "THREAT BOARD", "items": threat_board})
    emit({"type": "status", "text": "patrol complete — resuming passive watch"})
    emit({"type": "done"})
