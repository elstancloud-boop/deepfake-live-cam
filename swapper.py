import os, cv2, numpy as np, insightface
from insightface.app import FaceAnalysis

MODEL_PATH = os.environ.get("SWAP_MODEL", "models/inswapper_128.onnx")
ENHANCER_PATH = os.environ.get("ENHANCER_MODEL", "models/GFPGANv1.4.pth")
ENHANCE = os.environ.get("ENHANCE", "1") == "1"      # GFPGAN face restoration (sharper, more realistic, slower)
MOUTH_MASK = os.environ.get("MOUTH_MASK", "1") == "1"  # keep your real mouth for accurate lip movement
DET_SIZE = int(os.environ.get("DET_SIZE", "320"))
SMOOTH = float(os.environ.get("SMOOTH", "0.6"))        # 0 = off; higher = steadier landmarks

_providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
_app = FaceAnalysis(name="buffalo_l", providers=_providers)
_app.prepare(ctx_id=0, det_size=(DET_SIZE, DET_SIZE))
_swapper = insightface.model_zoo.get_model(MODEL_PATH, providers=_providers)
_source_face = None
_enhancer = None
_prev = {}

if ENHANCE and os.path.exists(ENHANCER_PATH):
    from gfpgan import GFPGANer
    _enhancer = GFPGANer(model_path=ENHANCER_PATH, upscale=1, arch="clean",
                         channel_multiplier=2, bg_upsampler=None)

def set_source(image_bytes: bytes) -> bool:
    global _source_face
    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    faces = _app.get(img) if img is not None else []
    if not faces:
        return False
    _source_face = max(faces, key=lambda f: (f.bbox[2]-f.bbox[0])*(f.bbox[3]-f.bbox[1]))
    return True

def _smooth(i, face):
    if SMOOTH <= 0:
        return
    for attr in ("kps", "bbox"):
        cur = getattr(face, attr).astype(np.float32)
        old = _prev.get((i, attr))
        if old is not None and old.shape == cur.shape:
            cur = SMOOTH * old + (1 - SMOOTH) * cur
        _prev[(i, attr)] = cur
        setattr(face, attr, cur)

def _mouth_blend(orig, swapped, face):
    lm = getattr(face, "landmark_2d_106", None)
    if lm is None:
        return swapped
    pts = lm[52:72].astype(np.int32)  # lips
    mask = np.zeros(orig.shape[:2], np.uint8)
    cv2.fillConvexPoly(mask, cv2.convexHull(pts), 255)
    mask = cv2.dilate(mask, np.ones((9, 9), np.uint8))
    mask = cv2.GaussianBlur(mask, (15, 15), 0).astype(np.float32)[..., None] / 255.0
    return (orig * mask + swapped * (1 - mask)).astype(np.uint8)

def swap(frame_bgr):
    if _source_face is None:
        return frame_bgr
    out = frame_bgr.copy()
    for i, face in enumerate(_app.get(frame_bgr)):
        _smooth(i, face)
        res = _swapper.get(out, face, _source_face, paste_back=True)
        if MOUTH_MASK:
            res = _mouth_blend(out, res, face)
        out = res
    if _enhancer is not None:
        _, _, out = _enhancer.enhance(out, has_aligned=False, only_center_face=False, paste_back=True)
    return out
