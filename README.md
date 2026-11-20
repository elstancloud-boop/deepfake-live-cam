# Deepfake Live Cam

Real-time face swap in the browser. Your webcam goes to the server over WebRTC (aiortc), faces are swapped with InsightFace `inswapper_128`, and the result streams back.

## Run
1. `pip install -r requirements.txt` (use `onnxruntime-gpu` instead of `onnxruntime` for an NVIDIA GPU)
2. Download `inswapper_128.onnx` and place it at `models/inswapper_128.onnx` (or set `SWAP_MODEL`). Its license is non-commercial research only.
3. `python server.py`, then open http://localhost:8080 (camera access needs localhost or HTTPS).

Docker: `docker build -t dlc . && docker run -p 8080:8080 -v $PWD/models:/app/models dlc`

CPU runs at a few FPS; a GPU is recommended. Only use photos of people who have agreed to it.
