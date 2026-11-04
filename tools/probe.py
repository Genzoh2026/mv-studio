"""Reports what this Python can do for MV Studio, as one line of JSON. Nothing is installed or changed."""
import json
import sys


def version_of(module_name):
    try:
        module = __import__(module_name)
    except Exception:  # a broken install counts as missing
        return None
    return str(getattr(module, "__version__", "unknown"))


def demucs_problem():
    """None when Demucs really loads; otherwise the reason. Having the package is not enough: its own imports
    (numpy, ...) are not always installed with it, so the actual entry point is imported."""
    try:
        import demucs.separate  # noqa: F401
    except Exception as error:
        return f"{type(error).__name__}: {error}"[:300]
    return None


def torch_info():
    try:
        import torch

        return str(torch.__version__), bool(torch.cuda.is_available())
    except Exception:
        return None, False


demucs = version_of("demucs")
torch_version, cuda = torch_info()
print(json.dumps({
    "python": ".".join(str(part) for part in sys.version_info[:3]),
    "numpy": version_of("numpy"),
    "demucs": demucs,
    "demucs_error": demucs_problem() if demucs else None,
    "torch": torch_version,
    "cuda": cuda,
}))
