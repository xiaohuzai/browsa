/* @ts-self-types="./docling_wasm.d.ts" */

/**
 * A digital PDF being converted page by page. Construct it from the file's
 * bytes (the text layer is parsed once, in Rust), then feed the rasterized
 * pages in order.
 */
export class DigitalConverter {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DigitalConverterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_digitalconverter_free(ptr, 0);
    }
    /**
     * [`add_page`](Self::add_page) with TableFormer for the table regions whose
     * geometric reconstruction looks unreliable.
     * @param {number} index
     * @param {Uint8Array} rgba
     * @param {number} px_w
     * @param {number} px_h
     * @param {number} scale
     * @param {any} layout
     * @param {any} tf
     * @param {any | null} [rec]
     * @returns {Promise<void>}
     */
    addPageTf(index, rgba, px_w, px_h, scale, layout, tf, rec) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.digitalconverter_addPageTf(this.__wbg_ptr, index, ptr0, len0, px_w, px_h, scale, layout, tf, isLikeNone(rec) ? 0 : addToExternrefTable0(rec));
        return ret;
    }
    /**
     * Convert page `index` (0-based) given its rendered bitmap: layout
     * detection plus geometric tables. `scale` is the raster's pixels per PDF
     * point (2.0 for pdf.js `{scale: 2}`). With `rec` (and a dictionary at
     * construction), embedded raster pictures that carry no text cells are
     * OCR'd — the text a digital page's images hide from its text layer.
     * @param {number} index
     * @param {Uint8Array} rgba
     * @param {number} px_w
     * @param {number} px_h
     * @param {number} scale
     * @param {any} layout
     * @param {any | null} [rec]
     * @returns {Promise<void>}
     */
    add_page(index, rgba, px_w, px_h, scale, layout, rec) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.digitalconverter_add_page(this.__wbg_ptr, index, ptr0, len0, px_w, px_h, scale, layout, isLikeNone(rec) ? 0 : addToExternrefTable0(rec));
        return ret;
    }
    /**
     * Assemble the converted pages into a document and render it as `"md"`
     * (default), `"json"`, `"doclang"` or `"latex"`, with `images` picking how pictures
     * render in Markdown. Resets the converter.
     * @param {string} name
     * @param {string | null} [to]
     * @param {string | null} [images]
     * @returns {string}
     */
    finish(name, to, images) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(to) ? 0 : passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            var ptr2 = isLikeNone(images) ? 0 : passStringToWasm0(images, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len2 = WASM_VECTOR_LEN;
            const ret = wasm.digitalconverter_finish(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * Parse the PDF's text layer. Fails when there is none — the caller should
     * fall back to the scanned pipeline, exactly as the demo page does.
     * `dict` (optional) is the recognition dictionary text; with it and a
     * `RecSession` on `add_page`, embedded raster pictures get OCR'd too.
     * @param {Uint8Array} bytes
     * @param {string | null} [dict]
     */
    constructor(bytes, dict) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(dict) ? 0 : passStringToWasm0(dict, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.digitalconverter_new(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        DigitalConverterFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Pages the text parser found.
     * @returns {number}
     */
    page_count() {
        const ret = wasm.digitalconverter_page_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Install the recognition dictionary after construction — the host probes
     * the text layer first (the constructor throws on a scan) and only then
     * fetches the recognition model + dictionary.
     * @param {string} dict
     */
    setDict(dict) {
        const ptr0 = passStringToWasm0(dict, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.digitalconverter_setDict(this.__wbg_ptr, ptr0, len0);
    }
}
if (Symbol.dispose) DigitalConverter.prototype[Symbol.dispose] = DigitalConverter.prototype.free;

/**
 * Multi-page scanned-document converter (lite profile). Feed pages in
 * order, then [`finish`](Self::finish) — cross-page paragraph continuations
 * merge exactly like the native pipeline.
 */
export class ScannedConverter {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ScannedConverterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_scannedconverter_free(ptr, 0);
    }
    /**
     * Convert one page with TableFormer (#157 stage 3): table regions get the
     * ONNX table-structure model + docling's cell matcher instead of the
     * geometric reconstruction. `tf` is the JS-side session over the encoder /
     * decoder / bbox graphs.
     * @param {Uint8Array} rgba
     * @param {number} px_w
     * @param {number} px_h
     * @param {number} scale
     * @param {any} layout
     * @param {any} rec
     * @param {any} tf
     * @returns {Promise<void>}
     */
    addPageTf(rgba, px_w, px_h, scale, layout, rec, tf) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.scannedconverter_addPageTf(this.__wbg_ptr, ptr0, len0, px_w, px_h, scale, layout, rec, tf);
        return ret;
    }
    /**
     * Convert one page (lite profile — geometric tables): `rgba` is the
     * rendered bitmap (canvas ImageData), `scale` its pixels-per-PDF-point
     * (2.0 for pdf.js `{scale: 2}`; 1.0 for a standalone image).
     * @param {Uint8Array} rgba
     * @param {number} px_w
     * @param {number} px_h
     * @param {number} scale
     * @param {any} layout
     * @param {any} rec
     * @returns {Promise<void>}
     */
    add_page(rgba, px_w, px_h, scale, layout, rec) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.scannedconverter_add_page(this.__wbg_ptr, ptr0, len0, px_w, px_h, scale, layout, rec);
        return ret;
    }
    /**
     * Assemble the accumulated pages into the final document and render it
     * as `"md"` (default), `"json"`, `"doclang"` or `"latex"` — the same four the
     * declarative [`crate::convert`] entry point offers. `images` picks how
     * cropped figures render in Markdown (`"placeholder"` | `"embedded"`),
     * like [`crate::convert`]. Resets the converter.
     * @param {string} name
     * @param {string | null} [to]
     * @param {string | null} [images]
     * @returns {string}
     */
    finish(name, to, images) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(to) ? 0 : passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            var ptr2 = isLikeNone(images) ? 0 : passStringToWasm0(images, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len2 = WASM_VECTOR_LEN;
            const ret = wasm.scannedconverter_finish(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * `dict` is the recognition dictionary text (`en_dict.txt` for the
     * default English model).
     * @param {string} dict
     */
    constructor(dict) {
        const ptr0 = passStringToWasm0(dict, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.scannedconverter_new(ptr0, len0);
        this.__wbg_ptr = ret;
        ScannedConverterFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Number of pages converted so far (progress display).
     * @returns {number}
     */
    page_count() {
        const ret = wasm.scannedconverter_page_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Attach a text-detection session (#429): detected lines no layout region
     * or recognized cell covers — a diagram's labels, a margin note — get
     * recognized and placed as orphan text, as the native pipeline and
     * docling's OCR engines do. Call once before the first `add_page`.
     * @param {any} det
     */
    setDetector(det) {
        wasm.scannedconverter_setDetector(this.__wbg_ptr, det);
    }
}
if (Symbol.dispose) ScannedConverter.prototype[Symbol.dispose] = ScannedConverter.prototype.free;

/**
 * Convert a document (as bytes + filename, the extension drives format
 * detection) to `to`: `"md"` (Markdown, default), `"json"` (docling-core's
 * `DoclingDocument` wire format, schema 1.10.0), `"doclang"` (docling's
 * DocLang XML serialization) or `"latex"` (docling 2.124's LaTeX document,
 * #317).
 *
 * `images` controls how pictures render in Markdown — `"placeholder"`
 * (default) or `"embedded"` (base64 data URIs), the same option
 * docling-serve exposes. `max_pages` converts only a PDF's first N pages
 * (issue #80's window, first pinned to 1); other formats ignore it.
 * `page_break_placeholder` is docling's `export_to_markdown` option of the
 * same name: text inserted between pages in the Markdown (e.g.
 * `"<!-- page break -->"`); unset, the Markdown carries no page breaks.
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @param {string | null} [to]
 * @param {string | null} [images]
 * @param {number | null} [max_pages]
 * @param {string | null} [page_break_placeholder]
 * @returns {string}
 */
export function convert(bytes, filename, to, images, max_pages, page_break_placeholder) {
    let deferred7_0;
    let deferred7_1;
    try {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(filename, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(to) ? 0 : passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len2 = WASM_VECTOR_LEN;
        var ptr3 = isLikeNone(images) ? 0 : passStringToWasm0(images, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len3 = WASM_VECTOR_LEN;
        var ptr4 = isLikeNone(page_break_placeholder) ? 0 : passStringToWasm0(page_break_placeholder, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len4 = WASM_VECTOR_LEN;
        const ret = wasm.convert(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, isLikeNone(max_pages) ? Number.MAX_SAFE_INTEGER : (max_pages) >>> 0, ptr4, len4);
        var ptr6 = ret[0];
        var len6 = ret[1];
        if (ret[3]) {
            ptr6 = 0; len6 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred7_0 = ptr6;
        deferred7_1 = len6;
        return getStringFromWasm0(ptr6, len6);
    } finally {
        wasm.__wbindgen_free(deferred7_0, deferred7_1, 1);
    }
}

/**
 * One-shot scanned-image conversion through the full lite profile (layout +
 * OCR + assembly) — the browser counterpart of the native image path
 * (a standalone image is its own page at scale 1).
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {string} dict
 * @param {any} layout
 * @param {any} rec
 * @param {string | null} [to]
 * @param {string | null} [images]
 * @returns {Promise<string>}
 */
export function convert_scanned_image(bytes, name, dict, layout, rec, to, images) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(dict, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    var ptr3 = isLikeNone(to) ? 0 : passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len3 = WASM_VECTOR_LEN;
    var ptr4 = isLikeNone(images) ? 0 : passStringToWasm0(images, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len4 = WASM_VECTOR_LEN;
    const ret = wasm.convert_scanned_image(ptr0, len0, ptr1, len1, ptr2, len2, layout, rec, ptr3, len3, ptr4, len4);
    return ret;
}

/**
 * OCR a scanned image entirely in the browser: `bytes` is the image file
 * (PNG/JPEG/…), `dict` the recognition dictionary text (`en_dict.txt` for
 * the default English model), `session` the JS inference wrapper. Returns
 * Markdown (default) or docling JSON per `to`, one paragraph per recognized
 * line.
 * @param {Uint8Array} bytes
 * @param {string} dict
 * @param {any} session
 * @param {string | null} [to]
 * @returns {Promise<string>}
 */
export function ocr_image(bytes, dict, session, to) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(dict, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(to) ? 0 : passStringToWasm0(to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len2 = WASM_VECTOR_LEN;
    const ret = wasm.ocr_image(ptr0, len0, ptr1, len1, session, ptr2, len2);
    return ret;
}

export function start() {
    wasm.start();
}

/**
 * The file extensions this build can convert, as a JSON string array —
 * handy for an `<input accept=…>` filter. PDF converts via its embedded
 * text layer (`pdf-text`); the remaining ML formats (images, audio, METS)
 * are excluded: they are not compiled into the wasm build.
 * @returns {string}
 */
export function supported_extensions() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.supported_extensions();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * The docling.rs version this module was built from.
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_67e7344beaa85059: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_debug_string_0e68cf47c9cbd9b0: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_function_fcda5e3902d732fe: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_undefined_8c687d0b90d5b524: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_number_get_1dc732b810cb937c: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_997e73d32238e655: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_bbox_66018ea3bcb06583: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.bbox(arg1, arg2 >>> 0);
            return ret;
        }, arguments); },
        __wbg_call_6bcf8d3e20937e46: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_encode_f1cec20ab8a49426: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.encode(arg1);
            return ret;
        }, arguments); },
        __wbg_error_757e9472f8410341: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_getRandomValues_436a51d0629d84e1: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_get_989d0a1309644f2b: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_b1f0ab13c737f856: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_instanceof_Float32Array_31e80d3e88752523: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Float32Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_5674713bb7b79043: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_length_4e1adc0d42e23620: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_8768c6f6941913e3: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_from_slice_2221cabb71753908: function(arg0, arg1) {
            const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_typed_6f8b0d724fe26c07: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen_15402cda974f4c9c___convert__closures_____invoke___js_sys_6d47007f28f83474___Function_fn_wasm_bindgen_15402cda974f4c9c___JsValue_____wasm_bindgen_15402cda974f4c9c___sys__Undefined___js_sys_6d47007f28f83474___Function_fn_wasm_bindgen_15402cda974f4c9c___JsValue_____wasm_bindgen_15402cda974f4c9c___sys__Undefined_______true_(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_prototypesetcall_804a1eb1b047ccb9: function(arg0, arg1, arg2) {
            Float32Array.prototype.set.call(getArrayF32FromWasm0(arg0, arg1), arg2);
        },
        __wbg_queueMicrotask_85c90f6987555d65: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_f6a1fa10b81d1fc0: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_resolve_35ec7e0c6af4c82c: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_run_1ab5ada8c6560d5e: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.run(arg1 >>> 0, arg2 >>> 0, arg3);
            return ret;
        }, arguments); },
        __wbg_run_7c9e736f922251b0: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            const ret = arg0.run(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4);
            return ret;
        }, arguments); },
        __wbg_run_ef11651c7e0f6629: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.run(arg1);
            return ret;
        }, arguments); },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_8eb4cd83130a11a0: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_1e7044f654e934db: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_d8b50611246a6d92: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_fd0bc376bf0f8b42: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_step_fc206b94dbc0e4d3: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.step(arg1);
            return ret;
        }, arguments); },
        __wbg_then_7a850dae4493f353: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_b830475380919203: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 85, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_15402cda974f4c9c___convert__closures_____invoke___wasm_bindgen_15402cda974f4c9c___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_15402cda974f4c9c___JsError___true_);
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./docling_wasm_bg.js": import0,
    };
}

