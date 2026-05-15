#!/usr/bin/env python3
"""
Super Visual — Topaz Mac Agent
Polls the cloud server for upscale jobs, runs Topaz Video AI, uploads result.
"""
import os
import sys
import time
import json
import subprocess
import tempfile
import urllib.request
import urllib.error
import urllib.parse
import shutil

SERVER_URL    = os.environ.get("SERVER_URL", "https://your-app.up.railway.app")
SERVICE_JWT   = os.environ.get("SERVICE_JWT", "")
TOPAZ_CLI     = os.environ.get("TOPAZ_CLI", "/Applications/Topaz Video AI.app/Contents/MacOS/Topaz Video AI")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))
SUPABASE_URL  = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY  = os.environ.get("SUPABASE_SERVICE_KEY", "")
BUCKET        = "generated-images"

HEADERS = {
    "Authorization": f"Bearer {SERVICE_JWT}",
    "Content-Type":  "application/json",
}


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def api_get(path: str) -> dict:
    req = urllib.request.Request(f"{SERVER_URL}{path}", headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def api_post(path: str, payload: dict) -> dict:
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(f"{SERVER_URL}{path}", data=data, headers=HEADERS, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def download_file(url: str, dest: str) -> None:
    log(f"Downloading {url} → {dest}")
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def run_topaz(input_path: str, output_path: str) -> bool:
    """Run Topaz Video AI CLI for 4× upscale with Iris model."""
    if not os.path.exists(TOPAZ_CLI):
        log(f"⚠️  Topaz CLI not found at: {TOPAZ_CLI}")
        log("    Trying ffmpeg passthrough fallback…")
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", input_path, "-c", "copy", output_path],
            capture_output=True, text=True, timeout=600
        )
        return result.returncode == 0

    cmd = [
        TOPAZ_CLI,
        "-i", input_path,
        "-o", output_path,
        "--model", "iris-4",
        "--scale", "4",
        "--output-fps", "60",
        "--codec", "h265",
        "--quality", "17",
    ]
    log(f"Running Topaz: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if result.returncode != 0:
        log(f"Topaz error: {result.stderr[:500]}")
        return False
    return True


def upload_to_supabase(file_path: str, filename: str) -> str:
    """Upload file to Supabase storage and return public URL."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_KEY not set")

    upload_url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/topaz/{filename}"
    with open(file_path, "rb") as f:
        data = f.read()

    headers = {
        "Authorization":  f"Bearer {SUPABASE_KEY}",
        "Content-Type":   "video/mp4",
        "x-upsert":       "true",
    }
    req = urllib.request.Request(upload_url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=300) as r:
        r.read()

    public_url = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/topaz/{filename}"
    log(f"Uploaded → {public_url}")
    return public_url


def process_job(job: dict) -> None:
    job_id    = job.get("id")
    video_url = job.get("video_url")
    scene_id  = job.get("scene_id")
    log(f"Processing job {job_id} | scene {scene_id}")

    with tempfile.TemporaryDirectory() as tmpdir:
        ext        = os.path.splitext(video_url.split("?")[0])[1] or ".mp4"
        input_path = os.path.join(tmpdir, f"input{ext}")
        output_fn  = f"topaz_{job_id}.mp4"
        output_path = os.path.join(tmpdir, output_fn)

        try:
            download_file(video_url, input_path)
        except Exception as e:
            log(f"Download failed: {e}")
            api_post("/topaz/complete", {"job_id": job_id, "error": f"Download failed: {e}"})
            return

        success = run_topaz(input_path, output_path)
        if not success or not os.path.exists(output_path):
            log("Topaz processing failed")
            api_post("/topaz/complete", {"job_id": job_id, "error": "Topaz processing failed"})
            return

        try:
            result_url = upload_to_supabase(output_path, output_fn)
        except Exception as e:
            log(f"Upload failed: {e}")
            api_post("/topaz/complete", {"job_id": job_id, "error": f"Upload failed: {e}"})
            return

        resp = api_post("/topaz/complete", {
            "job_id":     job_id,
            "result_url": result_url,
            "scene_id":   scene_id,
        })
        log(f"✅ Job {job_id} done → {result_url}")
        log(f"   Server: {resp}")


def main() -> None:
    log("═══════════════════════════════════")
    log("Super Visual — Topaz Mac Agent")
    log(f"Server : {SERVER_URL}")
    log(f"Topaz  : {TOPAZ_CLI}")
    log(f"Poll   : {POLL_INTERVAL}s")
    log("═══════════════════════════════════")

    if not SERVICE_JWT:
        log("⚠️  SERVICE_JWT not set — run init.js on server to generate one")
        sys.exit(1)

    while True:
        try:
            data = api_get("/topaz/queue")
            jobs = data.get("jobs", [])
            if jobs:
                log(f"{len(jobs)} job(s) in queue")
                for job in jobs:
                    process_job(job)
            else:
                log("Queue empty — sleeping…")
        except urllib.error.HTTPError as e:
            log(f"HTTP {e.code}: {e.reason}")
        except urllib.error.URLError as e:
            log(f"Network error: {e.reason}")
        except Exception as e:
            log(f"Error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
