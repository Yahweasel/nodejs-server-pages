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
const ws = require("ws");

const session = require("./session.js");

/**
 * Global no-server websocket server
 */
const wss = new ws.Server({noServer: true});

/**
 * Our compiled function
 */
var func;

/**
 * Our child module
 */
var cmodule;

/**
 * Compile the named file into an AsyncFunction
 */
function compile(fname) {
    // Make require accessible directly
    var header = "var require = module.require;\n";

    // Compile
    var fcont = fs.readFileSync(fname, "utf8");
    try {
        func = new AsyncFunction("request", "sock", "session", "module", header + fcont);
    } catch (ex) {
        func = async function(req, sock) { sock.close(); };
    }

    // And make the "module"
    cmodule = {
        require: require.main.require
    };
}

/**
 * The main entry point. Respond to a socket.
 */
function run(db, req, sock) {
    // Create a session
    var s = new session.Session(db, req, {setHeader: ()=>{}});

    // Parse its query string
    req.query = querystring.parse(req.url.replace(/^[^\?]*(\?|$)/, ""));

    // Run it
    wss.handleUpgrade(req, sock, [], (ws) => {
        ws.on("close", finish);
        func(req, ws, s, cmodule).catch(() => {
            ws.close();
        });
    });

    // Close when we're done
    function finish() {
        s.close(); // No await, just let it finish in the background
    }
}

// Handle messages from the server
process.on("message", (msg, sock) => {
    switch (msg.c) {
        case "l":
            compile(msg.f);
            break;

        case "r":
            run(msg.d, msg.r, sock);
            break;
    }
});
