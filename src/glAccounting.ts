/**
 * Bytes the page holds on the GPU, counted off the WebGL2 prototype: every texture,
 * renderbuffer and buffer allocation adds, every delete subtracts. The browser
 * reports none of this to a page, and the failure it explains is a GPU-process
 * out-of-memory that takes the context with it, so the count has to be kept here.
 *
 * Patched on the prototype, so every context on the page is counted, including the
 * thumbnailer's mini map. Level 0 only, mipmaps add a third; the numbers are for
 * comparing runs, not for reconciling with a driver.
 */

type Usage = { textureBytes: number; textures: number; bufferBytes: number; buffers: number };

type ContextState = {
  usage: Usage;
  unit: number;
  /** Bound TEXTURE_2D per texture unit. */
  bound: Map<number, WebGLTexture | null>;
  renderbuffer: WebGLRenderbuffer | null;
  /** Bound buffer per binding target. */
  buffers: Map<number, WebGLBuffer | null>;
};

const contexts = new WeakMap<WebGL2RenderingContext, ContextState>();
/** Level-0 bytes and whether a mip chain sits on top; generateMipmap runs every re-render. */
const textureBytes = new WeakMap<WebGLTexture, { base: number; mip: boolean }>();
const renderbufferBytes = new WeakMap<WebGLRenderbuffer, number>();
const bufferBytes = new WeakMap<WebGLBuffer, number>();
const live = new Set<WeakRef<WebGL2RenderingContext>>();

/** Milliseconds into the page when counting began, null until then. */
export let installedAt: number | null = null;

const emptyUsage = (): Usage => ({ textureBytes: 0, textures: 0, bufferBytes: 0, buffers: 0 });

function stateOf(gl: WebGL2RenderingContext): ContextState {
  let s = contexts.get(gl);
  if (!s) {
    s = { usage: emptyUsage(), unit: 0, bound: new Map(), renderbuffer: null, buffers: new Map() };
    contexts.set(gl, s);
    live.add(new WeakRef(gl));
  }
  return s;
}

/** Bytes per pixel for the type/format pairs MapLibre uploads. */
function bytesPerPixel(gl: WebGL2RenderingContext, format: number, type: number): number {
  const channels =
    format === gl.RGBA || format === gl.RGBA_INTEGER
      ? 4
      : format === gl.RGB || format === gl.RGB_INTEGER
        ? 3
        : format === gl.RG || format === gl.RG_INTEGER
          ? 2
          : format === gl.DEPTH_STENCIL
            ? 4
            : 1;
  switch (type) {
    case gl.FLOAT:
    case gl.UNSIGNED_INT:
    case gl.INT:
    case gl.UNSIGNED_INT_24_8:
      return format === gl.DEPTH_STENCIL || format === gl.DEPTH_COMPONENT ? 4 : channels * 4;
    case gl.HALF_FLOAT:
    case gl.UNSIGNED_SHORT:
    case gl.SHORT:
      return format === gl.DEPTH_COMPONENT ? 2 : channels * 2;
    default:
      return channels;
  }
}

/** Bytes per pixel of a sized internal format, for texStorage2D and renderbuffers. */
function bytesPerPixelSized(gl: WebGL2RenderingContext, internalformat: number): number {
  switch (internalformat) {
    case gl.DEPTH_COMPONENT16:
    case gl.RGB565:
    case gl.RGBA4:
    case gl.RGB5_A1:
    case gl.RG8:
    case gl.R16F:
      return 2;
    case gl.R8:
    case gl.STENCIL_INDEX8:
      return 1;
    case gl.RGBA16F:
    case gl.RG32F:
      return 8;
    case gl.RGBA32F:
      return 16;
    default:
      return 4;
  }
}

