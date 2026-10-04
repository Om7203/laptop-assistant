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


def cached_model_source(name, root):
    """Use a completed local Hugging Face snapshot without contacting the network."""
    if not root or os.path.isdir(name):
        return name
    repository = os.path.join(root, f"models--Systran--faster-whisper-{name}")
    snapshots = os.path.join(repository, "snapshots")
    if not os.path.isdir(snapshots):
        return name
    required = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
    candidates = []
    for revision in os.listdir(snapshots):
        directory = os.path.join(snapshots, revision)
        if os.path.isdir(directory) and all(os.path.isfile(os.path.join(directory, item)) for item in required):
            candidates.append(directory)
    return candidates[-1] if candidates else name


model_source = cached_model_source(model_name, model_directory)

try:
    model = WhisperModel(
        model_source,
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
