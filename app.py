"""
The Splat Guy - WebUI for Apple SHARP
Single image, batch folder, webcam, and PLY converter
"""

from flask import Flask, render_template, request, jsonify, send_from_directory
import subprocess, os, sys, base64, threading, uuid, shutil
from pathlib import Path

app = Flask(__name__,
    template_folder=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'templates'),
    static_folder=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static'))

BASE_DIR      = Path(os.path.dirname(os.path.abspath(__file__)))
UPLOAD_FOLDER = BASE_DIR / "uploads"
OUTPUT_FOLDER = BASE_DIR / "outputs"
UPLOAD_FOLDER.mkdir(exist_ok=True)
OUTPUT_FOLDER.mkdir(exist_ok=True)

SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic"}

def find_sharp():
    candidates = [
        Path(os.environ.get("APPDATA","")) / "Python" / "Python313" / "Scripts" / "sharp.exe",
        Path(os.environ.get("APPDATA","")) / "Python" / "Python312" / "Scripts" / "sharp.exe",
        Path(os.environ.get("APPDATA","")) / "Python" / "Python310" / "Scripts" / "sharp.exe",
        Path(sys.executable).parent / "Scripts" / "sharp.exe",
        Path(sys.executable).parent / "sharp.exe",
    ]
    for c in candidates:
        if c.exists(): return str(c)
    return "sharp"

SHARP_EXE = find_sharp()
jobs = {}

def run_sharp_job(job_id, input_path, output_path):
    jobs[job_id].update({"status":"running","log":[]})
    cmd = [SHARP_EXE, "predict", "-i", str(input_path), "-o", str(output_path)]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in proc.stdout:
            line = line.strip()
            if line: jobs[job_id]["log"].append(line)
        proc.wait()
        plys = list(Path(output_path).glob("*.ply"))
        if plys:
            jobs[job_id].update({"status":"done","ply":plys[0].name,"output_dir":str(output_path)})
        else:
            jobs[job_id].update({"status":"error","error":"No .ply generated. Is SHARP installed?"})
    except Exception as e:
        jobs[job_id].update({"status":"error","error":str(e)})

def run_batch_job(job_id, image_files, output_base):
    jobs[job_id].update({"status":"running","log":[],"results":[]})
    total = len(image_files)
    for i, img_path in enumerate(image_files):
        stem = img_path.stem
        out_dir = output_base / stem; out_dir.mkdir(parents=True, exist_ok=True)
        in_dir = UPLOAD_FOLDER / job_id / stem; in_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(img_path, in_dir / img_path.name)
        jobs[job_id]["log"].append(f"[{i+1}/{total}] Processing: {img_path.name}")
        jobs[job_id]["current"] = f"{img_path.name} ({i+1}/{total})"
        cmd = [SHARP_EXE, "predict", "-i", str(in_dir), "-o", str(out_dir)]
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in proc.stdout:
                line = line.strip()
                if line: jobs[job_id]["log"].append(f"  {line}")
            proc.wait()
            plys = list(out_dir.glob("*.ply"))
            if plys:
                jobs[job_id]["results"].append({"image":img_path.name,"ply":plys[0].name,"subdir":stem,"status":"done"})
                jobs[job_id]["log"].append(f"  \u2713 Done: {plys[0].name}")
            else:
                jobs[job_id]["results"].append({"image":img_path.name,"status":"error","error":"No .ply"})
                jobs[job_id]["log"].append("  \u2717 Failed: no .ply")
        except Exception as e:
            jobs[job_id]["results"].append({"image":img_path.name,"status":"error","error":str(e)})
            jobs[job_id]["log"].append(f"  \u2717 Error: {e}")
    done = sum(1 for r in jobs[job_id]["results"] if r["status"]=="done")
    jobs[job_id].update({"status":"done","current":f"Complete \u2014 {done}/{total} succeeded"})

@app.route("/")
def index(): return render_template("index.html")

@app.route("/upload", methods=["POST"])
def upload():
    if "image" not in request.files: return jsonify({"error":"No image"}),400
    file = request.files["image"]
    job_id = str(uuid.uuid4())[:8]
    in_dir = UPLOAD_FOLDER/job_id; out_dir = OUTPUT_FOLDER/job_id
    in_dir.mkdir(parents=True); out_dir.mkdir(parents=True)
    ext = Path(file.filename).suffix or ".jpg"
    file.save(in_dir/f"input{ext}")
    jobs[job_id] = {"status":"queued","log":[],"ply":None,"mode":"single"}
    threading.Thread(target=run_sharp_job, args=(job_id,in_dir,out_dir), daemon=True).start()
    return jsonify({"job_id":job_id})

@app.route("/upload_webcam", methods=["POST"])
def upload_webcam():
    data = request.get_json()
    if not data or "image" not in data: return jsonify({"error":"No image data"}),400
    img_bytes = base64.b64decode(data["image"].split(",")[1] if "," in data["image"] else data["image"])
    job_id = str(uuid.uuid4())[:8]
    in_dir = UPLOAD_FOLDER/job_id; out_dir = OUTPUT_FOLDER/job_id
    in_dir.mkdir(parents=True); out_dir.mkdir(parents=True)
    (in_dir/"input.jpg").write_bytes(img_bytes)
    jobs[job_id] = {"status":"queued","log":[],"ply":None,"mode":"single"}
    threading.Thread(target=run_sharp_job, args=(job_id,in_dir,out_dir), daemon=True).start()
    return jsonify({"job_id":job_id})

