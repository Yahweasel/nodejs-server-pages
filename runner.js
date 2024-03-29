/*
 * Copyright (c) 2020, 2021 Yahweasel
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const zlib = require("zlib");

const multipart = require("./multipart.js");
const session = require("./session.js");

const contentRE = /^([^ ;]*)/;
const boundaryRE = /^multipart\/.+?(?:; boundary=(?:(?:"(.+)")|(?:([^\s]+))))$/i;

/**
 * Timestamps for already-compiled files
 */
const times = {};

/**
 * Already-compiled files
 */
const funcs = {};

/**
 * The list of global(ish) values, which are passed through our async functions
 */
const globals = [
    "request", "response", "params", "writeHead", "write", "session",
    "compileAbsolute", "require", "__dirname", "__filename"
];

/**
 * When a page is done, we need to eliminate all cached requires that aren't
 * part of the runner itself. As such, we remember the cache here, so we know
 * what not to delete.
 */
const requireCacheCleanState = {};
for (const m in require.cache)
    requireCacheCleanState[m] = true;

/**
 * "Parse" a JSS file into JavaScript code
 * @param {string} file     The file content
 */
function parse(file) {
    let start = 0;
    const out = {o: ""};
    let inComment = false;

    // Look for meaningful tags
    for (let i = 0; i < file.length; i++) {
        if (!inComment) {
            if (file.slice(i, i+4) === "<!--") {
                inComment = true;
            } else if (file.slice(i, i+2) === "<?") {
                const part = file.slice(start, i);
                if (part.trim() !== "") {
                    // Generate code to output this part
                    out.o += "write(" + JSON.stringify(part) + ");\n";
                }

                // Then pass through the JS part
                start = i = parseJS(file, i + 2, out) + 2;
                continue;
            }
        } else {
            // Just looking for -->
            if (file.slice(i, i+3) === "-->")
                inComment = false;
        }
    }

    const part = file.slice(start);
    if (part.trim() !== "")
        out.o += "write(" + JSON.stringify(part) + ");\n";

    return out.o;
}

/**
 * Parse just the JS part of a JSS file
 */
function parseJS(file, i, out) {
    let isEchoTag = false;

    // First, we can start with "JS<whitespace>" or an echo tag
    const optStart = /^(js)?(=)?(!)?\s/i;
    const ose = optStart.exec(file.slice(i));
    if (ose) {
        i += ose[0].length;
        if (ose[3] === "!")
            out.o += "if (!module.included) { module.writeHead(500); return; }\n";
        if (ose[2] === "=") {
            out.o += "write(String(";
            isEchoTag = true;
        }
    }

    // This doesn't really parse, of course, just avoids ?> in comments
    const start = i;
    for (; i < file.length; i++) {
        const c = file[i];
        if (c === "/") {
            // Maybe a comment
            if (file[i+1] === "*") {
                // Multi-line comment
                for (i += 2; i < file.length; i++) {
                    if (file[i] === "*" && file[i+1] === "/") {
                        i += 2;
                        break;
                    }
                }

            } else if (file[i+1] === "/") {
                // Single-line comment
                for (i += 2; i < file.length && file[i] !== "\n"; i++) {}

            }

        } else if (c === "\"" || c === "'" || c === "`") {
            // Quoted string
            for (i++; i < file.length && file[i] !== c; i++) {
                if (file[i] === "\\")
                    i++;
            }

        } else if (c === "?" && file[i+1] === ">") {
            // End of JS part
            break;

        }
    }

    // Output what we skipped
    out.o += file.slice(start, i);

    // And possibly close our echo tag
    if (isEchoTag)
        out.o += "));\n";

    return i;
}

/**
 * Compile the named file into an AsyncFunction
 */
