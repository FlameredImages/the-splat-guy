/**
 * The Splat Guy — Local WebGL Gaussian Splat Viewer
 * Minimal but functional: parses .ply, sorts splats back-to-front, renders via WebGL
 */

(function() {

const VS = `
precision highp float;
attribute vec3 position;
attribute vec3 color;
attribute vec2 scale;   // sx, sy in screen px
attribute float opacity;
attribute float angle;  // rotation in radians

uniform mat4 uMVP;
uniform vec2 uViewport;

varying vec3 vColor;
varying float vOpacity;
varying vec2 vUV;

void main() {
    vec4 clip = uMVP * vec4(position, 1.0);
    float w = clip.w;

    // corner offset in NDC
    float cosA = cos(angle);
    float sinA = sin(angle);
    vec2 corner = vec2(
        gl_VertexID == 0 || gl_VertexID == 3 ? -1.0 : 1.0,
        gl_VertexID == 0 || gl_VertexID == 1 ?  1.0 : -1.0
    );
    vec2 rotCorner = vec2(
        cosA * corner.x - sinA * corner.y,
        sinA * corner.x + cosA * corner.y
    );

    // scale from world to screen pixels then back to NDC
    vec2 screenSize = scale * 2.0;
    vec2 ndcOffset = (rotCorner * screenSize) / uViewport * w;

    gl_Position = vec4(clip.xy + ndcOffset, clip.z, w);
    vColor   = color;
    vOpacity = opacity;
    vUV      = corner;
}`;

const FS = `
precision mediump float;
varying vec3 vColor;
varying float vOpacity;
varying vec2 vUV;

void main() {
    float r2 = dot(vUV, vUV);
    if (r2 > 1.0) discard;
    float alpha = vOpacity * exp(-3.0 * r2);
    gl_FragColor = vec4(vColor * alpha, alpha);
}`;

// ── PLY parser ──────────────────────────────────────────────────────────────
function parsePLY(buffer) {
    const bytes  = new Uint8Array(buffer);
    let pos = 0;

    // find end_header
    const enc = new TextDecoder();
    let headerEnd = -1;
    for (let i = 0; i < bytes.length - 10; i++) {
        if (bytes[i]===101&&bytes[i+1]===110&&bytes[i+2]===100&&bytes[i+3]===95) { // "end_"
            const line = enc.decode(bytes.slice(i, i+12));
            if (line.startsWith('end_header')) {
                headerEnd = i + line.indexOf('\n') + 1;
                break;
            }
        }
    }
    if (headerEnd < 0) throw new Error('No PLY header found');

    const header = enc.decode(bytes.slice(0, headerEnd));
    const lines  = header.split('\n').map(l => l.trim());

    // parse vertex count and properties
    let vertexCount = 0;
    let props = [];
    let inVertex = false;
    for (const line of lines) {
        if (line.startsWith('element vertex')) { vertexCount = parseInt(line.split(' ')[2]); inVertex = true; continue; }
        if (line.startsWith('element ') && !line.startsWith('element vertex')) { inVertex = false; }
        if (inVertex && line.startsWith('property float')) props.push(line.split(' ')[2]);
        if (inVertex && line.startsWith('property uchar') || (inVertex && line.startsWith('property uint8'))) props.push(line.split(' ')[2]);
    }

    // build property map
    const SIZES = {float:4, uchar:1, uint8:1, double:8, int:4, uint:4, short:2, ushort:2, char:1, int8:1, float32:4, float64:8};
    let rowSize = 0;
    const propDefs = [];
    for (const line of lines) {
        if (!inVertex && line.startsWith('element vertex')) inVertex = true;
        if (line.startsWith('property ')) {
            const parts = line.split(' ');
            const type = parts[1], name = parts[2];
            const size = SIZES[type] || 4;
            propDefs.push({name, type, offset: rowSize, size});
            rowSize += size;
        }
    }

    const data = bytes.slice(headerEnd);
    const view = new DataView(data.buffer, data.byteOffset);

    // extract common properties by name
    function findProp(name) { return propDefs.find(p => p.name === name); }
    const px = findProp('x'), py = findProp('y'), pz = findProp('z');
    const pr = findProp('f_dc_0') || findProp('red');
    const pg = findProp('f_dc_1') || findProp('green');
    const pb = findProp('f_dc_2') || findProp('blue');
    const pa = findProp('opacity');
    const ps0 = findProp('scale_0'), ps1 = findProp('scale_1');
    const prot = findProp('rot_0');

    const positions = new Float32Array(vertexCount * 3);
    const colors    = new Float32Array(vertexCount * 3);
    const scales    = new Float32Array(vertexCount * 2);
    const opacities = new Float32Array(vertexCount);
    const angles    = new Float32Array(vertexCount);

    const sigmoid = x => 1 / (1 + Math.exp(-x));
    const SH_C0   = 0.28209479177387814;

    for (let i = 0; i < vertexCount; i++) {
        const base = i * rowSize;

        const x = px ? view.getFloat32(base + px.offset, true) : 0;
        const y = py ? view.getFloat32(base + py.offset, true) : 0;
        const z = pz ? view.getFloat32(base + pz.offset, true) : 0;
        positions[i*3]   = x;
        positions[i*3+1] = y;
        positions[i*3+2] = z;

        // colour — SH f_dc or raw byte
        if (pr && pr.type === 'float') {
            colors[i*3]   = Math.min(1, Math.max(0, 0.5 + SH_C0 * view.getFloat32(base + pr.offset, true)));
            colors[i*3+1] = Math.min(1, Math.max(0, 0.5 + SH_C0 * view.getFloat32(base + pg.offset, true)));
            colors[i*3+2] = Math.min(1, Math.max(0, 0.5 + SH_C0 * view.getFloat32(base + pb.offset, true)));
        } else if (pr) {
            colors[i*3]   = view.getUint8(base + pr.offset) / 255;
            colors[i*3+1] = view.getUint8(base + pg.offset) / 255;
            colors[i*3+2] = view.getUint8(base + pb.offset) / 255;
        } else {
            colors[i*3] = colors[i*3+1] = colors[i*3+2] = 0.8;
        }

        opacities[i] = pa ? sigmoid(view.getFloat32(base + pa.offset, true)) : 0.8;

        // scale — exponential in GS format
        if (ps0 && ps1) {
            scales[i*2]   = Math.exp(view.getFloat32(base + ps0.offset, true));
            scales[i*2+1] = Math.exp(view.getFloat32(base + ps1.offset, true));
        } else {
            scales[i*2] = scales[i*2+1] = 0.02;
        }

        angles[i] = prot ? view.getFloat32(base + prot.offset, true) : 0;
    }

    return { vertexCount, positions, colors, scales, opacities, angles };
}

// ── Viewer class ─────────────────────────────────────────────────────────────
class SplatViewer {
    constructor(canvas) {
        this.canvas  = canvas;
        this.gl      = canvas.getContext('webgl', {alpha:true, premultipliedAlpha:false});
        this.splat   = null;
        this.cam     = { azimuth: 0.4, elevation: 0.2, distance: 3.5, target: [0,0,0] };
        this.dragging = false;
        this.lastMouse = [0,0];
        this._initGL();
        this._bindEvents();
        this._loop();
    }

    _initGL() {
        const gl = this.gl;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);

        const compile = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src); gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s);
            return s;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER,   VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw gl.getProgramInfoLog(prog);
        this.prog = prog;

        this.uMVP      = gl.getUniformLocation(prog, 'uMVP');
        this.uViewport = gl.getUniformLocation(prog, 'uViewport');
        this.aPos      = gl.getAttribLocation(prog,  'position');
        this.aCol      = gl.getAttribLocation(prog,  'color');
        this.aScale    = gl.getAttribLocation(prog,  'scale');
        this.aOpacity  = gl.getAttribLocation(prog,  'opacity');
        this.aAngle    = gl.getAttribLocation(prog,  'angle');

        // quad index buffer for instanced-like drawing (2 tris per splat)
        this.quadIBO = gl.createBuffer();

        this.bufPos     = gl.createBuffer();
        this.bufCol     = gl.createBuffer();
        this.bufScale   = gl.createBuffer();
        this.bufOpacity = gl.createBuffer();
        this.bufAngle   = gl.createBuffer();
        this.bufIdx     = gl.createBuffer();
    }

    load(data) {
        this.splat = data;
        this._uploadBuffers(data);
        // auto-fit camera
        let cx=0,cy=0,cz=0;
        for (let i=0;i<data.vertexCount;i++){cx+=data.positions[i*3];cy+=data.positions[i*3+1];cz+=data.positions[i*3+2];}
        this.cam.target = [cx/data.vertexCount, cy/data.vertexCount, cz/data.vertexCount];
        this.cam.distance = 3.5;
    }

    _uploadBuffers(d) {
        const gl = this.gl;
        const N  = d.vertexCount;

        // Expand per-splat data to 4 vertices each
        const pos4     = new Float32Array(N * 4 * 3);
        const col4     = new Float32Array(N * 4 * 3);
        const scale4   = new Float32Array(N * 4 * 2);
        const opacity4 = new Float32Array(N * 4);
        const angle4   = new Float32Array(N * 4);

        for (let i = 0; i < N; i++) {
            for (let v = 0; v < 4; v++) {
                pos4[(i*4+v)*3]   = d.positions[i*3];
                pos4[(i*4+v)*3+1] = d.positions[i*3+1];
                pos4[(i*4+v)*3+2] = d.positions[i*3+2];
                col4[(i*4+v)*3]   = d.colors[i*3];
                col4[(i*4+v)*3+1] = d.colors[i*3+1];
                col4[(i*4+v)*3+2] = d.colors[i*3+2];
                scale4[(i*4+v)*2]   = d.scales[i*2]   * 200;
                scale4[(i*4+v)*2+1] = d.scales[i*2+1] * 200;
                opacity4[i*4+v]     = d.opacities[i];
                angle4[i*4+v]       = d.angles[i];
            }
        }

        // index buffer: 2 tris per quad
        const idx = new Uint32Array(N * 6);
        for (let i = 0; i < N; i++) {
            idx[i*6+0] = i*4+0; idx[i*6+1] = i*4+1; idx[i*6+2] = i*4+2;
            idx[i*6+3] = i*4+0; idx[i*6+4] = i*4+2; idx[i*6+5] = i*4+3;
        }

        const upload = (buf, data, attr, size) => {
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
            if (attr >= 0) { gl.enableVertexAttribArray(attr); gl.vertexAttribPointer(attr, size, gl.FLOAT, false, 0, 0); }
        };

        upload(this.bufPos,     pos4,     this.aPos,     3);
        upload(this.bufCol,     col4,     this.aCol,     3);
        upload(this.bufScale,   scale4,   this.aScale,   2);
        upload(this.bufOpacity, opacity4, this.aOpacity, 1);
        upload(this.bufAngle,   angle4,   this.aAngle,   1);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

        this.indexCount = N * 6;

        // sort splats back to front initially
        this._sortSplats();
    }

    _sortSplats() {
        if (!this.splat) return;
        const d   = this.splat;
        const N   = d.vertexCount;
        const eye = this._eyePos();

        // compute depth for each splat
        const depths = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const dx = d.positions[i*3]   - eye[0];
            const dy = d.positions[i*3+1] - eye[1];
            const dz = d.positions[i*3+2] - eye[2];
            depths[i] = dx*dx + dy*dy + dz*dz;
        }

        // sort indices
        const indices = Array.from({length:N}, (_,i)=>i);
        indices.sort((a,b) => depths[b] - depths[a]);

        // rebuild index buffer in sorted order
        const idx = new Uint32Array(N * 6);
        for (let j = 0; j < N; j++) {
            const i = indices[j];
            idx[j*6+0]=i*4+0;idx[j*6+1]=i*4+1;idx[j*6+2]=i*4+2;
            idx[j*6+3]=i*4+0;idx[j*6+4]=i*4+2;idx[j*6+5]=i*4+3;
        }
        const gl = this.gl;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
    }

    _eyePos() {
        const c = this.cam;
        const az = c.azimuth, el = c.elevation, d = c.distance;
        return [
            c.target[0] + d * Math.cos(el) * Math.sin(az),
            c.target[1] + d * Math.sin(el),
            c.target[2] + d * Math.cos(el) * Math.cos(az)
        ];
    }

    _mvp() {
        const c   = this.cam;
        const eye = this._eyePos();
        const up  = [0, 1, 0];

        // lookAt
        let f = normalize(sub(c.target, eye));
        let r = normalize(cross(f, up));
        let u = cross(r, f);

        const view = new Float32Array([
            r[0], u[0], -f[0], 0,
            r[1], u[1], -f[1], 0,
            r[2], u[2], -f[2], 0,
            -dot(r,eye), -dot(u,eye), dot(f,eye), 1
        ]);

        // perspective
        const fov = Math.PI / 3, aspect = this.canvas.width / this.canvas.height;
        const near = 0.1, far = 100;
        const t = Math.tan(fov/2);
        const proj = new Float32Array([
            1/(aspect*t),0,0,0,
            0,1/t,0,0,
            0,0,-(far+near)/(far-near),-1,
            0,0,-2*far*near/(far-near),0
        ]);

        return mat4mul(proj, view);
    }

    _loop() {
        const render = () => {
            requestAnimationFrame(render);
            const gl = this.gl;
            const W  = this.canvas.clientWidth;
            const H  = this.canvas.clientHeight;
            if (this.canvas.width !== W || this.canvas.height !== H) {
                this.canvas.width = W; this.canvas.height = H;
            }
            gl.viewport(0, 0, W, H);
            gl.clearColor(0.02, 0.03, 0.06, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);

            if (!this.splat) return;

            gl.useProgram(this.prog);
            gl.uniformMatrix4fv(this.uMVP, false, this._mvp());
            gl.uniform2f(this.uViewport, W, H);

            // rebind all attribs
            const bind = (buf, attr, size) => {
                gl.bindBuffer(gl.ARRAY_BUFFER, buf);
                gl.enableVertexAttribArray(attr);
                gl.vertexAttribPointer(attr, size, gl.FLOAT, false, 0, 0);
            };
            bind(this.bufPos,     this.aPos,     3);
            bind(this.bufCol,     this.aCol,     3);
            bind(this.bufScale,   this.aScale,   2);
            bind(this.bufOpacity, this.aOpacity, 1);
            bind(this.bufAngle,   this.aAngle,   1);

            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx);
            gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
        };
        render();
    }

    _bindEvents() {
        const c = this.canvas;
        c.addEventListener('mousedown', e => { this.dragging=true; this.lastMouse=[e.clientX,e.clientY]; e.preventDefault(); });
        window.addEventListener('mouseup', () => { if(this.dragging){this.dragging=false;this._sortSplats();} });
        window.addEventListener('mousemove', e => {
            if (!this.dragging) return;
            const dx = e.clientX - this.lastMouse[0];
            const dy = e.clientY - this.lastMouse[1];
            this.lastMouse = [e.clientX, e.clientY];
            if (e.buttons & 1) {
                this.cam.azimuth   -= dx * 0.005;
                this.cam.elevation += dy * 0.005;
                this.cam.elevation  = Math.max(-Math.PI/2+0.05, Math.min(Math.PI/2-0.05, this.cam.elevation));
            } else if (e.buttons & 2) {
                this.cam.distance = Math.max(0.5, this.cam.distance + dy * 0.01);
            }
        });
        c.addEventListener('wheel', e => {
            this.cam.distance = Math.max(0.5, this.cam.distance + e.deltaY * 0.005);
            this._sortSplats();
            e.preventDefault();
        }, {passive:false});
        c.addEventListener('contextmenu', e => e.preventDefault());

        // touch
        let lastTouchDist = 0;
        c.addEventListener('touchstart', e => {
            if (e.touches.length === 1) { this.dragging=true; this.lastMouse=[e.touches[0].clientX,e.touches[0].clientY]; }
            if (e.touches.length === 2) { const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY; lastTouchDist=Math.sqrt(dx*dx+dy*dy); }
            e.preventDefault();
        },{passive:false});
        c.addEventListener('touchend', () => { this.dragging=false; this._sortSplats(); });
        c.addEventListener('touchmove', e => {
            if (e.touches.length === 1 && this.dragging) {
                const dx=e.touches[0].clientX-this.lastMouse[0], dy=e.touches[0].clientY-this.lastMouse[1];
                this.lastMouse=[e.touches[0].clientX,e.touches[0].clientY];
                this.cam.azimuth -= dx*0.005;
                this.cam.elevation = Math.max(-Math.PI/2+0.05, Math.min(Math.PI/2-0.05, this.cam.elevation+dy*0.005));
            }
            if (e.touches.length === 2) {
                const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY;
                const d=Math.sqrt(dx*dx+dy*dy);
                this.cam.distance=Math.max(0.5, this.cam.distance+(lastTouchDist-d)*0.01);
                lastTouchDist=d;
            }
            e.preventDefault();
        },{passive:false});
    }
}

// ── Math helpers ─────────────────────────────────────────────────────────────
function sub(a,b){return[a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function cross(a,b){return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
function normalize(v){const l=Math.sqrt(dot(v,v));return l>0?[v[0]/l,v[1]/l,v[2]/l]:v;}
function mat4mul(a,b){
    const r=new Float32Array(16);
    for(let i=0;i<4;i++)for(let j=0;j<4;j++){let s=0;for(let k=0;k<4;k++)s+=a[i+k*4]*b[k+j*4];r[i+j*4]=s;}
    return r;
}

// ── Public API ───────────────────────────────────────────────────────────────
window.SplatViewer = SplatViewer;
window.parsePLY    = parsePLY;

})();
