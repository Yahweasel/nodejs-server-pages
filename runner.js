/*
 * Copyright (c) 2020 Yahweasel
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

const session = require("./session.js");

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
    "request", "response", "params", "writeHead", "write", "session", "compileAbsolute", "require"
];

/**
 * "Parse" a JSS file into JavaScript code
 * @param {string} file     The file content
 */
function parse(file) {
    var start = 0;
    var out = {o: ""};
    var inComment = false;

    // Look for meaningful tags
    for (var i = 0; i < file.length; i++) {
        if (!inComment) {
            if (file.slice(i, i+4) === "<!--") {
                inComment = true;
            } else if (file.slice(i, i+2) === "<?") {
                var part = file.slice(start, i);
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
            if (file.slice(i, 3) === "-->")
                inComment = false;
        }
    }

    var part = file.slice(start);
    if (part.trim() !== "")
        out.o += "write(" + JSON.stringify(part) + ");\n";

    return out.o;
}

/**
 * Parse just the JS part of a JSS file
 */
function parseJS(file, i, out) {
    var isEchoTag = false;

    // First, we can start with "JS<whitespace>" or an echo tag
    var optStart = /^(js)?(=)?\s/i;
    var ose = optStart.exec(file.slice(i));
    if (ose) {
        i += ose[0].length;
        if (ose[2] === "=") {
            out.o += "write(String(";
            isEchoTag = true;
        }
    }

    // This doesn't really parse, of course, just avoids ?> in comments
    var start = i;
    for (; i < file.length; i++) {
        var c = file[i];
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
    var sbuf;
    var func = null;

    // Get the stats
    try {
        sbuf = fs.statSync(fname);
    } catch (ex) {
        res.writeHead(500, {"Content-type": "text/plain"});
        res.write("500: " + ex.stack);
        res.end();
        return;
    }

    // Check
    if (fname in times && sbuf.mtimeMs <= times[fname]) {
        // Still good
        func = funcs[fname];
    }

    // If we don't already have it, read it
    if (!func) {
        var fcont, parsed;

        // A header is needed to make usable local variables and specialized functions
        var header = "";
        globals.forEach((global) => {
            header += "var " + global + " = module." + global + ";\n";
        });

        header +=
            "function compile(name) {\n" +
            "name = (name[0]==='/') ? name : (" + JSON.stringify(path.dirname(fname) + "/") + "+name);\n" +
            "return module.compileAbsolute(name);\n" +
            "}\n" +
            "async function include(name) {\n" +
            "var sm = {" + globals.join(",") + ",exports:{}};\n" +
            "await (compile(name)(sm));\n" +
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
function run(db, params, req, res) {
    var fname = params.DOCUMENT_ROOT + params.SCRIPT_NAME;
    var func;

    // Compile the page
    try {
        func = compile(fname);
    } catch (ex) {
        res.writeHead(500, {"Content-type": "text/plain"});
        res.write("500: " + ex.stack);
        res.end();
        return;
    }

    // Create a session
    var s = new session.Session(db, req, res);

    // Cry a lot if we time out
    var timeout = setTimeout(() => {
        // No safe way to kill this but to kill it
        process.exit(0);
    }, 30000);

    // Set up its module object
    var module = {
        request: req,
        response: res,
        params,
        writeHead: res.writeHead.bind(res),
        write: res.write.bind(res),
        session: s,
        compileAbsolute: compile,
        require,
        exports: {}
    };

    // Parse its query string
    req.query = querystring.parse(req.query);

    // Run it
    func(module).then(() => {
        clearTimeout(timeout);
        s.close(); // Just let it finish in the background
        res.end();
    }).catch((ex) => {
        clearTimeout(timeout);
        res.write(ex.stack + "");
        s.close();
        res.end();
    });
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
}

Response.prototype.writeHead = function(code, headers) {
    if (this.ended || this.sentHeaders) {
        // Ruh roh!
        return;
    }
    if (headers) {
        for (var h in headers)
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
    process.send({c: "w", d: data});
}

Response.prototype.end = function() {
    if (this.ended)
        return;
    if (!this.sentHeaders)
        this.writeHead(200);
    process.send({c: "e"});
    this.ended = true;
}

// Handle messages from the server
process.on("message", (msg) => {
    switch (msg.c) {
        case "r":
            // Run a command
            var res = new Response();
            run(msg.d, msg.p, msg.r, res);
            break;
    }
});