"""Reports what this Python can do for MV Studio, as one line of JSON. Nothing is installed or changed."""
import json
import sys


def version_of(module_name):
    try:
        module = __import__(module_name)
    except Exception:  # a broken install counts as missing
        return None
    return str(getattr(module, "__version__", "unknown"))


def cuda_available():
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


print(json.dumps({
    "python": ".".join(str(part) for part in sys.version_info[:3]),
    "numpy": version_of("numpy"),
    "demucs": version_of("demucs"),
    "cuda": cuda_available(),
}))