function compile(fname) {
    let sbuf;
    let func = null;

    // Get the stats
    try {
        sbuf = fs.statSync(fname);
    } catch (ex) {
        return null;
    }

    // Check
    if (fname in times && sbuf.mtimeMs <= times[fname]) {
        // Still good
        func = funcs[fname];
    }

    // If we don't already have it, read it
    if (!func) {
        let fcont, parsed;

        // A header is needed to make usable local variables and specialized functions
        let header = "";
        for (const global of globals)
            header += "var " + global + " = module." + global + ";\n";

        header +=
            "function compile(name) {\n" +
            "name = (name[0]==='/') ? name : (" + JSON.stringify(path.dirname(fname) + "/") + "+name);\n" +
            "return module.compileAbsolute(name);\n" +
            "}\n" +
            "async function include(name) {\n" +
            "var sm = {" + globals.join(",") + ",included:true,exports:{}};\n" +
            "var a = [sm].concat(Array.prototype.slice.call(arguments, 1));\n" +
            "await (compile(name).apply(null, a));\n" +
            "return sm.exports;\n" +
            "}\n";

        // Compile
        fcont = fs.readFileSync(fname, "utf8");
        parsed = parse(fcont);
        func = new AsyncFunction("module", header + parsed);

        times[fname] = sbuf.mtimeMs;
        funcs[fname] = func;
    }

    return func;
}

/**
 * The main entry point. Run the given params.
 */
function run(db, params, req, body, res) {
    const pname = `${params.REQUEST_SCHEME}://${params.SERVER_NAME}:${params.SERVER_PORT}${params.REQUEST_URI}`;
    const fname = params.DOCUMENT_ROOT + params.SCRIPT_NAME;
    let realName = fname;
    try {
        realName = fs.realpathSync(fname);
    } catch (ex) {}
    let func;

    // Compile the page
    try {
        func = compile(fname);
    } catch (ex) {
        process.send({
            c: "x",
            p: pname,
            f: fname,
            e: ex + "\n" + ex.stack
        });

        res.writeHead(500, {"Content-type": "text/plain"});
        res.write("500: Internal server error");
        res.end();
        return;
    }

    if (func === null) {
        // Not found!
        res.writeHead(404);
        res.write("404: File not found");
        res.end();
        return;
    }

    // Create a session
    const s = new session.Session(db, req, res);

    // Set up its module object
    const module = {
        request: req,
        response: res,
        params,
        writeHead: res.writeHead.bind(res),
        write: res.write.bind(res),
        session: s,
        compileAbsolute: compile,
        require: require.main.require,
        __dirname: path.dirname(realName),
        __filename: realName,
        exports: {}
    };

    // Parse its query string
    req.query = querystring.parse(req.query);

    // Handle the body
    if (body) {
        req.bodyRaw = body = Buffer.from(body, "binary");
        let ct = (req.headers["content-type"]||"text/plain");
        ct = contentRE.exec(ct)[1];

        try {
            switch (ct) {
                case "application/json":
                    req.body = JSON.parse(body.toString("utf8"));
                    break;

                case "application/x-www-form-urlencoded":
                    req.body = querystring.parse(body.toString("utf8"));
                    break;

                case "multipart/form-data":
                {
                    const boundary = boundaryRE.exec(req.headers["content-type"]);
                    const parts = multipart.Parse(body.toString("utf8"), boundary[1] || boundary[2]);
                    req.files = [];
                    req.body = {};
                    for (const part of parts) {
                        if (part.filename) {
                            req.files.push(part);
                        } else if (part.name) {
                            try {
                                req.body[part.name] = part.data.toString("utf8");
                            } catch (ex) {
                                req.body[part.name] = part.data;
                            }
                        }
                    }
                    break;
                }

                case "text/plain":
                    req.body = body.toString("utf8");
                    break;
            }
        } catch (ex) {
            req.bodyException = ex;
        }
    }

    // Enable compression by default
    res.compress(req);

    // Cry a lot if we time out
    let timeout = setTimeout(() => {
        // No safe way to kill this but to kill it
        process.exit(0);
    }, 30000);

    // Allow a different timeout (FIXME: inelegant)
    res.setTimeLimit = function(tl) {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            process.exit(0);
        }, tl);
    };

    // Run it
    func(module).then(() => {
        clearTimeout(timeout);
        finish();
    }).catch((ex) => {
        clearTimeout(timeout);
        process.send({
            c: "x",
            p: pname,
            f: fname,
            e: ex + "\n" + ex.stack
        });
        res.write("ERROR");
        finish();
    });

    // Close when we're done
    function finish() {
        s.close(); // No await, just let it finish in the background
        res.end();

        // So that future requires don't cache our stuff, delete the whole cache
        for (const m in require.cache) {
            if (/\.js(on)?$/.test(m) && !requireCacheCleanState[m])
                delete require.cache[m];
        }
    }
}

