import json
import os
import sys
import time

from faster_whisper import WhisperModel


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


model_name = os.environ.get("WHISPER_MODEL", "base.en")
model_directory = os.environ.get("WHISPER_MODEL_DIR")
device = os.environ.get("WHISPER_DEVICE", "cpu")
compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

try:
    model = WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        download_root=model_directory,
        cpu_threads=max(1, min(8, os.cpu_count() or 4)),
    )
except Exception as error:
    emit({"type": "startup_error", "error": str(error)})
    raise

emit({"type": "ready", "model": model_name, "device": device, "compute_type": compute_type})

for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        started = time.perf_counter()
        segments, info = model.transcribe(
            request["path"],
            beam_size=1,
            best_of=1,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 350},
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
        emit({
            "id": request["id"],
            "text": text,
            "language": getattr(info, "language", None),
            "duration_ms": round((time.perf_counter() - started) * 1000),
        })
    except Exception as error:
        emit({"id": request.get("id") if isinstance(request, dict) else None, "error": str(error)})