/** Width and height of a texImage2D source: an image-like object or the raw size. */
function sourceSize(source: unknown): [number, number] {
  const s = source as { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
  return [s.videoWidth ?? s.width ?? 0, s.videoHeight ?? s.height ?? 0];
}

let installed = false;

/** Idempotent; counting starts at the first call, so call it before the map exists. */
export function installGlAccounting(): void {
  if (installed) return;
  installed = true;
  installedAt = performance.now();
  const proto = WebGL2RenderingContext.prototype;

  const wrap = <K extends keyof WebGL2RenderingContext>(
    name: K,
    before: (gl: WebGL2RenderingContext, s: ContextState, args: unknown[]) => void,
  ): void => {
    const original = proto[name] as unknown as (...args: unknown[]) => unknown;
    (proto as unknown as Record<string, unknown>)[name] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
      before(this, stateOf(this), args);
      return original.apply(this, args);
    };
  };

  const total = (t: { base: number; mip: boolean } | undefined): number =>
    t ? (t.mip ? Math.round((t.base * 4) / 3) : t.base) : 0;
  const setTexture = (s: ContextState, tex: WebGLTexture, base: number, mip = false): void => {
    const prev = textureBytes.get(tex);
    const next = { base, mip };
    if (!prev?.base && base > 0) s.usage.textures++;
    if (prev?.base && base === 0) s.usage.textures--;
    s.usage.textureBytes += total(next) - total(prev);
    textureBytes.set(tex, next);
  };

  wrap('activeTexture', (gl, s, [unit]) => {
    s.unit = (unit as number) - gl.TEXTURE0;
  });
  wrap('bindTexture', (gl, s, [target, tex]) => {
    if (target === gl.TEXTURE_2D) s.bound.set(s.unit, tex as WebGLTexture | null);
  });
  wrap('texImage2D', (gl, s, args) => {
    const [target, level] = args as [number, number];
    if (target !== gl.TEXTURE_2D || level !== 0) return;
    const tex = s.bound.get(s.unit);
    if (!tex) return;
    let width: number, height: number, format: number, type: number;
    if (args.length === 6) {
      [width, height] = sourceSize(args[5]);
      format = args[3] as number;
      type = args[4] as number;
    } else {
      width = args[3] as number;
      height = args[4] as number;
      format = args[6] as number;
      type = args[7] as number;
    }
    setTexture(s, tex, width * height * bytesPerPixel(gl, format, type));
  });
  wrap('texStorage2D', (gl, s, [target, levels, internalformat, width, height]) => {
    if (target !== gl.TEXTURE_2D) return;
    const tex = s.bound.get(s.unit);
    if (!tex) return;
    const base = (width as number) * (height as number) * bytesPerPixelSized(gl, internalformat as number);
    setTexture(s, tex, base, (levels as number) > 1);
  });
  wrap('generateMipmap', (gl, s, [target]) => {
    if (target !== gl.TEXTURE_2D) return;
    const tex = s.bound.get(s.unit);
    if (tex) setTexture(s, tex, textureBytes.get(tex)?.base ?? 0, true);
  });
  wrap('deleteTexture', (_gl, s, [tex]) => {
    if (tex) setTexture(s, tex as WebGLTexture, 0);
  });

  wrap('bindRenderbuffer', (_gl, s, [, rb]) => {
    s.renderbuffer = rb as WebGLRenderbuffer | null;
  });
  const setRenderbuffer = (s: ContextState, rb: WebGLRenderbuffer, bytes: number): void => {
    const prev = renderbufferBytes.get(rb) ?? 0;
    if (prev === 0 && bytes > 0) s.usage.textures++;
    if (prev > 0 && bytes === 0) s.usage.textures--;
    s.usage.textureBytes += bytes - prev;
    renderbufferBytes.set(rb, bytes);
  };
  wrap('renderbufferStorage', (gl, s, [, internalformat, width, height]) => {
    if (s.renderbuffer) {
      setRenderbuffer(s, s.renderbuffer, (width as number) * (height as number) * bytesPerPixelSized(gl, internalformat as number));
    }
  });
  wrap('renderbufferStorageMultisample', (gl, s, [, samples, internalformat, width, height]) => {
    if (s.renderbuffer) {
      const px = (width as number) * (height as number) * Math.max(1, samples as number);
      setRenderbuffer(s, s.renderbuffer, px * bytesPerPixelSized(gl, internalformat as number));
    }
  });
  wrap('deleteRenderbuffer', (_gl, s, [rb]) => {
    if (rb) setRenderbuffer(s, rb as WebGLRenderbuffer, 0);
  });

  wrap('bindBuffer', (_gl, s, [target, buf]) => {
    s.buffers.set(target as number, buf as WebGLBuffer | null);
  });
  wrap('bufferData', (_gl, s, [target, sizeOrData]) => {
    const buf = s.buffers.get(target as number);
    if (!buf) return;
    const bytes =
      typeof sizeOrData === 'number' ? sizeOrData : ((sizeOrData as ArrayBufferView | null)?.byteLength ?? 0);
    const prev = bufferBytes.get(buf) ?? 0;
    if (prev === 0 && bytes > 0) s.usage.buffers++;
    s.usage.bufferBytes += bytes - prev;
    bufferBytes.set(buf, bytes);
  });
  wrap('deleteBuffer', (_gl, s, [buf]) => {
    const b = buf as WebGLBuffer | null;
    if (!b) return;
    const prev = bufferBytes.get(b) ?? 0;
    if (prev > 0) s.usage.buffers--;
    s.usage.bufferBytes -= prev;
    bufferBytes.set(b, 0);
  });
}

/** What one context holds; zeros for a context created before counting began. */
export function glUsage(gl: WebGL2RenderingContext): Usage {
  return { ...(contexts.get(gl)?.usage ?? emptyUsage()) };
}

/** Every context on the page together. */
export function glUsageAll(): Usage {
  const total = emptyUsage();
  for (const ref of live) {
    const gl = ref.deref();
    if (!gl) {
      live.delete(ref);
      continue;
    }
    const u = contexts.get(gl)!.usage;
    total.textureBytes += u.textureBytes;
    total.textures += u.textures;
    total.bufferBytes += u.bufferBytes;
    total.buffers += u.buffers;
  }
  return total;
}
