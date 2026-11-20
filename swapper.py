import os, cv2, numpy as np, insightface
from insightface.app import FaceAnalysis

MODEL_PATH = os.environ.get("SWAP_MODEL", "models/inswapper_128.onnx")
_providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
_app = FaceAnalysis(name="buffalo_l", providers=_providers)
_app.prepare(ctx_id=0, det_size=(320, 320))
_swapper = insightface.model_zoo.get_model(MODEL_PATH, providers=_providers)
_source_face = None

def set_source(image_bytes: bytes) -> bool:
    global _source_face
    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    faces = _app.get(img) if img is not None else []
    if not faces:
        return False
    _source_face = max(faces, key=lambda f: (f.bbox[2]-f.bbox[0])*(f.bbox[3]-f.bbox[1]))
    return True

def swap(frame_bgr):
    if _source_face is None:
        return frame_bgr
    out = frame_bgr.copy()
    for face in _app.get(frame_bgr):
        out = _swapper.get(out, face, _source_face, paste_back=True)
    return out