/**
 * Our response simulacrum, which sends actual response data back to the
 * server.
 */
function Response() {
    this.code = 200;
    this.headers = {"content-type": "text/html"};
    this.sentHeaders = false;
    this.ended = false;
    this.compression = null;
    this.compressor = null;
}

// Enable compression
Response.prototype.compress = function(req) {
    if (!req) {
        this.compression = null;
        this.setHeader("content-encoding", "identity");
        return;
    }

    // Check for supported compression
    const supported = {};
    for (const enc of (req.headers["accept-encoding"]||"").split(","))
        supported[enc.trim()] = true;

    if (supported.br && zlib.createBrotliCompress) {
        // Brotli
        this.compression = "br";
    } else if (supported.gzip && zlib.createGzip) {
        this.compression = "gzip";
    } else {
        this.compression = null;
    }

    if (this.compression)
        this.setHeader("content-encoding", this.compression);
    else
        this.setHeader("content-encoding", "identity");

    /* We don't initialize the compressor until we've actually started writing
     * data, in case they change their mind */
}

Response.prototype.writeHead = function(code, headers) {
    if (this.ended || this.sentHeaders) {
        // Ruh roh!
        return;
    }
    if (headers) {
        for (const h in headers)
            this.headers[h.toLowerCase()] = headers[h];
    }
    process.send({c: "h", x: code, h: this.headers});
    this.sentHeaders = true;
}

Response.prototype.setHeader = function(name, value) {
    this.headers[name.toLowerCase()] = value;
}

Response.prototype.write = function(data) {
    if (this.ended)
        return;
    if (!this.sentHeaders)
        this.writeHead(200);

    // Convert to a sendable type
    if (typeof data === "object") {
        if (!(data instanceof Buffer)) {
            try {
                data = JSON.stringify(data);
            } catch (ex) {
                data = data + "";
            }
        }
    } else {
        data = data+"";
    }

    // Use the compressor if needed
    if (this.compression) {
        if (!this.compressor) {
            switch (this.compression) {
                case "br": // Brotli
                    this.compressor = zlib.createBrotliCompress();
                    break;

                case "gzip":
                    this.compressor = zlib.createGzip();
                    break;
            }

            this.compressor.on("data", (chunk) => {
                process.send({c: "w", x: chunk.toString("binary")});
            });

            this.compressor.on("end", () => {
                process.send({c: "e"});
            });
        }

        this.compressor.write(data);

    } else {
        if (typeof data === "string")
            process.send({c: "w", d: data});
        else
            process.send({c: "w", x: data.toString("binary")});

    }
}

Response.prototype.end = function() {
    if (this.ended)
        return;
    if (!this.sentHeaders)
        this.writeHead(200);
    if (this.compressor)
        this.compressor.end();
    else
        process.send({c: "e"});
    this.ended = true;
}

// Handle messages from the server
process.on("message", (msg) => {
    switch (msg.c) {
        case "r":
            // Run a command
            run(msg.d, msg.p, msg.r, msg.b, new Response());
            break;

        case "t":
            // Terminate
            process.exit(0);
            break;
    }
});
