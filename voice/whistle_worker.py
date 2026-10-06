import json
import os
import sys
import tempfile
import time

import av


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


try:
    os.environ.setdefault("NEEDLE_TELEMETRY", "0")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    import needle
except Exception as error:
    emit({"type": "startup_error", "error": str(error)})
    raise


try:
    keywords = json.loads(os.environ.get("WHISTLE_KEYWORDS", "[]"))
    if not isinstance(keywords, list):
        keywords = []
except json.JSONDecodeError:
    keywords = []

emit({"type": "ready", "model": "Cactus-Compute/whistle", "device": "cpu"})


def convert_to_wav(source_path):
    """Decode browser audio and write the 16 kHz mono WAV Whistle expects."""
    handle, wav_path = tempfile.mkstemp(prefix="laptop-assistant-whistle-", suffix=".wav")
    os.close(handle)
    try:
        with av.open(source_path) as source, av.open(wav_path, mode="w", format="wav") as target:
            output = target.add_stream("pcm_s16le", rate=16000)
            output.layout = "mono"
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            for frame in source.decode(audio=0):
                converted = resampler.resample(frame)
                if converted is None:
                    continue
                for item in converted if isinstance(converted, list) else [converted]:
                    for packet in output.encode(item):
                        target.mux(packet)
            for item in resampler.resample(None) or []:
                for packet in output.encode(item):
                    target.mux(packet)
            for packet in output.encode(None):
                target.mux(packet)
        return wav_path
    except Exception:
        try:
            os.remove(wav_path)
        except OSError:
            pass
        raise


for line in sys.stdin:
    request = None
    wav_path = None
    try:
        request = json.loads(line)
        started = time.perf_counter()
        source_path = request["path"]
        wav_path = source_path if source_path.lower().endswith(".wav") else convert_to_wav(source_path)
        result = needle.transcribe(wav_path, keywords=keywords or None)
        emit({
            "id": request["id"],
            "text": result.get("text", "").strip(),
            "language": result.get("language"),
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "ttft_ms": result.get("ttft_ms"),
            "decode_tps": result.get("decode_tps"),
        })
    except Exception as error:
        emit({"id": request.get("id") if isinstance(request, dict) else None, "error": str(error)})
    finally:
        if wav_path and request and wav_path != request.get("path"):
            try:
                os.remove(wav_path)
            except OSError:
                pass