@app.route("/scan_folder", methods=["POST"])
def scan_folder():
    data = request.get_json()
    p = Path(data.get("folder","").strip())
    if not p.exists() or not p.is_dir(): return jsonify({"error":f"Folder not found: {p}"}),400
    images = [f.name for f in sorted(p.iterdir()) if f.is_file() and f.suffix.lower() in SUPPORTED_EXTS]
    if not images: return jsonify({"error":"No supported images found"}),400
    return jsonify({"images":images,"count":len(images),"folder":str(p)})

@app.route("/batch", methods=["POST"])
def batch():
    data = request.get_json()
    p = Path(data.get("folder","").strip())
    if not p.exists() or not p.is_dir(): return jsonify({"error":f"Folder not found: {p}"}),400
    files = sorted([f for f in p.iterdir() if f.is_file() and f.suffix.lower() in SUPPORTED_EXTS])
    if not files: return jsonify({"error":"No images found"}),400
    job_id = str(uuid.uuid4())[:8]
    out_base = OUTPUT_FOLDER/job_id; out_base.mkdir(parents=True)
    jobs[job_id] = {"status":"queued","mode":"batch","log":[],"results":[],"total":len(files),"current":"Starting..."}
    threading.Thread(target=run_batch_job, args=(job_id,files,out_base), daemon=True).start()
    return jsonify({"job_id":job_id,"total":len(files)})

@app.route("/status/<job_id>")
def status(job_id):
    if job_id not in jobs: return jsonify({"error":"Job not found"}),404
    return jsonify(jobs[job_id])

@app.route("/download/<job_id>/<filename>")
def download(job_id, filename):
    return send_from_directory(str(OUTPUT_FOLDER/job_id), filename, as_attachment=True)

@app.route("/download_batch/<job_id>/<subdir>/<filename>")
def download_batch(job_id, subdir, filename):
    return send_from_directory(str(OUTPUT_FOLDER/job_id/subdir), filename, as_attachment=True)

@app.route("/outputs/<job_id>/<filename>")
def serve_output(job_id, filename):
    return send_from_directory(str(OUTPUT_FOLDER/job_id), filename)

@app.route("/convert_ply", methods=["POST"])
def convert_ply_route():
    files = request.files.getlist("files")
    output_folder = request.form.get("output_folder","").strip()
    if not files: return jsonify({"error":"No files uploaded"}),400
    SIZES = {"float":4,"float32":4,"double":8,"float64":8,"int":4,"int32":4,
             "uint":4,"uint32":4,"short":2,"int16":2,"ushort":2,"uint16":2,
             "char":1,"int8":1,"uchar":1,"uint8":1}
    job_id = str(uuid.uuid4())[:8]
    out_dir = Path(output_folder) if output_folder else OUTPUT_FOLDER/f"converted_{job_id}"
    out_dir.mkdir(parents=True, exist_ok=True)
    log=[]; ok=failed=0
    for file in files:
        fname = file.filename
        log.append(f"Processing: {fname}")
        try:
            raw = file.read()
            header_end = -1
            for ending in (b"end_header\n", b"end_header\r\n"):
                pos = raw.find(ending)
                if pos != -1: header_end = pos+len(ending); break
            if header_end == -1:
                log.append("  \u2717 No PLY header"); failed+=1; continue
            header_text = raw[:header_end].decode("ascii",errors="replace")
            body_bytes   = raw[header_end:]
            lines = header_text.splitlines()
            elements=[]; current=None
            for line in lines:
                if line.startswith("element "):
                    parts=line.split(); current={"name":parts[1],"count":int(parts[2]),"props":[]}; elements.append(current)
                elif line.startswith("property ") and current:
                    current["props"].append(line)
            vertex_el = next((e for e in elements if e["name"]=="vertex"),None)
            if not vertex_el:
                log.append("  \u2717 No vertex element"); failed+=1; continue
            non_std = [e["name"] for e in elements if e["name"]!="vertex"]
            if not non_std:
                (out_dir/fname).write_bytes(raw); log.append("  \u2713 Already compatible"); ok+=1; continue
            row=0
            for p in vertex_el["props"]:
                parts=p.strip().split()
                if parts[1]=="list": row=-1; break
                row+=SIZES.get(parts[1].lower(),4)
            if row<0:
                log.append("  \u2717 List props not supported"); failed+=1; continue
            vertex_data = body_bytes[:vertex_el["count"]*row]
            new_lines=[]; skip=False
            for line in lines:
                if line.startswith("element ") and any(line.startswith(f"element {n}") for n in non_std):
                    skip=True; continue
                if skip and (line.startswith("element ") or line=="end_header"): skip=False
                if skip: continue
                new_lines.append(line)
            new_header = "\n".join(new_lines)
            if not new_header.endswith("\n"): new_header+="\n"
            out_path = out_dir/fname
            if out_path.exists(): out_path = out_dir/f"{Path(fname).stem}_converted.ply"
            with open(out_path,"wb") as f_out:
                f_out.write(new_header.encode("ascii")+vertex_data)
            log.append(f"  \u2713 Stripped: {', '.join(non_std)}"); ok+=1
        except Exception as e:
            log.append(f"  \u2717 Error: {e}"); failed+=1
    log.append(f"\u2014 Done: {ok}/{ok+failed} converted  |  saved to: {out_dir}")
    return jsonify({"ok":ok,"failed":failed,"total":ok+failed,"log":log,"output_dir":str(out_dir)})

if __name__ == "__main__":
    print("="*50)
    print("  THE SPLAT GUY  |  http://127.0.0.1:7861")
    print("="*50)
    app.run(host="0.0.0.0", port=7861, debug=False)