function wasm_bindgen_15402cda974f4c9c___convert__closures_____invoke___wasm_bindgen_15402cda974f4c9c___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_15402cda974f4c9c___JsError___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_15402cda974f4c9c___convert__closures_____invoke___wasm_bindgen_15402cda974f4c9c___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_15402cda974f4c9c___JsError___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_15402cda974f4c9c___convert__closures_____invoke___js_sys_6d47007f28f83474___Function_fn_wasm_bindgen_15402cda974f4c9c___JsValue_____wasm_bindgen_15402cda974f4c9c___sys__Undefined___js_sys_6d47007f28f83474___Function_fn_wasm_bindgen_15402cda974f4c9c___JsValue_____wasm_bindgen_15402cda974f4c9c___sys__Undefined_______true_(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen_15402cda974f4c9c___convert__closures_____invoke___js_sys_6d47007f28f83474___Function_fn_wasm_bindgen_15402cda974f4c9c___JsValue_____wasm_bindgen_15402cda974f4c9c___sys__Undefined___js_sys_6d47007f28f83474___Function_fn_wasm_bindgen_15402cda974f4c9c___JsValue_____wasm_bindgen_15402cda974f4c9c___sys__Undefined_______true_(arg0, arg1, arg2, arg3);
}

const DigitalConverterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_digitalconverter_free(ptr, 1));
const ScannedConverterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_scannedconverter_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('docling_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
