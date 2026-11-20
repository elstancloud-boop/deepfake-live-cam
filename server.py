import asyncio, json, os, uuid
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from av import VideoFrame
import swapper

pcs = set()

class SwapTrack(VideoStreamTrack):
    def __init__(self, source):
        super().__init__()
        self.source = source
    async def recv(self):
        frame = await self.source.recv()
        img = frame.to_ndarray(format="bgr24")
        out = await asyncio.get_running_loop().run_in_executor(None, swapper.swap, img)
        new = VideoFrame.from_ndarray(out, format="bgr24")
        new.pts, new.time_base = frame.pts, frame.time_base
        return new

async def index(_):
    return web.FileResponse("static/index.html")

async def source(request):
    data = await request.post()
    ok = swapper.set_source(data["image"].file.read())
    return web.json_response({"ok": ok}, status=200 if ok else 400)

async def offer(request):
    p = await request.json()
    pc = RTCPeerConnection()
    pcs.add(pc)
    @pc.on("track")
    def on_track(track):
        if track.kind == "video":
            pc.addTrack(SwapTrack(track))
    @pc.on("connectionstatechange")
    async def _():
        if pc.connectionState in ("failed", "closed"):
            await pc.close(); pcs.discard(pc)
    await pc.setRemoteDescription(RTCSessionDescription(p["sdp"], p["type"]))
    await pc.setLocalDescription(await pc.createAnswer())
    return web.json_response({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})

async def on_shutdown(_):
    await asyncio.gather(*[pc.close() for pc in pcs]); pcs.clear()

app = web.Application(client_max_size=20*1024*1024)
app.add_routes([web.get("/", index), web.post("/source", source), web.post("/offer", offer)])
app.on_shutdown.append(on_shutdown)

if __name__ == "__main__":
    web.run_app(app, port=int(os.environ.get("PORT", 8080)))
